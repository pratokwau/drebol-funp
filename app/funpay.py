"""Проверка golden_key: заходим на funpay.com с куки и смотрим, кто мы."""
from __future__ import annotations

import html
import json
import re
import urllib.error
import urllib.request

FUNPAY_URL = "https://funpay.com/"
TIMEOUT = 20


def check_key(golden_key: str, user_agent: str) -> dict:
    """Возвращает {ok, user_id, username, balance, error}."""
    if not golden_key:
        return {"ok": False, "error": "Golden key не задан"}

    req = urllib.request.Request(
        FUNPAY_URL,
        headers={
            "User-Agent": user_agent,
            "Cookie": f"golden_key={golden_key}",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "ru-RU,ru;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"FunPay ответил {e.code}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"Нет связи с FunPay: {e.reason}"}
    except TimeoutError:
        return {"ok": False, "error": "FunPay не ответил за 20 секунд"}

    m = re.search(r'data-app-data="([^"]+)"', body)
    if not m:
        return {"ok": False, "error": "Не похоже на страницу FunPay — проверь user-agent"}

    try:
        app_data = json.loads(html.unescape(m.group(1)))
    except json.JSONDecodeError:
        return {"ok": False, "error": "FunPay вернул неожиданный ответ"}

    user_id = app_data.get("userId") or 0
    if not user_id:
        return {"ok": False, "error": "Ключ недействителен — FunPay видит тебя как гостя"}

    name = re.search(r'class="user-link-name"[^>]*>([^<]+)<', body)
    balance = re.search(r'class="badge badge-balance"[^>]*>([^<]+)<', body)
    return {
        "ok": True,
        "user_id": user_id,
        "username": html.unescape(name.group(1)).strip() if name else "",
        "balance": html.unescape(balance.group(1)).strip() if balance else "",
    }
