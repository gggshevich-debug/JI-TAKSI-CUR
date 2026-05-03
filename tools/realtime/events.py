"""
Доставка событий: Redis PUB → подписчик → Socket.IO emit.
Fallback без Redis: прямой emit в hub.
event_id + revision; ack_required + event_ack.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from decimal import Decimal
from typing import Any, Dict, Optional

from tools import redis_client as rc

logger = logging.getLogger(__name__)


def safe_json(obj: Any) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {k: safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [safe_json(v) for v in obj]
    if isinstance(obj, Decimal):
        return float(obj)
    if hasattr(obj, "isoformat"):
        try:
            return obj.isoformat()
        except Exception:
            return str(obj)
    return obj


ACK_TTL_SEC = 86400 * 2
IDEM_TTL_SEC = 3600


def enrich_outbound(
    data: Dict[str, Any],
    *,
    revision: Optional[int] = None,
    ack_required: bool = False,
) -> Dict[str, Any]:
    out = dict(data)
    out["event_id"] = str(uuid.uuid4())
    out["server_ts"] = int(time.time() * 1000)
    if revision is not None:
        out["revision"] = revision
    if ack_required:
        out["ack_required"] = True
    return safe_json(out)


async def notify_user(
    hub,
    redis_obj,
    user_type: str,
    user_id: str,
    event: str,
    data: Dict[str, Any],
) -> bool:
    """Публикация в Redis; при REDIS_REQUIRED — без in-process fallback на hub."""
    payload = json.dumps({"event": event, "data": data})
    if rc.REDIS_REQUIRED and not redis_obj:
        logger.error("[notify_user] Redis обязателен, клиент отсутствует (%s %s)", user_type, user_id)
        return False
    if redis_obj:
        try:
            await redis_obj.publish(rc.rt_channel(user_type, str(user_id)), payload)
            return True
        except Exception as e:
            if rc.REDIS_REQUIRED:
                logger.error("[notify_user] Redis publish не удался: %s", e)
                return False
            logger.warning("Redis publish failed, fallback hub: %s", e)
    if hub and not rc.REDIS_REQUIRED:
        await hub.emit_to(user_type, str(user_id), event, data)
        return True
    return False


async def redis_subscriber_loop(hub, redis_obj, stop_event: asyncio.Event):
    """Подписка taxi:rt:* → emit в локальный hub."""
    if not redis_obj or not hub:
        return
    import redis.asyncio as redis_mod

    pubsub = redis_obj.pubsub()
    try:
        await pubsub.psubscribe(f"{rc.RT_CHANNEL_PREFIX}:*")
        logger.info("[Redis] subscriber psubscribe %s:*", rc.RT_CHANNEL_PREFIX)
        while not stop_event.is_set():
            try:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug("pubsub get_message: %s", e)
                await asyncio.sleep(0.5)
                continue
            if not msg or msg.get("type") not in ("message", "pmessage"):
                continue
            try:
                raw = msg.get("data")
                if isinstance(raw, bytes):
                    raw = raw.decode()
                body = json.loads(raw)
                ch = msg.get("channel", "")
                if isinstance(ch, bytes):
                    ch = ch.decode()
                parts = ch.split(":")
                if len(parts) < 4:
                    continue
                ut, uid = parts[2], parts[3]
                ev = body.get("event")
                dat = body.get("data")
                if ev and isinstance(dat, dict):
                    await hub.emit_to(ut, uid, ev, dat)
            except Exception as e:
                logger.warning("subscriber handler: %s", e)
    finally:
        try:
            await pubsub.punsubscribe()
            await pubsub.close()
        except Exception:
            pass


async def record_event_ack(redis_obj, event_id: str) -> bool:
    if not redis_obj or not event_id:
        return False
    try:
        await redis_obj.setex(f"evt:ack:{event_id}", ACK_TTL_SEC, "1")
        return True
    except Exception:
        return False


async def idempotency_check_new(redis_obj, key: str) -> bool:
    """True если ключ новый (можно выполнять команду). False если дубликат."""
    if not redis_obj or not key:
        return True
    try:
        ok = await redis_obj.set(f"idem:{key}", "1", nx=True, ex=IDEM_TTL_SEC)
        return bool(ok)
    except Exception:
        return True


async def idempotency_mark(redis_obj, key: str, ttl_sec: int = IDEM_TTL_SEC) -> None:
    if not redis_obj or not key:
        return
    try:
        await redis_obj.setex(key, ttl_sec, "1")
    except Exception:
        pass


async def idempotency_seen(redis_obj, key: str) -> bool:
    """True если ключ уже был (повтор запроса)."""
    if not redis_obj or not key:
        return False
    try:
        v = await redis_obj.get(key)
        return bool(v)
    except Exception:
        return False
