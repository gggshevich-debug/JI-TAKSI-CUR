"""
Динамическое ценообразование поездок (AZN-логика, в UI может отображаться ₼).

Pipeline (после рефакторинга):
- Режим «короткая поездка» (км ≤ порога и задан short якорь): база = посадка + якорь×км + минуты;
  волна/спрос/рынок/дефицит; без ступеней км и без market reference controller.
- Иначе: база = ступени км + посадка + минуты + min + long linear cap при длинной;
  те же множители; затем финально market controller (якорь из истории/справочно) и при необходимости
  верх длинной поездки.

Приоритет водителя: рейтинг, acceptance, нагрузка (завершённые рейсы за 10 ч), расстояние.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

# Волновые множители цены (волна 5+ = последний коэффициент)
WAVE_PRICE_MULT: Dict[int, float] = {
    1: 1.0,
    2: 1.1,
    3: 1.25,
    4: 1.4,
}

DEFAULT_KM_TIERS: List[Dict[str, Any]] = [
    {"up_to": 5, "rate": 0.5},
    {"up_to": 20, "rate": 0.45},
    {"up_to": 50, "rate": 0.40},
    {"up_to": 100, "rate": 0.35},
    {"up_to": None, "rate": 0.32},
]

DEFAULT_PER_MINUTE = 0.04
DEFAULT_MIN_PRICE = 1.0
# При дистанции > порога база (до волн/спроса) не выше км × это значение (ключ в БД: pricing_long_trip_floor_per_km).
DEFAULT_LONG_TRIP_LINEAR_CAP_PER_KM = 0.34
DEFAULT_LONG_TRIP_KM_THRESHOLD = 100.0
# После множителей: итог для длинной поездки не выше км × ставка × этот коэффициент.
DEFAULT_LONG_TRIP_POST_CAP_MULT = 1.05
# Для длинных поездок: множитель волны не выше этого (спрос принудительно 1.0).
DEFAULT_LONG_TRIP_MAX_WAVE_MULT = 1.08
# Если ближайший из предложенных водителей ближе этого расстояния (км), волна и спрос не повышают цену.
DEFAULT_NEARBY_DRIVER_KM = 1.0
DEFAULT_DISPATCH_DIST_WEIGHT = 0.18

# Авто-множители (сервер подставляет по статистике / дефициту водителей).
MARKET_ADJUST_MIN = 0.95
MARKET_ADJUST_MAX = 1.07
SUPPLY_MULT_MAX = 1.10
DISPATCH_PRESSURE_MAX = 1.06
COMBO_ADJUST_MIN = 0.92
COMBO_ADJUST_MAX = 1.15
# Финальный контроллер относительно исторического ₼/км (якорь рынка).
DEFAULT_MARKET_REF_HIGH_MULT = 1.10
DEFAULT_MARKET_REF_LOW_MULT = 0.88


def wave_price_multiplier(wave: int) -> float:
    w = max(1, int(wave))
    return WAVE_PRICE_MULT.get(w, WAVE_PRICE_MULT[4])


def demand_coefficient_from_ratio(orders: int, drivers: int) -> float:
    """orders = открытые заказы, drivers = доступные водители. 1.0–1.5."""
    o = max(0, int(orders))
    d = max(1, int(drivers))
    ratio = float(o) / float(d)
    if ratio <= 0.35:
        return 1.0
    # 0.35 .. 2.0 → 1.0 .. 1.5
    t = (ratio - 0.35) / (2.0 - 0.35)
    t = max(0.0, min(1.0, t))
    return round(1.0 + t * 0.5, 3)


def parse_km_tiers_json(raw: Optional[str]) -> List[Dict[str, Any]]:
    if not raw or not str(raw).strip():
        return [dict(x) for x in DEFAULT_KM_TIERS]
    try:
        data = json.loads(raw)
        if not isinstance(data, list) or len(data) < 1:
            return [dict(x) for x in DEFAULT_KM_TIERS]
        out: List[Dict[str, Any]] = []
        for seg in data:
            if not isinstance(seg, dict):
                continue
            up = seg.get("up_to")
            if up is not None:
                up = float(up)
            rate = float(seg.get("rate", 0))
            if rate < 0:
                continue
            out.append({"up_to": up, "rate": rate})
        return out if out else [dict(x) for x in DEFAULT_KM_TIERS]
    except Exception:
        return [dict(x) for x in DEFAULT_KM_TIERS]


def dynamic_km_cost(km: float, tiers: List[Dict[str, Any]]) -> float:
    """Стоимость километров по ступеням (накопительные границы up_to)."""
    km = max(0.0, float(km))
    prev = 0.0
    total = 0.0
    for seg in sorted(tiers, key=lambda s: float("inf") if s.get("up_to") is None else float(s["up_to"])):
        up = seg.get("up_to")
        rate = float(seg.get("rate") or 0.0)
        if up is None:
            total += max(0.0, km - prev) * rate
            break
        upf = float(up)
        span = max(0.0, min(km, upf) - prev)
        total += span * rate
        prev = upf
        if km <= prev:
            break
    return total


def compute_short_anchor_base_before_multipliers(
    *,
    distance_km: float,
    duration_minutes: float,
    trip_base_fee: float,
    per_minute: float,
    anchor_pkm_per_km: float,
) -> float:
    """
    База только для короткого режима: посадка + (якорь ₼/км × км) + минуты.
    Без ступеней, без min_price здесь (нижний порог — один раз после множителей).
    """
    dk = max(0.0, float(distance_km or 0.0))
    dm = max(0.0, float(duration_minutes or 0.0))
    base = max(0.0, float(trip_base_fee or 0.0))
    pm = max(0.0, float(per_minute or 0.0))
    ap = max(0.0, float(anchor_pkm_per_km or 0.0))
    return round(base + dk * ap + dm * pm, 4)


def apply_wave_demand_market_to_base(
    base: float,
    *,
    distance_km: float,
    min_price: float,
    long_trip_km: float,
    long_trip_floor_per_km: float,
    wave: int,
    demand_coef: float,
    nearest_driver_km: Optional[float],
    long_trip_post_cap_mult: float,
    long_trip_max_wave_mult: float,
    nearby_driver_km_threshold: float,
    market_adjust: float,
    supply_shortage_mult: float,
    dispatch_pressure_mult: float,
    metrics_out: Optional[Dict[str, Any]] = None,
) -> float:
    """
    Умножает уже посчитанную базу (ступени или short-якорь) на волну/спрос/combo и long post-cap.
    """
    dk = max(0.0, float(distance_km or 0.0))
    cap_rate = max(0.0, float(long_trip_floor_per_km or 0.0))
    long_km = float(long_trip_km or 0.0)
    is_long = dk > long_km
    w_raw = wave_price_multiplier(wave)
    d_raw = max(1.0, min(1.5, float(demand_coef or 1.0)))

    ma = max(MARKET_ADJUST_MIN, min(MARKET_ADJUST_MAX, float(market_adjust or 1.0)))
    ss = max(1.0, min(SUPPLY_MULT_MAX, float(supply_shortage_mult or 1.0)))
    dp = max(1.0, min(DISPATCH_PRESSURE_MAX, float(dispatch_pressure_mult or 1.0)))

    nd = nearest_driver_km
    th = max(0.0, float(nearby_driver_km_threshold))
    nearby_offer = nd is not None and float(nd) < th

    if nearby_offer:
        w, d = 1.0, 1.0
        combo = max(MARKET_ADJUST_MIN, min(MARKET_ADJUST_MAX, ma))
    elif is_long:
        d = 1.0
        w = min(w_raw, max(1.0, float(long_trip_max_wave_mult)))
        combo = max(COMBO_ADJUST_MIN, min(COMBO_ADJUST_MAX, ma * ss * dp))
    else:
        w, d = w_raw, d_raw
        combo = max(COMBO_ADJUST_MIN, min(COMBO_ADJUST_MAX, ma * ss * dp))

    b = max(0.0, float(base))
    after_combo = b * d * w * combo
    final = after_combo
    post_mult = max(1.0, float(long_trip_post_cap_mult or 1.0))
    linear_final_cap: Optional[float] = None
    if is_long and cap_rate > 0.0:
        linear_final_cap = dk * cap_rate * post_mult
        final = min(final, linear_final_cap)

    mn = max(0.0, float(min_price or 0.0))
    out = max(mn, round(final, 2))

    if metrics_out is not None:
        metrics_out.update(
            {
                "base_before_multipliers": round(b, 4),
                "after_wave_demand_combo": round(after_combo, 4),
                "wave_mult": w,
                "demand_mult": d,
                "combo_mult": round(combo, 6),
                "w_raw": w_raw,
                "d_raw": round(d_raw, 4),
                "nearby_offer": nearby_offer,
                "is_long_route": is_long,
                "linear_long_final_cap": linear_final_cap,
                "after_long_cap_before_floor": round(final, 4),
                "min_price": mn,
                "after_multipliers": out,
            }
        )
    return out


def compute_base_price_before_multipliers(
    *,
    distance_km: float,
    duration_minutes: float,
    trip_base_fee: float,
    per_minute: float,
    tiers: List[Dict[str, Any]],
    min_price: float,
    long_trip_km: float,
    long_trip_floor_per_km: float,
) -> float:
    """
    price = base + km_segments + minutes * per_min
    затем max(min_price, price).
    Если км > long_trip_km: верхний потолок — min(price, км × long_trip_floor_per_km)
    (параметр в настройках — линейная ставка потолка ₼/км для длинных рейсов).
    """
    dk = max(0.0, float(distance_km or 0.0))
    dm = max(0.0, float(duration_minutes or 0.0))
    base = max(0.0, float(trip_base_fee or 0.0))
    pm = max(0.0, float(per_minute or 0.0))
    mn = max(0.0, float(min_price or 0.0))
    cap_rate = max(0.0, float(long_trip_floor_per_km or 0.0))

    part = base + dynamic_km_cost(dk, tiers) + dm * pm
    part = max(mn, part)
    if dk > float(long_trip_km) and cap_rate > 0.0:
        linear_cap = dk * cap_rate
        part = min(part, linear_cap)
    return round(part, 4)


def long_trip_dispatch_pressure_mult(wave: int) -> float:
    """Слабый рост при поздних волнах длинной поездки (не выше DISPATCH_PRESSURE_MAX)."""
    w = max(1, int(wave))
    if w < 4:
        return 1.0
    x = 1.0 + 0.008 * float(w - 3)
    return max(1.0, min(DISPATCH_PRESSURE_MAX, round(x, 4)))


def compute_final_trip_price(
    *,
    distance_km: float,
    duration_minutes: float,
    trip_base_fee: float,
    per_minute: float,
    tiers: List[Dict[str, Any]],
    min_price: float,
    long_trip_km: float,
    long_trip_floor_per_km: float,
    wave: int,
    demand_coef: float,
    nearest_driver_km: Optional[float] = None,
    long_trip_post_cap_mult: float = DEFAULT_LONG_TRIP_POST_CAP_MULT,
    long_trip_max_wave_mult: float = DEFAULT_LONG_TRIP_MAX_WAVE_MULT,
    nearby_driver_km_threshold: float = DEFAULT_NEARBY_DRIVER_KM,
    market_adjust: float = 1.0,
    supply_shortage_mult: float = 1.0,
    dispatch_pressure_mult: float = 1.0,
    metrics_out: Optional[Dict[str, Any]] = None,
) -> float:
    base = compute_base_price_before_multipliers(
        distance_km=distance_km,
        duration_minutes=duration_minutes,
        trip_base_fee=trip_base_fee,
        per_minute=per_minute,
        tiers=tiers,
        min_price=min_price,
        long_trip_km=long_trip_km,
        long_trip_floor_per_km=long_trip_floor_per_km,
    )
    return apply_wave_demand_market_to_base(
        base,
        distance_km=distance_km,
        min_price=min_price,
        long_trip_km=long_trip_km,
        long_trip_floor_per_km=long_trip_floor_per_km,
        wave=wave,
        demand_coef=demand_coef,
        nearest_driver_km=nearest_driver_km,
        long_trip_post_cap_mult=long_trip_post_cap_mult,
        long_trip_max_wave_mult=long_trip_max_wave_mult,
        nearby_driver_km_threshold=nearby_driver_km_threshold,
        market_adjust=market_adjust,
        supply_shortage_mult=supply_shortage_mult,
        dispatch_pressure_mult=dispatch_pressure_mult,
        metrics_out=metrics_out,
    )


def apply_reference_price_controller(
    price: float,
    *,
    distance_km: float,
    reference_price_per_km: float,
    min_price: float,
    low_mult: float = DEFAULT_MARKET_REF_LOW_MULT,
    high_mult: float = DEFAULT_MARKET_REF_HIGH_MULT,
    linear_long_max: Optional[float] = None,
) -> float:
    """
    Финальный слой только для «длинного» режима ценообразования в БД:
    итог в коридоре [якорь×км×low, якорь×км×high], не ниже min_price.
    Для короткого режима (якорь×км как единственная база км) не вызывается.
    """
    dk = max(0.0, float(distance_km or 0.0))
    ref = max(0.0, float(reference_price_per_km or 0.0))
    mn = max(0.0, float(min_price or 0.0))
    p = float(price)
    if ref <= 0.0 or dk <= 0.01:
        return max(mn, round(p, 2))
    anchor = ref * dk
    if anchor < mn * 0.75:
        return max(mn, round(p, 2))
    hi = max(mn * 1.12, anchor * max(1.0, float(high_mult)))
    lo = max(mn, anchor * max(0.5, min(1.0, float(low_mult))))
    if linear_long_max is not None:
        cap = max(0.0, float(linear_long_max))
        if cap > 0.0:
            lo = min(lo, cap)
    p = min(p, hi)
    p = max(p, lo)
    return max(mn, round(p, 2))


def driver_priority_score(
    *,
    rating: float,
    acceptance: float,
    activity: float,
    dist_km: float,
    dist_weight: float,
    recent_completed_10h: int = 0,
) -> float:
    """
    Балл: рейтинг и acceptance сильнее; низкий acceptance штрафуется.
    Итог: score - dist_km * dist_weight (ближе — выше при прочих равных).
    """
    r = max(0.0, min(5.0, float(rating or 0.0))) / 5.0
    a = max(0.0, min(1.0, float(acceptance or 0.0)))
    act = max(0.0, min(1.0, float(activity or 0.0)))
    score = r * 0.40 + a * 0.45 + act * 0.15
    penalty = max(0.0, (0.42 - a)) * 0.55
    score = max(0.0, score - penalty)
    rc10 = max(0, int(recent_completed_10h))
    score += 0.055 if rc10 == 0 else 0.0
    score -= min(8, rc10) * 0.034
    dk = max(0.0, float(dist_km or 0.0))
    w = max(0.0, float(dist_weight or DEFAULT_DISPATCH_DIST_WEIGHT))
    return score - dk * w


def activity_from_driver_row(row: Dict[str, Any]) -> float:
    """0..1 из rating_coefficient (1..2) и свежести last_seen_at."""
    try:
        rc = float(row.get("rating_coefficient") or 1.0)
    except (TypeError, ValueError):
        rc = 1.0
    rc = max(1.0, min(2.0, rc))
    act_rc = max(0.0, min(1.0, (rc - 1.0)))
    ts = row.get("last_seen_at")
    if ts is None:
        return round(0.5 * act_rc + 0.25, 4)
    try:
        if hasattr(ts, "tzinfo") and ts.tzinfo is not None:
            from datetime import datetime, timezone

            now = datetime.now(timezone.utc)
            delta = (now - ts).total_seconds()
        else:
            from datetime import datetime

            delta = (datetime.now() - ts).total_seconds()
    except Exception:
        delta = 999999.0
    if delta <= 900:
        fresh = 1.0
    elif delta <= 86400:
        fresh = 0.75
    else:
        fresh = 0.45
    return round(min(1.0, 0.55 * fresh + 0.45 * act_rc), 4)


def tiers_to_json(tiers: List[Dict[str, Any]]) -> str:
    return json.dumps(tiers, ensure_ascii=False)
