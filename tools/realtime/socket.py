"""
Socket.IO: connect/disconnect, маршрутизация message → trip_commands.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional, Tuple

import socketio

from tools import models
from tools import admin_auth
from tools.database import Database
from tools.realtime.events import safe_json

logger = logging.getLogger(__name__)

hub: Optional["RealtimeHub"] = None


def get_hub() -> "RealtimeHub":
    if hub is None:
        raise RuntimeError("Socket.IO hub не инициализирован")
    return hub


class RealtimeHub:
    def __init__(self, sio: socketio.AsyncServer, db: Database):
        self.sio = sio
        self.db = db
        self.user_to_sid: Dict[str, str] = {}
        self.sid_to_user: Dict[str, Tuple[str, str]] = {}
        self._last_seen_touch_mono: Dict[str, float] = {}
        self.last_seen_touch_interval_s: float = 45.0

    @staticmethod
    def user_key(user_type: str, user_id: str) -> str:
        return f"{user_type}:{user_id}"

    def register_session(self, sid: str, user_id: str, user_type: str) -> None:
        key = self.user_key(user_type, user_id)
        self.user_to_sid[key] = sid
        self.sid_to_user[sid] = (user_id, user_type)

    def unregister_session(self, sid: str) -> None:
        user = self.sid_to_user.pop(sid, None)
        if not user:
            return
        user_id, user_type = user
        key = self.user_key(user_type, user_id)
        if self.user_to_sid.get(key) == sid:
            del self.user_to_sid[key]

    async def emit_to(self, user_type: str, user_id: str, event: str, data: Any) -> bool:
        sid = self.user_to_sid.get(self.user_key(user_type, str(user_id)))
        if not sid:
            logger.debug("Нет активной сессии Socket.IO: %s:%s", user_type, user_id)
            return False
        await self.sio.emit(event, safe_json(data), to=sid)
        return True

    async def broadcast_to_all_drivers(self, event: str, data: Any) -> None:
        payload = safe_json(data)
        for key, sid in list(self.user_to_sid.items()):
            if key.startswith("driver:"):
                await self.sio.emit(event, payload, to=sid)

    async def emit_to_admins(self, event: str, data: Any) -> None:
        payload = safe_json(data)
        for key, sid in list(self.user_to_sid.items()):
            if key.startswith("admin:"):
                await self.sio.emit(event, payload, to=sid)

    async def revoke_user_session(
        self, user_type: str, user_id: str, *, reason: str = "banned"
    ) -> bool:
        """Принудительный выход: событие + disconnect Socket.IO (cookie снимает клиент по session_revoked)."""
        if user_type not in ("client", "driver"):
            return False
        key = self.user_key(user_type, str(user_id))
        sid = self.user_to_sid.get(key)
        if not sid:
            return False
        try:
            await self.sio.emit(
                "session_revoked",
                safe_json(
                    {
                        "type": "session_revoked",
                        "reason": str(reason or "banned"),
                        "message": "Сессия завершена администратором.",
                    }
                ),
                to=sid,
            )
        except Exception:
            logger.exception("revoke_user_session emit %s:%s", user_type, user_id)
        try:
            await self.sio.disconnect(sid)
        except Exception:
            logger.exception("revoke_user_session disconnect %s:%s", user_type, user_id)
        return True

    async def maybe_touch_last_seen(self, user_type: str, user_id: str) -> None:
        """Периодически обновляет last_seen_at в БД (не чаще раз в last_seen_touch_interval_s)."""
        if user_type not in ("driver", "client"):
            return
        key = self.user_key(user_type, user_id)
        now = time.monotonic()
        prev = self._last_seen_touch_mono.get(key, 0.0)
        if now - prev < self.last_seen_touch_interval_s:
            return
        self._last_seen_touch_mono[key] = now
        try:
            await self.db.touch_user_last_seen(user_type, int(user_id))
        except Exception:
            logger.exception("maybe_touch_last_seen %s %s", user_type, user_id)

    async def send_pending_trips_to_driver(self, driver_id: str) -> None:
        from tools import trip_commands

        try:
            pending = await self.db.get_pending_trips_for_driver(int(driver_id))
            for trip in pending:
                t = trip_commands._trip_row_to_pending_ws_trip(trip)
                await self.emit_to(
                    "driver",
                    driver_id,
                    "new_trip",
                    {"type": "new_trip", "trip": t},
                )
        except Exception as e:
            logger.exception("send_pending_trips_to_driver: %s", e)


def mount_socketio(fastapi_app, db: Database, serializer) -> socketio.ASGIApp:
    global hub

    sio = socketio.AsyncServer(
        async_mode="asgi",
        cors_allowed_origins="*",
        ping_interval=25,
        ping_timeout=60,
    )

    hub = RealtimeHub(sio, db)

    @sio.event
    async def connect(sid, environ, auth):
        token = None
        if isinstance(auth, dict):
            token = auth.get("token")
        if not token:
            q = environ.get("QUERY_STRING", "")
            from urllib.parse import parse_qs

            qs = parse_qs(q)
            token = (qs.get("token") or [None])[0]
        if not token:
            return False

        admin_claims = admin_auth.decode_admin_access_token(token)
        if admin_claims and admin_claims.get("role") == "admin":
            user_id = str(admin_claims.get("sub") or "1")
            user_type = "admin"
        else:
            user_data = models.get_user_from_token(serializer, token)
            if not user_data:
                return False
            user_id = str(user_data["user_id"])
            user_type = user_data["user_type"]

        hub.register_session(sid, user_id, user_type)
        if user_type in ("driver", "client"):
            try:
                await db.touch_user_last_seen(user_type, int(user_id))
            except Exception:
                logger.exception("touch_user_last_seen on connect %s %s", user_type, user_id)
        logger.info("[Socket.IO] %s (%s) подключён", user_id, user_type)
        await sio.emit(
            "connected",
            safe_json({"type": "connected", "user_id": user_id, "user_type": user_type}),
            to=sid,
        )
        if user_type == "driver":
            await hub.send_pending_trips_to_driver(user_id)
        return True

    @sio.event
    async def disconnect(sid):
        # Важно: last_seen_at при «тихой» сессии без message не обновлялся бы часами —
        # при отключении фиксируем конец сессии, чтобы в админке не было «1 ч назад» после выхода минуту назад.
        user = hub.sid_to_user.get(sid)
        if user:
            user_id, user_type = user
            if user_type in ("driver", "client"):
                try:
                    await db.touch_user_last_seen(user_type, int(user_id))
                except Exception:
                    logger.exception(
                        "touch_user_last_seen on disconnect %s %s", user_type, user_id
                    )
                hub._last_seen_touch_mono.pop(hub.user_key(user_type, user_id), None)
        hub.unregister_session(sid)
        logger.info("[Socket.IO] sid=%s отключён", sid)

    @sio.on("message")
    async def on_message(sid, data):
        from tools import trip_commands

        if not isinstance(data, dict):
            return {"type": "error", "message": "Invalid payload"}
        user = hub.sid_to_user.get(sid)
        if not user:
            return {"type": "error", "message": "Сессия не привязана к пользователю"}
        user_id, user_type = user
        if user_type == "admin":
            if isinstance(data, dict) and data.get("type") == "ping":
                return {"type": "pong"}
            return {"type": "error", "message": "Канал администратора только для чтения"}
        await hub.maybe_touch_last_seen(user_type, user_id)
        return await trip_commands.dispatch_socket_message(hub.db, data, user_id, user_type)

    return socketio.ASGIApp(sio, other_asgi_app=fastapi_app)
