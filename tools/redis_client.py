"""
Async Redis: GEO водителей, pub/sub, idempotency, ping для dispatch.
Если задан REDIS_REQUIRED=1, подключение обязательно при старте; иначе при сбое Redis — hub + SQL.
"""
from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, List, Optional, Tuple

if TYPE_CHECKING:
    import redis.asyncio as redis_async

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
GEO_KEY = "taxi:geo:drivers"
RT_CHANNEL_PREFIX = "taxi:rt"
PING_KEY_PREFIX = "taxi:drv:ping"
REDIS_REQUIRED = os.getenv("REDIS_REQUIRED", "").lower() in ("1", "true", "yes")

_client: Optional["redis_async.Redis"] = None


async def init_redis():
    global _client
    try:
        import redis.asyncio as redis

        _client = redis.from_url(REDIS_URL, decode_responses=True)
        await _client.ping()
        logger.info("[Redis] подключено %s", REDIS_URL)
        return _client
    except Exception as e:
        if REDIS_REQUIRED:
            logger.error("[Redis] обязателен (REDIS_REQUIRED), но недоступен: %s", e)
            raise
        logger.warning("[Redis] недоступен, realtime только in-process: %s", e)
        _client = None
        return None


def get_redis():
    return _client


async def close_redis():
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:
            pass
        _client = None


async def geo_update_driver(driver_id: int, lon: float, lat: float) -> None:
    r = _client
    if not r:
        return
    try:
        await r.geoadd(GEO_KEY, lon, lat, f"drv:{driver_id}")
    except Exception as e:
        logger.debug("GEOADD skip: %s", e)


async def geo_nearby_driver_ids(lon: float, lat: float, radius_km: float, count: int) -> List[int]:
    """Возвращает driver_id по возрастанию расстояния (Redis 6.2+ GEOSEARCH)."""
    r = _client
    if not r:
        return []
    try:
        raw = await r.geosearch(
            GEO_KEY,
            longitude=lon,
            latitude=lat,
            unit="km",
            radius=radius_km,
            count=count,
            sort="ASC",
        )
        out: List[int] = []
        for m in raw or []:
            if isinstance(m, str) and m.startswith("drv:"):
                try:
                    out.append(int(m.split(":", 1)[1]))
                except ValueError:
                    continue
        return out
    except Exception as e:
        logger.debug("GEOSEARCH skip: %s", e)
        return []


async def geo_nearby_drivers_with_dist(
    lon: float, lat: float, radius_km: float, count: int
) -> List[Tuple[int, float]]:
    """[(driver_id, distance_km), ...] по возрастанию расстояния."""
    r = _client
    if not r:
        return []
    try:
        raw = await r.execute_command(
            "GEOSEARCH",
            GEO_KEY,
            "FROMLONLAT",
            lon,
            lat,
            "BYRADIUS",
            radius_km,
            "km",
            "WITHDIST",
            "COUNT",
            count,
            "ASC",
        )
        out: List[Tuple[int, float]] = []
        if not raw:
            return out
        it = iter(raw)
        for member in it:
            dist_s = next(it, None)
            if isinstance(member, bytes):
                member = member.decode()
            if isinstance(dist_s, bytes):
                dist_s = dist_s.decode()
            if isinstance(member, str) and member.startswith("drv:"):
                try:
                    did = int(member.split(":", 1)[1])
                    dkm = float(dist_s) if dist_s is not None else 0.0
                    out.append((did, dkm))
                except (ValueError, TypeError):
                    continue
        return out
    except Exception as e:
        logger.debug("GEOSEARCH WITHDIST skip: %s", e)
        return []


async def driver_ping_score(redis_obj, driver_id: int) -> Optional[float]:
    """Меньше ms — лучше; None если нет данных."""
    if not redis_obj:
        return None
    try:
        v = await redis_obj.get(f"{PING_KEY_PREFIX}:{driver_id}")
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


async def record_driver_ping(redis_obj, driver_id: int, latency_ms: float) -> None:
    if not redis_obj:
        return
    try:
        await redis_obj.setex(f"{PING_KEY_PREFIX}:{driver_id}", 45, str(latency_ms))
    except Exception:
        pass


def rt_channel(user_type: str, user_id: str) -> str:
    return f"{RT_CHANNEL_PREFIX}:{user_type}:{user_id}"
