"""
Единая точка смены trips.state (FSM) + лог + снимок из БД после любого шага.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, Optional

from tools import trip_fsm
from tools.database import Database
from tools.trip_enums import normalize_leg_state
from tools import trip_logging

logger = logging.getLogger("taxi.fsm")


async def _append_state_change_log(
    db: Database,
    *,
    trip_id: int,
    from_state: Optional[str],
    to_state: Optional[str],
    ok: bool,
    latency_ms: float,
    source: str,
    actor_user_id: Optional[int],
    error_message: Optional[str],
    debug: Optional[Dict[str, Any]],
) -> None:
    dbg = json.dumps(debug if debug is not None else {}, default=str)
    try:
        await db._execute(
            """
            INSERT INTO trip_state_changes
                (trip_id, from_state, to_state, ok, latency_ms, source, actor_user_id, error_message, debug)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
            """,
            (
                trip_id,
                from_state,
                to_state,
                ok,
                latency_ms,
                (source[:64] if source else None),
                actor_user_id,
                error_message[:500] if error_message else None,
                dbg,
            ),
        )
    except Exception as e:
        logger.warning("trip_state_changes insert skip: %s", e)


async def transition_trip_leg_state(
    db: Database,
    redis,
    *,
    trip_id: int,
    to_state: str,
    source: str = "api",
    actor_user_id: Optional[int] = None,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Любое изменение trips.state — только через эту функцию.
    Возвращает dict: ok, code, http_status, message, snapshot (из БД), debug (для фронта).
    """
    t0 = time.perf_counter()
    to_n = normalize_leg_state(to_state)
    debug: Dict[str, Any] = {"trip_id": trip_id, "requested_to": to_n, "source": source}

    trip = await db.get_trips(trip_id=trip_id)
    if not trip:
        debug["reason"] = "trip_not_found"
        await _append_state_change_log(
            db,
            trip_id=trip_id,
            from_state=None,
            to_state=to_n,
            ok=False,
            latency_ms=(time.perf_counter() - t0) * 1000,
            source=source,
            actor_user_id=actor_user_id,
            error_message="not_found",
            debug=debug,
        )
        return {
            "ok": False,
            "code": "not_found",
            "http_status": 404,
            "message": "Поездка не найдена",
            "snapshot": None,
            "debug": debug,
        }

    from_n = normalize_leg_state(trip.get("state"))
    debug["from_state"] = from_n

    if idempotency_key and redis:
        ik = f"idem:trip_state:{trip_id}:{idempotency_key}"
        try:
            prev = await redis.get(ik)
            if prev:
                fresh = await db.get_trips(trip_id=trip_id) or trip
                debug["reason"] = "idempotent_repeat"
                return {
                    "ok": True,
                    "code": "duplicate",
                    "http_status": 200,
                    "message": "Идемпотентный повтор",
                    "snapshot": fresh,
                    "debug": debug,
                }
        except Exception as e:
            logger.debug("idem trip_state read: %s", e)

    if from_n == to_n:
        fresh = await db.get_trips(trip_id=trip_id) or trip
        debug["reason"] = "no_change"
        await _append_state_change_log(
            db,
            trip_id=trip_id,
            from_state=from_n,
            to_state=to_n,
            ok=True,
            latency_ms=(time.perf_counter() - t0) * 1000,
            source=source,
            actor_user_id=actor_user_id,
            error_message=None,
            debug=debug,
        )
        return {
            "ok": True,
            "code": "nochange",
            "http_status": 200,
            "message": "Состояние без изменений",
            "snapshot": fresh,
            "debug": debug,
        }

    if not trip_fsm.can_transition(from_n, to_n):
        debug["reason"] = "forbidden_transition"
        debug["allowed_from"] = from_n
        msg = f"Недопустимый переход: {from_n!r} → {to_n!r}"
        trip_logging.trip_log(
            "fsm_forbidden",
            trip_id=trip_id,
            state=from_n,
            extra=f"to={to_n} source={source}",
        )
        await _append_state_change_log(
            db,
            trip_id=trip_id,
            from_state=from_n,
            to_state=to_n,
            ok=False,
            latency_ms=(time.perf_counter() - t0) * 1000,
            source=source,
            actor_user_id=actor_user_id,
            error_message=msg,
            debug=debug,
        )
        return {
            "ok": False,
            "code": "forbidden",
            "http_status": 400,
            "message": msg,
            "snapshot": trip,
            "debug": debug,
        }

    st_row = await db.try_update_trip_state(trip_id, from_n, to_n)
    if not st_row:
        fresh = await db.get_trips(trip_id=trip_id) or trip
        debug["reason"] = "optimistic_lock_conflict"
        debug["current_state"] = normalize_leg_state(fresh.get("state"))
        await _append_state_change_log(
            db,
            trip_id=trip_id,
            from_state=from_n,
            to_state=to_n,
            ok=False,
            latency_ms=(time.perf_counter() - t0) * 1000,
            source=source,
            actor_user_id=actor_user_id,
            error_message="state_conflict",
            debug=debug,
        )
        return {
            "ok": False,
            "code": "conflict",
            "http_status": 409,
            "message": "Состояние поездки изменилось, обновите экран",
            "snapshot": fresh,
            "debug": debug,
        }

    if idempotency_key and redis:
        try:
            await redis.setex(f"idem:trip_state:{trip_id}:{idempotency_key}", 3600, "1")
        except Exception as e:
            logger.debug("idem trip_state set: %s", e)

    fresh = await db.get_trips(trip_id=trip_id) or st_row
    lat_ms = (time.perf_counter() - t0) * 1000
    trip_logging.trip_log(
        "fsm_transition",
        trip_id=trip_id,
        driver_id=fresh.get("driver_id"),
        client_id=fresh.get("client_id"),
        state=fresh.get("state"),
        latency_ms=lat_ms,
        extra=f"{from_n}→{to_n} source={source}",
    )
    await _append_state_change_log(
        db,
        trip_id=trip_id,
        from_state=from_n,
        to_state=to_n,
        ok=True,
        latency_ms=lat_ms,
        source=source,
        actor_user_id=actor_user_id,
        error_message=None,
        debug=debug,
    )
    return {
        "ok": True,
        "code": "ok",
        "http_status": 200,
        "message": "Состояние поездки изменено",
        "snapshot": fresh,
        "debug": {**debug, "applied": f"{from_n}→{to_n}"},
    }
