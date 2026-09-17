"""drebol-funp :: веб-панель для работы с FunPay."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Form, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"
ENV_FILE = BASE_DIR / ".env"

COOKIE_NAME = "drebol_session"
SESSION_TTL = 60 * 60 * 12  # 12 часов


def load_env() -> None:
    """Подхватывает .env, если сервис запущен без systemd EnvironmentFile."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env()

DOMAIN = os.getenv("DOMAIN", "localhost")
ADMIN_LOGIN = os.getenv("ADMIN_LOGIN", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
SECRET_KEY = os.getenv("SECRET_KEY") or secrets.token_hex(32)

if not ADMIN_PASSWORD:
    ADMIN_PASSWORD = secrets.token_urlsafe(12)

# --- простая защита от перебора: ip -> (попытки, время блокировки) ---
MAX_ATTEMPTS = 6
LOCK_SECONDS = 300
_attempts: dict[str, list[float]] = {}


def sign(payload: str) -> str:
    mac = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    raw = f"{payload}|{mac}".encode()
    return base64.urlsafe_b64encode(raw).decode()


def verify(token: str | None) -> bool:
    if not token:
        return False
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        login, expires, mac = raw.rsplit("|", 2)
    except Exception:
        return False
    if not hmac.compare_digest(
        mac, hmac.new(SECRET_KEY.encode(), f"{login}|{expires}".encode(), hashlib.sha256).hexdigest()
    ):
        return False
    if login != ADMIN_LOGIN:
        return False
    return float(expires) > time.time()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def throttle(ip: str) -> int:
    """Возвращает сколько секунд ждать, 0 — можно пробовать."""
    now = time.time()
    hits = [t for t in _attempts.get(ip, []) if now - t < LOCK_SECONDS]
    _attempts[ip] = hits
    if len(hits) >= MAX_ATTEMPTS:
        return int(LOCK_SECONDS - (now - hits[0]))
    return 0


def banner() -> None:
    line = "=" * 60
    print(f"\n{line}", flush=True)
    print("  drebol-funp запущен", flush=True)
    print(f"  Адрес:  https://{DOMAIN}", flush=True)
    print(f"  Логин:  {ADMIN_LOGIN}", flush=True)
    print(f"  Пароль: {ADMIN_PASSWORD}", flush=True)
    print(f"{line}\n", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    banner()
    yield


app = FastAPI(
    title="drebol-funp", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
)
app.mount("/static", StaticFiles(directory=WEB_DIR / "static"), name="static")


@app.get("/")
async def index(request: Request):
    if verify(request.cookies.get(COOKIE_NAME)):
        return FileResponse(WEB_DIR / "dashboard.html")
    return FileResponse(WEB_DIR / "index.html")


@app.get("/login")
async def login_page(request: Request):
    if verify(request.cookies.get(COOKIE_NAME)):
        return RedirectResponse("/", status_code=302)
    return FileResponse(WEB_DIR / "index.html")


@app.post("/api/login")
async def api_login(request: Request, login: str = Form(...), password: str = Form(...)):
    ip = client_ip(request)
    wait = throttle(ip)
    if wait:
        return JSONResponse(
            {"ok": False, "error": f"Слишком много попыток. Подожди {wait} сек."}, status_code=429
        )

    good = hmac.compare_digest(login.strip(), ADMIN_LOGIN) and hmac.compare_digest(
        password, ADMIN_PASSWORD
    )
    if not good:
        _attempts.setdefault(ip, []).append(time.time())
        return JSONResponse({"ok": False, "error": "Неверный логин или пароль"}, status_code=401)

    _attempts.pop(ip, None)
    token = sign(f"{ADMIN_LOGIN}|{time.time() + SESSION_TTL}")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https",
        path="/",
    )
    return resp


@app.post("/api/logout")
async def api_logout(response: Response):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/api/me")
async def api_me(request: Request):
    if not verify(request.cookies.get(COOKIE_NAME)):
        return JSONResponse({"ok": False}, status_code=401)
    return {"ok": True, "login": ADMIN_LOGIN, "domain": DOMAIN}


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "drebol-funp"}
