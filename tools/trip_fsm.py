"""
Переходы trips.state (строго вперёд). См. tools.trip_enums.TripLegState.
"""
from __future__ import annotations

from typing import FrozenSet, Optional

from tools.trip_enums import TripLegState as S

_ALLOWED: dict[str, FrozenSet[str]] = {
    S.PENDING_CONFIRM.value: frozenset({S.EN_ROUTE.value}),
    S.EN_ROUTE.value: frozenset(
        {
            S.PENDING_CONFIRM.value,
            S.DRIVER_ARRIVED.value,
            S.CANCEL_CLIENT.value,
            S.CANCEL_DRIVER.value,
        }
    ),
    S.DRIVER_ARRIVED.value: frozenset(
        {S.ONBOARD.value, S.CANCEL_CLIENT.value, S.CANCEL_DRIVER.value}
    ),
    S.ONBOARD.value: frozenset(
        {S.IN_PROGRESS.value, S.CANCEL_CLIENT.value, S.CANCEL_DRIVER.value}
    ),
    S.IN_PROGRESS.value: frozenset(
        {
            S.AT_DESTINATION.value,
            S.PAUSED.value,
            S.CANCEL_CLIENT.value,
            S.CANCEL_DRIVER.value,
        }
    ),
    S.PAUSED.value: frozenset(
        {S.IN_PROGRESS.value, S.CANCEL_CLIENT.value, S.CANCEL_DRIVER.value}
    ),
    S.AT_DESTINATION.value: frozenset(
        {S.FINISHED.value, S.CANCEL_CLIENT.value, S.CANCEL_DRIVER.value}
    ),
    S.FINISHED.value: frozenset(),
    S.CANCEL_CLIENT.value: frozenset(),
    S.CANCEL_DRIVER.value: frozenset(),
}


def can_transition(old: Optional[str], new: str) -> bool:
    if not new:
        return False
    if old == new:
        return True
    o = old or S.PENDING_CONFIRM.value
    allowed = _ALLOWED.get(o)
    if allowed is None:
        return False
    return new in allowed
