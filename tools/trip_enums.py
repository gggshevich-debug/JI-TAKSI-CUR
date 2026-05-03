"""
Единые строковые enum поездки: lifecycle (trips.status) и фаза маршрута (trips.state).
Использовать в backend и валидаторах; фронт — static/js/tripEnums.js.
"""
from __future__ import annotations

from enum import Enum


class TripLifecycleStatus(str, Enum):
    """Статус заказа в trips.status."""

    PENDING = "pending"
    OFFERED = "offered"
    ACCEPTED = "accepted"
    BUSY = "busy"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class TripLegState(str, Enum):
    """Фаза поездки в trips.state (маршрут / UI)."""

    PENDING_CONFIRM = "pending_confirm"
    EN_ROUTE = "en_route"
    DRIVER_ARRIVED = "driver_arrived"
    ONBOARD = "onboard"
    IN_PROGRESS = "in_progress"
    PAUSED = "paused"
    AT_DESTINATION = "at_destination"
    FINISHED = "finished"
    CANCEL_CLIENT = "cancel_client"
    CANCEL_DRIVER = "cancel_driver"


# Миграция со старых значений (до выравнивания)
LEG_STATE_LEGACY_MAP: dict[str, str] = {
    "waiting": TripLegState.DRIVER_ARRIVED.value,
    "progress": TripLegState.IN_PROGRESS.value,
    "arrived": TripLegState.AT_DESTINATION.value,
    "done": TripLegState.FINISHED.value,
}


def normalize_leg_state(value: str | None) -> str:
    if not value:
        return TripLegState.PENDING_CONFIRM.value
    v = str(value).strip()
    return LEG_STATE_LEGACY_MAP.get(v, v)
