"""Authentication primitives: password hashing, signed tokens, rate limiting.

Hashing: PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP 2023 minimum for
SHA-256), 16-byte random salt per user. Comparisons use constant time.

Tokens: HMAC-SHA256-signed JSON payloads (compact JWS-style "body.sig"),
short TTL (default 1h). Verified with constant-time compare and rejected
when expired. Delivered to clients via HttpOnly, Secure, SameSite=Strict
cookie — never readable from JavaScript and not cross-site replayable.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import defaultdict, deque
from threading import Lock
from typing import Optional

from fastapi import Cookie, Depends, HTTPException, Request

# ---------- Configuration ----------

ENV = os.environ.get("PT_ENV", "production").lower()
IS_PROD = ENV == "production"

def _get_secret() -> bytes:
    env = os.environ.get("PT_SECRET")
    if env:
        return env.encode()
    if not IS_PROD:
        return b"dev-insecure-secret-do-not-use-in-production"
    raise RuntimeError(
        "PT_SECRET environment variable is required when PT_ENV=production. "
        "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
    )

TOKEN_TTL = int(os.environ.get("PT_TOKEN_TTL", "3600"))  # 1h default
COOKIE_NAME = "pt_session"
PBKDF2_ITERATIONS = 600_000
SALT_BYTES = 16
HASH_BYTES = 32


# ---------- Password hashing ----------

def hash_password(password: str, *, salt: bytes | None = None,
                  iterations: int = PBKDF2_ITERATIONS) -> tuple[bytes, bytes, int]:
    if not password or len(password) < 8:
        raise ValueError("Password must be at least 8 characters")
    salt = salt or secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 salt, iterations, dklen=HASH_BYTES)
    return digest, salt, iterations


def verify_password(password: str, *, expected_hash: bytes, salt: bytes,
                    iterations: int) -> bool:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 salt, iterations, dklen=len(expected_hash))
    return hmac.compare_digest(digest, expected_hash)


# ---------- Token signing ----------

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_token(*, user_id: int, username: str, role: str,
                employee: Optional[str]) -> str:
    payload = {
        "uid": user_id,
        "sub": username,
        "role": role,
        "employee": employee,
        "iat": int(time.time()),
        "exp": int(time.time()) + TOKEN_TTL,
        "jti": secrets.token_urlsafe(8),
    }
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64(hmac.new(_get_secret(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_token(token: str) -> dict:
    try:
        body, sig = token.split(".", 1)
    except ValueError:
        raise HTTPException(401, "Invalid token")
    expected = _b64(hmac.new(_get_secret(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(401, "Invalid token")
    try:
        payload = json.loads(_b64d(body))
    except Exception:
        raise HTTPException(401, "Invalid token")
    if payload.get("exp", 0) < time.time():
        raise HTTPException(401, "Token expired")
    return payload


# ---------- Login throttling (per-IP sliding window) ----------

_LOGIN_WINDOW_SEC = 300        # 5 minutes
_LOGIN_MAX_FAILURES = 8
_failed: dict[str, deque[float]] = defaultdict(deque)
_lock = Lock()


def login_throttle_check(ip: str) -> None:
    now = time.time()
    with _lock:
        q = _failed[ip]
        while q and q[0] < now - _LOGIN_WINDOW_SEC:
            q.popleft()
        if len(q) >= _LOGIN_MAX_FAILURES:
            raise HTTPException(429, "Too many login attempts. Try again later.")


def login_throttle_record_failure(ip: str) -> None:
    with _lock:
        _failed[ip].append(time.time())


def login_throttle_reset(ip: str) -> None:
    with _lock:
        _failed.pop(ip, None)


# ---------- FastAPI dependencies ----------

def current_user(request: Request,
                 pt_session: Optional[str] = Cookie(default=None)) -> dict:
    if not pt_session:
        raise HTTPException(401, "Not authenticated")
    return verify_token(pt_session)


def require_supervisor(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != "supervisor":
        raise HTTPException(403, "Supervisor only")
    return user


def require_worker(user: dict = Depends(current_user)) -> dict:
    if user.get("role") != "worker":
        raise HTTPException(403, "Worker only")
    return user


# ---------- Cookie helpers ----------

def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=TOKEN_TTL,
        httponly=True,
        secure=IS_PROD,
        samesite="strict",
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")
