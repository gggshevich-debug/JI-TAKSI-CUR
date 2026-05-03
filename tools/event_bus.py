"""
Абстракция шины событий: сейчас Redis pub/sub (через realtime.events.notify_user).
NATS: задать EVENT_BUS=nats и NATS_URL — тогда publish будет no-op с предупреждением,
      пока не подключён отдельный nats-py адаптер.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

_BUS = os.getenv("EVENT_BUS", "redis").lower()


async def publish_user_event(
    hub: Any,
    redis_obj: Any,
    user_type: str,
    user_id: str,
    event: str,
    data: dict,
    *,
    notify_fn: Any,
) -> bool:
    """
    notify_fn — обычно tools.realtime.events.notify_user (инъекция, чтобы не тянуть циклы).
    """
    if _BUS == "nats":
        logger.debug("[event_bus] NATS не подключён, fallback на notify_fn (redis/hub)")
    return await notify_fn(hub, redis_obj, user_type, user_id, event, data)
