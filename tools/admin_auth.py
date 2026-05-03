"""
JWT для админ-панели (отдельно от cookie-сессий клиента/водителя).
Демо-логин по умолчанию: admin / admin (переопределяется через ADMIN_USERNAME / ADMIN_PASSWORD).
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import jwt

ADMIN_JWT_ALG = "HS256"
ADMIN_TOKEN_TTL_HOURS = int(os.getenv("ADMIN_JWT_TTL_HOURS", "24"))


def _secret() -> str:
    key = os.getenv("SECRET_KEY")
    if not key:
        raise RuntimeError("SECRET_KEY required for admin JWT")
    return key


def verify_admin_credentials(username: str, password: str) -> bool:
    u = os.getenv("ADMIN_USERNAME", "admin")
    p = os.getenv("ADMIN_PASSWORD", "admin")
    return username == u and password == p


def create_admin_access_token(*, admin_id: int = 1) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(hours=ADMIN_TOKEN_TTL_HOURS)
    payload: Dict[str, Any] = {
        "sub": str(admin_id),
        "role": "admin",
        "user_type": "admin",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _secret(), algorithm=ADMIN_JWT_ALG)


def decode_admin_access_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        return jwt.decode(token, _secret(), algorithms=[ADMIN_JWT_ALG])
    except jwt.PyJWTError:
        return None
