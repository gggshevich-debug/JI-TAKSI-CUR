"""
Качественные волны диспетчеризации: доли волн, нормализованный скоринг (0..1 по осям),
SOLO (радиус, таймаут, пороги качества), ограничение «рядом хороший — не тащить издалека».
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

ACCEPT_SOFT_FLOOR = 0.36
ACCEPT_SOFT_PENALTY_NORM = 0.18

DIST_WEIGHT_DEFAULT = 0.18
LOAD_PER_COMPLETED_DEFAULT = 0.038
RATING_STRONG_PENALTY_BELOW = 3.5
RATING_STRONG_PENALTY_NORM = 0.12
COEFF_TERM_WEIGHT = 0.52
IDLE_BONUS_NO_HISTORY = 0.042
IDLE_BONUS_MAX = 0.095


def tier_quotas_percent(
    n: int,
    wave1_share: float = 0.2,
    wave2_share: float = 0.3,
) -> Tuple[int, int, int]:
    """
    Волна 1 ≈ share1 от n, волна 2 ≈ share2, волна 3 — остальные по порядку.
    Минимумы: q1 ≥ 1, q2 ≥ 1 (при n > 3). При n ≤ 3 — одна волна на всех.
    """
    n = max(0, int(n))
    if n <= 0:
        return (0, 0, 0)
    if n <= 3:
        return (max(1, n), 0, 0)
    w1 = max(0.05, min(0.55, float(wave1_share)))
    w2 = max(0.05, min(0.55, float(wave2_share)))
    q1 = max(1, min(n, int(round(n * w1))))
    rem = max(0, n - q1)
    q2 = max(1, min(max(0, rem), int(round(n * w2))))
    return (q1, q2, 10**6)


def wave1_quota_floor(
    q1: int,
    sorted_ids: Sequence[int],
    seen: Set[int],
    n: int,
    scoring: Dict[str, float],
) -> int:
    """Минимум 2 в волне 1, если есть ≥2 кандидата вне seen; иначе 1."""
    if n <= 3:
        return q1
    na = len([int(d) for d in sorted_ids if int(d) not in seen])
    want = max(1, int(round(float(scoring.get("dispatch_wave1_min_size", 2.0)))))
    want = min(2, want)
    if na >= want:
        return max(q1, want)
    return max(1, min(q1, na))


def distance_weight_for_density(n: int, scoring: Dict[str, float]) -> float:
    """Мало водителей — меньший вес км; плотная сеть — сильнее штраф за расстояние."""
    n = max(1, int(n))
    n_lo = max(2, int(scoring.get("dispatch_distw_density_low_n", 5)))
    n_hi = max(n_lo + 1, int(scoring.get("dispatch_distw_density_high_n", 16)))
    w_lo = float(scoring.get("dispatch_distw_sparse", 0.135))
    w_hi = float(scoring.get("dispatch_distw_dense", 0.22))
    w_lo = max(0.1, min(0.3, w_lo))
    w_hi = max(0.1, min(0.3, w_hi))
    if n <= n_lo:
        return w_lo
    if n >= n_hi:
        return w_hi
    t = (n - n_lo) / float(n_hi - n_lo)
    return w_lo + (w_hi - w_lo) * t


def tier_inter_wave_seconds(base_wave_timeout: int) -> int:
    b = max(3, min(120, int(base_wave_timeout)))
    return max(10, min(15, b))


def solo_radius_km(n_drivers_in_zone: int) -> float:
    n = max(0, int(n_drivers_in_zone))
    if n <= 5:
        return 1.1
    if n <= 15:
        return 0.8
    return 0.5


def solo_timeout_sec(acceptance_0_1: float, salt: int = 0) -> int:
    try:
        a = float(acceptance_0_1)
    except (TypeError, ValueError):
        a = 0.75
    a = max(0.0, min(1.0, a))
    h = abs(int(salt)) % 997
    if a >= 0.90:
        return 6 + (h % 3)
    if a >= 0.70:
        return 4 + (h % 2)
    return 2 + (h % 2)


def solo_eligible_for_window(row: Dict[str, Any], scoring: Dict[str, float]) -> bool:
    min_acc = float(scoring.get("dispatch_solo_min_accept", 0.70))
    min_rt = float(scoring.get("dispatch_solo_min_rating", 4.0))
    r, acc = _rating_acc(row)
    return acc >= min_acc and r >= min_rt


def _rating_acc(row: Dict[str, Any]) -> Tuple[float, float]:
    try:
        r = float(row.get("rating") or 4.5)
    except (TypeError, ValueError):
        r = 4.5
    try:
        ac = float(row.get("acceptance_rate") or 0.75)
    except (TypeError, ValueError):
        ac = 0.75
    return max(0.0, min(5.0, r)), max(0.0, min(1.0, ac))


def _norm_dist(dist_km: float, ref_km: float) -> float:
    ref = max(0.5, float(ref_km))
    return max(0.0, min(1.0, max(0.0, float(dist_km or 0.0)) / ref))


def _norm_load(completed_10h: int, ref_trips: float) -> float:
    ref = max(1.0, float(ref_trips))
    return max(0.0, min(1.0, max(0, int(completed_10h)) / ref))


def _norm_idle(idle_bonus: float) -> float:
    return max(0.0, min(1.0, float(idle_bonus or 0.0) / max(1e-6, IDLE_BONUS_MAX)))


def dispatch_match_score(
    row: Dict[str, Any],
    dist_km: float,
    completed_10h: int,
    idle_bonus: float,
    *,
    dist_weight: Optional[float] = None,
    load_per: Optional[float] = None,
    rating_weight: Optional[float] = None,
    accept_sq_weight: Optional[float] = None,
    extra_adj: float = 0.0,
    scoring: Optional[Dict[str, float]] = None,
) -> float:
    """
    Нормализованный скор: rating и acceptance в 0..1, км 0..1 от ref, нагрузка и idle 0..1.
    Веса rating_weight / accept_sq_weight / dist_weight / load_per — масштаб вклада.
    """
    r, acc = _rating_acc(row)
    try:
        rc = float(row.get("rating_coefficient") or 1.0)
    except (TypeError, ValueError):
        rc = 1.0
    rc = max(1.0, min(2.0, rc))

    sc = scoring or {}
    dist_ref = max(0.8, min(8.0, float(sc.get("dispatch_score_dist_ref_km", 4.0))))
    load_ref = max(2.0, min(24.0, float(sc.get("dispatch_score_load_ref_trips", 8.0))))

    r_n = r / 5.0
    a_n = acc**2
    d_n = _norm_dist(dist_km, dist_ref)
    load_n = _norm_load(completed_10h, load_ref)
    idle_n = _norm_idle(idle_bonus)

    if r < RATING_STRONG_PENALTY_BELOW:
        r_n -= min(r_n, (RATING_STRONG_PENALTY_BELOW - r) / 1.5 * RATING_STRONG_PENALTY_NORM)
    r_n = max(0.0, min(1.0, r_n))

    if acc < ACCEPT_SOFT_FLOOR:
        a_n -= (ACCEPT_SOFT_FLOOR - acc) * ACCEPT_SOFT_PENALTY_NORM
    a_n = max(0.0, min(1.0, a_n))

    rw = float(rating_weight if rating_weight is not None else 2.85)
    aw = float(accept_sq_weight if accept_sq_weight is not None else 2.35)
    dw = float(dist_weight if dist_weight is not None else DIST_WEIGHT_DEFAULT)
    lw = float(load_per if load_per is not None else LOAD_PER_COMPLETED_DEFAULT)
    iw = float(sc.get("dispatch_idle_score_weight", 0.55))

    coeff_term = (rc - 1.0) * COEFF_TERM_WEIGHT
    return (
        rw * r_n
        + aw * a_n
        + iw * idle_n
        + coeff_term
        + float(extra_adj)
        - dw * d_n
        - lw * load_n
    )


def sort_driver_ids_by_score(
    driver_ids: Sequence[int],
    dist_map: Dict[int, float],
    attrs: Dict[int, Dict[str, Any]],
    loads: Dict[int, int],
    idle_bonus_map: Dict[int, float],
    *,
    dist_weight: Optional[float] = None,
    load_per: Optional[float] = None,
    rating_weight: Optional[float] = None,
    accept_sq_weight: Optional[float] = None,
    extra_adj: Optional[Dict[int, float]] = None,
    scoring: Optional[Dict[str, float]] = None,
) -> List[int]:
    xm = extra_adj or {}
    scored: List[Tuple[float, int]] = []
    for did in driver_ids:
        row = attrs.get(int(did)) or {}
        dkm = float(dist_map.get(int(did), 99.0))
        adj = float(xm.get(int(did), 0.0))
        sc_val = dispatch_match_score(
            row,
            dkm,
            int(loads.get(int(did), 0)),
            float(idle_bonus_map.get(int(did), 0.0)),
            dist_weight=dist_weight,
            load_per=load_per,
            rating_weight=rating_weight,
            accept_sq_weight=accept_sq_weight,
            extra_adj=adj,
            scoring=scoring,
        )
        scored.append((sc_val, int(did)))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [d for _, d in scored]


def cap_wave_distance_if_close_good(
    cand: List[int],
    sorted_ids: Sequence[int],
    attrs: Dict[int, Dict[str, Any]],
    dist_map: Dict[int, float],
    scoring: Dict[str, float],
) -> List[int]:
    """
    Если есть «хороший» водитель ≤ near_km, в текущей волне не брать тех, кто дальше max_pick_km.
    """
    if not cand:
        return cand
    near_km = float(scoring.get("dispatch_near_good_km", 0.7))
    min_acc = float(scoring.get("dispatch_near_good_min_accept", 0.60))
    min_rt = float(scoring.get("dispatch_near_good_min_rating", 4.0))
    max_far = float(scoring.get("dispatch_wave_max_pick_km", 2.5))
    has_close = False
    for did in sorted_ids:
        di = int(did)
        row = attrs.get(di) or {}
        r, a = _rating_acc(row)
        if float(dist_map.get(di, 99.0)) <= near_km and a >= min_acc and r >= min_rt:
            has_close = True
            break
    if not has_close:
        return cand
    out = [int(d) for d in cand if float(dist_map.get(int(d), 99.0)) <= max_far]
    return out if out else cand


def pick_wave_from_sorted(sorted_ids: Sequence[int], seen: Set[int], quota: int) -> List[int]:
    if quota <= 0:
        return []
    out: List[int] = []
    for did in sorted_ids:
        di = int(did)
        if di in seen:
            continue
        out.append(di)
        if len(out) >= quota:
            break
    return out


def pick_tier_wave_candidates(
    tier: int,
    n: int,
    q1: int,
    q2: int,
    q3: int,
    seen: Set[int],
    sorted_ids: List[int],
) -> List[int]:
    if n <= 3:
        return [int(d) for d in sorted_ids if int(d) not in seen][: max(1, n)]
    if tier == 1:
        return pick_wave_from_sorted(sorted_ids, seen, q1)
    if tier == 2:
        return pick_wave_from_sorted(sorted_ids, seen, q2)
    return pick_wave_from_sorted(sorted_ids, seen, q3)


def take_from_pool_in_order(pool: Sequence[int], seen: Set[int], quota: int) -> List[int]:
    if quota <= 0:
        return []
    out: List[int] = []
    for did in pool:
        if int(did) in seen:
            continue
        out.append(int(did))
        if len(out) >= quota:
            break
    return out


def merge_pools_in_score_order(
    sorted_all: Sequence[int], p1: Sequence[int], p2: Sequence[int], p3: Sequence[int]
) -> List[int]:
    allow = {int(x) for x in p1} | {int(x) for x in p2} | {int(x) for x in p3}
    return [int(d) for d in sorted_all if int(d) in allow]
