"""Работа с FunPay через библиотеку FunPayAPI."""
from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:  # чтобы был виден пакет FunPayAPI рядом с app/
    sys.path.insert(0, str(BASE_DIR))

logger = logging.getLogger("drebol.funpay")

REQUEST_TIMEOUT = 20
ACCOUNT_TTL = 30 * 60  # FunPayAPI советует обновлять сессию каждые 40-60 минут

STATUS_RU = {
    "PAID": "Оплачен",
    "CLOSED": "Закрыт",
    "REFUNDED": "Возврат",
    "PARTIALLY_REFUNDED": "Частичный возврат",
    "UNPAID": "Не оплачен",
}

# кэш авторизованного аккаунта: пересоздаём при смене ключа или по таймауту
_cache: dict = {"account": None, "signature": None, "time": 0.0}
PROFILE_TTL = 5 * 60
_profile_cache: dict = {"profile": None, "user_id": None, "time": 0.0}


def _load_lib():
    """Импортирует библиотеку и возвращает (requests, FunPayAPI, exceptions)."""
    import requests
    import FunPayAPI
    from FunPayAPI.common import exceptions

    return requests, FunPayAPI, exceptions


def _sub_key(subcategory) -> str:
    """Уникальный ключ подкатегории: lot-256 / chip-4471."""
    type_name = getattr(getattr(subcategory, "type", None), "name", "COMMON")
    prefix = "chip" if type_name == "CURRENCY" else "lot"
    return f"{prefix}-{subcategory.id}"


def _profile(account, force: bool = False):
    """Профиль продавца с лотами, кэш на 5 минут."""
    if not force and _profile_cache["profile"] is not None \
            and _profile_cache["user_id"] == account.id \
            and time.time() - _profile_cache["time"] < PROFILE_TTL:
        return _profile_cache["profile"]

    profile = account.get_user(account.id)
    _profile_cache.update({"profile": profile, "user_id": account.id, "time": time.time()})
    return profile


def _error(exceptions_mod, requests_mod, e) -> dict | None:
    """Переводит исключение библиотеки в понятную ошибку. None — не наш случай."""
    if isinstance(e, exceptions_mod.UnauthorizedError):
        return {"ok": False, "error": "Ключ недействителен — FunPay не пустил в аккаунт"}
    if isinstance(e, exceptions_mod.RequestFailedError):
        code = getattr(getattr(e, "response", None), "status_code", "?")
        if code == 429:
            return {"ok": False, "error": "FunPay временно блокирует запросы (429). Подожди минуту."}
        return {"ok": False, "error": f"FunPay ответил {code}"}
    if isinstance(e, requests_mod.exceptions.Timeout):
        return {"ok": False, "error": f"FunPay не ответил за {REQUEST_TIMEOUT} секунд"}
    if isinstance(e, requests_mod.exceptions.RequestException):
        return {"ok": False, "error": f"Нет связи с FunPay: {e.__class__.__name__}"}
    return None


def get_account(golden_key: str, user_agent: str = "", force: bool = False):
    """Авторизованный аккаунт из кэша либо новый."""
    _, FunPayAPI, _ = _load_lib()
    signature = f"{golden_key}|{user_agent}"
    fresh = time.time() - _cache["time"] < ACCOUNT_TTL

    if not force and _cache["account"] is not None and _cache["signature"] == signature and fresh:
        return _cache["account"]

    account = FunPayAPI.Account(
        golden_key, user_agent.strip() or None, requests_timeout=REQUEST_TIMEOUT
    ).get()
    _cache.update({"account": account, "signature": signature, "time": time.time()})
    return account


def account_info(golden_key: str, user_agent: str = "") -> dict:
    """Заходит на FunPay с ключом и возвращает данные аккаунта."""
    key = (golden_key or "").strip()
    if not key:
        return {"ok": False, "error": "Golden key не задан"}

    try:
        import requests
        import FunPayAPI
        from FunPayAPI.common import exceptions
    except ImportError as e:
        return {"ok": False, "error": f"Не хватает библиотеки: {e}. Обнови панель с GitHub."}

    try:
        account = get_account(key, user_agent, force=True)
    except Exception as e:  # noqa: BLE001
        known = _error(exceptions, requests, e)
        if known:
            return known
        logger.exception("Не удалось получить данные аккаунта FunPay")
        return {"ok": False, "error": f"Неожиданная ошибка: {e.__class__.__name__}: {e}"}

    return {
        "ok": True,
        "user_id": account.id,
        "username": account.username,
        "balance": account.total_balance,
        "currency": str(account.currency),
        "active_sales": account.active_sales,
        "active_purchases": account.active_purchases,
    }


# старое имя, чтобы ничего не отвалилось
check_key = account_info


def orders(golden_key: str, user_agent: str = "", start_from: str | None = None) -> dict:
    """Страница продаж (100 штук) и указатель на следующую."""
    key = (golden_key or "").strip()
    if not key:
        return {"ok": False, "error": "Сначала задай golden key в настройках"}

    try:
        requests, _, exceptions = _load_lib()
    except ImportError as e:
        return {"ok": False, "error": f"Не хватает библиотеки: {e}. Обнови панель с GitHub."}

    try:
        account = get_account(key, user_agent)
        next_id, sales, _, _ = account.get_sales(start_from=start_from or None)
    except Exception as e:  # noqa: BLE001
        known = _error(exceptions, requests, e)
        if known:
            return known
        logger.exception("Не удалось получить заказы FunPay")
        return {"ok": False, "error": f"Неожиданная ошибка: {e.__class__.__name__}: {e}"}

    items = []
    for o in sales:
        status = getattr(o.status, "name", str(o.status))
        items.append({
            "id": o.id,
            "title": o.description,
            "category": o.subcategory_name,
            "price": o.price,
            "currency": str(o.currency),
            "amount": o.amount,
            "buyer": o.buyer_username,
            "buyer_id": o.buyer_id,
            "status": STATUS_RU.get(status, status),
            "status_code": status.lower(),
            "date": o.date.isoformat() if o.date else None,
            "link": f"https://funpay.com/orders/{o.id}/",
        })

    return {"ok": True, "orders": items, "next": next_id, "count": len(items)}


def unique_titles(titles) -> list[str]:
    """Названия лотов без повторов (как в «Мин. ценах»: регистр и пробелы по краям не важны)."""
    seen, out = set(), []
    for t in titles:
        t = (t or "").strip()
        k = t.lower()
        if t and k not in seen:
            seen.add(k)
            out.append(t)
    return out


def scan_games(golden_key: str, user_agent: str = "") -> dict:
    """Сканирует профиль и возвращает разделы FunPay, в которых есть лоты."""
    key = (golden_key or "").strip()
    if not key:
        return {"ok": False, "error": "Сначала задай golden key в настройках"}

    try:
        requests, _, exceptions = _load_lib()
    except ImportError as e:
        return {"ok": False, "error": f"Не хватает библиотеки: {e}. Обнови панель с GitHub."}

    try:
        account = get_account(key, user_agent)
        profile = _profile(account, force=True)
        sorted_lots = profile.get_sorted_lots(2)
    except Exception as e:  # noqa: BLE001
        known = _error(exceptions, requests, e)
        if known:
            return known
        logger.exception("Не удалось просканировать профиль FunPay")
        return {"ok": False, "error": f"Неожиданная ошибка: {e.__class__.__name__}: {e}"}

    games = []
    for subcategory, lots in sorted_lots.items():
        category = getattr(subcategory, "category", None)
        games.append({
            "key": _sub_key(subcategory),
            "sub_id": subcategory.id,
            "name": subcategory.name,
            "game": getattr(category, "name", "") or "",
            "fullname": getattr(subcategory, "fullname", subcategory.name),
            "link": getattr(subcategory, "public_link", ""),
            "lots": len(lots),
            "lot_titles": unique_titles(lot.description for lot in lots.values()),
        })

    games.sort(key=lambda g: (g["game"], g["name"]))
    return {"ok": True, "games": games, "username": profile.username, "total": len(games)}


def subcategory_lots(golden_key: str, user_agent: str = "", game_key: str = "") -> dict:
    """Лоты профиля внутри одного раздела — из них удобно заводить товары."""
    key = (golden_key or "").strip()
    if not key:
        return {"ok": False, "error": "Сначала задай golden key в настройках"}

    try:
        requests, _, exceptions = _load_lib()
    except ImportError as e:
        return {"ok": False, "error": f"Не хватает библиотеки: {e}. Обнови панель с GitHub."}

    try:
        account = get_account(key, user_agent)
        profile = _profile(account)
        sorted_lots = profile.get_sorted_lots(2)
    except Exception as e:  # noqa: BLE001
        known = _error(exceptions, requests, e)
        if known:
            return known
        logger.exception("Не удалось получить лоты раздела")
        return {"ok": False, "error": f"Неожиданная ошибка: {e.__class__.__name__}: {e}"}

    for subcategory, lots in sorted_lots.items():
        if _sub_key(subcategory) != game_key:
            continue
        items = [{
            "id": str(lot.id),
            "title": lot.description or "",
            "price": lot.price,
            "currency": str(lot.currency),
            "amount": lot.amount,
            "auto": bool(lot.auto),
            "link": lot.public_link,
        } for lot in lots.values()]
        items.sort(key=lambda i: i["title"])
        return {"ok": True, "lots": items, "count": len(items)}

    return {"ok": False, "error": "Раздел не найден в профиле — просканируй игры заново"}
