"""
Structured-style логи поездки (одна строка, предсказуемые поля).
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

logger = logging.getLogger("taxi.trip")


def trip_log(
    message: str,
    *,
    trip_id: Optional[Any] = None,
    driver_id: Optional[Any] = None,
    client_id: Optional[Any] = None,
    state: Optional[str] = None,
    status: Optional[str] = None,
    latency_ms: Optional[float] = None,
    extra: Optional[str] = None,
) -> None:
    parts = [message]
    if trip_id is not None:
        parts.append(f"trip_id={trip_id}")
    if driver_id is not None:
        parts.append(f"driver_id={driver_id}")
    if client_id is not None:
        parts.append(f"client_id={client_id}")
    if state is not None:
        parts.append(f"state={state}")
    if status is not None:
        parts.append(f"status={status}")
    if latency_ms is not None:
        parts.append(f"latency_ms={latency_ms:.1f}")
    if extra:
        parts.append(extra)
    logger.info(" | ".join(parts))


def timed_ms() -> float:
    return time.perf_counter() * 1000.0
