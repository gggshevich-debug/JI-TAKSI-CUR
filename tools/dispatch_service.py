"""
Волновая диспетчеризация: Redis GEO, волны по долям от числа водителей (~20% / ~30% / остальные),
скоринг (рейтинг, acceptance², расстояние, нагрузка 10 ч, простой, Redis: отказы и EMA времени accept).
SOLO: динамический радиус от плотности, таймаут от acceptance; водитель в dispatch_seen, без повтора соло.
Анти-спам: мин. интервал между офферами (last_offer_ts). Tier 2–3: доп. surge к цене (app_settings).
Радиус расширяется после исчерпания тиров; hold «рядом есть водители» сохранён.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple, TYPE_CHECKING

from tools import redis_client as rc
from tools.realtime import events as rt_events
from tools import trip_logging
from tools import push_notifications
from tools import pricing_engine
from tools import dispatch_quality as dq
from tools import dispatch_redis_metrics as drm

if TYPE_CHECKING:
    from tools.database import Database

logger = logging.getLogger(__name__)

# Топ водителей за волну (запрос: 3–5).
WAVE_SIZE = 4
WAVE_TIMEOUT_SEC = 12
# Базовые шаги радиуса (км); фактические подстраиваются под плотность GEO.
RADIUS_KM_STEPS = (2.0, 4.0, 7.0, 12.0, 18.0, 25.0)
DENSITY_SAMPLE_KM = 5.0
DISPATCH_HOLD_NEARBY_KM = 2.0
DISPATCH_HOLD_MAX = 6


def scaled_radius_steps(density_count: int) -> Tuple[float, ...]:
    """Чем плотнее водители в DENSITY_SAMPLE_KM, тем меньше стартовый радиус; в пустоте — шире."""
    n = max(0, int(density_count))
    if n >= 16:
        scale = 0.84
    elif n >= 10:
        scale = 0.91
    elif n >= 6:
        scale = 0.97
    elif n <= 2:
        scale = 1.22
    elif n <= 4:
        scale = 1.10
    else:
        scale = 1.0
    return tuple(max(0.8, round(float(r) * scale, 2)) for r in RADIUS_KM_STEPS)


def radius_km_from_steps(wave: int, steps: Tuple[float, ...]) -> float:
    idx = max(0, min(int(wave) - 1, len(steps) - 1))
    return float(steps[idx])


async def count_drivers_in_radius_geo(redis_obj, lon: float, lat: float, radius_km: float) -> int:
    pairs = await rc.geo_nearby_drivers_with_dist(lon, lat, radius_km, 120)
    return len(pairs or [])


async def dispatch_hold_clear(redis_obj, trip_id: int) -> None:
    if not redis_obj:
        return
    try:
        await redis_obj.delete(f"dispatch:hold:{int(trip_id)}")
    except Exception:
        pass


def scaled_dispatch_wave_timeout_sec(
    base_sec: int,
    *,
    avg_accept_sec: float,
    accept_samples: int,
    density_count: int,
) -> int:
    """Таймаут волны: при медленном принятии дольше ждём (реже поднимаем цену); при плотной сетке — короче."""
    b = max(3, min(120, int(base_sec)))
    if accept_samples < 5 or avg_accept_sec < 0.0:
        t = float(b)
    elif avg_accept_sec >= 260.0:
        t = b * 1.24
    elif avg_accept_sec >= 160.0:
        t = b * 1.12
    elif avg_accept_sec <= 22.0:
        t = b * 0.86
    elif avg_accept_sec <= 40.0:
        t = b * 0.93
    else:
        t = float(b)
    dc = max(0, int(density_count))
    if dc >= 15:
        t *= 0.9
    elif dc <= 2:
        t *= 1.08
    return max(3, min(120, int(round(t))))


async def relaxed_pricing_wave_index(
    db: "Database",
    redis_obj,
    lat: float,
    lon: float,
    nominal_wave: int,
) -> int:
    """
    Индекс волны для расчёта цены: при высокой плотности и быстром рынке — мягче (ниже номер);
    при пустоте и медленном принятии — сильнее.
    """
    w = max(1, int(nominal_wave))
    density = await count_drivers_in_radius_geo(redis_obj, lon, lat, DENSITY_SAMPLE_KM)
    avg_sec, n = await db.get_accept_time_stats_cached()
    if n < 5 or avg_sec < 0.0:
        return w
    relax = 0
    if density >= 14 and avg_sec < 52.0:
        relax = 1
    stress = 0
    if density <= 3 and avg_sec > 195.0:
        stress = 1
    return max(1, min(8, w - relax + stress))


async def _driver_completed_counts_10h(db: "Database", ids: List[int]) -> Dict[int, int]:
    if not ids:
        return {}
    rows = await db._execute(
        """
        SELECT driver_id, COUNT(*)::int AS c
        FROM trips
        WHERE driver_id = ANY($1::int[])
          AND status = 'completed'
          AND completed_at > NOW() - INTERVAL '10 hours'
        GROUP BY driver_id
        """,
        (ids,),
        fetchall=True,
    )
    return {int(r["driver_id"]): int(r["c"]) for r in (rows or [])}


async def _available_drivers_subset(db: "Database", ids: List[int]) -> List[int]:
    if not ids:
        return []
    rows = await db._execute(
        """
        SELECT driver_id FROM drivers
        WHERE driver_id = ANY($1::int[])
          AND status = 'available'
          AND LOWER(TRIM(COALESCE(NULLIF(verification, ''), 'pending'))) = 'verified'
        ORDER BY array_position($1::int[], driver_id)
        """,
        (ids,),
        fetchall=True,
    )
    return [int(r["driver_id"]) for r in rows] if rows else []


async def _driver_dispatch_attrs(db: "Database", ids: List[int]) -> Dict[int, Dict[str, Any]]:
    if not ids:
        return {}
    rows = await db._execute(
        """
        SELECT driver_id, rating,
               COALESCE(acceptance_rate, 0.75) AS acceptance_rate,
               COALESCE(rating_coefficient, 1.0) AS rating_coefficient,
               last_seen_at
        FROM drivers
        WHERE driver_id = ANY($1::int[])
        """,
        (ids,),
        fetchall=True,
    )
    return {int(r["driver_id"]): dict(r) for r in (rows or [])}


async def _idle_bonus_map(
    redis_obj,
    driver_ids: List[int],
    scoring: Optional[Dict[str, float]] = None,
) -> Dict[int, float]:
    """Бонус «давно не получал оффер» по Redis; при долгом простое — сильнее (настраивается)."""
    out: Dict[int, float] = {}
    if not driver_ids:
        return out
    long_sec = float((scoring or {}).get("dispatch_idle_long_sec", 600.0))
    if not redis_obj:
        return {int(d): dq.IDLE_BONUS_NO_HISTORY for d in driver_ids}
    import time as _time

    now = _time.time()
    for did in driver_ids:
        di = int(did)
        key = f"dispatch:drv:{di}:last_offer_ts"
        try:
            raw = await redis_obj.get(key)
            if raw is None:
                out[di] = dq.IDLE_BONUS_NO_HISTORY
                continue
            ts = float(raw)
            age_sec = max(0.0, now - ts)
            if age_sec >= max(1800.0, long_sec):
                out[di] = min(
                    dq.IDLE_BONUS_MAX,
                    0.024 + min(0.065, age_sec / 86400.0 * 0.16),
                )
            elif age_sec >= long_sec:
                out[di] = min(dq.IDLE_BONUS_MAX, 0.012 + min(0.04, age_sec / long_sec * 0.02))
            else:
                out[di] = 0.0
        except Exception:
            out[di] = dq.IDLE_BONUS_NO_HISTORY
    return out


async def _record_offers_sent(
    redis_obj,
    trip_id: Optional[int],
    driver_ids: Optional[List[int]],
    *,
    trip_repeat_cooldown_sec: float = 0.0,
) -> None:
    if not redis_obj or not driver_ids:
        return
    import time as _time

    ts = str(_time.time())
    for did in driver_ids:
        try:
            await redis_obj.set(f"dispatch:drv:{int(did)}:last_offer_ts", ts, ex=172800)
        except Exception:
            pass
    if trip_id is not None and trip_repeat_cooldown_sec > 0:
        await drm.trip_offer_mark_drivers(
            redis_obj, int(trip_id), [int(d) for d in driver_ids], trip_repeat_cooldown_sec
        )


async def filter_drivers_min_offer_gap(
    redis_obj,
    driver_ids: List[int],
    gap_sec: float,
) -> List[int]:
    """Не предлагать водителю новый оффер, если предыдущий был менее gap_sec назад."""
    if not redis_obj or gap_sec <= 0 or not driver_ids:
        return driver_ids
    import time as _time

    now = _time.time()
    keys = [f"dispatch:drv:{int(d)}:last_offer_ts" for d in driver_ids]
    try:
        vals = await redis_obj.mget(keys)
    except Exception:
        return driver_ids
    out: List[int] = []
    for did, raw in zip(driver_ids, vals or []):
        di = int(did)
        if raw is None:
            out.append(di)
            continue
        try:
            if now - float(raw) >= float(gap_sec):
                out.append(di)
        except (TypeError, ValueError):
            out.append(di)
    return out


async def _redis_score_adjustments(
    redis_obj,
    driver_ids: List[int],
    dist_map: Dict[int, float],
    scoring: Dict[str, float],
) -> Dict[int, float]:
    """Штраф по типам отказов (Redis), реакция EMA, стабильность принятия, микробуст дальним."""
    out: Dict[int, float] = {int(d): 0.0 for d in driver_ids}
    if not driver_ids:
        return out
    pen_scale = float(scoring.get("dispatch_decline_penalty_scale", 0.085))
    fast_sec = float(scoring.get("dispatch_react_fast_sec", 5.0))
    slow_sec = float(scoring.get("dispatch_react_slow_sec", 15.0))
    fast_b = float(scoring.get("dispatch_react_fast_bonus", 0.042))
    slow_p = float(scoring.get("dispatch_react_slow_penalty", 0.055))
    far_km = float(scoring.get("dispatch_far_km_threshold", 4.0))
    far_b = float(scoring.get("dispatch_far_priority_bonus", 0.035))
    stab_max = float(scoring.get("dispatch_stability_bonus_max", 0.042))
    stab_th = float(scoring.get("dispatch_stability_var_threshold", 0.085))
    if not redis_obj:
        for did in driver_ids:
            di = int(did)
            if float(dist_map.get(di, 0.0)) >= far_km:
                out[di] += far_b
        return out
    for did in driver_ids:
        di = int(did)
        try:
            pts = await drm.get_decline_penalty(redis_obj, di)
        except Exception:
            pts = 0.0
        out[di] -= pen_scale * float(pts)
        try:
            ema = await drm.get_accept_latency_ema(redis_obj, di)
        except Exception:
            ema = None
        if ema is not None:
            if ema < fast_sec:
                out[di] += fast_b
            elif ema > slow_sec:
                out[di] -= slow_p
        try:
            varv = await drm.get_accept_latency_var_ema(redis_obj, di)
        except Exception:
            varv = None
        if varv is not None and stab_th > 0 and varv <= stab_th:
            out[di] += stab_max * max(0.0, 1.0 - float(varv) / stab_th)
        if float(dist_map.get(di, 0.0)) >= far_km:
            out[di] += far_b
    return out


async def gather_all_candidates_in_radius(
    db: "Database",
    redis_obj,
    start_lat: float,
    start_lon: float,
    radius_km: float,
    exclude: Set[int],
) -> Tuple[List[int], Dict[int, float]]:
    merged: List[int] = []
    dist_map: Dict[int, float] = {}
    pairs = await rc.geo_nearby_drivers_with_dist(
        start_lon, start_lat, radius_km, 240
    )
    for did, dkm in pairs or []:
        di = int(did)
        if di in exclude or di in merged:
            continue
        merged.append(di)
        dist_map[di] = float(dkm)
    if len(merged) < 24:
        nearby = await db.find_nearby_drivers(start_lat, start_lon, radius_km=radius_km)
        for d in nearby or []:
            di = int(d["driver_id"])
            if di in exclude or di in merged:
                continue
            if d.get("status") != "available":
                continue
            merged.append(di)
            dist_map.setdefault(di, float(d.get("distance_km") or 0.0))
    avail = await _available_drivers_subset(db, merged)
    return avail, dist_map


async def _prepare_quality_context(
    db: "Database",
    redis_obj,
    avail: List[int],
    dist_map: Dict[int, float],
    scoring: Dict[str, float],
    seen: Optional[Set[int]] = None,
) -> Tuple[int, Tuple[int, int, int], Dict[int, Dict[str, Any]], Dict[int, int], Dict[int, float], List[int]]:
    """N, (q1,q2,q3), attrs, loads, idle, sorted_ids — порядок волн = глобальный скоринг."""
    seen_set = seen or set()
    merged = dict(scoring)
    if float(merged.get("dispatch_distw_auto", 1.0)) >= 0.5:
        merged["dispatch_priority_dist_weight"] = dq.distance_weight_for_density(len(avail), merged)
    attrs = await _driver_dispatch_attrs(db, avail)
    loads = await _driver_completed_counts_10h(db, avail)
    idle = await _idle_bonus_map(redis_obj, avail, merged)
    extra = await _redis_score_adjustments(redis_obj, avail, dist_map, merged)
    n = len(avail)
    q1, q2, q3 = dq.tier_quotas_percent(
        n,
        merged.get("dispatch_wave1_share", 0.2),
        merged.get("dispatch_wave2_share", 0.3),
    )
    sorted_ids = dq.sort_driver_ids_by_score(
        avail,
        dist_map,
        attrs,
        loads,
        idle,
        dist_weight=merged.get("dispatch_priority_dist_weight"),
        load_per=merged.get("dispatch_load_penalty_per_trip"),
        rating_weight=merged.get("dispatch_priority_rating_weight"),
        accept_sq_weight=merged.get("dispatch_priority_accept_sq_weight"),
        extra_adj=extra,
        scoring=merged,
    )
    q1 = dq.wave1_quota_floor(q1, sorted_ids, seen_set, n, merged)
    return n, (q1, q2, q3), attrs, loads, idle, sorted_ids


def _nearest_km(cand: List[int], dist_map: Dict[int, float]) -> Optional[float]:
    if not cand:
        return None
    return min(float(dist_map.get(int(d), 1e9)) for d in cand)


def _time_surge_fraction(wait_sec: float, sc: Dict[str, float]) -> float:
    """Доп. доля к цене от ожидания с первого оффера (ступени + общий потолок)."""
    w = max(0.0, float(wait_sec or 0.0))
    t15 = float(sc.get("dispatch_time_surge_at_15", 15.0))
    t30 = float(sc.get("dispatch_time_surge_at_30", 30.0))
    t45 = float(sc.get("dispatch_time_surge_at_45", 45.0))
    p15 = float(sc.get("dispatch_time_surge_pct_15", 0.015))
    p30 = float(sc.get("dispatch_time_surge_pct_30", 0.015))
    p45 = float(sc.get("dispatch_time_surge_pct_45", 0.015))
    cap = float(sc.get("dispatch_time_surge_total_cap", 0.075))
    add = 0.0
    if w >= t15:
        add += p15
    if w >= t30:
        add += p30
    if w >= t45:
        add += p45
    return min(cap, add)


async def _log_dispatch_compact(
    *,
    trip_id: int,
    tier: int,
    n: int,
    solo_used: Optional[int],
    top_did: Optional[int],
    top_score: Optional[float],
    top_dist: Optional[float],
    top_acc: Optional[float],
    top_rt: Optional[float],
    surge_total: float,
    wait_sec: float,
) -> None:
    logger.info(
        "[dispatch_decision] trip=%s tier=%s n=%s solo=%s top=%s score=%.3f d_km=%.2f acc=%.2f rt=%.2f surge=%.4f wait=%.1fs",
        trip_id,
        tier,
        n,
        solo_used,
        top_did,
        float(top_score or 0.0),
        float(top_dist or -1.0),
        float(top_acc or -1.0),
        float(top_rt or -1.0),
        surge_total,
        wait_sec,
    )


async def _maybe_client_dispatch_slow_hint(
    db: "Database",
    hub,
    redis_obj,
    trip_row: Dict[str, Any],
    scoring: Dict[str, float],
) -> None:
    if not redis_obj or not hub:
        return
    try:
        tid = int(trip_row["trip_id"])
        if str(trip_row.get("status") or "").lower() != "offered":
            return
        wait_need = float(scoring.get("dispatch_client_slow_hint_sec", 50.0))
        w = await drm.get_dispatch_wait_seconds(redis_obj, tid)
        if w < wait_need:
            return
        ok = await drm.client_slow_hint_mark_if_needed(redis_obj, tid)
        if not ok:
            return
        cid = trip_row.get("client_id")
        if cid is None:
            return
        bpct = round(float(scoring.get("dispatch_client_boost_pct", 0.04)) * 100.0, 2)
        try:
            bm = float(trip_row.get("client_dispatch_boost_mult") or 1.0)
        except (TypeError, ValueError):
            bm = 1.0
        body = {
            "type": "trip_dispatch_waiting_hint",
            "trip_id": tid,
            "message": "Ищем водителя… Можно увеличить шанс найти машину (слегка повысим цену).",
            "can_boost": bm < 1.001,
            "boost_percent": bpct,
        }
        enriched = rt_events.enrich_outbound(
            body, revision=int(trip_row.get("revision") or 1), ack_required=False
        )
        await rt_events.notify_user(
            hub, redis_obj, "client", str(int(cid)), "trip_dispatch_waiting_hint", enriched
        )
    except Exception:
        logger.debug("client dispatch hint skip", exc_info=True)


async def _log_dispatch_scores(
    db: "Database",
    avail: List[int],
    dist_map: Dict[int, float],
    *,
    trip_id: Optional[int],
    wave: Optional[int],
    radius_km: Optional[float],
    label: str,
) -> None:
    if not avail:
        return
    attrs = await _driver_dispatch_attrs(db, avail)
    loads = await _driver_completed_counts_10h(db, avail)
    idle = await _idle_bonus_map(None, avail)  # skip redis for log-only
    scored = dq.sort_driver_ids_by_score(avail, dist_map, attrs, loads, idle, scoring={})
    preview = []
    for did in scored[: min(10, len(scored))]:
        row = attrs.get(int(did)) or {}
        sc = dq.dispatch_match_score(
            row,
            float(dist_map.get(int(did), 0.0)),
            int(loads.get(int(did), 0)),
            float(idle.get(int(did), 0.0)),
            scoring={},
        )
        preview.append(f"{did}:{sc:.2f}")
    trip_logging.trip_log(
        "dispatch_wave_scores",
        trip_id=trip_id,
        extra=f"{label} wave={wave} r_km={radius_km} " + ",".join(preview),
    )


async def _trip_push_payload(
    db: "Database", trip_row: Dict, client_photo: Optional[str]
) -> Dict[str, Any]:
    tid = trip_row["trip_id"]
    dkm = float(trip_row["distance_km"] or 0)
    try:
        stored = float(trip_row.get("price") or 0)
    except (TypeError, ValueError):
        stored = 0.0
    if stored > 0:
        price_val = stored
    else:
        price_val = await db.trip_quote_amount(dkm)
    return {
        "type": "new_trip",
        "trip": {
            "trip_id": tid,
            "client_id": trip_row["client_id"],
            "start_lat": trip_row["start_lat"],
            "start_lon": trip_row["start_lon"],
            "end_lat": trip_row["end_lat"],
            "end_lon": trip_row["end_lon"],
            "start_address": trip_row.get("start_address"),
            "end_address": trip_row.get("end_address"),
            "distance": dkm,
            "price": price_val,
            "client_name": trip_row.get("client_name"),
            "client_rating": float(trip_row["client_rating"] or 0),
            "client_photo": client_photo,
            "driving_time": trip_row.get("driving_time"),
            "revision": trip_row.get("revision") or 1,
            "trip_status": trip_row.get("status"),
        },
    }


async def notify_drivers_new_trip(
    db: "Database",
    hub,
    redis_obj,
    driver_ids: Optional[List[int]],
    base: Dict[str, Any],
    rev: int,
    *,
    trip_repeat_cooldown_sec: float = 0.0,
):
    body = rt_events.enrich_outbound(base, revision=rev, ack_required=False)
    trip = body["trip"]
    inner = {**base, "trip": trip, "revision": rev}
    tid_raw = trip.get("trip_id")
    tid_i = int(tid_raw) if tid_raw is not None else None
    if driver_ids:
        for did in driver_ids:
            await rt_events.notify_user(hub, redis_obj, "driver", str(did), "new_trip", inner)
        if tid_i is not None:
            raw_price = trip.get("price")
            try:
                if isinstance(raw_price, (int, float)) and float(raw_price) > 0:
                    price_s = f"{float(raw_price):.2f}"
                else:
                    price_s = str(raw_price or "")
            except (TypeError, ValueError):
                price_s = str(raw_price or "")
            # Свежая строка trips: в socket-payload иногда нет end_address / distance_km.
            src: Dict[str, Any] = {}
            try:
                fr = await db.get_trips(trip_id=int(tid_i))
                if isinstance(fr, dict):
                    src = fr
            except Exception:
                pass
            addr_from = str(
                src.get("start_address") or trip.get("start_address") or ""
            ).strip()
            addr_to = str(src.get("end_address") or trip.get("end_address") or "").strip()
            raw_d = src.get("distance_km")
            if raw_d is None:
                raw_d = trip.get("distance")
            if raw_d is None:
                raw_d = trip.get("distance_km")
            try:
                distance_km_s = (
                    f"{float(raw_d):.2f}" if raw_d is not None and str(raw_d).strip() != "" else ""
                )
            except (TypeError, ValueError):
                distance_km_s = str(raw_d or "").strip()
            ctx = {
                "trip_id": str(int(tid_i)),
                "price": price_s,
                "start_address": addr_from,
                # camelCase (как в подсказке админки)
                "addressFrom": addr_from,
                "addressTo": addr_to,
                "distanceKm": distance_km_s,
                # snake_case — как у {start_address}, часто так пишут в шаблонах
                "address_from": addr_from,
                "address_to": addr_to,
                "distance_km": distance_km_s,
                "end_address": addr_to,
            }
            for did in driver_ids:
                await push_notifications.send_event_push(
                    db,
                    "driver",
                    int(did),
                    "driver_new_trip_offer",
                    ctx,
                    trip_id=int(tid_i),
                )
        await _record_offers_sent(
            redis_obj,
            tid_i,
            driver_ids,
            trip_repeat_cooldown_sec=float(trip_repeat_cooldown_sec or 0.0),
        )
    elif hub and not rc.REDIS_REQUIRED:
        await hub.broadcast_to_all_drivers("new_trip", inner)
    else:
        logger.warning(
            "[dispatch] нет целевых driver_ids для new_trip (broadcast отключён при REDIS_REQUIRED)"
        )


async def run_first_wave(
    db: "Database",
    hub,
    redis_obj,
    trip_id: int,
    client_photo: Optional[str],
) -> None:
    trip_row = await db.get_trips(trip_id=trip_id)
    if not trip_row or trip_row.get("driver_id"):
        return

    scoring = await db.get_dispatch_scoring_settings()
    gap = float(scoring.get("dispatch_min_offer_gap_sec", 0.0))

    base_timeout = await db.get_dispatch_wave_timeout_sec()
    tier_timeout = dq.tier_inter_wave_seconds(base_timeout)

    await dispatch_hold_clear(redis_obj, trip_id)

    lat, lon = float(trip_row["start_lat"]), float(trip_row["start_lon"])
    density = await count_drivers_in_radius_geo(redis_obj, lon, lat, DENSITY_SAMPLE_KM)
    avg_sec, acc_n = await db.get_accept_time_stats_cached()
    geo_timeout = scaled_dispatch_wave_timeout_sec(
        base_timeout,
        avg_accept_sec=avg_sec,
        accept_samples=acc_n,
        density_count=density,
    )
    steps = scaled_radius_steps(density)
    r1 = radius_km_from_steps(1, steps)
    seen = set(int(x) for x in (trip_row.get("dispatch_seen_driver_ids") or []) if x is not None)

    avail, dist_map = await gather_all_candidates_in_radius(
        db, redis_obj, lat, lon, r1, seen
    )
    avail = await filter_drivers_min_offer_gap(redis_obj, avail, gap)
    avail = await drm.filter_drivers_trip_offer_cooldown(redis_obj, int(trip_id), avail)
    if not avail:
        logger.warning("[dispatch] trip %s: нет верифицированных водителей в стартовом радиусе", trip_id)
        exp = datetime.now() + timedelta(seconds=max(tier_timeout, geo_timeout))
        await db.start_trip_offer_wave(
            trip_id,
            1,
            r1,
            None,
            [],
            exp,
            dispatch_quality_tier=1,
            dispatch_solo_driver_id=None,
        )
        return

    n, (q1, q2, q3), attrs, loads, idle, sorted_ids = await _prepare_quality_context(
        db, redis_obj, avail, dist_map, scoring, seen
    )
    await _log_dispatch_scores(
        db, avail, dist_map, trip_id=trip_id, wave=1, radius_km=r1, label="first"
    )

    solo_rad = dq.solo_radius_km(n)
    nearby_ok: List[int] = []
    if n > 3:
        for did in sorted_ids:
            if float(dist_map.get(int(did), 999.0)) <= solo_rad:
                nearby_ok.append(int(did))
        nearby_ok = await filter_drivers_min_offer_gap(redis_obj, nearby_ok, gap)
        nearby_ok = await drm.filter_drivers_trip_offer_cooldown(redis_obj, int(trip_id), nearby_ok)

    solo_id: Optional[int] = None
    if n > 3 and nearby_ok:
        for sid in nearby_ok:
            if dq.solo_eligible_for_window(attrs.get(int(sid)) or {}, scoring):
                solo_id = int(sid)
                break

    cand: List[int] = []
    solo_db: Optional[int] = None
    send_tier = 1
    exp_sec = tier_timeout

    if solo_id is not None:
        cand = [solo_id]
        solo_db = solo_id
        row_s = attrs.get(int(solo_id)) or {}
        try:
            acc_s = float(row_s.get("acceptance_rate") or 0.75)
        except (TypeError, ValueError):
            acc_s = 0.75
        exp_sec = dq.solo_timeout_sec(acc_s, salt=int(trip_id))
    elif n <= 3:
        cand = dq.pick_tier_wave_candidates(1, n, q1, q2, q3, seen, sorted_ids)
        cand = dq.cap_wave_distance_if_close_good(cand, sorted_ids, attrs, dist_map, scoring)
        send_tier = 3
    else:
        cand = dq.pick_tier_wave_candidates(1, n, q1, q2, q3, seen, sorted_ids)
        cand = dq.cap_wave_distance_if_close_good(cand, sorted_ids, attrs, dist_map, scoring)

    if not cand:
        logger.warning("[dispatch] trip %s: пустой первый набор кандидатов", trip_id)
        exp = datetime.now() + timedelta(seconds=geo_timeout)
        await db.start_trip_offer_wave(
            trip_id, 1, r1, None, [], exp, dispatch_quality_tier=1, dispatch_solo_driver_id=None
        )
        return

    await drm.dispatch_mark_first_offer_ts(redis_obj, int(trip_id))
    wait_sec = await drm.get_dispatch_wait_seconds(redis_obj, int(trip_id))
    nearest = _nearest_km(cand, dist_map)
    pw = await relaxed_pricing_wave_index(db, redis_obj, lat, lon, 1)
    await db.update_trip_price_for_dispatch_wave(
        trip_id,
        1,
        nearest_driver_km=nearest,
        pricing_wave=pw,
        dispatch_quality_tier=int(send_tier),
        wait_since_first_sec=wait_sec,
    )
    exp = datetime.now() + timedelta(seconds=exp_sec)
    seen_union = list(cand)
    await db.start_trip_offer_wave(
        trip_id,
        1,
        r1,
        cand,
        seen_union,
        exp,
        dispatch_quality_tier=send_tier,
        dispatch_solo_driver_id=solo_db,
    )
    await drm.trip_wave_started(redis_obj, int(trip_id))
    trip_row = await db.get_trips(trip_id=trip_id)
    if not trip_row:
        return
    await _maybe_client_dispatch_slow_hint(db, hub, redis_obj, trip_row, scoring)
    rev = trip_row.get("revision") or 1
    payload = await _trip_push_payload(db, trip_row, client_photo)
    trip_rep = float(scoring.get("dispatch_trip_repeat_cooldown_sec", 45.0))
    await notify_drivers_new_trip(
        db, hub, redis_obj, cand, payload, rev, trip_repeat_cooldown_sec=trip_rep
    )
    qt = int(send_tier)
    t2 = float(scoring.get("dispatch_tier2_price_surge", 0.03))
    t3 = float(scoring.get("dispatch_tier3_extra_price_surge", 0.02))
    tier_m = 1.0 + (t2 + t3 if qt >= 3 else (t2 if qt >= 2 else 0.0))
    time_f = _time_surge_fraction(wait_sec, scoring)
    top_d = int(cand[0]) if cand else None
    top_sc = None
    top_acc = top_rt = None
    msc = dict(scoring)
    if float(msc.get("dispatch_distw_auto", 1.0)) >= 0.5:
        msc["dispatch_priority_dist_weight"] = dq.distance_weight_for_density(n, msc)
    if top_d is not None:
        rw = attrs.get(top_d) or {}
        top_sc = dq.dispatch_match_score(
            rw,
            float(dist_map.get(top_d, 0.0)),
            int(loads.get(top_d, 0)),
            float(idle.get(top_d, 0.0)),
            dist_weight=msc.get("dispatch_priority_dist_weight"),
            load_per=msc.get("dispatch_load_penalty_per_trip"),
            rating_weight=msc.get("dispatch_priority_rating_weight"),
            accept_sq_weight=msc.get("dispatch_priority_accept_sq_weight"),
            scoring=msc,
        )
        try:
            top_rt = float(rw.get("rating") or 0.0)
            top_acc = float(rw.get("acceptance_rate") or 0.0)
        except (TypeError, ValueError):
            top_rt = top_acc = None
    await _log_dispatch_compact(
        trip_id=int(trip_id),
        tier=qt,
        n=n,
        solo_used=solo_db,
        top_did=top_d,
        top_score=top_sc,
        top_dist=float(dist_map.get(int(top_d), 0.0)) if top_d is not None else None,
        top_acc=top_acc,
        top_rt=top_rt,
        surge_total=float(tier_m * (1.0 + time_f)),
        wait_sec=wait_sec,
    )


async def process_expired_waves(db: "Database", hub, redis_obj) -> None:
    expired = await db.list_offered_trips_past_deadline()
    base_timeout = await db.get_dispatch_wave_timeout_sec()
    tier_timeout = dq.tier_inter_wave_seconds(base_timeout)
    scoring = await db.get_dispatch_scoring_settings()
    gap = float(scoring.get("dispatch_min_offer_gap_sec", 0.0))

    for trip_row in expired:
        tid = int(trip_row["trip_id"])
        if trip_row.get("driver_id"):
            continue
        lat, lon = float(trip_row["start_lat"]), float(trip_row["start_lon"])
        seen = set(
            int(x) for x in (trip_row.get("dispatch_seen_driver_ids") or []) if x is not None
        )
        density_timer = await count_drivers_in_radius_geo(redis_obj, lon, lat, DENSITY_SAMPLE_KM)
        avg_sec, acc_n = await db.get_accept_time_stats_cached()
        wave_timeout_eff = scaled_dispatch_wave_timeout_sec(
            base_timeout,
            avg_accept_sec=avg_sec,
            accept_samples=acc_n,
            density_count=density_timer,
        )

        hold_pairs = await rc.geo_nearby_drivers_with_dist(lon, lat, DISPATCH_HOLD_NEARBY_KM, 40)
        hold_ids = [did for did, _ in (hold_pairs or [])]
        avail_near = await _available_drivers_subset(db, hold_ids) if hold_ids else []
        if avail_near and redis_obj:
            try:
                streak = int(await redis_obj.incr(f"dispatch:hold:{int(tid)}"))
                await redis_obj.expire(f"dispatch:hold:{int(tid)}", 7200)
            except Exception:
                streak = DISPATCH_HOLD_MAX + 1
            if streak <= DISPATCH_HOLD_MAX:
                exp_hold = datetime.now() + timedelta(seconds=wave_timeout_eff)
                await db._execute(
                    """
                    UPDATE trips SET
                        offer_expires_at = $1,
                        revision = COALESCE(revision, 1) + 1
                    WHERE trip_id = $2 AND status = 'offered' AND driver_id IS NULL
                    """,
                    (exp_hold, tid),
                )
                logger.info(
                    "[dispatch] trip %s: продление волны без повышения (рядом есть водители), hold=%s",
                    tid,
                    streak,
                )
                continue

        await dispatch_hold_clear(redis_obj, tid)

        prev_offered = [int(x) for x in (trip_row.get("offer_driver_ids") or []) if x is not None]
        for did_pen in prev_offered:
            try:
                await drm.decline_penalty_add(redis_obj, int(did_pen), "timeout")
            except Exception:
                pass
        try:
            await _maybe_client_dispatch_slow_hint(db, hub, redis_obj, trip_row, scoring)
        except Exception:
            pass

        density = density_timer
        steps = scaled_radius_steps(density)
        current_r = float(trip_row.get("dispatch_radius_km") or 3.0)
        wave = int(trip_row.get("dispatch_wave") or 1)
        if wave < 1:
            wave = 1
        last_tier = int(trip_row.get("dispatch_quality_tier") or 1)
        solo_raw = trip_row.get("dispatch_solo_driver_id")
        solo_id = int(solo_raw) if solo_raw is not None else None

        async def _push_notify(cand: List[int]) -> None:
            if not cand:
                return
            fresh = await db.get_trips(trip_id=tid)
            if not fresh:
                return
            rev = fresh.get("revision") or 1
            client = await db.get_client(int(fresh["client_id"]))
            photo = None
            if client and not client.get("anonymous_profile"):
                photo = client.get("photo")
            payload = await _trip_push_payload(db, fresh, photo)
            tr = float(scoring.get("dispatch_trip_repeat_cooldown_sec", 45.0))
            await notify_drivers_new_trip(
                db, hub, redis_obj, cand, payload, rev, trip_repeat_cooldown_sec=tr
            )

        async def _radius_expand_only() -> bool:
            nonlocal wave, current_r
            nw = wave + 1
            if nw > len(steps):
                logger.info("[dispatch] trip %s: достигнут макс. радиус, волна %s", tid, nw)
                return False
            new_r = radius_km_from_steps(nw, steps)
            pw = await relaxed_pricing_wave_index(db, redis_obj, lat, lon, nw)
            wsec = await drm.get_dispatch_wait_seconds(redis_obj, tid)
            await db.update_trip_price_for_dispatch_wave(
                tid,
                nw,
                nearest_driver_km=None,
                pricing_wave=pw,
                dispatch_quality_tier=1,
                wait_since_first_sec=wsec,
            )
            exp = datetime.now() + timedelta(seconds=wave_timeout_eff)
            await db._execute(
                """
                UPDATE trips SET
                    dispatch_radius_km = $1,
                    offer_expires_at = $2,
                    dispatch_wave = $3,
                    dispatch_quality_tier = 1,
                    dispatch_solo_driver_id = NULL,
                    offer_driver_ids = NULL,
                    revision = COALESCE(revision, 1) + 1
                WHERE trip_id = $4 AND status = 'offered' AND driver_id IS NULL
                """,
                (new_r, exp, nw, tid),
            )
            wave, current_r = nw, new_r
            logger.info("[dispatch] trip %s: расширение радиуса wave=%s r=%s км", tid, nw, new_r)
            return True

        # --- Соло «рядом» закончилось → полная волна 1 ---
        if solo_id is not None:
            avail, dist_map = await gather_all_candidates_in_radius(
                db, redis_obj, lat, lon, current_r, seen
            )
            avail = await filter_drivers_min_offer_gap(redis_obj, avail, gap)
            avail = await drm.filter_drivers_trip_offer_cooldown(redis_obj, tid, avail)
            if not avail:
                if await _radius_expand_only():
                    avail, dist_map = await gather_all_candidates_in_radius(
                        db, redis_obj, lat, lon, current_r, seen
                    )
                    avail = await filter_drivers_min_offer_gap(redis_obj, avail, gap)
                    avail = await drm.filter_drivers_trip_offer_cooldown(redis_obj, tid, avail)
                if not avail:
                    continue
            n, (q1, q2, q3), attrs, loads, idle, sorted_ids = await _prepare_quality_context(
                db, redis_obj, avail, dist_map, scoring, seen
            )
            cand = dq.pick_tier_wave_candidates(1, n, q1, q2, q3, seen, sorted_ids)
            cand = await drm.filter_drivers_trip_offer_cooldown(redis_obj, tid, cand)
            cand = dq.cap_wave_distance_if_close_good(cand, sorted_ids, attrs, dist_map, scoring)
            if not cand:
                if not await _radius_expand_only():
                    pass
                continue
            nearest = _nearest_km(cand, dist_map)
            pw = await relaxed_pricing_wave_index(db, redis_obj, lat, lon, wave)
            wsec = await drm.get_dispatch_wait_seconds(redis_obj, tid)
            await db.update_trip_price_for_dispatch_wave(
                tid,
                wave,
                nearest_driver_km=nearest,
                pricing_wave=pw,
                dispatch_quality_tier=1,
                wait_since_first_sec=wsec,
            )
            exp = datetime.now() + timedelta(seconds=tier_timeout)
            await db.start_trip_offer_wave(
                tid,
                wave,
                current_r,
                cand,
                cand,
                exp,
                dispatch_quality_tier=1,
                dispatch_solo_driver_id=None,
            )
            await drm.trip_wave_started(redis_obj, tid)
            await _push_notify(cand)
            tier_m = 1.0
            time_f = _time_surge_fraction(wsec, scoring)
            td = int(cand[0]) if cand else None
            msc = dict(scoring)
            if float(msc.get("dispatch_distw_auto", 1.0)) >= 0.5:
                msc["dispatch_priority_dist_weight"] = dq.distance_weight_for_density(n, msc)
            tsc = None
            ta = trt = None
            if td is not None:
                rw = attrs.get(td) or {}
                tsc = dq.dispatch_match_score(
                    rw,
                    float(dist_map.get(td, 0.0)),
                    int(loads.get(td, 0)),
                    float(idle.get(td, 0.0)),
                    dist_weight=msc.get("dispatch_priority_dist_weight"),
                    load_per=msc.get("dispatch_load_penalty_per_trip"),
                    rating_weight=msc.get("dispatch_priority_rating_weight"),
                    accept_sq_weight=msc.get("dispatch_priority_accept_sq_weight"),
                    scoring=msc,
                )
                try:
                    trt = float(rw.get("rating") or 0.0)
                    ta = float(rw.get("acceptance_rate") or 0.0)
                except (TypeError, ValueError):
                    trt = ta = None
            await _log_dispatch_compact(
                trip_id=tid,
                tier=1,
                n=n,
                solo_used=None,
                top_did=td,
                top_score=tsc,
                top_dist=float(dist_map.get(int(td), 0.0)) if td is not None else None,
                top_acc=ta,
                top_rt=trt,
                surge_total=float(tier_m * (1.0 + time_f)),
                wait_sec=wsec,
            )
            logger.info("[dispatch] trip %s solo→tier1 %s водителей nearest=%s", tid, len(cand), nearest)
            continue

        # --- Обычное истечение таймера качественной волны ---
        avail, dist_map = await gather_all_candidates_in_radius(
            db, redis_obj, lat, lon, current_r, seen
        )
        avail = await filter_drivers_min_offer_gap(redis_obj, avail, gap)
        avail = await drm.filter_drivers_trip_offer_cooldown(redis_obj, tid, avail)
        if not avail:
            if await _radius_expand_only():
                avail, dist_map = await gather_all_candidates_in_radius(
                    db, redis_obj, lat, lon, current_r, seen
                )
                avail = await filter_drivers_min_offer_gap(redis_obj, avail, gap)
                avail = await drm.filter_drivers_trip_offer_cooldown(redis_obj, tid, avail)
            if not avail:
                continue

        n, (q1, q2, q3), attrs, loads, idle, sorted_ids = await _prepare_quality_context(
            db, redis_obj, avail, dist_map, scoring, seen
        )

        if n <= 3:
            if last_tier >= 3:
                if not await _radius_expand_only():
                    pass
                continue
            cand = [int(d) for d in sorted_ids if int(d) not in seen]
            cand = await drm.filter_drivers_trip_offer_cooldown(redis_obj, tid, cand)
            cand = dq.cap_wave_distance_if_close_good(cand, sorted_ids, attrs, dist_map, scoring)
            if not cand:
                if not await _radius_expand_only():
                    pass
                continue
            next_tier = 3
        else:
            t = last_tier + 1
            cand = []
            next_tier = last_tier
            while t <= 3 and not cand:
                cand = dq.pick_tier_wave_candidates(t, n, q1, q2, q3, seen, sorted_ids)
                if cand:
                    next_tier = t
                    break
                t += 1
            if not cand:
                if not await _radius_expand_only():
                    pass
                continue
            cand = await drm.filter_drivers_trip_offer_cooldown(redis_obj, tid, cand)
            cand = dq.cap_wave_distance_if_close_good(cand, sorted_ids, attrs, dist_map, scoring)
            if not cand:
                if not await _radius_expand_only():
                    pass
                continue

        nearest = _nearest_km(cand, dist_map)
        pw = await relaxed_pricing_wave_index(db, redis_obj, lat, lon, wave)
        wsec = await drm.get_dispatch_wait_seconds(redis_obj, tid)
        await db.update_trip_price_for_dispatch_wave(
            tid,
            wave,
            nearest_driver_km=nearest,
            pricing_wave=pw,
            dispatch_quality_tier=int(next_tier),
            wait_since_first_sec=wsec,
        )
        exp = datetime.now() + timedelta(seconds=tier_timeout)
        await db.start_trip_offer_wave(
            tid,
            wave,
            current_r,
            cand,
            cand,
            exp,
            dispatch_quality_tier=next_tier,
            dispatch_solo_driver_id=None,
        )
        await drm.trip_wave_started(redis_obj, tid)
        await _push_notify(cand)
        nt = int(next_tier)
        t2 = float(scoring.get("dispatch_tier2_price_surge", 0.03))
        t3 = float(scoring.get("dispatch_tier3_extra_price_surge", 0.02))
        tier_m = 1.0 + (t2 + t3 if nt >= 3 else (t2 if nt >= 2 else 0.0))
        time_f = _time_surge_fraction(wsec, scoring)
        td = int(cand[0]) if cand else None
        msc = dict(scoring)
        if float(msc.get("dispatch_distw_auto", 1.0)) >= 0.5:
            msc["dispatch_priority_dist_weight"] = dq.distance_weight_for_density(n, msc)
        tsc = None
        ta = trt = None
        if td is not None:
            rw = attrs.get(td) or {}
            tsc = dq.dispatch_match_score(
                rw,
                float(dist_map.get(td, 0.0)),
                int(loads.get(td, 0)),
                float(idle.get(td, 0.0)),
                dist_weight=msc.get("dispatch_priority_dist_weight"),
                load_per=msc.get("dispatch_load_penalty_per_trip"),
                rating_weight=msc.get("dispatch_priority_rating_weight"),
                accept_sq_weight=msc.get("dispatch_priority_accept_sq_weight"),
                scoring=msc,
            )
            try:
                trt = float(rw.get("rating") or 0.0)
                ta = float(rw.get("acceptance_rate") or 0.0)
            except (TypeError, ValueError):
                trt = ta = None
        await _log_dispatch_compact(
            trip_id=tid,
            tier=nt,
            n=n,
            solo_used=None,
            top_did=td,
            top_score=tsc,
            top_dist=float(dist_map.get(int(td), 0.0)) if td is not None else None,
            top_acc=ta,
            top_rt=trt,
            surge_total=float(tier_m * (1.0 + time_f)),
            wait_sec=wsec,
        )
        logger.info(
            "[dispatch] trip %s tier=%s wave=%s → %s водителей nearest=%s",
            tid,
            next_tier,
            wave,
            len(cand),
            nearest,
        )

