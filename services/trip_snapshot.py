"""
Снимок поездки только из строки БД (без «угадывания» на фронте).
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from tools.realtime.events import safe_json


def trip_row_minimal(trip: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Минимальный набор для событий realtime / ответа API."""
    if not trip:
        return None
    return safe_json(
        {
            "trip_id": trip.get("trip_id"),
            "client_id": trip.get("client_id"),
            "driver_id": trip.get("driver_id"),
            "status": trip.get("status"),
            "state": trip.get("state"),
            "revision": trip.get("revision") or 1,
            "start_lat": trip.get("start_lat"),
            "start_lon": trip.get("start_lon"),
            "end_lat": trip.get("end_lat"),
            "end_lon": trip.get("end_lon"),
            "start_address": trip.get("start_address"),
            "end_address": trip.get("end_address"),
            "distance_km": float(trip["distance_km"] or 0) if trip.get("distance_km") is not None else None,
            "price": float(trip["price"] or 0) if trip.get("price") is not None else None,
        }
    )


def update_trip_state_event_payload(fresh_trip: Dict[str, Any]) -> Dict[str, Any]:
    """Тело события update_trip_state — только из fresh SELECT."""
    snap = trip_row_minimal(fresh_trip) or {}
    return {
        "type": "update_trip_state",
        "success": True,
        "message": "Состояние поездки изменено",
        "trip": {
            "state": snap.get("state"),
            "trip_id": snap.get("trip_id"),
            "client_id": snap.get("client_id"),
            "driver_id": snap.get("driver_id"),
            "status": snap.get("status"),
            "revision": snap.get("revision"),
        },
    }
