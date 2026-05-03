# ============================================
# SERVER.PY - Refactored
# ============================================

from pathlib import Path
from dotenv import load_dotenv
import os

load_dotenv(Path(__file__).resolve().parent / ".env")


def _env_bool_positive(name: str, default: bool = True) -> bool:
    """True если включено (пусто/1/true/yes/on); False при 0/false/no/off/disabled."""
    v = os.getenv(name)
    if v is None or str(v).strip() == "":
        return default
    return str(v).strip().lower() not in ("0", "false", "no", "off", "disabled")


from fastapi import FastAPI, Depends, Request, Query, HTTPException, Response, BackgroundTasks
from pydantic import BaseModel, Field
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager
import asyncio
from starlette.middleware.sessions import SessionMiddleware
from itsdangerous import URLSafeTimedSerializer
from decimal import Decimal
import datetime
import uvicorn
import httpx
import json
import re
import logging

# Локальные модули
from tools import map_tools 
from tools.database import Database
from tools import models
from tools.realtime import (
    enrich_outbound,
    get_hub,
    mount_socketio,
    notify_user,
    redis_subscriber_loop,
)
from tools.realtime.events import idempotency_mark, idempotency_seen
from tools import redis_client as redis_c
from tools import dispatch_service
from tools import booking
from tools.trip_enums import normalize_leg_state
from tools import trip_logging
from tools import admin_router
from tools import pwa_push
from tools import push_notifications
from tools import az_card_bins
from services.state_machine import transition_trip_leg_state
from services.trip_snapshot import update_trip_state_event_payload

# ============================================
# КОНФИГУРАЦИЯ
# ============================================

SECRET_KEY = os.getenv("SECRET_KEY")
SESSION_SALT = os.getenv("SESSION_SALT")

if not SECRET_KEY or not SESSION_SALT:
    raise ValueError("SECRET_KEY and SESSION_SALT must be set in environment")

# OSRM (см. .env: OSRM_ROUTE_URL / OSRM_TABLE_URL)
OSRM_ROUTE_URL = os.getenv(
    "OSRM_ROUTE_URL",
    "http://127.0.0.1:9000/route/v1/driving",
).rstrip("/")
OSRM_TABLE_URL = os.getenv(
    "OSRM_TABLE_URL",
    "http://127.0.0.1:9000/table/v1/driving",
).rstrip("/")

# Nominatim (локальный Docker или публичный URL; фронт ходит на /nominatim/* — без CORS)
NOMINATIM_BACKEND_URL = os.getenv(
    "NOMINATIM_BACKEND_URL",
    "http://127.0.0.1:8080",
).rstrip("/")
NOMINATIM_HTTP_USER_AGENT = os.getenv(
    "NOMINATIM_HTTP_USER_AGENT",
    "JI-TAKSI/1.0 (nominatim proxy)",
)
NOMINATIM_ENABLED = _env_bool_positive("NOMINATIM_ENABLED", True)

# Сериализатор для сессий
serializer = URLSafeTimedSerializer(SECRET_KEY, salt=SESSION_SALT)
db = Database()
admin_router.init_admin_db(db)
pwa_push.init_pwa_push(serializer, db)

_dispatch_stop = asyncio.Event()
_bg_tasks: list = []


async def _dispatch_wave_loop():
    while not _dispatch_stop.is_set():
        try:
            await asyncio.sleep(5)
            await dispatch_service.process_expired_waves(db, get_hub(), redis_c.get_redis())
        except asyncio.CancelledError:
            break
        except Exception as e:
            logging.exception("dispatch_wave_loop: %s", e)


PEER_RATING_AGGREGATE_DELAY_SEC = 120.0


async def _deferred_peer_rating_aggregate(
    database: Database,
    rated_role: str,
    rated_user_id: int,
    stars: float,
) -> None:
    """Через 2 мин обновляет агрегированный рейтинг оценённой стороны (таблицы clients / drivers)."""
    await asyncio.sleep(PEER_RATING_AGGREGATE_DELAY_SEC)
    try:
        await database.apply_peer_aggregate_rating_roll(
            rated_role, int(rated_user_id), float(stars)
        )
    except Exception:
        logging.exception(
            "deferred peer aggregate: role=%s id=%s stars=%s",
            rated_role,
            rated_user_id,
            stars,
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager"""
    global _bg_tasks
    await db.connect()
    await redis_c.init_redis()
    print("[Server] Database connected")
    _dispatch_stop.clear()
    hub = get_hub()
    t_sub = asyncio.create_task(
        redis_subscriber_loop(hub, redis_c.get_redis(), _dispatch_stop)
    )
    t_dispatch = asyncio.create_task(_dispatch_wave_loop())
    _bg_tasks = [t_sub, t_dispatch]
    yield
    _dispatch_stop.set()
    for t in _bg_tasks:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    _bg_tasks.clear()
    await db.close()
    await redis_c.close_redis()
    print("[Server] Database closed")

fastapi_app = FastAPI(lifespan=lifespan)

# Middleware
fastapi_app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    session_cookie="taxi_session",
    https_only=False,  # TODO: True в продакшене
    max_age=3600*24*30,
    same_site="lax"
)

# Static files
fastapi_app.mount("/static", StaticFiles(directory="static"), name="static")

fastapi_app.include_router(admin_router.router)
fastapi_app.include_router(pwa_push.router)


def _compute_static_asset_version() -> str:
    """Целое число для ?v= в ссылках на локальные JS/CSS — меняется при правках статики или шаблона главной."""
    root = Path(__file__).resolve().parent
    mtimes: list[float] = []
    index_tpl = root / "templates" / "index.html"
    if index_tpl.is_file():
        try:
            mtimes.append(index_tpl.stat().st_mtime)
        except OSError:
            pass
    for sub in ("static/js", "static/css"):
        d = root / sub
        if not d.is_dir():
            continue
        for f in d.rglob("*"):
            if not f.is_file():
                continue
            if f.suffix.lower() not in (".js", ".css"):
                continue
            try:
                mtimes.append(f.stat().st_mtime)
            except OSError:
                continue
    return str(int(max(mtimes))) if mtimes else "0"


STATIC_ASSET_VERSION = _compute_static_asset_version()

templates = Jinja2Templates(directory="templates")


@fastapi_app.get("/sw.js")
async def pwa_service_worker():
    """Service Worker с корня сайта — область действия «/», не «/static/»."""
    return FileResponse(
        "static/service-worker.js",
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

# ============================================
# HTTP ENDPOINTS
# ============================================

def json_serializer(obj):
    """JSON serializer для Decimal и datetime"""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, datetime.datetime):
        return obj.isoformat()
    return str(obj)


def client_photo_for_peer_sharing(client_row: Optional[Dict[str, Any]]) -> Optional[Any]:
    """Фото клиента для водителя / сокета — скрывается при включённой анонимности."""
    if not client_row:
        return None
    if client_row.get("anonymous_profile"):
        return None
    return client_row.get("photo") or client_row.get("face_photo")


async def _trip_socket_price(db: Database, trip: Dict[str, Any]) -> float:
    try:
        sp = float(trip.get("price") or 0)
    except (TypeError, ValueError):
        sp = 0.0
    if sp > 0:
        return sp
    try:
        dkm = float(trip.get("distance_km") or 0)
    except (TypeError, ValueError):
        dkm = 0.0
    return await db.trip_quote_amount(dkm)


def _trip_restore_phase(trip: Dict[str, Any], user_type: str, user_id: int) -> str:
    st = (trip.get("status") or "").lower()
    did = trip.get("driver_id")
    uid = int(user_id)
    if user_type == "client":
        if st in ("pending", "offered") and not did:
            return "searching"
        if st == "accepted" and did:
            return "assigned"
        if st == "busy" and did:
            # Уже оценил водителя — не восстанавливать «активную» поездку после перезагрузки/реконнекта.
            if trip.get("post_trip_driver_stars") is not None:
                return "none"
            return "confirmed"
    if user_type == "driver":
        if st == "offered" and not did:
            return "incoming"
        if st in ("accepted", "busy") and did and int(did) == uid:
            if trip.get("post_trip_client_stars") is not None:
                return "none"
            return "confirmed"
    return "none"


async def build_frontend_trip_restore_payload(db: Database, trip: Dict[str, Any]) -> Dict[str, Any]:
    """Плоский объект поездки для confirmationTrip / showTripOrder (как с сокета)."""
    tid = trip.get("trip_id")
    cid = trip.get("client_id")
    did = trip.get("driver_id")

    def _flt(x, default=0.0):
        try:
            return float(x)
        except (TypeError, ValueError):
            return default

    client_info = await db.get_client(int(cid)) if cid else None
    driver_info = await db.get_driver(int(did)) if did else None

    dkm = _flt(trip.get("distance_km"))
    try:
        stored_p = float(trip.get("price") or 0)
    except (TypeError, ValueError):
        stored_p = 0.0
    if stored_p > 0:
        price_s = f"{stored_p:.2f}"
    else:
        price_s = f"{await db.trip_quote_amount(dkm):.2f}"

    out: Dict[str, Any] = {
        "trip_id": tid,
        "client_id": cid,
        "driver_id": did,
        "status": trip.get("status"),
        "state": trip.get("state"),
        "start_lat": _flt(trip.get("start_lat")),
        "start_lon": _flt(trip.get("start_lon")),
        "end_lat": _flt(trip.get("end_lat")),
        "end_lon": _flt(trip.get("end_lon")),
        "start_address": trip.get("start_address") or "",
        "end_address": trip.get("end_address") or "",
        "distance": dkm,
        "driving_time": trip.get("driving_time") or "",
        "price": price_s,
    }

    if client_info:
        out["client_name"] = trip.get("client_name") or (
            f"{(client_info.get('surname') or '')[:1]}. {client_info.get('name') or ''}"
        )
        out["client_rating"] = json_serializer(client_info.get("rating"))
        out["client_phone"] = client_info.get("phone")
        out["client_avatar"] = client_photo_for_peer_sharing(client_info)
    if driver_info:
        out["taxi_lat"] = _flt(driver_info.get("last_lat"), _flt(trip.get("start_lat")))
        out["taxi_lon"] = _flt(driver_info.get("last_lon"), _flt(trip.get("start_lon")))
        out["taxi_name"] = f"{(driver_info.get('surname') or '')[:1]}. {driver_info.get('name') or ''}"
        out["taxi_phone"] = driver_info.get("phone")
        out["taxi_rating"] = json_serializer(driver_info.get("rating"))
        out["taxi_car_name"] = driver_info.get("car_name")
        out["taxi_car_number"] = driver_info.get("car_number")
        out["taxi_car_year"] = driver_info.get("car_year")
        out["taxi_car_category"] = driver_info.get("car_category")
        out["taxi_car_model"] = driver_info.get("car_name")
        out["taxi_car_photo"] = driver_info.get("car_front_photo")
        out["taxi_avatar"] = driver_info.get("face_photo")
    else:
        out["taxi_lat"] = _flt(trip.get("start_lat"))
        out["taxi_lon"] = _flt(trip.get("start_lon"))
    return out


@fastapi_app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Главная страница"""
    session_token = request.cookies.get("taxi_session")
    user_display_status = "none"
    
    if session_token:
        user_data = models.get_user_from_token(serializer, session_token)
        
        if user_data and user_data["user_type"] == "driver":
            user_display_status = "flex"

    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "userDisplayStatus": user_display_status,
            "static_v": STATIC_ASSET_VERSION,
        },
    )

@fastapi_app.get("/api/session-token")
async def get_session_token(request: Request):
    """Получение session token для WebSocket"""
    session_token = request.cookies.get("taxi_session")
    
    if session_token:
        return {"token": session_token}
    else:
        raise HTTPException(status_code=401, detail="No session found")

@fastapi_app.post("/api/logout")
async def logout(request: Request):
    """Выход из системы"""
    response = JSONResponse({
        "success": True,
        "message": "Вы успешно вышли из системы"
    })
    response.delete_cookie(key="taxi_session", path="/")
    return response

# Продолжение в следующем файле...
# ============================================
# SERVER.PY - Part 2: API Endpoints
# ============================================
# (Продолжение файла server-refactored-part1.py)

# ... (предыдущий код)

# ============================================
# USER API
# ============================================

@fastapi_app.post("/api/me")
async def get_current_user(request: Request):
    """Получение информации о текущем пользователе"""
    session_token = request.cookies.get("taxi_session")
    
    if not session_token:
        return JSONResponse(
            {"success": False, "message": "Не авторизован"},
            status_code=401
        )
    
    user_data = models.get_user_from_token(serializer, session_token)
    
    if not user_data:
        return JSONResponse(
            {"success": False, "message": "Сессия недействительна"},
            status_code=401
        )
    
    user_id = user_data["user_id"]
    user_type = user_data["user_type"]
    
    try:
        if user_type == "client":
            client = await db.get_client(user_id)
            
            if not client:
                raise HTTPException(status_code=404, detail="Client not found")

            if client.get("is_banned") or client.get("admin_disabled"):
                resp = JSONResponse(
                    {
                        "success": False,
                        "message": "Аккаунт заблокирован или деактивирован.",
                        "code": "account_blocked",
                    },
                    status_code=403,
                )
                resp.delete_cookie(key="taxi_session", path="/")
                return resp

            return {
                "success": True,
                "user_type": "client",
                "user": {
                    "id": client["client_id"],
                    "name": client["name"],
                    "surname": client["surname"],
                    "phone": client["phone"],
                    "email": client.get("email"),
                    "photo": client.get("photo"),
                    "rating": float(client["rating"]),
                    "balance": float(client["balance"]),
                    "joined_at": client["created_at"],
                    "anonymous_profile": bool(client.get("anonymous_profile")),
                },
            }
        
        elif user_type == "driver":
            driver = await db.get_driver(user_id)
            
            if not driver:
                raise HTTPException(status_code=404, detail="Driver not found")

            if driver.get("is_banned") or driver.get("admin_disabled"):
                resp = JSONResponse(
                    {
                        "success": False,
                        "message": "Аккаунт заблокирован или деактивирован.",
                        "code": "account_blocked",
                    },
                    status_code=403,
                )
                resp.delete_cookie(key="taxi_session", path="/")
                return resp

            try:
                acceptance_rate = float(driver.get("acceptance_rate") or 0.75)
            except (TypeError, ValueError):
                acceptance_rate = 0.75
            
            return {
                "success": True,
                "user_type": "driver",
                "user": {
                    "id": driver["driver_id"],
                    "name": driver["name"],
                    "surname": driver["surname"],
                    "phone": driver["phone"],
                    "email": driver.get("email"),
                    "rating": float(driver["rating"]),
                    "ratio": float(driver["rating_coefficient"]),
                    "acceptance_rate": acceptance_rate,
                    "balance": float(driver["balance"]),
                    "car_name": driver["car_name"],
                    "car_year": driver["car_year"],
                    "car_category": driver["car_category"],
                    "car_number": driver["car_number"],
                    "car_tech_passport": driver.get("car_tech_passport"),
                    "driver_license": driver.get("driver_license"),
                    "car_front_photo": driver["car_front_photo"],
                    "avatar": driver.get("face_photo"),
                    "face_photo": driver.get("face_photo"),
                    "status": driver["status"],
                    "joined_at": driver["created_at"],
                    "verification": driver["verification"],
                },
            }
    
    except Exception as e:
        print(f'[API] Error getting user: {e}')
        return JSONResponse(
            {"success": False, "message": "Internal error"},
            status_code=500
        )
    
    return JSONResponse(
        {"success": False, "message": "Пользователь не найден"},
        status_code=404
    )


class MeDeviceReportBody(BaseModel):
    screen: Optional[str] = Field(None, max_length=48)
    platform: Optional[str] = Field(None, max_length=24)
    lang: Optional[str] = Field(None, max_length=48)


def _normalize_me_device_platform(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s:
        return None
    if s in ("ios", "iphone", "ipad", "ipod"):
        return "ios"
    if s in ("android",):
        return "android"
    if s in ("web", "browser", "pwa", "desktop"):
        return "web"
    return s[:16]


@fastapi_app.post("/api/me/device")
async def api_me_device_report(request: Request, body: MeDeviceReportBody):
    """Сохранение метаданных устройства (экран, ОС, язык) для клиента/водителя."""
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        return JSONResponse({"success": False, "message": "Не авторизован"}, status_code=401)
    user_data = models.get_user_from_token(serializer, session_token)
    if not user_data:
        return JSONResponse({"success": False, "message": "Сессия недействительна"}, status_code=401)
    uid = int(user_data["user_id"])
    ut = str(user_data.get("user_type") or "")
    kwargs: Dict[str, Any] = {}
    if body.screen is not None:
        t = str(body.screen).strip()[:32]
        kwargs["device_screen"] = t or None
    if body.platform is not None:
        kwargs["device_platform"] = _normalize_me_device_platform(body.platform)
    if body.lang is not None:
        t = str(body.lang).strip()[:32]
        kwargs["device_lang"] = t or None
    if not kwargs:
        return {"success": True}
    if ut == "client":
        await db.update_client(uid, **kwargs)
    elif ut == "driver":
        await db.update_driver(uid, **kwargs)
    else:
        return JSONResponse({"success": False, "message": "Неподдерживаемый тип пользователя"}, status_code=400)
    return {"success": True}


class DriverWithdrawalCreateBody(BaseModel):
    amount: float = Field(..., gt=0, le=9_999_999)
    card: str = Field(..., min_length=16, max_length=40)


def _money_decimal_2(v: Any) -> Decimal:
    """Сравнение баланса и суммы вывода без ошибок float."""
    try:
        return Decimal(str(v)).quantize(Decimal("0.01"))
    except Exception:
        return Decimal("0")


def _session_from_cookie(request: Request) -> Optional[Dict[str, Any]]:
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        return None
    return models.get_user_from_token(serializer, session_token)


async def _api_withdrawals_list(request: Request):
    """Список заявок на вывод (только водитель, cookie-сессия)."""
    ud = _session_from_cookie(request)
    if not ud or ud.get("user_type") != "driver":
        return JSONResponse(
            {"success": False, "message": "Только для водителя"},
            status_code=401,
        )
    try:
        items = await db.driver_list_withdrawals(int(ud["user_id"]), limit=50)
        return {"success": True, "items": items}
    except Exception as e:
        logging.getLogger(__name__).exception("withdrawals list: %s", e)
        return JSONResponse(
            {"success": False, "message": "Ошибка сервера"},
            status_code=500,
        )


async def _api_withdrawals_create(request: Request, body: DriverWithdrawalCreateBody):
    ud = _session_from_cookie(request)
    if not ud or ud.get("user_type") != "driver":
        return JSONResponse(
            {"success": False, "message": "Только для водителя"},
            status_code=401,
        )
    digits = re.sub(r"\D", "", body.card or "")
    if len(digits) != 16:
        return JSONResponse(
            {"success": False, "message": "Kart nömrəsi 16 rəqəm olmalıdır."},
            status_code=400,
        )
    if not az_card_bins.is_az_bank_card_digits(digits):
        return JSONResponse(
            {"success": False, "message": "Yalnız Azərbaycan bank kartları qəbul olunur."},
            status_code=400,
        )
    driver_id = int(ud["user_id"])
    drv = await db.get_driver(driver_id)
    if not drv:
        return JSONResponse({"success": False, "message": "Водитель не найден"}, status_code=404)
    if drv.get("is_banned") or drv.get("admin_disabled"):
        return JSONResponse(
            {"success": False, "message": "Hesab bloklanıb."},
            status_code=403,
        )
    amt_dec = _money_decimal_2(body.amount)
    bal_dec = _money_decimal_2(drv.get("balance") or 0)
    if amt_dec > bal_dec:
        return JSONResponse(
            {"success": False, "message": "Balans kifayət deyil."},
            status_code=400,
        )
    amt = float(amt_dec)
    try:
        res = await db.driver_create_withdrawal_request(
            driver_id,
            amt,
            digits[:6],
            digits[-4:],
        )
    except Exception as e:
        logging.getLogger(__name__).exception("withdrawal create: %s", e)
        return JSONResponse(
            {"success": False, "message": "Ошибка сервера"},
            status_code=500,
        )
    if not res:
        return JSONResponse(
            {"success": False, "message": "Balans kifayət deyil və ya əməliyyat mümkün deyil."},
            status_code=400,
        )
    wid = int(res["id"])
    try:
        await push_notifications.send_event_push(
            db,
            "driver",
            driver_id,
            "driver_withdraw_submitted",
            {
                "withdrawal_id": str(wid),
                "amount": f"{amt:.2f}".rstrip("0").rstrip("."),
            },
            url="/",
        )
    except Exception:
        logging.getLogger(__name__).exception("withdrawal push submitted")
    return {
        "success": True,
        "withdrawal": res,
        "balance": float(res["balance"]),
    }


@fastapi_app.get("/api/driver/withdrawals")
async def api_driver_withdrawals_list(request: Request):
    return await _api_withdrawals_list(request)


@fastapi_app.get("/api/me/withdrawals")
async def api_me_withdrawals_list(request: Request):
    """Тот же список, что /api/driver/withdrawals — удобнее за прокси и кэшами."""
    return await _api_withdrawals_list(request)


@fastapi_app.post("/api/driver/withdrawals")
async def api_driver_withdrawals_create(request: Request, body: DriverWithdrawalCreateBody):
    return await _api_withdrawals_create(request, body)


@fastapi_app.post("/api/me/withdrawals")
async def api_me_withdrawals_create(request: Request, body: DriverWithdrawalCreateBody):
    """Тот же приём заявки, что POST /api/driver/withdrawals."""
    return await _api_withdrawals_create(request, body)


_PROFILE_BLOB_MAX = 8_000_000


def _strip_data_url_b64(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if "base64," in s:
        return s.split("base64,", 1)[1].strip()
    return s


def _check_b64_len(field: str, s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    if len(s) > _PROFILE_BLOB_MAX:
        raise ValueError(f"{field}: слишком большой файл")
    return s


@fastapi_app.post("/api/me/profile")
async def update_me_profile(request: Request, payload: models.MeProfileUpdate):
    """Частичное обновление профиля (только разрешённые поля, без системных)."""
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        return JSONResponse(
            {"success": False, "message": "Не авторизован"},
            status_code=401,
        )
    user_data = models.get_user_from_token(serializer, session_token)
    if not user_data:
        return JSONResponse(
            {"success": False, "message": "Сессия недействительна"},
            status_code=401,
        )

    uid = int(user_data["user_id"])
    user_type = user_data["user_type"]
    incoming = payload.model_dump(exclude_unset=True)
    if not incoming:
        return {"success": False, "message": "Нет полей для обновления"}

    if user_type == "client":
        allowed = {
            "name",
            "surname",
            "phone",
            "email",
            "new_password",
            "photo",
            "anonymous_profile",
        }
    elif user_type == "driver":
        allowed = {
            "name",
            "surname",
            "phone",
            "email",
            "new_password",
            "car_name",
            "car_year",
            "car_number",
            "car_tech_passport",
            "driver_license",
            "car_front_photo",
            "driver_license_photo",
            "car_tech_photo",
            "face_photo",
        }
    else:
        return JSONResponse(
            {"success": False, "message": "Неподдерживаемая роль"},
            status_code=400,
        )

    patch: Dict[str, Any] = {}
    try:
        for key in list(incoming.keys()):
            if key not in allowed:
                continue
            val = incoming[key]
            if key == "new_password":
                if val is not None and str(val).strip():
                    pwd = str(val).strip()
                    if len(pwd) < 6:
                        return {"success": False, "message": "Пароль минимум 6 символов"}
                    patch["password"] = pwd
                continue
            if key == "anonymous_profile":
                if user_type != "client":
                    continue
                if val is not None:
                    patch["anonymous_profile"] = bool(val)
                continue
            if key == "phone":
                if not val or not str(val).strip():
                    continue
                ph = str(val).strip()
                if not re.match(r"^\d{2} \d{3} \d{2}-\d{2}$", ph):
                    return {"success": False, "message": "Неверный формат телефона"}
                full_phone = f"+994 {ph}"
                if user_type == "client":
                    row = await db._execute(
                        "SELECT client_id FROM clients WHERE phone = $1 AND client_id <> $2",
                        (full_phone, uid),
                        fetchone=True,
                    )
                else:
                    row = await db._execute(
                        "SELECT driver_id FROM drivers WHERE phone = $1 AND driver_id <> $2",
                        (full_phone, uid),
                        fetchone=True,
                    )
                if row:
                    return {"success": False, "message": "Этот телефон уже занят"}
                patch["phone"] = full_phone
                continue
            if key == "email":
                if val is None:
                    continue
                em = str(val).strip()
                if len(em) > 100:
                    return {"success": False, "message": "Email слишком длинный"}
                patch["email"] = em or None
                continue
            if key in ("name", "surname", "car_name"):
                if val is None:
                    continue
                s = str(val).strip()
                if not s:
                    continue
                patch[key] = s[:100]
                continue
            if key == "car_year":
                if val is None:
                    continue
                y = int(val)
                cy = datetime.datetime.now().year
                if y < 1990 or y > cy + 1:
                    return {"success": False, "message": "Неверный год автомобиля"}
                patch["car_year"] = y
                continue
            if key == "car_number":
                if not val or not str(val).strip():
                    continue
                cn = str(val).strip().upper()
                if not re.match(r"^\d{2} [A-Z]{2} \d{3}$", cn):
                    return {"success": False, "message": "Неверный формат номера автомобиля"}
                exist = await db._execute(
                    "SELECT driver_id FROM drivers WHERE car_number = $1 AND driver_id <> $2",
                    (cn, uid),
                    fetchone=True,
                )
                if exist:
                    return {"success": False, "message": "Автомобиль с таким номером уже зарегистрирован"}
                patch["car_number"] = cn
                continue
            if key == "car_tech_passport":
                if not val or not str(val).strip():
                    continue
                tp = str(val).strip().upper()
                if not re.match(r"^[A-Z]{2}\s*№?\s*\d{6}$", tp):
                    return {"success": False, "message": "Неверный формат техпаспорта"}
                patch["car_tech_passport"] = tp
                continue
            if key == "driver_license":
                if not val or not str(val).strip():
                    continue
                dl = str(val).strip().upper()
                if not re.match(r"^[A-Z]{2}\s*№?\s*\d{6}$", dl):
                    return {"success": False, "message": "Неверный формат водительского удостоверения"}
                patch["driver_license"] = dl
                continue
            if key in (
                "photo",
                "car_front_photo",
                "driver_license_photo",
                "car_tech_photo",
                "face_photo",
            ):
                if val is None:
                    continue
                b64 = _check_b64_len(key, _strip_data_url_b64(str(val)))
                if b64:
                    patch[key] = b64
                continue

        if not patch:
            return {"success": False, "message": "Нечего сохранять"}

        if user_type == "client":
            await db.update_client(uid, **patch)
        else:
            await db.update_driver(uid, **patch)

        return {"success": True, "message": "Сохранено"}
    except ValueError as ve:
        return {"success": False, "message": str(ve)}
    except Exception as e:
        print(f"[API] update_me_profile: {e}")
        return JSONResponse(
            {"success": False, "message": "Ошибка сервера"},
            status_code=500,
        )


# ============================================
# REGISTRATION & LOGIN
# ============================================

@fastapi_app.post("/api/registration-client", response_model=models.ClientRegistrationResponse)
async def register_client(client_data: models.ClientRegistration, response: Response):
    """Регистрация клиента"""
    try:
        # Валидация
        if not re.match(r'^\d{2} \d{3} \d{2}-\d{2}$', client_data.phone):
            return models.ClientRegistrationResponse(
                success=False,
                message="Неверный формат телефона",
                error="phone_format"
            )
        
        if not client_data.name.strip():
            return models.ClientRegistrationResponse(
                success=False,
                message="Имя обязательно",
                error="name_required"
            )
        
        if not client_data.surname.strip():
            return models.ClientRegistrationResponse(
                success=False,
                message="Фамилия обязательна",
                error="surname_required"
            )
        
        if len(client_data.password) < 6:
            return models.ClientRegistrationResponse(
                success=False,
                message="Пароль минимум 6 символов",
                error="password_length"
            )
        
        if not client_data.agree_to_terms:
            return models.ClientRegistrationResponse(
                success=False,
                message="Необходимо согласие с правилами",
                error="terms_not_accepted"
            )
        
        # Регистрация
        client_id = await db.add_client(
            name=client_data.name.strip(),
            surname=client_data.surname.strip(),
            phone=f"+994 {client_data.phone}",
            password=client_data.password,
            last_lat=client_data.last_lat,
            last_lon=client_data.last_lng
        )
        
        if not client_id:
            return models.ClientRegistrationResponse(
                success=False,
                message="Телефон уже существует",
                error="phone_exists"
            )
        
        # Создаем сессию
        session_token = models.create_session_token(serializer, client_id, "client")
        
        response.set_cookie(
            key="taxi_session",
            value=session_token,
            max_age=3600*24*30,
            httponly=False,
            samesite="lax"
        )
        
        return models.ClientRegistrationResponse(
            success=True,
            message="Регистрация успешна",
            client_id=str(client_id)
        )
    
    except Exception as e:
        print(f'[API] Registration error: {e}')
        return models.ClientRegistrationResponse(
            success=False,
            message="Ошибка сервера",
            error="server_error"
        )


# Эндпоинт для регистрации таксиста
@fastapi_app.post("/api/registration-taxi", response_model=models.TaxiRegistrationResponse)
async def register_taxi(taxi_data: models.TaxiRegistration, response: Response):
    """
    Регистрация нового таксиста
    """
    try:
        # Валидация телефона
        phone_pattern = r'^\d{2} \d{3} \d{2}-\d{2}$'
        if not re.match(phone_pattern, taxi_data.phone):
            return models.TaxiRegistrationResponse(success=False, message="Неверный формат телефона", error="phone_format")

        # Валидация имени
        if not taxi_data.name.strip():
            return models.TaxiRegistrationResponse(success=False, message="Имя обязательно для заполнения", error="name_required")

        # Валидация фамилии
        if not taxi_data.surname.strip():
            return models.TaxiRegistrationResponse(success=False, message="Фамилия обязательна для заполнения", error="surname_required")

        # Валидация пароля
        if len(taxi_data.password) < 6:
            return models.TaxiRegistrationResponse(success=False, message="Пароль должен содержать минимум 6 символов", error="password_length")

        # Валидация года автомобиля
        current_year = datetime.datetime.now().year
        if taxi_data.car_year < 1990 or taxi_data.car_year > current_year + 1:
            return models.TaxiRegistrationResponse(success=False, message="Неверный год выпуска автомобиля", error="car_year_invalid")

        # Валидация номера автомобиля
        if not re.match(r'^\d{2} [A-Z]{2} \d{3}$', taxi_data.car_number):
            return models.TaxiRegistrationResponse(success=False, message="Неверный формат номера автомобиля", error="car_number_invalid")

        # Валидация названия автомобиля
        if not taxi_data.car_name.strip():
            return models.TaxiRegistrationResponse(success=False, message="Название автомобиля обязательно для заполнения", error="car_name_required")

        # Валидация техпаспорта
        if not re.match(r'^[A-Z]{2}\s*№?\s*\d{6}$', taxi_data.tech_passport):
            return models.TaxiRegistrationResponse(success=False, message="Неверный формат техпаспорта", error="tech_passport_invalid")

        # Валидация водительского удостоверения
        if not re.match(r'^[A-Z]{2}\s*№?\s*\d{6}$', taxi_data.driver_license):
            return models.TaxiRegistrationResponse(success=False, message="Неверный формат водительского удостоверения", error="driver_license_invalid")

        # Валидация согласия с правилами
        if not taxi_data.agree_to_terms:
            return models.TaxiRegistrationResponse(success=False, message="Необходимо согласие с правилами", error="terms_not_accepted")

        # Проверка наличия всех фотографий
        required_photos = ['car_photo', 'driver_license_photo', 'tech_passport_photo', 'face_photo']
        for photo_field in required_photos:
            if not getattr(taxi_data, photo_field):
                return models.TaxiRegistrationResponse(success=False, message="Все фотографии обязательны для заполнения", error="photo_required")

        # ---------- КРИТИЧЕСКИЙ МОМЕНТ 1 ----------
        # Проверка уникальности телефона ДО регистрации
        existing_user = await db.get_client_by_phone(taxi_data.phone)
        if existing_user:
            return models.TaxiRegistrationResponse(success=False, message="Пользователь с таким телефоном уже существует", error="phone_exists")
        
        # ---------- КРИТИЧЕСКИЙ МОМЕНТ 2 ----------
        # Проверка уникальности номера автомобиля ДО регистрации
        # Нужен метод для проверки по car_number
        existing_car = await db._execute(
            "SELECT driver_id FROM drivers WHERE car_number = $1",
            (taxi_data.car_number,),
            fetchone=True
        )
        if existing_car:
            return models.TaxiRegistrationResponse(success=False, message="Автомобиль с таким номером уже зарегистрирован", error="car_number_exists")

        # Регистрируем таксиста в базе данных
        phone_for_db = f"+994 {taxi_data.phone}" 
        driver_id = await db.add_driver(
            name=taxi_data.name.strip(),
            surname=taxi_data.surname.strip(),
            phone=phone_for_db,  # Используем отформатированный номер
            password=taxi_data.password,
            car_year=taxi_data.car_year,
            car_number=taxi_data.car_number,
            tech_passport=taxi_data.tech_passport,
            driver_license=taxi_data.driver_license,
            car_photo=taxi_data.car_photo,
            driver_license_photo=taxi_data.driver_license_photo,
            tech_passport_photo=taxi_data.tech_passport_photo,
            face_photo=taxi_data.face_photo,
            last_lat=taxi_data.last_lat,
            last_lon=taxi_data.last_lng,
            car_name=taxi_data.car_name)

        # Если driver_id is None, значит регистрация не удалась
        if not driver_id:
            # Это может случиться, если вдруг проверки не сработали
            return models.TaxiRegistrationResponse(success=False, message="Не удалось зарегистрировать водителя", error="registration_failed")

        # Создаем токен сессии для водителя  
        session_token = models.create_session_token(serializer, driver_id, "driver")

        # Устанавливаем куки
        response.set_cookie(
            key="taxi_session",
            value=session_token,
            max_age=3600*24*30,
            httponly=True,  # Рекомендую True для безопасности
            secure=True,    # True для HTTPS
            samesite="lax")

        # Успешная регистрация
        return models.TaxiRegistrationResponse(
            success=True, 
            message="Регистрация успешно завершена", 
            driver_id=str(driver_id))

    # Обработка неожиданных ошибок
    except Exception as e:
        return models.TaxiRegistrationResponse(
            success=False, 
            message="Внутренняя ошибка сервера", 
            error="server_error")
    



@fastapi_app.post("/api/login-client", response_model=models.ClientLoginResponse)
async def login_client(login_data: models.ClientLogin, response: Response):
    """Вход клиента"""
    try:
        if not login_data.agree_to_terms:
            return models.ClientLoginResponse(
                success=False,
                message="Необходимо согласие с правилами",
                error="terms_not_accepted"
            )
        
        if not re.match(r'^\d{2} \d{3} \d{2}-\d{2}$', login_data.phone):
            return models.ClientLoginResponse(
                success=False,
                message="Неверный формат телефона",
                error="phone_format"
            )
        
        # Получаем пользователя
        client = await db.get_client_by_phone(f"+994 {login_data.phone}")
        
        if not client:
            return models.ClientLoginResponse(
                success=False,
                message="Пользователь не найден",
                error="client_not_found"
            )
        
        # Проверяем пароль
        if client["password"] != login_data.password:
            return models.ClientLoginResponse(
                success=False,
                message="Неверный пароль",
                error="wrong_password"
            )

        if client.get("role") == "client":
            if client.get("is_banned"):
                return models.ClientLoginResponse(
                    success=False,
                    message="Ваш аккаунт заблокирован (бан). Свяжитесь с поддержкой сервиса.",
                    error="account_banned",
                )
            if client.get("admin_disabled"):
                return models.ClientLoginResponse(
                    success=False,
                    message="Вход временно запрещён: аккаунт отключён администратором.",
                    error="account_disabled",
                )
        elif client.get("role") == "driver":
            if client.get("is_banned"):
                return models.ClientLoginResponse(
                    success=False,
                    message="Ваш аккаунт водителя заблокирован (бан). Свяжитесь с поддержкой сервиса.",
                    error="account_banned",
                )
            if client.get("admin_disabled"):
                return models.ClientLoginResponse(
                    success=False,
                    message="Вход временно запрещён: аккаунт водителя отключён администратором.",
                    error="account_disabled",
            )
        
        # Определяем роль и ID
        role = client["role"]
        user_id = client.get("client_id") if role == "client" else client.get("driver_id")
        
        # Создаем сессию
        session_token = models.create_session_token(serializer, user_id, role)
        
        response.set_cookie(
            key="taxi_session",
            value=session_token,
            max_age=3600*24*30,
            httponly=False,
            samesite="lax"
        )
        
        return models.ClientLoginResponse(
            success=True,
            message="Вход выполнен",
            client_id=str(user_id)
        )
    
    except Exception as e:
        print(f'[API] Login error: {e}')
        return models.ClientLoginResponse(
            success=False,
            message="Ошибка сервера",
            error="server_error"
        )

# ============================================
# TAXI STATUS
# ============================================

@fastapi_app.get("/api/taxi-status")
async def get_taxi_status(request: Request):
    """Получение статуса такси"""
    session_token = request.cookies.get("taxi_session")
    
    if not session_token:
        raise HTTPException(status_code=401, detail="Не авторизован")
    
    user_data = models.get_user_from_token(serializer, session_token)
    
    if not user_data or user_data["user_type"] != "driver":
        raise HTTPException(status_code=401, detail="Недействительная сессия")
    
    driver = await db.get_driver(driver_id=user_data["user_id"])
    
    if not driver:
        raise HTTPException(status_code=404, detail="Водитель не найден")
    
    return models.TaxiGetStatusResponse(
        success=True,
        status=driver['status'],
        message="Статус получен",
        driver_id=str(driver['driver_id'])
    )

@fastapi_app.post("/api/taxi-status")
async def set_taxi_status(taxi_data: models.TaxiUpdateStatus, request: Request):
    """Обновление статуса такси"""
    session_token = request.cookies.get("taxi_session")
    
    if not session_token:
        raise HTTPException(status_code=401, detail="Не авторизован")
    
    user_data = models.get_user_from_token(serializer, session_token)
    
    if not user_data or user_data["user_type"] != "driver":
        raise HTTPException(status_code=401, detail="Недействительная сессия")
    
    if taxi_data.status not in ["available", "offline"]:
        return models.TaxiUpdateStatusResponse(
            success=False,
            message="Неверный статус",
            error="taxi_status_error"
        )
    
    await db.update_driver(
        driver_id=user_data["user_id"],
        status=taxi_data.status,
        last_lat=taxi_data.last_lat,
        last_lon=taxi_data.last_lng
    )
    
    return models.TaxiUpdateStatusResponse(
        success=True,
        message="Статус обновлен"
    )

# ============================================
# ORDERS / TRIPS
# ============================================

@fastapi_app.post("/api/orders")
async def create_order(order_data: models.OrderCreate, request: Request):
    """Создание заказа"""
    try:
        now = datetime.datetime.now()
        r = redis_c.get_redis()
        idem = (
            (order_data.idempotency_key or "").strip()
            or (request.headers.get("Idempotency-Key") or "").strip()
        )
        if idem and r:
            ik = f"idem:create_trip:{order_data.clientID}:{idem}"
            prev = await r.get(ik)
            if prev:
                try:
                    tid_dup = int(prev)
                    dup_row = await db.get_trips(trip_id=tid_dup)
                    dup_price = (
                        float(dup_row.get("price") or 0) if dup_row else 0.0
                    )
                    return {
                        "success": True,
                        "trip_id": tid_dup,
                        "duplicate": True,
                        "price": dup_price,
                    }
                except (TypeError, ValueError):
                    pass
        
        # Создаем поездку
        trip_id = await db.add_trip(
            client_id=order_data.clientID,
            start_lat=order_data.fromLocation[0],
            start_lon=order_data.fromLocation[1],
            end_lat=order_data.toLocation[0],
            end_lon=order_data.toLocation[1],
            distance_km=order_data.distance,
            start_address=order_data.startAddress,
            end_address=order_data.endAddress,
            requested_at=now,
            client_name=order_data.clientName,
            client_rating=order_data.clientRating,
            driving_time=order_data.drivingTime,
            route_duration_minutes=order_data.routeDurationMinutes,
        )
        
        if not trip_id:
            raise HTTPException(status_code=500, detail="Failed to create trip")

        if idem and r:
            await r.setex(f"idem:create_trip:{order_data.clientID}:{idem}", 3600, str(trip_id))

        # Получаем фото клиента
        client_data = await db.get_client(order_data.clientID)
        client_photo = client_photo_for_peer_sharing(client_data)
        await dispatch_service.run_first_wave(
            db, get_hub(), redis_c.get_redis(), trip_id, client_photo
        )

        try:
            await get_hub().emit_to_admins(
                "admin_event",
                {
                    "type": "admin_trip_created",
                "trip_id": trip_id,
                "client_id": order_data.clientID,
                },
            )
        except Exception:
            logging.getLogger(__name__).debug("emit admin_trip_created skipped", exc_info=True)

        fresh = await db.get_trips(trip_id=trip_id)
        price_out = float(fresh.get("price") or 0) if fresh else 0.0
        wave_out = int(fresh.get("dispatch_wave") or 1) if fresh else 1
        return {
            "success": True,
            "trip_id": trip_id,
            "price": price_out,
            "dispatch_wave": wave_out,
        }
    
    except Exception as e:
        print(f'[API] Create order error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/api/pricing/quote")
async def pricing_quote(
    km: float,
    minutes: float = 0,
    wave: int = 1,
):
    """Предпросмотр цены по км и минутам (волна и спрос — как на сервере)."""
    try:
        dk = float(km)
        dm = max(0.0, float(minutes))
        w = max(1, min(int(wave), 20))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Некорректные km или minutes")
    demand = await db.compute_demand_coefficient()
    price = await db.compute_trip_price_azn(dk, dm, wave=w, demand_coef=demand)
    return {
        "price": price,
        "km": dk,
        "minutes": dm,
        "wave": w,
        "demand_coef": demand,
    }


@fastapi_app.post("/api/confirmation/trip")
async def confirmation_trip(order_data: models.ConfirmationTrip, request: Request):
    """Подтверждение поездки"""
    try:
        session_token = request.cookies.get("taxi_session")
        if not session_token:
            return {"success": False, "message": "No session"}
        
        user_data = models.get_user_from_token(serializer, session_token)
        if not user_data or user_data["user_type"] != "client":
            return {"success": False, "message": "Invalid user"}
        
        trip_status = await db.get_trips(trip_id=order_data.tripID)
        if trip_status.get("status") == "busy":
            return {
                "success": True,
                "trip_id": order_data.tripID,
                "message": "Поездка уже подтверждена",
                "status": trip_status.get("status"),
            }
        if trip_status.get("status") != "accepted":
            return {
                "success": False,
                "message": "Поездка не в статусе accepted (ожидайте водителя)",
                "status": trip_status.get("status"),
            }
        if int(trip_status.get("driver_id") or 0) != int(order_data.driverID):
            return {"success": False, "message": "Неверный водитель для поездки"}

        await db.update_trip_status(trip_id=order_data.tripID, status="busy")
        tr = await transition_trip_leg_state(
            db,
            redis_c.get_redis(),
            trip_id=int(order_data.tripID),
            to_state="en_route",
            source="confirmation_trip",
            actor_user_id=int(user_data["user_id"]),
            idempotency_key=order_data.idempotency_key,
        )
        if not tr["ok"] and tr["code"] not in ("nochange", "duplicate"):
            return {
                "success": False,
                "message": tr["message"],
                "debug": tr.get("debug"),
            }
        await db.update_trip_accepted_at(trip_id=order_data.tripID, accepted_at=datetime.datetime.now())
        
        
        # Получаем данные
        driver_info = await db.get_driver(driver_id=order_data.driverID)
        client_info = await db.get_client(client_id=order_data.clientID)
        
        # Отправляем подтверждение всем участникам
        trip_data = {
            "type": "confirmation_trip",
            "success": True,
            "message": "Поездка подтверждена",
            "status": "busy",
            "trip": {
                "trip_id": order_data.tripID,
                "client_id": order_data.clientID,
                "client_name": f"{client_info.get('surname', '')[:1]}. {client_info.get('name', '')}",
                "client_avatar": client_photo_for_peer_sharing(client_info),
                "client_rating": json_serializer(client_info.get('rating')),
                "client_phone": client_info.get('phone'),
                "driver_id": order_data.driverID,
                "taxi_avatar": driver_info.get('face_photo'),
                "taxi_car_name": driver_info.get('car_name'),
                "taxi_car_number": driver_info.get('car_number'),
                "taxi_car_year": driver_info.get('car_year'),
                "taxi_car_category": driver_info.get('car_category'),
                "taxi_car_photo": driver_info.get('car_front_photo'),
                "start_address": order_data.startAddress,
                "end_address": order_data.endAddress,
                "taxi_lat": order_data.taxiLocation[0],
                "taxi_lon": order_data.taxiLocation[1],
                "start_lat": order_data.fromLocation[0],
                "start_lon": order_data.fromLocation[1],
                "end_lat": order_data.toLocation[0],
                "end_lon": order_data.toLocation[1],
                "distance": order_data.distance,
                "price": (
                    f"{float(trip_status.get('price') or 0):.2f}"
                    if float(trip_status.get("price") or 0) > 0
                    else f"{await db.trip_quote_amount(order_data.distance, duration_minutes=float(trip_status.get('route_duration_minutes') or 0)):.2f}"
                ),
                "taxi_name": f"{driver_info.get('surname', '')[:1]}. {driver_info.get('name', '')}",
                "taxi_phone": driver_info.get('phone'),
                "taxi_rating": json_serializer(driver_info.get('rating')),
                "driving_time": order_data.drivingTime,
            }
        }
        
        trip_rev = (await db.get_trips(trip_id=order_data.tripID)) or {}
        trip_body = enrich_outbound(
            trip_data, revision=trip_rev.get("revision"), ack_required=True
        )
        await notify_user(
            get_hub(), redis_c.get_redis(), "client", str(order_data.clientID), "confirmation_trip", trip_body
        )
        await notify_user(
            get_hub(), redis_c.get_redis(), "driver", str(order_data.driverID), "confirmation_trip", trip_body
        )

        tid_cf = int(order_data.tripID)
        price_txt = str(trip_data["trip"].get("price") or "")
        taxi_nm = str(trip_data["trip"].get("taxi_name") or "")
        await push_notifications.send_event_push(
            db,
            "client",
            int(order_data.clientID),
            "client_trip_confirmed",
            {"trip_id": str(tid_cf), "taxi_name": taxi_nm, "price": price_txt},
            trip_id=tid_cf,
        )
        await push_notifications.send_event_push(
            db,
            "driver",
            int(order_data.driverID),
            "driver_trip_confirmed",
            {"trip_id": str(tid_cf)},
            trip_id=tid_cf,
        )

        return {"success": True, "trip_id": order_data.tripID, "message": "Поездка подтверждена"}
    
    except Exception as e:
        print(f'[API] Confirmation error: {e}')
        raise HTTPException(status_code=500, detail=str(e))
    
@fastapi_app.get("/api/trip/busy")
async def busy_trip(request: Request):
    """Получение поездки который был ранее занят"""
    try:
        session_token = request.cookies.get("taxi_session")
        if not session_token:
            return {"success": False, "message": "No session"}
        
        user_data = models.get_user_from_token(serializer, session_token)
        if not user_data:
            return {"success": False, "message": "Invalid user"}
        
        # Получаем занятые поездки
        if user_data["user_type"] == "driver": trip = await db.get_trips(driver_busy_trip=True, driver_id=user_data["user_id"])
        else: trip = await db.get_trips(client_busy_trip=True, client_id=user_data["user_id"])

        if trip:

            # Получаем данные
            driver_info = await db.get_driver(driver_id=trip.get("driver_id"))
            client_info = await db.get_client(client_id=trip.get("client_id"))
            
            # Отправляем подтверждение всем участникам
            trip_data = {
                "type": "confirmation_trip",
                "success": True,
                "message": "Поездка загружена и подтверждена",
                "status": trip.get("status") or "busy",
                "trip": {
                    "trip_id": trip["trip_id"],
                    "client_id": trip.get("client_id"),
                    "client_name": trip.get("client_name"),
                    "client_avatar": client_photo_for_peer_sharing(client_info),
                    "client_rating": json_serializer(client_info.get('rating')),
                    "client_phone": client_info.get('phone'),
                    "driver_id": trip.get("driver_id"),
                    "taxi_avatar": driver_info.get('face_photo'),
                    "taxi_car_name": driver_info.get('car_name'),
                    "taxi_car_number": driver_info.get('car_number'),
                    "taxi_car_year": driver_info.get('car_year'),
                    "taxi_car_category": driver_info.get('car_category'),
                    "taxi_car_photo": driver_info.get('car_front_photo'),
                    "start_address": trip.get("start_address"),
                    "end_address": trip.get("end_address"),
                    "taxi_lat": driver_info.get("last_lat"),
                    "taxi_lon": driver_info.get("last_lon"),
                    "start_lat": trip.get("start_lat"),
                    "start_lon": trip.get("start_lon"),
                    "end_lat": trip.get("end_lat"),
                    "end_lon": trip.get("end_lon"),
                    "distance": trip.get("distance_km"),
                    "price": f"{await _trip_socket_price(db, trip):.2f}",
                    "taxi_name": f"{driver_info.get('surname', '')[:1]}. {driver_info.get('name', '')}",
                    "taxi_phone": driver_info.get('phone'),
                    "taxi_rating": json_serializer(driver_info.get('rating')),
                    "driving_time": trip.get("driving_time"),
                }
            }
            
            trip_body = enrich_outbound(
                trip_data, revision=trip.get("revision"), ack_required=False
            )
            r = redis_c.get_redis()
            h = get_hub()
            cid, did = trip.get("client_id"), trip.get("driver_id")
            if cid:
                await notify_user(
                    h, r, "client", str(cid), "confirmation_trip", trip_body
                )
            if did:
                await notify_user(
                    h, r, "driver", str(did), "confirmation_trip", trip_body
                )
            
            return {"success": True, "trip_id": trip["trip_id"], "message": "Поездка подтверждена"}
    
        return {"success": True, "message": "Поездка не найдена"}
    
    except Exception as e:
        print(f'[API] Confirmation error: {e}')
        raise HTTPException(status_code=500, detail=str(e))
    

@fastapi_app.get("/api/trip/active")
async def trip_active_restore(request: Request):
    """Активная поездка из БД для восстановления UI после перезагрузки (клиент/водитель)."""
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        return {"success": False, "message": "No session", "phase": "none", "payload": None}
    user_data = models.get_user_from_token(serializer, session_token)
    if not user_data:
        return {"success": False, "message": "Invalid user", "phase": "none", "payload": None}
    trip = await db.get_active_trip_for_restore(
        str(user_data["user_type"]), int(user_data["user_id"])
    )
    if not trip:
        return {"success": True, "phase": "none", "payload": None}
    phase = _trip_restore_phase(trip, str(user_data["user_type"]), int(user_data["user_id"]))
    if phase == "none":
        return {"success": True, "phase": "none", "payload": None}
    payload = await build_frontend_trip_restore_payload(db, trip)
    return {"success": True, "phase": phase, "payload": payload}


@fastapi_app.post("/api/trip/state")
async def trip_state(order_data: models.TripState, request: Request):
    redis = redis_c.get_redis()
    try:
        session_token = request.cookies.get("taxi_session")
        if not session_token:
            return {"success": False, "message": "No session"}
        
        user_data = models.get_user_from_token(serializer, session_token)
        if not user_data:
            return {"success": False, "message": "Invalid user"}

        trip = await db.get_trips(trip_id=int(order_data.trip_id))
        if not trip:
            return {"success": False, "message": "Поездка не найдена"}

        uid = user_data["user_id"]
        if trip.get("client_id") != uid and trip.get("driver_id") != uid:
            return JSONResponse(
                {"success": False, "message": "Нет доступа к поездке"},
                status_code=403,
            )

        tid = int(order_data.trip_id)
        new_state = normalize_leg_state(order_data.state)
        t0 = trip_logging.timed_ms()

        tr = await transition_trip_leg_state(
            db,
            redis,
            trip_id=tid,
            to_state=new_state,
            source=f"api_trip_state:{user_data.get('user_type')}",
            actor_user_id=int(uid),
            idempotency_key=order_data.idempotency_key,
        )
        snap = tr.get("snapshot") or {}
        if not tr["ok"]:
            body = {
                "success": False,
                "trip_id": tid,
                "message": tr["message"],
                "debug": tr.get("debug"),
                "state": snap.get("state"),
            }
            return JSONResponse(body, status_code=tr["http_status"])

        trip_logging.trip_log(
            "trip_state_changed",
            trip_id=tid,
            driver_id=snap.get("driver_id"),
            client_id=snap.get("client_id"),
            state=snap.get("state"),
            latency_ms=trip_logging.timed_ms() - t0,
            extra=f"user={uid} type={user_data.get('user_type')} code={tr.get('code')}",
        )

        if tr["code"] in ("ok", "nochange", "duplicate"):
            trip_data = update_trip_state_event_payload(snap)
            trip_body = enrich_outbound(
                trip_data, revision=snap.get("revision"), ack_required=True
            )
            h = get_hub()
            cid, did = snap.get("client_id"), snap.get("driver_id")
            if cid:
                await notify_user(
                    h, redis, "client", str(cid), "update_trip_state", trip_body
                )
            if did:
                await notify_user(
                    h, redis, "driver", str(did), "update_trip_state", trip_body
                )

        return {
            "success": True,
            "trip_id": tid,
            "message": tr["message"],
            "state": snap.get("state"),
            "code": tr.get("code"),
            "debug": tr.get("debug"),
        }
    
    except Exception as e:
        print(f'[API] Trip/state error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/trip/rate")
async def trip_peer_rate(
    body: models.TripPeerRating,
    request: Request,
    background_tasks: BackgroundTasks,
):
    """Оценка контрагента после поездки (обе стороны в состоянии at_destination)."""
    redis = redis_c.get_redis()
    try:
        session_token = request.cookies.get("taxi_session")
        if not session_token:
            return JSONResponse({"success": False, "message": "No session"}, status_code=401)
        user_data = models.get_user_from_token(serializer, session_token)
        if not user_data:
            return JSONResponse({"success": False, "message": "Invalid user"}, status_code=401)
        ut = str(user_data.get("user_type") or "")
        if ut not in ("client", "driver"):
            return JSONResponse({"success": False, "message": "Forbidden"}, status_code=403)
        uid = int(user_data["user_id"])
        tid = int(body.trip_id)
        trip_row = await db.get_trips(trip_id=tid)
        if not trip_row:
            return JSONResponse({"success": False, "message": "Поездка не найдена"}, status_code=404)
        if trip_row.get("client_id") != uid and trip_row.get("driver_id") != uid:
            return JSONResponse({"success": False, "message": "Нет доступа"}, status_code=403)

        ok, code, snap = await db.submit_trip_peer_rating(
            tid, uid, ut, float(body.stars), body.comment, body.reasons
        )
        if not ok:
            status = 403 if code == "forbidden" else 400
            if code == "not_found":
                status = 404
            return JSONResponse(
                {"success": False, "code": code, "state": (snap or {}).get("state")},
                status_code=status,
            )

        if code == "already_rated":
            both_dup = (
                snap
                and snap.get("post_trip_driver_stars") is not None
                and snap.get("post_trip_client_stars") is not None
            )
            return JSONResponse(
                {
                    "success": True,
                    "code": code,
                    "both_rated": bool(both_dup),
                    "state": snap.get("state") if snap else None,
                }
            )

        if code == "ok" and snap:
            if ut == "client" and snap.get("driver_id"):
                background_tasks.add_task(
                    _deferred_peer_rating_aggregate,
                    db,
                    "driver",
                    int(snap["driver_id"]),
                    float(body.stars),
                )
            elif ut == "driver" and snap.get("client_id"):
                background_tasks.add_task(
                    _deferred_peer_rating_aggregate,
                    db,
                    "client",
                    int(snap["client_id"]),
                    float(body.stars),
                )

        both = (
            snap
            and snap.get("post_trip_driver_stars") is not None
            and snap.get("post_trip_client_stars") is not None
        )
        if both:
            tr = await transition_trip_leg_state(
                db,
                redis,
                trip_id=tid,
                to_state="finished",
                source="api_trip_rate",
                actor_user_id=uid,
                idempotency_key=None,
            )
            snap = tr.get("snapshot") or snap
            if snap and str(snap.get("status") or "") != "completed":
                elat = float(snap.get("end_lat") or snap.get("start_lat") or 0)
                elon = float(snap.get("end_lon") or snap.get("start_lon") or 0)
                dkm = float(snap.get("distance_km") or 0)
                price = float(snap.get("price") or 0)
                await db.complete_trip(tid, elat, elon, dkm, price)
                snap = await db.get_trips(trip_id=tid) or snap
            did = snap.get("driver_id") if snap else None
            if did:
                await db.update_driver(int(did), status="available")
            if snap:
                trip_data = update_trip_state_event_payload(snap)
                trip_body = enrich_outbound(
                    trip_data, revision=snap.get("revision"), ack_required=True
                )
                h = get_hub()
                cid, did = snap.get("client_id"), snap.get("driver_id")
                if cid:
                    await notify_user(h, redis, "client", str(cid), "update_trip_state", trip_body)
                if did:
                    await notify_user(h, redis, "driver", str(did), "update_trip_state", trip_body)
                try:
                    ptxt = f"{float(snap.get('price') or 0):.2f}".rstrip("0").rstrip(".")
                    if cid:
                        await push_notifications.send_event_push(
                            db,
                            "client",
                            int(cid),
                            "client_trip_finished",
                            {"trip_id": str(tid), "price": ptxt},
                            trip_id=tid,
                        )
                    if did:
                        await push_notifications.send_event_push(
                            db,
                            "driver",
                            int(did),
                            "driver_trip_finished",
                            {"trip_id": str(tid), "price": ptxt},
                            trip_id=tid,
                        )
                except Exception:
                    logging.getLogger(__name__).exception("push trip_finished")

        return {
            "success": True,
            "code": code,
            "both_rated": bool(both),
            "state": snap.get("state") if snap else None,
        }
    except Exception as e:
        print(f"[API] Trip/rate error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/api/trip/{trip_id}/sync")
async def http_sync_trip(trip_id: int, request: Request):
    """HTTP resync поездки после reconnect / потери событий."""
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        raise HTTPException(status_code=401, detail="No session")
    user_data = models.get_user_from_token(serializer, session_token)
    if not user_data:
        raise HTTPException(status_code=401, detail="Invalid session")
    trip = await db.get_trips(trip_id=trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    uid = user_data["user_id"]
    if trip.get("client_id") != uid and trip.get("driver_id") != uid:
        raise HTTPException(status_code=403, detail="Forbidden")
    return {
        "ok": True,
        "trip": trip,
        "revision": trip.get("revision") or 1,
    }


@fastapi_app.post("/api/check/trip")
async def checking_trip(order_data: models.CheckTrip, request: Request):
    """Атомарный accept поездки водителем + уведомление клиента."""
    try:
        session_token = request.cookies.get("taxi_session")
        
        if not session_token:
            return {"success": False, "message": "Нет сессии", "code": "NO_SESSION"}

        user_data = models.get_user_from_token(serializer, session_token)

        if not user_data or user_data["user_type"] != "driver":
            return {"success": False, "message": "Нужна сессия водителя", "code": "INVALID_USER"}
        
        trip_status = await db.get_trips(trip_id=order_data.tripID)
        if not trip_status:
            return {
                "success": False,
                "message": "Заказ не найден.",
                "code": "TRIP_NOT_FOUND",
                "silent": True,
            }
        if trip_status.get("status") not in ("offered", "pending"):
            return {
                "success": False,
                "message": "Заказ уже недоступен (отменён или обработан).",
                "code": "TRIP_NOT_OPEN",
                "silent": True,
            }

        driver_id = int(user_data["user_id"])

        try:
            stored_trip_price = float(trip_status.get("price") or 0)
        except (TypeError, ValueError):
            stored_trip_price = 0.0
        view_price = (
            f"{stored_trip_price:.2f}"
            if stored_trip_price > 0
            else f"{await db.trip_quote_amount(order_data.distance):.2f}"
        )

        def build_view(driver_info: dict, row: dict) -> dict:
            return {
            "type": "view_trip_for_client",
            "trip": {
                "for": "client",
                "trip_id": order_data.tripID,
                "client_id": order_data.clientID,
                    "driver_id": driver_id,
                    "taxi_avatar": driver_info.get("face_photo"),
                    "taxi_car_name": driver_info.get("car_name"),
                    "taxi_car_number": driver_info.get("car_number"),
                    "taxi_car_year": driver_info.get("car_year"),
                    "taxi_car_category": driver_info.get("car_category"),
                    "taxi_car_photo": driver_info.get("car_front_photo"),
                "taxi_lat": order_data.taxiLocation[0],
                "taxi_lon": order_data.taxiLocation[1],
                "start_lat": order_data.fromLocation[0],
                "start_lon": order_data.fromLocation[1],
                "end_lat": order_data.toLocation[0],
                "end_lon": order_data.toLocation[1],
                "start_address": order_data.startAddress,
                "end_address": order_data.endAddress,
                "distance": order_data.distance,
                    "price": view_price,
                "taxi_name": f"{driver_info.get('surname', '')[:1]}. {driver_info.get('name', '')}",
                    "taxi_rating": json_serializer(driver_info.get("rating")),
                "driving_time": order_data.drivingTime,
                },
            }

        result = await booking.driver_claim_trip(
            db,
            redis_c.get_redis(),
            get_hub(),
            driver_id=driver_id,
            trip_id=order_data.tripID,
            idempotency_key=order_data.idempotency_key,
            build_view_payload=build_view,
        )

        if result.get("duplicate"):
            return {"success": True, "trip_id": order_data.tripID, "duplicate": True}
        if not result.get("success"):
            return result
        
        return {"success": True, "trip_id": order_data.tripID}
    
    except Exception as e:
        print(f"[API] Check trip error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/api/trips/driver-release-awaiting-client")
async def driver_release_awaiting_client_endpoint(
    body: models.DriverReleaseAwaitingBody,
    request: Request,
):
    """Водитель отменяет ожидание подтверждения клиента — заказ снова в поиске (тот же trip_id)."""
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        return JSONResponse({"success": False, "message": "Не авторизован"}, status_code=401)
    user_data = models.get_user_from_token(serializer, session_token)
    if not user_data or user_data.get("user_type") != "driver":
        return JSONResponse({"success": False, "message": "Нужна сессия водителя"}, status_code=403)
    driver_id = int(user_data["user_id"])
    row = await db.driver_release_trip_awaiting_client(int(body.trip_id), driver_id)
    if not row:
        return {
            "success": False,
            "message": "Нельзя отменить: заказ уже не в ожидании клиента или назначен другому.",
        }
    try:
        from tools import dispatch_redis_metrics as _drm

        _r = redis_c.get_redis()
        if _r:
            await _drm.decline_penalty_add(_r, driver_id, "busy")
    except Exception:
        pass
    cid = row.get("client_id")
    client_photo = None
    if cid:
        crow = await db.get_client(int(cid))
        client_photo = client_photo_for_peer_sharing(crow)
    await dispatch_service.run_first_wave(
        db, get_hub(), redis_c.get_redis(), int(body.trip_id), client_photo
    )
    fresh = await db.get_trips(trip_id=int(body.trip_id)) or {}
    rev = fresh.get("revision") or 1
    if cid:
        payload = enrich_outbound(
            {
                "type": "trip_searching_resumed",
                "trip_id": int(body.trip_id),
                "message": "Водитель отменил ожидание; продолжаем поиск.",
            },
            revision=rev,
            ack_required=True,
        )
        await notify_user(
            get_hub(),
            redis_c.get_redis(),
            "client",
            str(int(cid)),
            "trip_searching_resumed",
            payload,
        )
    return {"success": True, "trip_id": int(body.trip_id)}


@fastapi_app.post("/api/trips/client-dispatch-boost")
async def client_dispatch_boost_endpoint(
    body: models.ClientDispatchBoostBody,
    request: Request,
):
    """Одноразовый мягкий буст цены клиентом, пока заказ в поиске (pending/offered)."""
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        return JSONResponse({"success": False, "message": "Не авторизован"}, status_code=401)
    user_data = models.get_user_from_token(serializer, session_token)
    if not user_data or user_data.get("user_type") != "client":
        return JSONResponse({"success": False, "message": "Нужна сессия клиента"}, status_code=403)
    client_id = int(user_data["user_id"])
    row = await db.apply_client_dispatch_boost(int(body.trip_id), client_id)
    if not row:
        return {
            "success": False,
            "message": "Буст недоступен (уже применён, заказ не в поиске или не ваш).",
        }
    rev = int(row.get("revision") or 1)
    price = row.get("price")
    return {
        "success": True,
        "trip_id": int(body.trip_id),
        "revision": rev,
        "price": float(price) if price is not None else None,
    }


@fastapi_app.post("/api/trips/driver-decline-offer")
async def driver_decline_offer_endpoint(
    body: models.DriverDeclineOfferBody,
    request: Request,
):
    """Водитель явно отклоняет показанный заказ (снимается с offer_driver_ids)."""
    session_token = request.cookies.get("taxi_session")
    if not session_token:
        return JSONResponse({"success": False, "message": "Не авторизован"}, status_code=401)
    user_data = models.get_user_from_token(serializer, session_token)
    if not user_data or user_data.get("user_type") != "driver":
        return JSONResponse({"success": False, "message": "Нужна сессия водителя"}, status_code=403)
    driver_id = int(user_data["user_id"])
    row = await db.driver_remove_from_offer_wave(int(body.trip_id), driver_id)
    if not row:
        return {
            "success": False,
            "message": "Нельзя отклонить: заказ не в оффере или вы не в списке волны.",
        }
    await db.record_driver_offer_declined(driver_id)
    rsn = (body.reason or "decline").strip().lower()
    kind = "decline"
    if rsn in ("busy", "cant", "late", "занят", "занята", "не успеваю", "no_time"):
        kind = "busy"
    elif rsn in ("timeout", "ignore", "silent", "soft"):
        kind = "timeout"
    try:
        from tools import dispatch_redis_metrics as _drm

        _r = redis_c.get_redis()
        if _r:
            await _drm.decline_penalty_add(_r, driver_id, kind)
    except Exception:
        pass
    return {"success": True, "trip_id": int(body.trip_id)}


@fastapi_app.post("/api/orders/cancel")
async def cancel_order(request: Request, data: models.CancelOrderRequest):
    """Отмена заказа"""
    redis = redis_c.get_redis()
    session_token = request.cookies.get("taxi_session")
    
    if not session_token:
        return JSONResponse(
            {"success": False, "message": "Не авторизован"},
            status_code=401
        )
    
    user_data = models.get_user_from_token(serializer, session_token)
    
    if not user_data:
        return JSONResponse(
            {"success": False, "message": "Недействительная сессия"},
            status_code=401
        )
    
    user_id = user_data["user_id"]
    user_type_session = user_data["user_type"]
    
    if data.idempotency_key and redis:
        ik = f"idem:cancel:{data.order_id}:{user_id}:{data.idempotency_key}"
        if await idempotency_seen(redis, ik):
            return {
                "success": True,
                "status": "cancelled",
                "order_id": data.order_id,
                "duplicate": True,
            }
    
    if data.user_type != user_type_session:
        return JSONResponse(
            {"success": False, "message": "Некорректный тип пользователя"},
            status_code=403
        )
    
    # Получаем заказ
    order = await db.get_trips(trip_id=data.order_id)
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Проверяем права
    if data.user_type == "client":
        if order.get("client_id") != user_id:
            return JSONResponse(
                {"success": False, "message": "Нет прав"},
                status_code=403
            )
    elif data.user_type == "driver":
        if order.get("driver_id") != user_id:
            return JSONResponse(
                {"success": False, "message": "Нет прав"},
                status_code=403
            )
    
    driver_lat, driver_lon = None, None
    client_lat, client_lon = None, None

    if data.user_type == "driver":
        driver = await db.get_driver(driver_id=user_id)
        driver_lat = driver.get("last_lat")
        driver_lon = driver.get("last_lon")
        cancelled_user_id = order.get("client_id")
    
    elif data.user_type == "client":
        client = await db.get_client(client_id=user_id)
        client_lat = client.get("last_lat")
        client_lon = client.get("last_lon")
        cancelled_user_id = order.get("driver_id")

    # Записываем причину отказа
    cancelled_status = await db.cancel_trip_with_refusal(trip_id=data.order_id, initiator_type=data.user_type, initiator_id=user_id, 
        reason_type=data.reason_type, reason_text=data.reason_text, cancel_stage=order.get("status"), 
        driver_lat=driver_lat, driver_lon=driver_lon, client_lat=client_lat, client_lon=client_lon, penalty_amount=0, penalty_rating=0.2)
    
    # Отменяем поездку
    if cancelled_status != False:
        await db.update_trip_status(trip_id=data.order_id, status="cancelled")
        await db.update_trip_cancelled_at(trip_id=data.order_id, cancelled_at=datetime.datetime.now())
        if data.idempotency_key and redis:
            await idempotency_mark(
                redis, f"idem:cancel:{data.order_id}:{user_id}:{data.idempotency_key}"
            )

    trip_logging.trip_log(
        "trip_cancel",
        trip_id=data.order_id,
        driver_id=order.get("driver_id"),
        client_id=order.get("client_id"),
        status=order.get("status"),
        extra=f"initiator={data.user_type} uid={user_id}",
    )

    fresh_row = await db.get_trips(trip_id=data.order_id) or {}
    rev = fresh_row.get("revision")
    hub = get_hub()

    # Уведомляем другую сторону.
    # Клиент отменил до назначения: driver_id NULL — иначе водители с открытым new_trip не получали trip_cancelled.
    if data.user_type == "client":
        driver_targets: List[int] = []
        if order.get("driver_id") is not None:
            try:
                driver_targets.append(int(order["driver_id"]))
            except (TypeError, ValueError):
                pass
        for key in ("offer_driver_ids", "dispatch_seen_driver_ids"):
            arr = order.get(key)
            if not arr:
                continue
            for x in arr:
                try:
                    driver_targets.append(int(x))
                except (TypeError, ValueError):
                    continue
        seen_notify = set()
        for did in driver_targets:
            if did in seen_notify:
                continue
            seen_notify.add(did)
            cancel_payload = enrich_outbound(
                {
                    "type": "trip_cancelled",
                    "trip_id": data.order_id,
                    "cancelled_user_id": order.get("driver_id"),
                    "message": "Поездка отменена",
                },
                revision=rev,
                ack_required=True,
            )
            await notify_user(hub, redis, "driver", str(did), "trip_cancelled", cancel_payload)
            try:
                await push_notifications.send_event_push(
                    db,
                    "driver",
                    int(did),
                    "driver_trip_cancelled",
                    {"trip_id": str(int(data.order_id))},
                    trip_id=int(data.order_id),
                )
            except Exception:
                logging.getLogger(__name__).exception("push driver_trip_cancelled")
    elif data.user_type == "driver":
        other_party_id = order.get("client_id")
        if other_party_id:
            cancel_payload = enrich_outbound(
                {
                    "type": "trip_cancelled",
                    "trip_id": data.order_id,
                    "cancelled_user_id": cancelled_user_id,
                    "message": "Поездка отменена",
                },
                revision=rev,
                ack_required=True,
            )
            await notify_user(
                hub,
                redis,
                "client",
                str(other_party_id),
                "trip_cancelled",
                cancel_payload,
            )
            try:
                await push_notifications.send_event_push(
                    db,
                    "client",
                    int(other_party_id),
                    "client_trip_cancelled",
                    {"trip_id": str(int(data.order_id))},
                    trip_id=int(data.order_id),
                )
            except Exception:
                logging.getLogger(__name__).exception("push client_trip_cancelled")

    return {"success": True, "status": "cancelled", "order_id": data.order_id}

# ============================================
# OSRM PROXY
# ============================================

@fastapi_app.get("/route/v1/driving/{from_coord};{to_coord}")
async def route_v1_driving(
    from_coord: str,
    to_coord: str,
    overview: str = Query("full"),
    steps: bool = Query(True),
    alternatives: bool = Query(True),
    hints: str = Query(";")
):
    """OSRM routing proxy"""
    from_lon, from_lat = map(float, from_coord.split(","))
    to_lon, to_lat = map(float, to_coord.split(","))
    
    async with httpx.AsyncClient() as client:
        osrm_resp = await client.get(
            f"{OSRM_ROUTE_URL}/{from_lon},{from_lat};{to_lon},{to_lat}",
            params={
                "overview": overview,
                "steps": str(steps).lower(),
                "alternatives": str(alternatives).lower(),
                "hints": hints
            }
        )
        
        if osrm_resp.status_code != 200:
            return JSONResponse(
                content={"code": "Error", "message": "OSRM request failed"},
                status_code=500
            )
        
        return JSONResponse(content=osrm_resp.json())

@fastapi_app.get("/table/v1/driving/{coords}")
async def table_v1_driving(request: Request, coords: str, annotations: str = "duration"):
    """OSRM table proxy"""
    query_params = dict(request.query_params)
    osrm_url = f"{OSRM_TABLE_URL}/{coords}"
    
    if query_params:
        params = "&".join([f"{k}={v}" for k, v in query_params.items()])
        osrm_url += f"?{params}"
    
    async with httpx.AsyncClient() as client:
        osrm_resp = await client.get(osrm_url)
        
        if osrm_resp.status_code != 200:
            return JSONResponse(
                content={"code": "Error", "message": "OSRM table request failed"},
                status_code=500
            )
        
        return JSONResponse(content=osrm_resp.json())


# ============================================
# NOMINATIM PROXY (reverse + search) — фронт: /nominatim/reverse, /nominatim/search
# ============================================


async def _nominatim_proxy(path: str, request: Request) -> JSONResponse:
    """Прокси на NOMINATIM_BACKEND_URL; при выключенном Nominatim — 503 JSON."""
    if not NOMINATIM_ENABLED:
        return JSONResponse(
            content={
                "error": "nominatim_disabled",
                "detail": "NOMINATIM_ENABLED=0 в .env.",
            },
            status_code=503,
        )
    params = dict(request.query_params)
    target = f"{NOMINATIM_BACKEND_URL}{path}"
    timeout = httpx.Timeout(90.0, connect=15.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(
                target,
                params=params,
                headers={"User-Agent": NOMINATIM_HTTP_USER_AGENT},
            )
    except httpx.RequestError as e:
        logging.warning(
            "Nominatim proxy 502: %s — %s (NOMINATIM_BACKEND_URL=%s)",
            target,
            e,
            NOMINATIM_BACKEND_URL,
        )
        return JSONResponse(
            content={
                "error": "nominatim_unreachable",
                "detail": str(e),
                "hint": "Проверьте контейнер Nominatim и NOMINATIM_BACKEND_URL в .env.",
            },
            status_code=502,
        )
    try:
        body = r.json()
    except json.JSONDecodeError:
        return JSONResponse(
            content={
                "error": "nominatim_non_json",
                "http_status": r.status_code,
                "detail": (r.text or "")[:500],
            },
            status_code=502,
        )
    return JSONResponse(content=body, status_code=r.status_code)


@fastapi_app.get("/nominatim/reverse")
async def nominatim_reverse(request: Request):
    """Прокси reverse → NOMINATIM_BACKEND_URL."""
    return await _nominatim_proxy("/reverse", request)


@fastapi_app.get("/nominatim/search")
async def nominatim_search(request: Request):
    """Прокси search → NOMINATIM_BACKEND_URL."""
    return await _nominatim_proxy("/search", request)


# ============================================
# SOCKET.IO + ASGI (оборачивает FastAPI)
# ============================================

app = mount_socketio(fastapi_app, db, serializer)

# ============================================
# START SERVER
# ============================================

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="localhost",
        port=9999,
        reload=True,
        log_level="info"
    )
