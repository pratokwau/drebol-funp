"""drebol-funp :: веб-панель для работы с FunPay."""
from __future__ import annotations

import base64
import hashlib
import hmac
import math
import re
import os
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import analytics, funpay, orders_store, pricing, store, updater

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"
ENV_FILE = BASE_DIR / ".env"

BRAND_DIR = BASE_DIR / "data" / "brand"
BRAND_EXTS = (".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif", ".ico")
BRAND_TYPES = {".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
               ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
               ".ico": "image/x-icon"}

# запасная иконка, если своей не положили
FALLBACK_ICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
<rect width="64" height="64" rx="16" fill="url(#g)"/>
<text x="32" y="42" font-family="Inter,system-ui,sans-serif" font-size="26" font-weight="700"
      fill="#fff" text-anchor="middle">DF</text></svg>"""


def brand_file(name: str) -> Path | None:
    """Файл оформления из data/brand: logo.png, favicon.svg и т.п."""
    for ext in BRAND_EXTS:
        path = BRAND_DIR / f"{name}{ext}"
        if path.is_file():
            return path
    return None


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


@app.middleware("http")
async def no_cache(request: Request, call_next):
    """Браузер обязан переспрашивать файлы: иначе после обновления панели
    остаётся старый js/css и интерфейс ведёт себя как до апдейта."""
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache, must-revalidate")
    return response


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


@app.get("/profit")
async def profit_page(request: Request):
    if not verify(request.cookies.get(COOKIE_NAME)):
        return RedirectResponse("/login", status_code=302)
    return FileResponse(WEB_DIR / "profit.html")


@app.get("/pricing")
async def pricing_page(request: Request):
    if not verify(request.cookies.get(COOKIE_NAME)):
        return RedirectResponse("/login", status_code=302)
    return FileResponse(WEB_DIR / "pricing.html")


@app.get("/orders")
async def orders_page(request: Request):
    if not verify(request.cookies.get(COOKIE_NAME)):
        return RedirectResponse("/login", status_code=302)
    return FileResponse(WEB_DIR / "orders.html")


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


@app.get("/api/brand")
async def api_brand():
    """Что лежит в data/brand — логотип и иконка вкладки. Нужен и до входа."""
    logo, icon = brand_file("logo"), brand_file("favicon")
    return {
        "ok": True,
        "dir": str(BRAND_DIR),
        "logo": f"/brand/logo?v={int(logo.stat().st_mtime)}" if logo else None,
        "logo_file": logo.name if logo else None,
        "favicon_file": icon.name if icon else (logo.name if logo else None),
        "formats": [e.lstrip(".") for e in BRAND_EXTS],
    }


@app.get("/brand/logo")
async def brand_logo():
    logo = brand_file("logo")
    if not logo:
        return JSONResponse({"ok": False, "error": "Логотип не найден"}, status_code=404)
    return FileResponse(logo, media_type=BRAND_TYPES.get(logo.suffix.lower(), "image/png"))


@app.get("/favicon.ico")
async def favicon():
    icon = brand_file("favicon") or brand_file("logo")
    if icon:
        return FileResponse(icon, media_type=BRAND_TYPES.get(icon.suffix.lower(), "image/png"))
    return Response(FALLBACK_ICON, media_type="image/svg+xml")


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


# ---------------------------- заказы ----------------------------


@app.get("/api/orders", dependencies=[Depends(require_auth)])
def api_orders(start_from: str = ""):
    """Страница продаж с FunPay: 100 заказов и указатель на следующую сотню."""
    data = store.load()
    result = funpay.orders(data["golden_key"], data["user_agent"], start_from.strip() or None)
    if result["ok"]:
        result["orders"] = pricing.apply_to_orders(result["orders"])
        settings_pricing = pricing.load()
        result["fee"] = settings_pricing["fee"]
        result["cashback_min"] = settings_pricing["cashback_min"]
    return JSONResponse(result, status_code=200 if result["ok"] else 400)


@app.post("/api/orders/choice", dependencies=[Depends(require_auth)])
async def api_orders_choice(request: Request):
    """Какой закуп пошёл в заказ: с кэшбеком или без. null — сбросить выбор."""
    body = await request.json()
    order_id = str(body.get("id") or "").strip().lstrip("#")
    choice = body.get("choice")
    if not order_id:
        return JSONResponse({"ok": False, "error": "Не указан заказ"}, status_code=400)
    if choice not in ("cashback", "plain", None):
        return JSONResponse({"ok": False, "error": "Вариант: cashback или plain"}, status_code=400)
    pricing.set_choice(order_id, choice)
    return {"ok": True, "id": order_id, "choice": choice}


@app.post("/api/orders/choice-bulk", dependencies=[Depends(require_auth)])
async def api_orders_choice_bulk(request: Request):
    """Выбор «с кэшбеком / без» сразу для списка заказов."""
    body = await request.json()
    ids = [str(i).strip().lstrip("#") for i in (body.get("ids") or []) if str(i).strip()]
    choice = body.get("choice")
    if not ids:
        return JSONResponse({"ok": False, "error": "Не выбрано ни одного заказа"}, status_code=400)
    if len(ids) > 5000:
        return JSONResponse({"ok": False, "error": "Слишком много заказов за раз"}, status_code=400)
    if choice not in ("cashback", "plain", None):
        return JSONResponse({"ok": False, "error": "Вариант: cashback или plain"}, status_code=400)
    pricing.set_choices(ids, choice)
    return {"ok": True, "count": len(ids), "choice": choice}


@app.post("/api/orders/cost", dependencies=[Depends(require_auth)])
async def api_orders_cost(request: Request):
    """Ручной закуп за весь заказ. Пустое значение — вернуть автоматический.
    В ответ — заказ, пересчитанный теми же правилами, что и список."""
    body = await request.json()
    order = body.get("order") or {}
    order_id = str(body.get("id") or order.get("id") or "").strip().lstrip("#")
    if not order_id:
        return JSONResponse({"ok": False, "error": "Не указан заказ"}, status_code=400)

    raw = str(body.get("cost") if body.get("cost") is not None else "").strip()
    try:
        cost = _money_field(raw, "Цена закупа") if raw else None
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    pricing.set_override(order_id, cost)
    fresh = {k: order.get(k) for k in ("id", "title", "price", "amount", "status_code")}
    fresh["id"] = order_id
    recalculated = pricing.apply_to_orders([fresh])[0] if fresh.get("title") is not None else None
    return {"ok": True, "id": order_id, "cost": cost, "order": recalculated}


# ---------------------------- мин. цены ----------------------------


@app.get("/api/pricing", dependencies=[Depends(require_auth)])
def api_pricing_get():
    data = pricing.load()
    return {
        "ok": True,
        "fee": data["fee"],
        "cashback_min": data["cashback_min"],
        "games": data["games"],
        "items": data["items"],
    }


@app.post("/api/pricing/scan", dependencies=[Depends(require_auth)])
def api_pricing_scan():
    """Сканирует профиль FunPay и возвращает разделы, отмечая уже добавленные."""
    settings = store.load()
    result = funpay.scan_games(settings["golden_key"], settings["user_agent"])
    if not result["ok"]:
        return JSONResponse(result, status_code=400)

    pricing.refresh_games(result["games"])
    added = {g["key"] for g in pricing.load()["games"]}
    for game in result["games"]:
        game["added"] = game["key"] in added
    return result


@app.post("/api/pricing/games", dependencies=[Depends(require_auth)])
async def api_pricing_add_games(request: Request):
    body = await request.json()
    keys = [str(k) for k in (body.get("keys") or [])]
    found = body.get("found") or []
    if not keys:
        return JSONResponse({"ok": False, "error": "Не выбрано ни одной игры"}, status_code=400)

    data = pricing.add_games(found, keys)
    return {"ok": True, "games": data["games"], "added": len(keys)}


@app.delete("/api/pricing/games/{key}", dependencies=[Depends(require_auth)])
def api_pricing_remove_game(key: str):
    data = pricing.remove_game(key)
    return {"ok": True, "games": data["games"]}


@app.post("/api/pricing/games/delete", dependencies=[Depends(require_auth)])
async def api_pricing_remove_games(request: Request):
    body = await request.json()
    keys = [str(k) for k in (body.get("keys") or [])]
    if not keys:
        return JSONResponse({"ok": False, "error": "Не выбрано ни одной игры"}, status_code=400)
    data = pricing.remove_games(keys)
    return {"ok": True, "games": data["games"], "removed": len(keys)}


@app.get("/api/pricing/lots", dependencies=[Depends(require_auth)])
def api_pricing_lots(key: str = ""):
    settings = store.load()
    result = funpay.subcategory_lots(settings["golden_key"], settings["user_agent"], key)
    if result["ok"]:
        pricing.update_game_lots(key, result["count"], funpay.unique_titles(l["title"] for l in result["lots"]))
    return JSONResponse(result, status_code=200 if result["ok"] else 400)


@app.post("/api/pricing/items", dependencies=[Depends(require_auth)])
async def api_pricing_add_item(request: Request):
    body = await request.json()
    key = str(body.get("key") or "")
    title = str(body.get("title") or "").strip()
    if not key or not title:
        return JSONResponse({"ok": False, "error": "Нужны раздел и название товара"}, status_code=400)

    try:
        cost = _money_field(body.get("cost") if body.get("cost") not in (None, "") else 0, "Цена закупа")
        raw_cashback = str(body.get("cost_cashback") or "").strip()
        cost_cashback = _money_field(raw_cashback, "Цена с кэшбеком") if raw_cashback else None
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    if cost_cashback is not None:
        if cost_cashback > cost:
            return JSONResponse(
                {"ok": False, "error": "Цена с кэшбеком должна быть меньше обычной"}, status_code=400)

    has_cashback = bool(body.get("has_cashback")) and cost_cashback is not None

    try:
        data = pricing.add_item(
            key, title, cost,
            keywords=str(body.get("keywords") or ""),
            lot_id=body.get("lot_id"),
            price=body.get("price"),
            cost_cashback=cost_cashback,
            has_cashback=has_cashback,
        )
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    return {"ok": True, "items": data["items"].get(key, [])}


_MONEY_RE = re.compile(r"^-?\d+(?:[.,]\d+)?$")


def _money_field(value, name: str) -> float:
    """Строгий разбор цены: только «123», «123.45» или «123,45».
    float() сам по себе пропустил бы «2e3», «nan» и «inf»."""
    raw = str(value).strip().replace(" ", "")
    if not _MONEY_RE.match(raw):
        raise ValueError(f"{name} должна быть числом, например 245 или 245.50")
    number = float(raw.replace(",", "."))
    if number < 0:
        raise ValueError(f"{name} не может быть отрицательной")
    return round(number, 2)


@app.patch("/api/pricing/items/{item_id}", dependencies=[Depends(require_auth)])
async def api_pricing_edit_item(item_id: str, request: Request):
    """Правка товара: название, ключевые слова, закуп, цена с кэшбеком."""
    found = pricing.get_item(item_id)
    if not found:
        return JSONResponse({"ok": False, "error": "Товар не найден"}, status_code=404)
    _, current = found
    body = await request.json()
    fields: dict = {}
    try:
        if "title" in body:
            title = str(body.get("title") or "").strip()
            if not title:
                raise ValueError("Название товара не может быть пустым")
            fields["title"] = title
        if "keywords" in body:
            fields["keywords"] = str(body.get("keywords") or "").strip()
        if "cost" in body:
            fields["cost"] = _money_field(body.get("cost") or 0, "Цена закупа")
        if "cost_cashback" in body:
            raw = str(body.get("cost_cashback") if body.get("cost_cashback") is not None else "").strip()
            if raw:
                cb = _money_field(raw, "Цена с кэшбеком")
                cost = fields.get("cost", float(current.get("cost") or 0))
                if cb > cost:
                    raise ValueError("Цена с кэшбеком должна быть меньше обычной")
                fields.update({"cost_cashback": cb, "has_cashback": True})
            else:
                fields.update({"cost_cashback": None, "has_cashback": False})
        elif "cost" in fields and current.get("has_cashback") \
                and current.get("cost_cashback") is not None and current["cost_cashback"] > fields["cost"]:
            raise ValueError("Новый закуп меньше цены с кэшбеком — поправь и её")
        result = pricing.update_item(item_id, fields)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    return {"ok": True, "item": result["item"], "items": result["items"]}


@app.delete("/api/pricing/items/{item_id}", dependencies=[Depends(require_auth)])
def api_pricing_remove_item(item_id: str):
    data = pricing.remove_item(item_id)
    return {"ok": True, "items": data["items"]}


@app.post("/api/pricing/cashback-apply", dependencies=[Depends(require_auth)])
async def api_pricing_cashback_apply(request: Request):
    """Цена с кэшбеком всем товарам игры: процент, округление вниз до рубля, от порога."""
    body = await request.json()
    key = str(body.get("key") or "")
    try:
        percent = float(str(body.get("percent")).replace(",", "."))
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "Процент должен быть числом"}, status_code=400)
    if not math.isfinite(percent) or not 0 < percent < 100:
        return JSONResponse({"ok": False, "error": "Процент кэшбека — от 0 до 100"}, status_code=400)
    try:
        result = pricing.apply_cashback(key, percent, overwrite=bool(body.get("overwrite")))
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    return {"ok": True, **result}


@app.post("/api/pricing/fee", dependencies=[Depends(require_auth)])
async def api_pricing_fee(request: Request):
    body = await request.json()
    try:
        fee = float(str(body.get("fee")).replace(",", "."))
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "Комиссия должна быть числом"}, status_code=400)
    if not math.isfinite(fee) or not 0 <= fee < 100:
        return JSONResponse({"ok": False, "error": "Комиссия должна быть от 0 до 100"}, status_code=400)
    return {"ok": True, "fee": pricing.set_fee(fee)["fee"]}


@app.post("/api/pricing/cashback-min", dependencies=[Depends(require_auth)])
async def api_pricing_cashback_min(request: Request):
    body = await request.json()
    try:
        value = float(str(body.get("cashback_min")).replace(",", "."))
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "Порог должен быть числом"}, status_code=400)
    if not math.isfinite(value) or value < 0:
        return JSONResponse({"ok": False, "error": "Порог не может быть отрицательным"}, status_code=400)
    return {"ok": True, "cashback_min": pricing.set_cashback_min(value)["cashback_min"]}


# ---------------------------- прибыль ----------------------------


@app.get("/api/profit/report", dependencies=[Depends(require_auth)])
def api_profit_report(period: str = "30d", date_from: str = "", date_to: str = "",
                      statuses: str = "closed,paid", game: str = "",
                      only_matched: bool = False, group: str = ""):
    return analytics.report(period, date_from, date_to, statuses, game, only_matched, group)


@app.get("/api/profit/sync", dependencies=[Depends(require_auth)])
def api_profit_sync_status():
    return {"ok": True, **orders_store.status()}


@app.post("/api/profit/sync", dependencies=[Depends(require_auth)])
async def api_profit_sync(request: Request):
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    result = orders_store.start_sync(full=bool(body.get("full")))
    return JSONResponse(result, status_code=200 if result["ok"] else 409)


@app.delete("/api/profit/cache", dependencies=[Depends(require_auth)])
def api_profit_cache_clear():
    if orders_store.status()["running"]:
        return JSONResponse({"ok": False, "error": "Дождись конца синхронизации"}, status_code=409)
    orders_store.clear()
    return {"ok": True}
