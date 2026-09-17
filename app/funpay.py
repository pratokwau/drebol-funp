"""Работа с FunPay через библиотеку FunPayAPI."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:  # чтобы был виден пакет FunPayAPI рядом с app/
    sys.path.insert(0, str(BASE_DIR))

logger = logging.getLogger("drebol.funpay")

REQUEST_TIMEOUT = 20


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
        account = FunPayAPI.Account(
            key,
            user_agent.strip() or None,
            requests_timeout=REQUEST_TIMEOUT,
        ).get()
    except exceptions.UnauthorizedError:
        return {"ok": False, "error": "Ключ недействителен — FunPay не пустил в аккаунт"}
    except exceptions.RequestFailedError as e:
        code = getattr(getattr(e, "response", None), "status_code", "?")
        if code == 429:
            return {"ok": False, "error": "FunPay временно блокирует запросы (429). Подожди минуту."}
        return {"ok": False, "error": f"FunPay ответил {code}"}
    except requests.exceptions.Timeout:
        return {"ok": False, "error": f"FunPay не ответил за {REQUEST_TIMEOUT} секунд"}
    except requests.exceptions.RequestException as e:
        return {"ok": False, "error": f"Нет связи с FunPay: {e.__class__.__name__}"}
    except Exception as e:  # noqa: BLE001 — показываем причину, но не роняем панель
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
