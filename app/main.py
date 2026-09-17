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

from fastapi import Depends, FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import funpay, store, updater

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
SITE_PORT = os.getenv("SITE_PORT", "")
SITE_URL = os.getenv("SITE_URL") or (
    f"https://{DOMAIN}" if SITE_PORT in ("", "443") else f"https://{DOMAIN}:{SITE_PORT}"
)
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
    print(f"  Адрес:  {SITE_URL}", flush=True)
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


def require_auth(request: Request) -> None:
    if not verify(request.cookies.get(COOKIE_NAME)):
        raise HTTPException(status_code=401, detail="Нужен вход")


@app.get("/settings")
async def settings_page(request: Request):
    if not verify(request.cookies.get(COOKIE_NAME)):
        return RedirectResponse("/login", status_code=302)
    return FileResponse(WEB_DIR / "settings.html")


@app.get("/calc")
async def calc_page(request: Request):
    if not verify(request.cookies.get(COOKIE_NAME)):
        return RedirectResponse("/login", status_code=302)
    return FileResponse(WEB_DIR / "calc.html")


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
    return {"ok": True, "login": ADMIN_LOGIN, "domain": DOMAIN, "url": SITE_URL}


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "drebol-funp"}


# ---------------------------- настройки FunPay ----------------------------


@app.get("/api/settings", dependencies=[Depends(require_auth)])
async def api_settings_get():
    data = store.load()
    return {
        "ok": True,
        "has_key": bool(data["golden_key"]),
        "key_mask": store.mask(data["golden_key"]),
        "user_agent": data["user_agent"],
        "default_user_agent": store.DEFAULT_UA,
        "updated_at": data["updated_at"],
        "account": data.get("account") or {},
    }


@app.post("/api/settings", dependencies=[Depends(require_auth)])
async def api_settings_save(
    golden_key: str = Form(""),
    user_agent: str = Form(""),
    clear_key: str = Form(""),
):
    data = store.load()

    if clear_key == "1":
        data["golden_key"] = ""
        data["account"] = {}
    elif golden_key.strip():
        key = golden_key.strip()
        if len(key) < 20:
            return JSONResponse(
                {"ok": False, "error": "Golden key слишком короткий — проверь, что скопировал целиком"},
                status_code=400,
            )
        data["golden_key"] = key

    data["user_agent"] = user_agent.strip() or store.DEFAULT_UA
    store.save(data)
    return {
        "ok": True,
        "has_key": bool(data["golden_key"]),
        "key_mask": store.mask(data["golden_key"]),
        "user_agent": data["user_agent"],
    }


@app.post("/api/settings/check", dependencies=[Depends(require_auth)])
def api_settings_check(golden_key: str = Form(""), user_agent: str = Form("")):
    """Тянет данные аккаунта с FunPay и запоминает их."""
    data = store.load()
    key = golden_key.strip() or data["golden_key"]
    ua = user_agent.strip() or data["user_agent"]

    result = funpay.account_info(key, ua)
    if result["ok"]:
        data["account"] = {
            "id": result["user_id"],
            "username": result["username"],
            "balance": result["balance"],
            "currency": result["currency"],
            "active_sales": result["active_sales"],
            "active_purchases": result["active_purchases"],
            "checked_at": int(time.time()),
        }
        store.save(data)
    return JSONResponse(result, status_code=200 if result["ok"] else 400)


# ---------------------------- обновление с GitHub ----------------------------


@app.get("/api/version", dependencies=[Depends(require_auth)])
def api_version():
    return updater.version()


@app.post("/api/update/check", dependencies=[Depends(require_auth)])
def api_update_check():
    return updater.check()


@app.post("/api/update/run", dependencies=[Depends(require_auth)])
def api_update_run():
    result = updater.start()
    return JSONResponse(result, status_code=200 if result["ok"] else 409)


@app.get("/api/update/log", dependencies=[Depends(require_auth)])
def api_update_log():
    return updater.log_tail()
