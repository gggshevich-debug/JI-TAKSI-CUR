"""Redis-метрики диспетчеризации: время поиска, отказы по типам, EMA принятия и дисперсии, анти-повтор оффера."""
from __future__ import annotations

import math
import time
from typing import Any, List, Optional, Sequence


async def trip_wave_started(redis_obj: Any, trip_id: int) -> None:
    if not redis_obj:
        return
    try:
        await redis_obj.set(
            f"dispatch:trip:{int(trip_id)}:wave_ts",
            str(time.time()),
            ex=7200,
        )
    except Exception:
        pass


async def dispatch_mark_first_offer_ts(redis_obj: Any, trip_id: int) -> None:
    """Фиксирует момент первой реальной раздачи оффера (для surge по времени и UX клиента)."""
    if not redis_obj:
        return
    try:
        k = f"dispatch:trip:{int(trip_id)}:first_dispatch_ts"
        await redis_obj.set(k, str(time.time()), nx=True, ex=7200)
    except Exception:
        pass


async def get_dispatch_wait_seconds(redis_obj: Any, trip_id: int) -> float:
    if not redis_obj:
        return 0.0
    try:
        raw = await redis_obj.get(f"dispatch:trip:{int(trip_id)}:first_dispatch_ts")
        if raw is None:
            return 0.0
        return max(0.0, time.time() - float(raw))
    except Exception:
        return 0.0


async def client_slow_hint_mark_if_needed(
    redis_obj: Any,
    trip_id: int,
    *,
    ttl_sec: int = 7200,
) -> bool:
    """Возвращает True, если это первый раз для подсказки клиенту (SET NX)."""
    if not redis_obj:
        return True
    try:
        k = f"dispatch:trip:{int(trip_id)}:client_slow_hint_sent"
        ok = await redis_obj.set(k, "1", nx=True, ex=int(ttl_sec))
        return bool(ok)
    except Exception:
        return True


async def trip_offer_cooldown_active(redis_obj: Any, trip_id: int, driver_id: int) -> bool:
    """True — этому водителю по этому заказу ещё нельзя слать повтор (жёсткий cooldown)."""
    if not redis_obj:
        return False
    try:
        raw = await redis_obj.get(f"dispatch:trip:{int(trip_id)}:offered:{int(driver_id)}")
        return raw is not None
    except Exception:
        return False


async def trip_offer_mark_drivers(redis_obj: Any, trip_id: int, driver_ids: Sequence[int], ttl_sec: float) -> None:
    if not redis_obj or not driver_ids:
        return
    ex = max(15, min(600, int(round(float(ttl_sec)))))
    for did in driver_ids:
        try:
            await redis_obj.set(
                f"dispatch:trip:{int(trip_id)}:offered:{int(did)}",
                "1",
                ex=ex,
            )
        except Exception:
            pass


async def filter_drivers_trip_offer_cooldown(
    redis_obj: Any,
    trip_id: int,
    driver_ids: List[int],
) -> List[int]:
    if not redis_obj or not driver_ids:
        return driver_ids
    out: List[int] = []
    for did in driver_ids:
        di = int(did)
        if await trip_offer_cooldown_active(redis_obj, trip_id, di):
            continue
        out.append(di)
    return out


_DECL_KIND = {
    "soft": 0.38,
    "timeout": 0.38,
    "busy": 0.62,
    "medium": 0.78,
    "decline": 1.15,
    "hard": 1.15,
}


async def decline_penalty_add(redis_obj: Any, driver_id: int, kind: str) -> float:
    """Добавляет взвешенный штраф отказа/таймаута. Возвращает текущую сумму (cap ~3)."""
    if not redis_obj:
        return 0.0
    k = f"dispatch:drv:{int(driver_id)}:decline_penalty"
    w = float(_DECL_KIND.get(str(kind or "soft").lower().strip(), 0.4))
    try:
        raw = await redis_obj.get(k)
        cur = float(raw) if raw is not None else 0.0
        nv = min(3.0, cur + w)
        await redis_obj.set(k, str(round(nv, 4)), ex=172800)
        return float(nv)
    except Exception:
        return 0.0


async def get_decline_penalty(redis_obj: Any, driver_id: int) -> float:
    if not redis_obj:
        return 0.0
    try:
        raw = await redis_obj.get(f"dispatch:drv:{int(driver_id)}:decline_penalty")
        if raw is None:
            return 0.0
        return max(0.0, min(3.0, float(raw)))
    except Exception:
        return 0.0


async def decline_reset(redis_obj: Any, driver_id: int) -> None:
    if not redis_obj:
        return
    try:
        did = int(driver_id)
        await redis_obj.delete(f"dispatch:drv:{did}:decline_penalty")
        await redis_obj.delete(f"dispatch:drv:{did}:decline_streak")
    except Exception:
        pass


async def decline_bump(redis_obj: Any, driver_id: int) -> int:
    """Совместимость: старый streak как грубый индикатор."""
    if not redis_obj:
        return 0
    k = f"dispatch:drv:{int(driver_id)}:decline_streak"
    try:
        n = int(await redis_obj.incr(k))
        await redis_obj.expire(k, 172800)
        return min(5, n)
    except Exception:
        return 0


async def get_decline_streak(redis_obj: Any, driver_id: int) -> int:
    if not redis_obj:
        return 0
    try:
        raw = await redis_obj.get(f"dispatch:drv:{int(driver_id)}:decline_streak")
        return max(0, min(5, int(float(raw)))) if raw is not None else 0
    except Exception:
        return 0


async def accept_record_latency(
    redis_obj: Any,
    driver_id: int,
    trip_id: int,
    *,
    ema_alpha: float = 0.35,
) -> None:
    """EMA секунд до accept + EMA квадрата отклонения (для бонуса стабильности)."""
    if not redis_obj:
        return
    try:
        raw = await redis_obj.get(f"dispatch:trip:{int(trip_id)}:wave_ts")
        if raw is None:
            return
        lat = max(0.0, time.time() - float(raw))
        a = max(0.05, min(0.95, float(ema_alpha)))
        ek = f"dispatch:drv:{int(driver_id)}:accept_latency_ema"
        vk = f"dispatch:drv:{int(driver_id)}:accept_latency_var_ema"
        prev = await redis_obj.get(ek)
        if prev is None:
            nv = lat
            var_v = 0.0
        else:
            p = float(prev)
            nv = p * (1.0 - a) + lat * a
            dev = lat - p
            var_prev_raw = await redis_obj.get(vk)
            var_prev = float(var_prev_raw) if var_prev_raw is not None else 0.0
            var_v = var_prev * (1.0 - a) + (dev * dev) * a
        await redis_obj.set(ek, str(round(nv, 3)), ex=2592000)
        await redis_obj.set(vk, str(round(max(0.0, var_v), 5)), ex=2592000)
    except Exception:
        pass


async def get_accept_latency_ema(redis_obj: Any, driver_id: int) -> Optional[float]:
    if not redis_obj:
        return None
    try:
        raw = await redis_obj.get(f"dispatch:drv:{int(driver_id)}:accept_latency_ema")
        if raw is None:
            return None
        return float(raw)
    except Exception:
        return None


async def get_accept_latency_var_ema(redis_obj: Any, driver_id: int) -> Optional[float]:
    if not redis_obj:
        return None
    try:
        raw = await redis_obj.get(f"dispatch:drv:{int(driver_id)}:accept_latency_var_ema")
        if raw is None:
            return None
        return max(0.0, float(raw))
    except Exception:
        return None
