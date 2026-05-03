"""
Web Push (VAPID) для PWA: подписки в БД и отправка уведомлений.
Переменные окружения: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CLAIM_EMAIL (mailto:...).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from tools import models

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pwa"])


def _env_scalar(name: str) -> str:
    """
    Значение из окружения без пробелов; снимает обрамляющие кавычки и переводы строк
    (частая причина 403 BadJwtToken у FCM — «битый» приватный ключ в .env).
    """
    v = (os.getenv(name) or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        v = v[1:-1].strip()
    return v.replace("\n", "").replace("\r", "").strip()


def _vapid_sub_claim(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return "mailto:alex@example.com"
    if not s.lower().startswith("mailto:"):
        return "mailto:" + s
    return s

_serializer = None
_db = None


def init_pwa_push(serializer, database) -> None:
    global _serializer, _db
    _serializer = serializer
    _db = database


class PushKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")

    p256dh: str
    auth: str


class PushSubscribeBody(BaseModel):
    """Только поля подписки браузера; user_id / user_type всегда из сессии (см. push_subscribe)."""

    model_config = ConfigDict(extra="forbid")

    endpoint: str
    keys: PushKeys
    expirationTime: Optional[float] = None


class PushUnsubscribeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: Optional[str] = None


def _session_user(request: Request) -> Optional[Dict[str, Any]]:
    token = request.cookies.get("taxi_session")
    if not token or not _serializer:
        return None
    return models.get_user_from_token(_serializer, token)


@router.get("/api/push/vapid-public-key")
async def push_vapid_public_key():
    pub = _env_scalar("VAPID_PUBLIC_KEY")
    if not pub:
        return {"enabled": False, "publicKey": None}
    return {"enabled": True, "publicKey": pub}


@router.post("/api/push/subscribe")
async def push_subscribe(request: Request, body: PushSubscribeBody):
    """
    Привязка push-подписки только к пользователю из cookie-сессии.
    Любые user_id / роль из тела запроса запрещены (extra='forbid' у модели).
    """
    user = _session_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Не авторизован")
    ep = (body.endpoint or "").strip()
    if not ep:
        raise HTTPException(status_code=400, detail="endpoint обязателен")
    await _db.upsert_push_subscription(
        str(user["user_type"]),
        int(user["user_id"]),
        ep,
        body.keys.p256dh,
        body.keys.auth,
    )
    return {"success": True}


@router.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request, body: PushUnsubscribeBody):
    user = _session_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Не авторизован")
    if body.endpoint and body.endpoint.strip():
        await _db.delete_push_subscription(
            user["user_type"], user["user_id"], body.endpoint.strip()
        )
    else:
        await _db.delete_all_push_subscriptions_for_user(
            user["user_type"], user["user_id"]
        )
    return {"success": True}


async def send_web_push_to_user(
    database,
    user_type: str,
    user_id: int,
    *,
    title: str,
    body: str,
    subtitle: Optional[str] = None,
    url: str = "/",
    tag: Optional[str] = None,
    trip_id: Optional[int] = None,
) -> int:
    """
    Отправляет Web Push всем сохранённым подпискам пользователя.
    Дедупликация на клиенте: при trip_id в payload попадает tag ``ji-trip-{id}`` (замена, не дубль).
    До 3 попыток с backoff при временных сбоях сети / 5xx.
    Возвращает число успешных ответов от push-сервиса.
    """
    private = _env_scalar("VAPID_PRIVATE_KEY")
    mail = _vapid_sub_claim(
        _env_scalar("VAPID_CLAIM_EMAIL") or "alex@example.com"
    )
    if not private:
        logger.warning("VAPID_PRIVATE_KEY не задан — push не отправлен")
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.warning("Пакет pywebpush не установлен")
        return 0

    eff_tag = tag
    if eff_tag is None and trip_id is not None:
        eff_tag = f"ji-trip-{int(trip_id)}"
    if eff_tag is None:
        eff_tag = "ji-taxi"
    payload_obj: Dict[str, Any] = {
        "title": title,
        "body": body,
        "url": url,
        "tag": eff_tag,
    }
    if subtitle and str(subtitle).strip():
        payload_obj["subtitle"] = str(subtitle).strip()
    if trip_id is not None:
        payload_obj["trip_id"] = int(trip_id)
    payload = json.dumps(payload_obj, ensure_ascii=False)
    subs = await database.list_push_subscriptions_for_user(user_type, user_id)
    n_ok = 0
    backoff_delays_s = (0.0, 0.4, 1.0)

    for s in subs:
        endpoint = str(s["endpoint"] or "").strip()
        if not endpoint:
            # Некорректная запись в БД: без endpoint отправлять нельзя.
            try:
                await database.delete_push_subscription(user_type, user_id, s.get("endpoint"))
            except Exception:
                pass
            continue
        subscription = {
            "endpoint": endpoint,
            "keys": {"p256dh": s["p256dh"], "auth": s["auth"]},
        }

        # Явно задаём aud/exp: некоторые push-провайдеры (FCM/Mozilla) жёстко валидируют aud.
        # aud должен быть origin push-ресурса (scheme + host[:port]) БЕЗ path.
        # В некоторых реализациях (py_vapid) значение с trailing "/" может интерпретироваться как path="/"
        # и приводить к ошибке вида "Missing 'aud' from claims".
        endpoint_l = endpoint.lower()
        if "fcm.googleapis.com" in endpoint_l:
            aud = "https://fcm.googleapis.com"
        elif "updates.push.services.mozilla.com" in endpoint_l:
            aud = "https://updates.push.services.mozilla.com"
        elif "web.push.apple.com" in endpoint_l:
            aud = "https://web.push.apple.com"
        else:
            u = urlparse(endpoint)
            aud = f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else ""
        if not aud:
            # Без aud py_vapid падает исключением. Такое бывает при "битом" endpoint в БД.
            logger.warning("WebPush: пропуск подписки с некорректным endpoint (aud пустой): %r", endpoint)
            try:
                await database.delete_push_subscription(user_type, user_id, endpoint)
            except Exception:
                pass
            continue
        exp = int(time.time()) + 300  # 5 минут
        for attempt, delay_s in enumerate(backoff_delays_s):
            if delay_s > 0:
                await asyncio.sleep(delay_s)
            try:
                # Новый dict на каждый вызов: pywebpush дописывает aud/exp в vapid_claims in-place.
                webpush(
                    subscription_info=subscription,
                    data=payload,
                    vapid_private_key=private,
                    vapid_claims={
                        "sub": mail,
                        "aud": aud,
                        "exp": exp,
                    },
                    ttl=86400,
                )
                n_ok += 1
                break
            except WebPushException as e:
                resp = getattr(e, "response", None)
                code = getattr(resp, "status_code", None) if resp is not None else None
                if code is None:
                    low = str(e).lower()
                    if "410" in low or "gone" in low:
                        code = 410
                    elif "404" in low or "not found" in low:
                        code = 404
                if code in (404, 410):
                    await database.delete_push_subscription(
                        user_type, user_id, s["endpoint"]
                    )
                    break
                retryable = code is None or code >= 500 or code in (408, 429)
                if not retryable:
                    logger.info("WebPush: %s", e)
                    break
                if attempt == len(backoff_delays_s) - 1:
                    logger.info("WebPush после %s попыток: %s", len(backoff_delays_s), e)
            except Exception as e:
                # Сюда попадают ошибки генерации VAPID (py_vapid), валидации claims и т.п.
                # Не роняем весь admin endpoint из-за одной подписки.
                logger.exception(
                    "WebPush: ошибка до/во время отправки (endpoint=%r aud=%r): %s",
                    endpoint,
                    aud,
                    e,
                )
                break
    return n_ok
