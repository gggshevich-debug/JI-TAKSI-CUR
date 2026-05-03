"""
Вся бизнес-логика команд, приходящих через Socket.IO (или тесты).
Socket.IO только вызывает dispatch_socket_message и отдаёт ACK.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, Optional, Tuple

from tools import models
from tools.realtime import events as rt_events
from tools import redis_client as rc
from tools.database import Database

logger = logging.getLogger(__name__)


async def _admin_emit_user_location(
    db: Database, hub, user_id: str, user_type: str, lat: Any, lng: Any
) -> None:
    if not hub or user_type not in ("driver", "client"):
        return
    try:
        uid = int(user_id)
        trip = None
        row: Optional[dict] = None
        if user_type == "driver":
            row = await db.get_driver(uid)
            trip = await _trip_for_live_location_driver(db, uid)
        else:
            row = await db.get_client(uid)
            trip = await _trip_for_live_location_client(db, uid)
        if not row:
            return
        name = f"{row.get('name') or ''} {row.get('surname') or ''}".strip()
        active = None
        if trip:
            active = {
                "trip_id": trip.get("trip_id"),
                "status": trip.get("status"),
                "driver_id": trip.get("driver_id"),
                "client_id": trip.get("client_id"),
            }
        payload = {
            "type": "admin_user_position",
            "user_type": user_type,
            "user_id": uid,
            "lat": float(lat),
            "lng": float(lng),
            "name": name,
            "rating": float(row.get("rating") or 0),
            "status": row.get("status") if user_type == "driver" else None,
            "active_trip": active,
        }
        await hub.emit_to_admins("admin_event", rt_events.safe_json(payload))
    except Exception:
        logger.exception("admin_emit_user_location")


def _hub_redis():
    from tools.realtime import get_hub

    return get_hub(), rc.get_redis()


async def _trip_for_live_location_driver(db: Database, driver_id: int) -> Optional[dict]:
    trip = await db.get_trips(driver_busy_trip=True, driver_id=driver_id)
    if trip:
        return trip
    return await db._execute(
        """
        SELECT * FROM trips
        WHERE driver_id = $1 AND status IN ('pending', 'accepted', 'offered')
        ORDER BY created_at DESC LIMIT 1
        """,
        (driver_id,),
        fetchone=True,
    )


async def _trip_for_live_location_client(db: Database, client_id: int) -> Optional[dict]:
    trip = await db.get_trips(client_busy_trip=True, client_id=client_id)
    if trip:
        return trip
    return await db._execute(
        """
        SELECT * FROM trips
        WHERE client_id = $1 AND status IN ('pending', 'accepted', 'offered', 'busy')
          AND driver_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
        """,
        (client_id,),
        fetchone=True,
    )


async def dispatch_socket_message(
    db: Database,
    data: dict,
    user_id: str,
    user_type: str,
) -> Optional[dict]:
    hub, redis_obj = _hub_redis()
    message_type = data.get("type")

    if message_type == "event_ack":
        eid = data.get("event_id")
        await rt_events.record_event_ack(redis_obj, str(eid))
        return rt_events.safe_json({"type": "event_ack_ok", "event_id": eid})

    if user_type == "driver":
        drow = await db.get_driver(int(user_id))
        if drow and (drow.get("is_banned") or drow.get("admin_disabled")):
            return {"type": "error", "message": "Аккаунт заблокирован администратором"}
    if user_type == "client":
        crow = await db.get_client(int(user_id))
        if crow and (crow.get("is_banned") or crow.get("admin_disabled")):
            return {"type": "error", "message": "Аккаунт заблокирован администратором"}

    handlers = {
        "location_update": _handle_location_update,
        "get_taxi_status": _handle_get_taxi_status,
        "get_map_radars": _handle_get_map_radars,
        "update_taxi_status": _handle_update_taxi_status,
        "get_price": _handle_get_price,
        "get_pending_trips": _handle_get_pending_trips,
        "get_client_trips": _handle_get_client_trips,
        "ping": _handle_ping,
        "sync_request": _handle_sync_request,
    }

    fn = handlers.get(message_type)
    if not fn:
        return {"type": "error", "message": f"Unknown message type: {message_type}"}

    result = await fn(db, hub, redis_obj, data, user_id, user_type)
    return rt_events.safe_json(result)


def _trip_row_to_pending_ws_trip(trip: Dict) -> Dict:
    return rt_events.safe_json(
        {
            "trip_id": trip["trip_id"],
            "client_id": trip["client_id"],
            "start_lat": trip["start_lat"],
            "start_lon": trip["start_lon"],
            "end_lat": trip["end_lat"],
            "end_lon": trip["end_lon"],
            "start_address": trip.get("start_address"),
            "end_address": trip.get("end_address"),
            "distance": float(trip["distance_km"]) if trip["distance_km"] else 0.0,
            "price": float(trip["price"]) if trip["price"] else 0.0,
            "client_name": trip["client_name"],
            "client_rating": float(trip["client_rating"]) if trip["client_rating"] else 0.0,
            "driving_time": trip.get("driving_time"),
            "revision": trip.get("revision") or 1,
        }
    )


async def _handle_location_update(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    lat = data.get("lat")
    lng = data.get("lng")
    if lat is None or lng is None:
        return {"type": "error", "message": "Missing lat or lng"}

    ts = int(time.time() * 1000)

    if user_type == "driver":
        await db.update_driver(driver_id=int(user_id), last_lat=lat, last_lon=lng)
        # Redis GEO — не чаще ~3 с на водителя (нагрузка + согласованность с 2–5 с на клиенте).
        geo_ok = True
        if redis_obj:
            try:
                geo_ok = bool(
                    await redis_obj.set(
                        f"geo:throttle:driver:{user_id}", "1", nx=True, ex=3
                    )
                )
            except Exception:
                geo_ok = True
        if geo_ok or not redis_obj:
            await rc.geo_update_driver(int(user_id), float(lng), float(lat))
        trip = await _trip_for_live_location_driver(db, int(user_id))
        if trip and trip.get("client_id"):
            peer = {
                "type": "trip_peer_location",
                "peer": "driver",
                "trip_id": trip["trip_id"],
                "lat": float(lat),
                "lng": float(lng),
                "server_ts": ts,
            }
            body = rt_events.enrich_outbound(peer, revision=trip.get("revision"), ack_required=False)
            await rt_events.notify_user(
                hub, redis_obj, "client", str(trip["client_id"]), "trip_peer_location", body
            )
        await _admin_emit_user_location(db, hub, user_id, user_type, lat, lng)
        return {"type": "location_updated", "lat": lat, "lng": lng}

    if user_type == "client":
        await db.update_client(client_id=int(user_id), last_lat=lat, last_lon=lng)
        trip = await _trip_for_live_location_client(db, int(user_id))
        if trip and trip.get("driver_id"):
            peer = {
                "type": "trip_peer_location",
                "peer": "client",
                "trip_id": trip["trip_id"],
                "lat": float(lat),
                "lng": float(lng),
                "server_ts": ts,
            }
            body = rt_events.enrich_outbound(peer, revision=trip.get("revision"), ack_required=False)
            await rt_events.notify_user(
                hub, redis_obj, "driver", str(trip["driver_id"]), "trip_peer_location", body
            )
        await _admin_emit_user_location(db, hub, user_id, user_type, lat, lng)
        return {"type": "location_updated", "lat": lat, "lng": lng}

    return {"type": "error", "message": "Only client or driver can update location"}


async def _handle_get_client_trips(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    if user_type == "client":
        trips_info = await db.get_trips(client_id=int(user_id), all_client_trips=True)
    elif user_type == "driver":
        trips_info = await db.get_trips(driver_id=int(user_id), all_driver_trips=True)
    else:
        return {"type": "error", "message": "Only clients and drivers can load trip history"}
    return {
        "type": "client_trips_for_profile",
        "profile": {"total_trips": len(trips_info), "trips": trips_info},
    }


async def _handle_get_taxi_status(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    if user_type != "driver":
        return {"type": "error", "message": "Only drivers have taxi status"}
    driver_info = await db.get_driver(int(user_id))
    if not driver_info:
        return {"type": "error", "message": "Driver not found"}
    return {
        "type": "taxi_status",
        "status": driver_info["status"],
        "driver_id": user_id,
        "rating": float(driver_info["rating"] or 0),
        "balance": float(driver_info["balance"] or 0),
    }


async def _handle_update_taxi_status(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    import datetime as dt

    if user_type != "driver":
        return {"type": "error", "message": "Only drivers can update taxi status"}
    status = data.get("status")
    if status not in models.DriverStatus.values():
        return {"type": "error", "message": "Invalid status"}
    update_data = {"status": status}
    lat, lng = data.get("lat"), data.get("lng")
    if lat is not None and lng is not None:
        coords = models.Coordinates.validate(lat, lng)
        if coords:
            update_data["last_lat"] = coords[0]
            update_data["last_lon"] = coords[1]
    await db.update_driver(driver_id=int(user_id), **update_data)
    if "last_lat" in update_data:
        await rc.geo_update_driver(int(user_id), float(update_data["last_lon"]), float(update_data["last_lat"]))
    try:
        await hub.emit_to_admins(
            "admin_event",
            rt_events.safe_json(
                {
                    "type": "admin_driver_status",
                    "driver_id": int(user_id),
                    "status": status,
                    "lat": update_data.get("last_lat"),
                    "lng": update_data.get("last_lon"),
                }
            ),
        )
    except Exception:
        logger.exception("emit admin_driver_status")
    return {
        "type": "taxi_status_updated",
        "status": status,
        "driver_id": user_id,
        "timestamp": dt.datetime.utcnow().isoformat(),
    }


async def _handle_get_price(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    p = await db.get_pricing_params()
    return {
        "type": "price_per_km",
        "price": p["price_per_km"],
        "price_per_km": p["price_per_km"],
        "trip_base_fee": p["trip_base_fee"],
    }


async def _handle_get_pending_trips(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    if user_type != "driver":
        return {"type": "error", "message": "Only drivers can get pending trips"}
    pending = await db.get_pending_trips_for_driver(int(user_id))
    return {
        "type": "pending_trips",
        "status": "pending",
        "trips": [_trip_row_to_pending_ws_trip(t) for t in pending],
    }


async def _handle_ping(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    return {"type": "pong"}


async def _handle_get_map_radars(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    try:
        with open("azerbaijan_radars.json", "r", encoding="utf-8") as f:
            radars = json.load(f)
        return {"type": "map_radars", "radars": radars}
    except Exception as e:
        return {"type": "error", "message": str(e)}


async def _handle_sync_request(
    db: Database, hub, redis_obj, data: dict, user_id: str, user_type: str
) -> dict:
    trip_id = data.get("trip_id")
    if not trip_id:
        return {"ok": True, "snapshot": None}
    trip = await db.get_trips(trip_id=int(trip_id))
    if not trip:
        return {"ok": False, "error": "trip_not_found"}
    uid = int(user_id)
    if trip.get("client_id") != uid and trip.get("driver_id") != uid:
        return {"ok": False, "error": "forbidden"}
    last_rev = data.get("last_revision")
    if last_rev is not None and int(trip.get("revision") or 1) == int(last_rev):
        return {"ok": True, "snapshot": None, "unchanged": True}
    return {
        "ok": True,
        "snapshot": {"trip": trip, "revision": trip.get("revision") or 1},
    }
