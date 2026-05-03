"""
REST API админ-панели. Инициализация: server вызывает init_admin_db(db).
"""
from __future__ import annotations

import logging
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Deque, Dict, List, Literal, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from tools import admin_auth
from tools import push_notifications
from tools.database import Database
from tools.realtime import get_hub

_db: Optional[Database] = None
_audit: Deque[Dict[str, Any]] = deque(maxlen=400)
_logger = logging.getLogger(__name__)

router = APIRouter(tags=["admin"])
security = HTTPBearer(auto_error=False)

_REPO_ROOT = Path(__file__).resolve().parent.parent


async def _revoke_socket_if_admin_blocked(
    user_type: str, user_id: int, patch: Dict[str, Any]
) -> None:
    """Принудительный выход из приложения при бане/деактивации (Socket.IO + клиент снимет cookie)."""
    if patch.get("is_banned") is not True and patch.get("admin_disabled") is not True:
        return
    if user_type not in ("client", "driver"):
        return
    try:
        await get_hub().revoke_user_session(user_type, str(int(user_id)), reason="admin_block")
    except RuntimeError:
        pass
    except Exception:
        _logger.exception("revoke_socket_if_admin_blocked %s:%s", user_type, user_id)


def _compute_admin_static_v() -> str:
    """Версия для ?v= в admin.css / admin.js — max mtime по файлам админки."""
    mtimes: list[float] = []
    for rel in (
        "static/admin/admin.css",
        "static/admin/admin.js",
        "static/admin/index.html",
    ):
        p = _REPO_ROOT / rel
        if p.is_file():
            try:
                mtimes.append(p.stat().st_mtime)
            except OSError:
                continue
    return str(int(max(mtimes))) if mtimes else "0"


ADMIN_STATIC_V = _compute_admin_static_v()


def init_admin_db(database: Database) -> None:
    global _db
    _db = database


def get_db() -> Database:
    if _db is None:
        raise RuntimeError("admin DB not initialized")
    return _db


def audit(action: str, detail: str = "") -> None:
    _audit.appendleft({"ts": time.time(), "action": action, "detail": detail})


async def require_admin(
    creds: HTTPAuthorizationCredentials = Depends(security),
) -> Dict[str, Any]:
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="Требуется Bearer токен")
    payload = admin_auth.decode_admin_access_token(creds.credentials)
    if not payload or payload.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав администратора")
    return payload


class AdminLoginBody(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class ClientAdminPatchBody(BaseModel):
    is_banned: Optional[bool] = None
    admin_disabled: Optional[bool] = None
    phone: Optional[str] = Field(None, max_length=32)
    name: Optional[str] = Field(None, max_length=100)
    surname: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    balance: Optional[float] = None
    rating: Optional[float] = Field(None, ge=0, le=5)
    last_lat: Optional[float] = None
    last_lon: Optional[float] = None
    password: Optional[str] = Field(None, max_length=255)
    photo: Optional[str] = None


class WithdrawalTimelineMessagesBody(BaseModel):
    """Тексты комментариев в истории заявки на вывод (водитель видит в приложении)."""

    withdrawal_timeline_pending: str = Field(..., min_length=1, max_length=600)
    withdrawal_timeline_processing: str = Field(..., min_length=1, max_length=600)
    withdrawal_timeline_completed: str = Field(..., min_length=1, max_length=600)
    withdrawal_timeline_rejected: str = Field(..., min_length=1, max_length=600)


class ProjectSettingsPatchBody(BaseModel):
    price_per_km: Optional[float] = Field(None, ge=0)
    trip_base_fee: Optional[float] = Field(None, ge=0)
    dispatch_wave_timeout_sec: Optional[int] = Field(None, ge=3, le=120)
    dispatch_wave_size: Optional[int] = Field(None, ge=1, le=20)
    pricing_km_tiers_json: Optional[str] = Field(None, max_length=8000)
    pricing_per_minute_azn: Optional[float] = Field(None, ge=0)
    pricing_min_price_azn: Optional[float] = Field(None, ge=0)
    pricing_long_trip_floor_per_km: Optional[float] = Field(None, ge=0)
    pricing_long_trip_km_threshold: Optional[float] = Field(None, ge=0)
    pricing_long_trip_post_cap_mult: Optional[float] = Field(None, ge=1, le=3)
    pricing_long_trip_max_wave_mult: Optional[float] = Field(None, ge=1, le=2)
    pricing_quote_nearby_driver_km: Optional[float] = Field(None, ge=0, le=50)
    pricing_market_ref_high_mult: Optional[float] = Field(None, ge=1, le=1.35)
    pricing_market_ref_low_mult: Optional[float] = Field(None, ge=0.5, le=1)
    pricing_market_ref_short_max_km: Optional[float] = Field(
        None, ge=0, le=500, description="Если >0 и задан якорь ₼/км — для поездок с км ≤ этого порога"
    )
    pricing_market_ref_pkm_short: Optional[float] = Field(
        None, ge=0, le=2.5, description="Якорь ₼/км для коротких (0 = не использовать)"
    )
    dispatch_priority_dist_weight: Optional[float] = Field(None, ge=0, le=0.35)
    dispatch_min_offer_gap_sec: Optional[float] = Field(None, ge=0, le=120)
    dispatch_wave1_share: Optional[float] = Field(None, ge=0.05, le=0.55)
    dispatch_wave2_share: Optional[float] = Field(None, ge=0.05, le=0.55)
    dispatch_tier2_price_surge: Optional[float] = Field(None, ge=0, le=0.08)
    dispatch_tier3_extra_price_surge: Optional[float] = Field(None, ge=0, le=0.06)
    dispatch_decline_penalty_per_streak: Optional[float] = Field(None, ge=0, le=0.25)
    dispatch_react_fast_sec: Optional[float] = Field(None, ge=1, le=30)
    dispatch_react_slow_sec: Optional[float] = Field(None, ge=2, le=120)
    dispatch_react_fast_bonus: Optional[float] = Field(None, ge=0, le=0.15)
    dispatch_react_slow_penalty: Optional[float] = Field(None, ge=0, le=0.15)
    dispatch_far_km_threshold: Optional[float] = Field(None, ge=2, le=12)
    dispatch_far_priority_bonus: Optional[float] = Field(None, ge=0, le=0.12)
    dispatch_load_penalty_per_trip: Optional[float] = Field(None, ge=0.01, le=0.09)
    dispatch_priority_rating_weight: Optional[float] = Field(None, ge=1, le=4)
    dispatch_priority_accept_sq_weight: Optional[float] = Field(None, ge=1, le=4)
    dispatch_idle_long_sec: Optional[float] = Field(None, ge=120, le=7200)
    dispatch_decline_penalty_scale: Optional[float] = Field(None, ge=0, le=0.25)
    dispatch_time_surge_at_15: Optional[float] = Field(None, ge=5, le=120)
    dispatch_time_surge_at_30: Optional[float] = Field(None, ge=6, le=180)
    dispatch_time_surge_at_45: Optional[float] = Field(None, ge=7, le=300)
    dispatch_time_surge_pct_15: Optional[float] = Field(None, ge=0, le=0.04)
    dispatch_time_surge_pct_30: Optional[float] = Field(None, ge=0, le=0.04)
    dispatch_time_surge_pct_45: Optional[float] = Field(None, ge=0, le=0.04)
    dispatch_time_surge_total_cap: Optional[float] = Field(None, ge=0, le=0.12)
    dispatch_solo_min_accept: Optional[float] = Field(None, ge=0.35, le=0.95)
    dispatch_solo_min_rating: Optional[float] = Field(None, ge=3, le=5)
    dispatch_near_good_km: Optional[float] = Field(None, ge=0.3, le=2)
    dispatch_near_good_min_accept: Optional[float] = Field(None, ge=0.35, le=0.95)
    dispatch_near_good_min_rating: Optional[float] = Field(None, ge=3, le=5)
    dispatch_wave_max_pick_km: Optional[float] = Field(None, ge=1.2, le=6)
    dispatch_trip_repeat_cooldown_sec: Optional[float] = Field(None, ge=15, le=120)
    dispatch_distw_auto: Optional[float] = Field(None, ge=0, le=1)
    dispatch_distw_density_low_n: Optional[float] = Field(None, ge=2, le=20)
    dispatch_distw_density_high_n: Optional[float] = Field(None, ge=3, le=40)
    dispatch_distw_sparse: Optional[float] = Field(None, ge=0.1, le=0.3)
    dispatch_distw_dense: Optional[float] = Field(None, ge=0.1, le=0.3)
    dispatch_score_dist_ref_km: Optional[float] = Field(None, ge=0.8, le=8)
    dispatch_score_load_ref_trips: Optional[float] = Field(None, ge=2, le=24)
    dispatch_idle_score_weight: Optional[float] = Field(None, ge=0.1, le=1.2)
    dispatch_stability_bonus_max: Optional[float] = Field(None, ge=0, le=0.12)
    dispatch_stability_var_threshold: Optional[float] = Field(None, ge=0.02, le=0.35)
    dispatch_client_slow_hint_sec: Optional[float] = Field(None, ge=25, le=120)
    dispatch_client_boost_pct: Optional[float] = Field(None, ge=0.01, le=0.08)
    dispatch_client_boost_price_mult: Optional[float] = Field(None, ge=1, le=1.12)
    dispatch_wave1_min_size: Optional[float] = Field(None, ge=1, le=4)


class PushTemplatePatchBody(BaseModel):
    title_template: str = Field(..., min_length=1, max_length=300)
    body_template: str = Field(..., min_length=1, max_length=2000)
    subtitle_template: str = Field("", max_length=500)


class AdminWithdrawalPatchBody(BaseModel):
    status: Literal["pending", "processing", "completed", "rejected"] = Field(
        ..., description="Новый статус заявки на вывод"
    )
    comment: str = Field("", max_length=2000)


class AdminPushTestBody(BaseModel):
    user_type: Literal["client", "driver"]
    user_id: int = Field(..., ge=1)
    title: str = Field("Тест уведомления", min_length=1, max_length=300)
    body: str = Field(
        "Если вы видите это сообщение, Web Push настроен верно.",
        min_length=1,
        max_length=2000,
    )
    subtitle: str = Field("", max_length=500)
    url: str = Field("/", max_length=500)
    trip_id: Optional[int] = Field(None, ge=1)


class DriverAdminPatchBody(BaseModel):
    is_banned: Optional[bool] = None
    admin_disabled: Optional[bool] = None
    verification: Optional[str] = None
    status: Optional[str] = None
    phone: Optional[str] = Field(None, max_length=32)
    name: Optional[str] = Field(None, max_length=100)
    surname: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    car_name: Optional[str] = Field(None, max_length=100)
    car_number: Optional[str] = Field(None, max_length=32)
    car_category: Optional[str] = Field(None, max_length=50)
    car_year: Optional[int] = Field(None, ge=1950, le=2035)
    balance: Optional[float] = None
    rating: Optional[float] = Field(None, ge=0, le=5)
    price_per_km: Optional[float] = Field(None, ge=0)
    rating_coefficient: Optional[float] = Field(None, ge=0, le=20)
    car_tech_passport: Optional[str] = Field(None, max_length=100)
    driver_license: Optional[str] = Field(None, max_length=100)
    last_lat: Optional[float] = None
    last_lon: Optional[float] = None
    password: Optional[str] = Field(None, max_length=255)
    acceptance_rate: Optional[float] = Field(None, ge=0, le=1)


@router.post("/admin/login")
async def admin_login(body: AdminLoginBody):
    if not admin_auth.verify_admin_credentials(body.username, body.password):
        audit("admin_login_failed", body.username)
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    token = admin_auth.create_admin_access_token(admin_id=1)
    audit("admin_login_ok", body.username)
    return {"access_token": token, "token_type": "bearer"}


@router.get("/admin")
@router.get("/admin/ui")
async def admin_ui():
    path = _REPO_ROOT / "static/admin/index.html"
    raw = path.read_text(encoding="utf-8")
    html = raw.replace("{{ static_v }}", ADMIN_STATIC_V)
    return HTMLResponse(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
        },
    )


def _online_from_hub() -> Dict[str, Any]:
    try:
        hub = get_hub()
    except RuntimeError:
        return {"drivers": [], "clients": [], "admins": [], "total_users_online": 0}
    drivers: List[str] = []
    clients: List[str] = []
    admins: List[str] = []
    for key in hub.user_to_sid.keys():
        if key.startswith("driver:"):
            drivers.append(key.split(":", 1)[1])
        elif key.startswith("client:"):
            clients.append(key.split(":", 1)[1])
        elif key.startswith("admin:"):
            admins.append(key.split(":", 1)[1])
    total = len(drivers) + len(clients)
    return {
        "driver_ids_online": drivers,
        "client_ids_online": clients,
        "admin_ids_online": admins,
        "total_users_online": total,
        "drivers_online_socket": len(drivers),
    }


@router.get("/admin/stats")
async def admin_stats(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    counts = await db.admin_count_stats()
    online = _online_from_hub()
    clients_total = int(counts.get("clients_total") or 0)
    drivers_total = int(counts.get("drivers_total") or 0)
    return {
        "total_users": clients_total + drivers_total,
        "clients_total": clients_total,
        "drivers_total": drivers_total,
        "online_users_socket": online["total_users_online"],
        "drivers_online_socket": online["drivers_online_socket"],
        "clients_online_socket": len(online.get("client_ids_online") or []),
        "admins_online_socket": len(online.get("admin_ids_online") or []),
        "drivers_active_status": int(counts.get("drivers_active_status") or 0),
        "drivers_status_available": int(counts.get("drivers_status_available") or 0),
        "drivers_status_busy": int(counts.get("drivers_status_busy") or 0),
        "drivers_status_offline": int(counts.get("drivers_status_offline") or 0),
        "drivers_restricted": int(counts.get("drivers_restricted") or 0),
        "active_trips": int(counts.get("trips_active") or 0),
        "trips_pending": int(counts.get("trips_pending") or 0),
        "trips_offered": int(counts.get("trips_offered") or 0),
        "completed_trips": int(counts.get("trips_completed") or 0),
        "trips_cancelled": int(counts.get("trips_cancelled") or 0),
        "trips_created_today": int(counts.get("trips_created_today") or 0),
        "trips_completed_today": int(counts.get("trips_completed_today") or 0),
        "trips_cancelled_today": int(counts.get("trips_cancelled_today") or 0),
        "avg_driver_rating": float(counts.get("avg_driver_rating") or 0),
        "avg_client_rating": float(counts.get("avg_client_rating") or 0),
        "drivers_verif_pending": int(counts.get("drivers_verif_pending") or 0),
        "drivers_verif_verified": int(counts.get("drivers_verif_verified") or 0),
        "drivers_verif_refused": int(counts.get("drivers_verif_refused") or 0),
        "revenue_completed_total": float(counts.get("revenue_completed_total") or 0),
        "revenue_completed_today": float(counts.get("revenue_completed_today") or 0),
        "trips_created_7d": int(counts.get("trips_created_7d") or 0),
        "trips_accepted": int(counts.get("trips_accepted") or 0),
        "drivers_registered_today": int(counts.get("drivers_registered_today") or 0),
        "clients_restricted": int(counts.get("clients_restricted") or 0),
        "clients_banned": int(counts.get("clients_banned") or 0),
        "drivers_banned": int(counts.get("drivers_banned") or 0),
        "drivers_deactivated_only": int(counts.get("drivers_deactivated_only") or 0),
        "trips_busy": int(counts.get("trips_busy") or 0),
        "avg_km_completed": float(counts.get("avg_km_completed") or 0),
        "refusals_today": int(counts.get("refusals_today") or 0),
        "trips_completed_7d": int(counts.get("trips_completed_7d") or 0),
        "dispatch_avg_accept_sec_24h": float(counts.get("dispatch_avg_accept_sec_24h") or 0),
        "dispatch_accept_samples_24h": int(counts.get("dispatch_accept_samples_24h") or 0),
        "dispatch_avg_price_per_km_24h": float(counts.get("dispatch_avg_price_per_km_24h") or 0),
        "socket": online,
    }


@router.get("/admin/project-settings")
async def admin_project_settings_get(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    data = await db.admin_get_project_settings()
    return JSONResponse(
        content=data,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


@router.patch("/admin/project-settings")
async def admin_project_settings_patch(
    body: ProjectSettingsPatchBody,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    if (
        body.price_per_km is None
        and body.trip_base_fee is None
        and body.dispatch_wave_timeout_sec is None
        and body.dispatch_wave_size is None
        and body.pricing_km_tiers_json is None
        and body.pricing_per_minute_azn is None
        and body.pricing_min_price_azn is None
        and body.pricing_long_trip_floor_per_km is None
        and body.pricing_long_trip_km_threshold is None
        and body.pricing_long_trip_post_cap_mult is None
        and body.pricing_long_trip_max_wave_mult is None
        and body.pricing_quote_nearby_driver_km is None
        and body.pricing_market_ref_high_mult is None
        and body.pricing_market_ref_low_mult is None
        and body.pricing_market_ref_short_max_km is None
        and body.pricing_market_ref_pkm_short is None
        and body.dispatch_priority_dist_weight is None
        and body.dispatch_min_offer_gap_sec is None
        and body.dispatch_wave1_share is None
        and body.dispatch_wave2_share is None
        and body.dispatch_tier2_price_surge is None
        and body.dispatch_tier3_extra_price_surge is None
        and body.dispatch_decline_penalty_per_streak is None
        and body.dispatch_react_fast_sec is None
        and body.dispatch_react_slow_sec is None
        and body.dispatch_react_fast_bonus is None
        and body.dispatch_react_slow_penalty is None
        and body.dispatch_far_km_threshold is None
        and body.dispatch_far_priority_bonus is None
        and body.dispatch_load_penalty_per_trip is None
        and body.dispatch_priority_rating_weight is None
        and body.dispatch_priority_accept_sq_weight is None
        and body.dispatch_idle_long_sec is None
        and body.dispatch_decline_penalty_scale is None
        and body.dispatch_time_surge_at_15 is None
        and body.dispatch_time_surge_at_30 is None
        and body.dispatch_time_surge_at_45 is None
        and body.dispatch_time_surge_pct_15 is None
        and body.dispatch_time_surge_pct_30 is None
        and body.dispatch_time_surge_pct_45 is None
        and body.dispatch_time_surge_total_cap is None
        and body.dispatch_solo_min_accept is None
        and body.dispatch_solo_min_rating is None
        and body.dispatch_near_good_km is None
        and body.dispatch_near_good_min_accept is None
        and body.dispatch_near_good_min_rating is None
        and body.dispatch_wave_max_pick_km is None
        and body.dispatch_trip_repeat_cooldown_sec is None
        and body.dispatch_distw_auto is None
        and body.dispatch_distw_density_low_n is None
        and body.dispatch_distw_density_high_n is None
        and body.dispatch_distw_sparse is None
        and body.dispatch_distw_dense is None
        and body.dispatch_score_dist_ref_km is None
        and body.dispatch_score_load_ref_trips is None
        and body.dispatch_idle_score_weight is None
        and body.dispatch_stability_bonus_max is None
        and body.dispatch_stability_var_threshold is None
        and body.dispatch_client_slow_hint_sec is None
        and body.dispatch_client_boost_pct is None
        and body.dispatch_client_boost_price_mult is None
        and body.dispatch_wave1_min_size is None
    ):
        raise HTTPException(
            status_code=400,
            detail="Укажите хотя бы одно поле: тарифы или параметры диспетчеризации",
        )
    await db.admin_set_project_settings(
        price_per_km=body.price_per_km,
        trip_base_fee=body.trip_base_fee,
        dispatch_wave_timeout_sec=body.dispatch_wave_timeout_sec,
        dispatch_wave_size=body.dispatch_wave_size,
        pricing_km_tiers_json=body.pricing_km_tiers_json,
        pricing_per_minute_azn=body.pricing_per_minute_azn,
        pricing_min_price_azn=body.pricing_min_price_azn,
        pricing_long_trip_floor_per_km=body.pricing_long_trip_floor_per_km,
        pricing_long_trip_km_threshold=body.pricing_long_trip_km_threshold,
        pricing_long_trip_post_cap_mult=body.pricing_long_trip_post_cap_mult,
        pricing_long_trip_max_wave_mult=body.pricing_long_trip_max_wave_mult,
        pricing_quote_nearby_driver_km=body.pricing_quote_nearby_driver_km,
        pricing_market_ref_high_mult=body.pricing_market_ref_high_mult,
        pricing_market_ref_low_mult=body.pricing_market_ref_low_mult,
        pricing_market_ref_short_max_km=body.pricing_market_ref_short_max_km,
        pricing_market_ref_pkm_short=body.pricing_market_ref_pkm_short,
        dispatch_priority_dist_weight=body.dispatch_priority_dist_weight,
        dispatch_min_offer_gap_sec=body.dispatch_min_offer_gap_sec,
        dispatch_wave1_share=body.dispatch_wave1_share,
        dispatch_wave2_share=body.dispatch_wave2_share,
        dispatch_tier2_price_surge=body.dispatch_tier2_price_surge,
        dispatch_tier3_extra_price_surge=body.dispatch_tier3_extra_price_surge,
        dispatch_decline_penalty_per_streak=body.dispatch_decline_penalty_per_streak,
        dispatch_react_fast_sec=body.dispatch_react_fast_sec,
        dispatch_react_slow_sec=body.dispatch_react_slow_sec,
        dispatch_react_fast_bonus=body.dispatch_react_fast_bonus,
        dispatch_react_slow_penalty=body.dispatch_react_slow_penalty,
        dispatch_far_km_threshold=body.dispatch_far_km_threshold,
        dispatch_far_priority_bonus=body.dispatch_far_priority_bonus,
        dispatch_load_penalty_per_trip=body.dispatch_load_penalty_per_trip,
        dispatch_priority_rating_weight=body.dispatch_priority_rating_weight,
        dispatch_priority_accept_sq_weight=body.dispatch_priority_accept_sq_weight,
        dispatch_idle_long_sec=body.dispatch_idle_long_sec,
        dispatch_decline_penalty_scale=body.dispatch_decline_penalty_scale,
        dispatch_time_surge_at_15=body.dispatch_time_surge_at_15,
        dispatch_time_surge_at_30=body.dispatch_time_surge_at_30,
        dispatch_time_surge_at_45=body.dispatch_time_surge_at_45,
        dispatch_time_surge_pct_15=body.dispatch_time_surge_pct_15,
        dispatch_time_surge_pct_30=body.dispatch_time_surge_pct_30,
        dispatch_time_surge_pct_45=body.dispatch_time_surge_pct_45,
        dispatch_time_surge_total_cap=body.dispatch_time_surge_total_cap,
        dispatch_solo_min_accept=body.dispatch_solo_min_accept,
        dispatch_solo_min_rating=body.dispatch_solo_min_rating,
        dispatch_near_good_km=body.dispatch_near_good_km,
        dispatch_near_good_min_accept=body.dispatch_near_good_min_accept,
        dispatch_near_good_min_rating=body.dispatch_near_good_min_rating,
        dispatch_wave_max_pick_km=body.dispatch_wave_max_pick_km,
        dispatch_trip_repeat_cooldown_sec=body.dispatch_trip_repeat_cooldown_sec,
        dispatch_distw_auto=body.dispatch_distw_auto,
        dispatch_distw_density_low_n=body.dispatch_distw_density_low_n,
        dispatch_distw_density_high_n=body.dispatch_distw_density_high_n,
        dispatch_distw_sparse=body.dispatch_distw_sparse,
        dispatch_distw_dense=body.dispatch_distw_dense,
        dispatch_score_dist_ref_km=body.dispatch_score_dist_ref_km,
        dispatch_score_load_ref_trips=body.dispatch_score_load_ref_trips,
        dispatch_idle_score_weight=body.dispatch_idle_score_weight,
        dispatch_stability_bonus_max=body.dispatch_stability_bonus_max,
        dispatch_stability_var_threshold=body.dispatch_stability_var_threshold,
        dispatch_client_slow_hint_sec=body.dispatch_client_slow_hint_sec,
        dispatch_client_boost_pct=body.dispatch_client_boost_pct,
        dispatch_client_boost_price_mult=body.dispatch_client_boost_price_mult,
        dispatch_wave1_min_size=body.dispatch_wave1_min_size,
    )
    audit(
        "project_settings",
        f"price_per_km={body.price_per_km} trip_base_fee={body.trip_base_fee} "
        f"dispatch_timeout={body.dispatch_wave_timeout_sec} dispatch_size={body.dispatch_wave_size} "
        f"pricing_tiers_set={body.pricing_km_tiers_json is not None}",
    )
    out = {"ok": True, **(await db.admin_get_project_settings())}
    return JSONResponse(
        content=out,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


@router.patch("/admin/project-settings/withdrawal-messages")
async def admin_withdrawal_timeline_messages_patch(
    body: WithdrawalTimelineMessagesBody,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    await db.admin_set_withdrawal_timeline_messages(
        pending=body.withdrawal_timeline_pending,
        processing=body.withdrawal_timeline_processing,
        completed=body.withdrawal_timeline_completed,
        rejected=body.withdrawal_timeline_rejected,
    )
    audit("withdrawal_timeline_messages", "updated")
    data = await db.admin_get_project_settings()
    return JSONResponse(
        content={"ok": True, **data},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


@router.get("/admin/analytics")
async def admin_analytics(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    snap = await db.admin_analytics_snapshot()
    stats = await db.admin_count_stats()
    snap["summary"] = {
        "trips_total": sum(int(v) for v in (snap.get("trips_by_status") or {}).values()),
        "drivers_total": int(stats.get("drivers_total") or 0),
        "clients_total": int(stats.get("clients_total") or 0),
    }
    return snap


@router.get("/admin/online-users")
async def admin_online_users(
    _: Dict[str, Any] = Depends(require_admin),
):
    return _online_from_hub()


@router.get("/admin/drivers")
async def admin_drivers(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    q: Optional[str] = Query(None),
    sort_by: str = Query("driver_id"),
    sort_dir: str = Query("desc"),
    verification: Optional[str] = Query(
        None, description="pending | verified | refused"
    ),
):
    return {
        "items": await db.admin_list_drivers(
            limit=limit,
            offset=offset,
            q=q,
            sort_by=sort_by,
            sort_dir=sort_dir,
            verification=verification,
        )
    }


@router.get("/admin/drivers/{driver_id}")
async def admin_driver_detail(
    driver_id: int,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    row = await db.admin_get_driver_public(driver_id)
    if not row:
        raise HTTPException(status_code=404, detail="Водитель не найден")
    return row


@router.patch("/admin/drivers/{driver_id}")
async def admin_driver_patch(
    driver_id: int,
    body: DriverAdminPatchBody,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    data = body.model_dump(exclude_unset=True)
    driver_allowed = frozenset(
        {
            "is_banned",
            "admin_disabled",
            "verification",
            "status",
            "phone",
            "name",
            "surname",
            "email",
            "car_name",
            "car_number",
            "car_category",
            "car_year",
            "balance",
            "rating",
            "price_per_km",
            "rating_coefficient",
            "car_tech_passport",
            "driver_license",
            "last_lat",
            "last_lon",
            "password",
            "acceptance_rate",
        }
    )
    if not data:
        raise HTTPException(status_code=400, detail="Передайте поля для изменения")
    if not driver_allowed.intersection(data.keys()):
        raise HTTPException(status_code=400, detail="Нет поддерживаемых полей для водителя")
    existing = await db.admin_get_driver_public(driver_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Водитель не найден")

    patch: Dict[str, Any] = {}
    if "phone" in data:
        p = (data["phone"] or "").strip()
        if not p:
            raise HTTPException(status_code=400, detail="Телефон не может быть пустым")
        patch["phone"] = p
    if "name" in data:
        n = (data["name"] or "").strip()
        if not n:
            raise HTTPException(status_code=400, detail="Имя не может быть пустым")
        patch["name"] = n
    if "surname" in data:
        n = (data["surname"] or "").strip()
        if not n:
            raise HTTPException(status_code=400, detail="Фамилия не может быть пустой")
        patch["surname"] = n
    if "email" in data:
        e = (data["email"] or "").strip()
        patch["email"] = e if e else None
    if "car_name" in data:
        patch["car_name"] = (data["car_name"] or "").strip() or "Unknown"
    if "car_number" in data:
        cn = (data["car_number"] or "").strip()
        if not cn:
            raise HTTPException(status_code=400, detail="Номер авто не может быть пустым")
        patch["car_number"] = cn
    if "car_category" in data:
        patch["car_category"] = (data["car_category"] or "").strip() or "Econom"
    if "car_year" in data:
        patch["car_year"] = int(data["car_year"])
    if "balance" in data and data["balance"] is not None:
        patch["balance"] = float(data["balance"])
    if "rating" in data and data["rating"] is not None:
        patch["rating"] = float(data["rating"])
    if "price_per_km" in data and data["price_per_km"] is not None:
        patch["price_per_km"] = float(data["price_per_km"])
    if "rating_coefficient" in data and data["rating_coefficient"] is not None:
        patch["rating_coefficient"] = float(data["rating_coefficient"])
    if "acceptance_rate" in data and data["acceptance_rate"] is not None:
        patch["acceptance_rate"] = float(data["acceptance_rate"])
    if "car_tech_passport" in data:
        patch["car_tech_passport"] = (data["car_tech_passport"] or "").strip()
    if "driver_license" in data:
        patch["driver_license"] = (data["driver_license"] or "").strip()
    if "last_lat" in data:
        patch["last_lat"] = data["last_lat"]
    if "last_lon" in data:
        patch["last_lon"] = data["last_lon"]
    if "password" in data:
        pw = (data["password"] or "").strip()
        if pw:
            patch["password"] = pw
    if "verification" in data and data["verification"] is not None:
        v = str(data["verification"]).strip().lower()
        if v not in ("pending", "verified", "refused"):
            raise HTTPException(status_code=400, detail="verification: pending | verified | refused")
        patch["verification"] = v
    if "status" in data and data["status"] is not None:
        st = str(data["status"]).strip().lower()
        if st not in ("available", "busy", "offline"):
            raise HTTPException(status_code=400, detail="status: available | busy | offline")
        patch["status"] = st
    if "is_banned" in data:
        patch["is_banned"] = data["is_banned"]
    if "admin_disabled" in data:
        patch["admin_disabled"] = data["admin_disabled"]
    if patch.get("is_banned") is True or patch.get("admin_disabled") is True:
        patch["status"] = "offline"

    if patch:
        try:
            await db.update_driver(driver_id, **patch)
        except asyncpg.UniqueViolationError:
            raise HTTPException(
                status_code=409, detail="Такой телефон уже занят другим пользователем"
            ) from None
        await _revoke_socket_if_admin_blocked("driver", driver_id, patch)

    audit("driver_patch", f"id={driver_id} keys={list(data.keys())}")
    return {"ok": True, "driver_id": driver_id}


@router.delete("/admin/drivers/{driver_id}")
async def admin_driver_delete(
    driver_id: int,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    existing = await db.admin_get_driver_public(driver_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Водитель не найден")
    try:
        await db.admin_delete_driver(driver_id)
    except asyncpg.ForeignKeyViolationError as e:
        raise HTTPException(
            status_code=409,
            detail="Нельзя удалить: остались связанные данные. Подробности в логе сервера.",
        ) from e
    audit("driver_delete", f"id={driver_id}")
    return {"ok": True, "driver_id": driver_id}


@router.get("/admin/clients")
async def admin_clients(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    q: Optional[str] = Query(None),
    sort_by: str = Query("client_id"),
    sort_dir: str = Query("desc"),
):
    return {
        "items": await db.admin_list_clients(
            limit=limit, offset=offset, q=q, sort_by=sort_by, sort_dir=sort_dir
        )
    }


@router.get("/admin/clients/{client_id}")
async def admin_client_detail(
    client_id: int,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    row = await db.admin_get_client_public(client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return row


@router.patch("/admin/clients/{client_id}")
async def admin_client_patch(
    client_id: int,
    body: ClientAdminPatchBody,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    data = body.model_dump(exclude_unset=True)
    client_allowed = frozenset(
        {
            "is_banned",
            "admin_disabled",
            "phone",
            "name",
            "surname",
            "email",
            "balance",
            "rating",
            "last_lat",
            "last_lon",
            "password",
            "photo",
        }
    )
    if not data:
        raise HTTPException(status_code=400, detail="Передайте поля для изменения")
    if not client_allowed.intersection(data.keys()):
        raise HTTPException(status_code=400, detail="Нет поддерживаемых полей для клиента")
    existing = await db.admin_get_client_public(client_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Клиент не найден")

    patch: Dict[str, Any] = {}
    if "phone" in data:
        p = (data["phone"] or "").strip()
        if not p:
            raise HTTPException(status_code=400, detail="Телефон не может быть пустым")
        patch["phone"] = p
    if "name" in data:
        n = (data["name"] or "").strip()
        if not n:
            raise HTTPException(status_code=400, detail="Имя не может быть пустым")
        patch["name"] = n
    if "surname" in data:
        n = (data["surname"] or "").strip()
        if not n:
            raise HTTPException(status_code=400, detail="Фамилия не может быть пустой")
        patch["surname"] = n
    if "email" in data:
        e = (data["email"] or "").strip()
        patch["email"] = e if e else None
    if "balance" in data and data["balance"] is not None:
        patch["balance"] = float(data["balance"])
    if "rating" in data and data["rating"] is not None:
        patch["rating"] = float(data["rating"])
    if "last_lat" in data:
        patch["last_lat"] = data["last_lat"]
    if "last_lon" in data:
        patch["last_lon"] = data["last_lon"]
    if "password" in data:
        pw = (data["password"] or "").strip()
        if pw:
            patch["password"] = pw
    if "photo" in data:
        ph = data["photo"]
        if ph is None:
            patch["photo"] = None
        elif isinstance(ph, str) and ph.strip():
            patch["photo"] = ph.strip()
    if "is_banned" in data:
        patch["is_banned"] = data["is_banned"]
    if "admin_disabled" in data:
        patch["admin_disabled"] = data["admin_disabled"]

    if patch:
        try:
            await db.update_client(client_id, **patch)
        except asyncpg.UniqueViolationError:
            raise HTTPException(
                status_code=409, detail="Такой телефон уже занят другим пользователем"
            ) from None
        await _revoke_socket_if_admin_blocked("client", client_id, patch)

    audit("client_patch", f"id={client_id} keys={list(data.keys())}")
    return {"ok": True, "client_id": client_id}


@router.delete("/admin/clients/{client_id}")
async def admin_client_delete(
    client_id: int,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    existing = await db.admin_get_client_public(client_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    try:
        await db.admin_delete_client(client_id)
    except asyncpg.ForeignKeyViolationError as e:
        raise HTTPException(
            status_code=409,
            detail="Нельзя удалить: остались связанные данные.",
        ) from e
    audit("client_delete", f"id={client_id}")
    return {"ok": True, "client_id": client_id}


@router.get("/admin/trips/{trip_id}")
async def admin_trip_detail(
    trip_id: int,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    row = await db.admin_get_trip(trip_id)
    if not row:
        raise HTTPException(status_code=404, detail="Поездка не найдена")
    return row


@router.delete("/admin/trips/{trip_id}")
async def admin_trip_delete(
    trip_id: int,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    existing = await db.admin_get_trip(trip_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Поездка не найдена")
    try:
        await db.admin_delete_trip(trip_id)
    except asyncpg.ForeignKeyViolationError as e:
        raise HTTPException(
            status_code=409,
            detail="Нельзя удалить: остались связанные данные.",
        ) from e
    audit("trip_delete", f"id={trip_id}")
    return {"ok": True, "trip_id": trip_id}


@router.get("/admin/trips")
async def admin_trips(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    q: Optional[str] = Query(None),
    sort_by: str = Query("created_at"),
    sort_dir: str = Query("desc"),
):
    return {
        "items": await db.admin_list_trips(
            limit=limit,
            offset=offset,
            status=status,
            date_from=date_from,
            date_to=date_to,
            q=q,
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
    }


@router.get("/admin/positions")
async def admin_positions(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    return await db.admin_map_snapshot()


@router.get("/admin/logs")
async def admin_logs(
    _: Dict[str, Any] = Depends(require_admin),
    limit: int = Query(100, ge=1, le=400),
):
    return {"items": list(_audit)[:limit]}


@router.get("/admin/push-templates")
async def admin_push_templates_list(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    rows = await db.list_push_notification_templates()
    items: List[Dict[str, Any]] = []
    for r in rows:
        item = dict(r)
        ek = str(item.get("event_key") or "").strip()
        item["placeholder_help"] = push_notifications.push_template_placeholder_hint(ek)
        items.append(item)
    return {"items": items}


@router.patch("/admin/push-templates/{event_key}")
async def admin_push_templates_patch(
    event_key: str,
    body: PushTemplatePatchBody,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    ek = (event_key or "").strip()
    if not ek or len(ek) > 64:
        raise HTTPException(status_code=400, detail="Некорректный ключ события")
    existing = await db.get_push_notification_template(ek)
    if not existing:
        raise HTTPException(status_code=404, detail="Неизвестный ключ шаблона")
    await db.upsert_push_notification_template(
        ek,
        body.title_template,
        body.body_template,
        body.subtitle_template,
    )
    audit("push_template_update", ek)
    row = await db.get_push_notification_template(ek)
    return {"ok": True, "item": row}


@router.post("/admin/push/test")
async def admin_push_test_send(
    body: AdminPushTestBody,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    from tools.pwa_push import send_web_push_to_user

    subs = await db.list_push_subscriptions_for_user(
        body.user_type, int(body.user_id)
    )
    n_subs = len(subs or [])
    n = await send_web_push_to_user(
        db,
        body.user_type,
        int(body.user_id),
        title=body.title.strip(),
        body=body.body.strip(),
        subtitle=(body.subtitle or "").strip() or None,
        url=(body.url or "/").strip() or "/",
        trip_id=body.trip_id,
    )
    _logger.info(
        "admin push test: %s:%s subscriptions_in_db=%s delivered_ok=%s",
        body.user_type,
        body.user_id,
        n_subs,
        n,
    )
    audit(
        "push_test",
        f"type={body.user_type} id={body.user_id} ok_subscriptions={n}",
    )
    return {
        "ok": True,
        "delivered_to_subscriptions": n,
        "subscriptions_in_db": n_subs,
    }


def _fmt_money_push(v: Any) -> str:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return str(v or "")
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return s or "0"


@router.get("/admin/withdrawals")
async def admin_withdrawals_list(
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
    status: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=300),
    offset: int = Query(0, ge=0),
):
    st = (status or "").strip().lower() or None
    if st and st not in ("pending", "processing", "completed", "rejected"):
        raise HTTPException(status_code=400, detail="Некорректный статус")
    items = await db.admin_list_withdrawals(status=st, limit=limit, offset=offset)
    return {"items": items}


@router.patch("/admin/withdrawals/{withdrawal_id}")
async def admin_withdrawals_patch(
    withdrawal_id: int,
    body: AdminWithdrawalPatchBody,
    admin: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    actor = str(admin.get("sub") or admin.get("username") or "admin")
    row = await db.admin_patch_withdrawal_request(
        int(withdrawal_id),
        body.status,
        body.comment or "",
        actor_label=actor,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Заявка не найдена или недопустимый переход")
    audit("withdrawal_patch", f"id={withdrawal_id} status={body.status}")
    did = int(row["driver_id"])
    wid = int(row["id"])
    amt_s = _fmt_money_push(row.get("amount"))
    last4 = str(row.get("card_last4") or "")
    tl = row.get("timeline") or []
    last_comment = ""
    if isinstance(tl, list) and tl:
        last_comment = str(tl[-1].get("comment") or "").strip()
    reason = last_comment or (body.comment or "").strip() or "—"
    ctx_base = {
        "withdrawal_id": str(wid),
        "amount": amt_s,
        "card_last4": last4,
        "reason": reason,
    }
    try:
        if body.status == "processing":
            await push_notifications.send_event_push(
                db,
                "driver",
                did,
                "driver_withdraw_processing",
                ctx_base,
                url="/",
            )
        elif body.status == "completed":
            await push_notifications.send_event_push(
                db,
                "driver",
                did,
                "driver_withdraw_completed",
                ctx_base,
                url="/",
            )
        elif body.status == "rejected":
            await push_notifications.send_event_push(
                db,
                "driver",
                did,
                "driver_withdraw_rejected",
                ctx_base,
                url="/",
            )
    except Exception:
        _logger.exception("withdrawal admin push failed id=%s", withdrawal_id)
    return {"ok": True, "item": row}


@router.delete("/admin/withdrawals/{withdrawal_id}")
async def admin_withdrawals_delete(
    withdrawal_id: int,
    _: Dict[str, Any] = Depends(require_admin),
    db: Database = Depends(get_db),
):
    out = await db.admin_delete_withdrawal_request(int(withdrawal_id))
    if not out:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    audit("withdrawal_delete", f"id={withdrawal_id} credited={out.get('balance_credited')}")
    return {"ok": True, **out}
