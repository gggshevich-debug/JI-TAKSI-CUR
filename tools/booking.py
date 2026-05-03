"""
Атомарный accept поездки + Redis lock/idempotency + уведомление клиента (через pub/sub).
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

from tools.realtime import events as rt_events
from tools.database import Database
from tools import push_notifications

logger = logging.getLogger(__name__)


async def driver_claim_trip(
    db: Database,
    redis_obj,
    hub,
    *,
    driver_id: int,
    trip_id: int,
    idempotency_key: Optional[str] = None,
    build_view_payload: Callable[[Dict, Dict], Dict[str, Any]],
) -> Dict[str, Any]:
    """
    SETNX lock → (опционально) idempotency → try_accept_trip → notify client.
    """
    lock_key = f"trip:claim_lock:{trip_id}"
    if redis_obj:
        got = await redis_obj.set(lock_key, "1", nx=True, ex=12)
        if not got:
            return {"success": False, "error": "claim_in_progress", "message": "Повторите через секунду"}

    try:
        if idempotency_key and redis_obj:
            ik = f"idem:accept:{driver_id}:{idempotency_key}"
            if not await rt_events.idempotency_check_new(redis_obj, ik):
                return {"success": True, "duplicate": True, "message": "Идемпотентный повтор"}

        drv = await db.get_driver(driver_id)
        if not drv:
            return {"success": False, "error": "driver_not_found", "message": "Водитель не найден"}
        vf = (drv.get("verification") or "pending").strip().lower()
        if vf != "verified":
            return {
                "success": False,
                "error": "not_verified",
                "message": "Заказы можно принимать только после подтверждения аккаунта сервисом.",
            }

        row = await db.try_accept_trip(trip_id, driver_id, redis_obj=redis_obj)
        if not row:
            return {
                "success": False,
                "error": "not_available",
                "message": "Заказ уже недоступен (клиент отменил или назначен другому).",
                "code": "TRIP_NOT_OPEN",
                "silent": True,
            }

        driver_info = await db.get_driver(driver_id)
        view_payload = build_view_payload(driver_info or {}, row)
        enriched = rt_events.enrich_outbound(
            view_payload,
            revision=row.get("revision"),
            ack_required=True,
        )
        cid = row.get("client_id")
        if cid:
            await rt_events.notify_user(
                hub, redis_obj, "client", str(cid), "view_trip_for_client", enriched
            )
            drv = driver_info or {}
            sur = (drv.get("surname") or "").strip()
            nm = (drv.get("name") or "").strip()
            driver_label = (
                (f"{sur[:1]}. {nm}" if sur and nm else (nm or sur or "Водитель")).strip()
            )
            await push_notifications.send_event_push(
                db,
                "client",
                int(cid),
                "client_driver_found",
                {"trip_id": str(int(trip_id)), "driver_label": driver_label},
                trip_id=int(trip_id),
            )
        return {"success": True, "trip_id": trip_id, "revision": row.get("revision")}
    finally:
        if redis_obj:
            try:
                await redis_obj.delete(lock_key)
            except Exception:
                pass
