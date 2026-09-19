"""Локальный кэш заказов FunPay для отчётов по прибыли.

FunPay отдаёт продажи страницами по 100, поэтому считать отчёт «вживую» по
каждому запросу — десятки обращений. Заказы складываем в data/orders_cache.json
и докачиваем в фоне только новое.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import funpay, store

logger = logging.getLogger("drebol.orders")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
FILE = DATA_DIR / "orders_cache.json"

PAGE_PAUSE = 1.2          # пауза между страницами, чтобы FunPay не выдал 429
RETRY_PAUSE = 15          # пауза после 429
RETRIES = 3
FRESH_DAYS = 3            # заказы моложе этого перепроверяем: статус ещё может смениться

_lock = threading.Lock()
_state: dict = {
    "running": False, "mode": None, "pages": 0, "fetched": 0, "new": 0,
    "error": None, "started_at": None, "finished_at": None,
}


def load() -> dict:
    data = {"orders": {}, "synced_at": None, "full_synced_at": None}
    if FILE.exists():
        try:
            data.update(json.loads(FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            logger.warning("Кэш заказов повреждён — начинаю с пустого")
    return data


def _save(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(FILE)


def _parse_date(value: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if value else None
    except ValueError:
        return None


def status() -> dict:
    data = load()
    dates = [d for d in (_parse_date(o.get("date")) for o in data["orders"].values()) if d]
    return {
        **_state,
        "cached": len(data["orders"]),
        "synced_at": data.get("synced_at"),
        "full_synced_at": data.get("full_synced_at"),
        "oldest": min(dates).isoformat() if dates else None,
        "newest": max(dates).isoformat() if dates else None,
    }


def _fetch_page(key: str, ua: str, start_from: str | None) -> dict:
    """Одна страница с повтором при 429."""
    for attempt in range(RETRIES):
        page = funpay.orders(key, ua, start_from)
        if page.get("ok"):
            return page
        if "429" in str(page.get("error", "")) and attempt < RETRIES - 1:
            time.sleep(RETRY_PAUSE)
            continue
        return page
    return page


def _run(full: bool) -> None:
    settings = store.load()
    key, ua = settings["golden_key"], settings["user_agent"]
    data = load()
    known = data["orders"]
    fresh_border = datetime.now() - timedelta(days=FRESH_DAYS)
    start_from = None

    try:
        while True:
            page = _fetch_page(key, ua, start_from)
            if not page.get("ok"):
                _state["error"] = page.get("error") or "Не удалось получить заказы"
                break

            orders = page["orders"]
            new_here = 0
            for o in orders:
                if o["id"] not in known:
                    new_here += 1
                known[o["id"]] = o  # обновляем в т.ч. статус старых

            _state["pages"] += 1
            _state["fetched"] += len(orders)
            _state["new"] += new_here
            data["synced_at"] = datetime.now().isoformat(timespec="seconds")
            _save(data)

            start_from = page.get("next")
            if not start_from or not orders:
                if full:
                    data["full_synced_at"] = data["synced_at"]
                    _save(data)
                break

            if not full:
                # дальше идут уже известные и «устоявшиеся» заказы — хватит
                newest_here = max((_parse_date(o.get("date")) for o in orders if o.get("date")),
                                  default=None)
                if new_here == 0 and newest_here and newest_here < fresh_border:
                    break

            time.sleep(PAGE_PAUSE)
    except Exception as e:  # noqa: BLE001 — фоновая задача не должна ронять сервис
        logger.exception("Синхронизация заказов упала")
        _state["error"] = f"{e.__class__.__name__}: {e}"
    finally:
        _state["running"] = False
        _state["finished_at"] = datetime.now().isoformat(timespec="seconds")


def start_sync(full: bool = False) -> dict:
    with _lock:
        if _state["running"]:
            return {**status(), "ok": False, "error": "Синхронизация уже идёт"}
        if not store.load()["golden_key"]:
            return {"ok": False, "error": "Сначала задай golden key в настройках"}
        _state.update({
            "running": True, "mode": "full" if full else "new", "pages": 0, "fetched": 0,
            "new": 0, "error": None, "started_at": datetime.now().isoformat(timespec="seconds"),
            "finished_at": None,
        })
    threading.Thread(target=_run, args=(full,), daemon=True, name="orders-sync").start()
    return {"ok": True, **status()}


def clear() -> None:
    with _lock:
        if FILE.exists():
            FILE.unlink()
