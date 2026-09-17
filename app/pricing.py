"""Мин. цены: закупочные цены товаров и сопоставление их с продажами."""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
FILE = DATA_DIR / "pricing.json"

DEFAULTS: dict = {
    "fee": 3.0,            # комиссия FunPay, %
    "cashback_min": 100.0,  # кэшбек в банке работает от этой суммы покупки
    "games": [],           # выбранные подкатегории профиля
    "items": {},           # ключ игры -> список товаров с закупочной ценой
}

_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)


def load() -> dict:
    data = json.loads(json.dumps(DEFAULTS))  # глубокая копия
    if FILE.exists():
        try:
            saved = json.loads(FILE.read_text(encoding="utf-8"))
            data.update({k: saved.get(k, data[k]) for k in DEFAULTS})
        except (json.JSONDecodeError, OSError):
            pass
    return data


def save(data: dict) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(FILE)
    return data


# ---------------------------- игры ----------------------------


def add_games(found: list[dict], keys: list[str]) -> dict:
    """Добавляет выбранные подкатегории, не трогая уже сохранённые."""
    data = load()
    existing = {g["key"] for g in data["games"]}
    by_key = {g["key"]: g for g in found}

    for key in keys:
        game = by_key.get(key)
        if not game or key in existing:
            continue
        data["games"].append({**game, "added_at": int(time.time())})
        data["items"].setdefault(key, [])

    data["games"].sort(key=lambda g: (g.get("game", ""), g.get("name", "")))
    return save(data)


def remove_game(key: str) -> dict:
    return remove_games([key])


def remove_games(keys: list[str]) -> dict:
    data = load()
    drop = set(keys)
    data["games"] = [g for g in data["games"] if g["key"] not in drop]
    for key in drop:
        data["items"].pop(key, None)
    return save(data)


# ---------------------------- товары ----------------------------


def add_item(key: str, title: str, cost: float, keywords: str = "",
             lot_id: str | int | None = None, price: float | None = None,
             cost_cashback: float | None = None, has_cashback: bool = False) -> dict:
    data = load()
    if not any(g["key"] == key for g in data["games"]):
        raise ValueError("Такой игры нет в списке")

    fields = {
        "cost": cost,
        "cost_cashback": cost_cashback,
        "has_cashback": bool(has_cashback and cost_cashback is not None),
        "keywords": keywords.strip(),
        "lot_id": lot_id,
        "price": price,
    }

    items = data["items"].setdefault(key, [])
    same = next((i for i in items if i["title"].strip().lower() == title.strip().lower()), None)
    if same:
        same.update(fields)
    else:
        items.append({
            "id": uuid.uuid4().hex[:12],
            "title": title.strip(),
            **fields,
            "created_at": int(time.time()),
        })
    return save(data)


def update_item(item_id: str, fields: dict) -> dict:
    data = load()
    for items in data["items"].values():
        for item in items:
            if item["id"] == item_id:
                item.update({k: v for k, v in fields.items()
                             if k in ("title", "cost", "keywords", "cost_cashback", "has_cashback")})
                return save(data)
    raise ValueError("Товар не найден")


def remove_item(item_id: str) -> dict:
    data = load()
    for key, items in data["items"].items():
        data["items"][key] = [i for i in items if i["id"] != item_id]
    return save(data)


def set_fee(fee: float) -> dict:
    data = load()
    data["fee"] = fee
    return save(data)


def set_cashback_min(value: float) -> dict:
    data = load()
    data["cashback_min"] = value
    return save(data)


def effective_cost(item: dict, cashback_min: float) -> tuple[float, bool]:
    """Цена закупа с учётом кэшбека и порога. Возвращает (цена, кэшбек применён)."""
    plain = float(item.get("cost") or 0)
    cashback = item.get("cost_cashback")

    if not item.get("has_cashback") or cashback is None:
        return plain, False
    if plain < cashback_min:       # покупка меньше порога — банк кэшбек не даст
        return plain, False
    return float(cashback), True


# ---------------------------- сопоставление ----------------------------


def normalize(text: str) -> str:
    return _WORD_RE.sub(" ", (text or "").lower()).strip()


def squash(text: str) -> str:
    """Та же строка без пробелов: «170 шт» и «170шт» должны совпадать."""
    return normalize(text).replace(" ", "")


def _all_items(data: dict) -> list[dict]:
    out = []
    for key, items in data["items"].items():
        for item in items:
            out.append({**item, "game_key": key})
    return out


def match(order_title: str, items: list[dict]) -> dict | None:
    """Ищет товар, подходящий под название заказа. Побеждает самое точное совпадение."""
    target = normalize(order_title)
    target_sq = squash(order_title)
    if not target:
        return None

    best, best_score = None, 0
    for item in items:
        title, title_sq = normalize(item["title"]), squash(item["title"])
        words = [w for w in normalize(item.get("keywords", "")).split() if w]

        score = 0
        if title and title in target:
            score = len(title)
        elif title_sq and title_sq in target_sq:
            score = len(title_sq)
        elif words and all(squash(w) in target_sq for w in words):
            score = sum(len(w) for w in words)

        if score > best_score:
            best, best_score = item, score

    return best


def apply_to_orders(orders: list[dict]) -> list[dict]:
    """Дополняет заказы себестоимостью и прибылью — сразу в двух вариантах:
    по обычной цене закупа и по цене с кэшбеком."""
    data = load()
    items = _all_items(data)
    fee = float(data.get("fee") or 0) / 100
    cashback_min = float(data.get("cashback_min") or 0)

    for order in orders:
        item = match(order.get("title", ""), items) if items else None
        price = float(order.get("price") or 0)
        net = price * (1 - fee)
        order["net"] = round(net, 2)

        if not item:
            order.update({
                "cost": None, "cost_cashback": None, "profit": None,
                "profit_cashback": None, "cashback_used": False, "matched": None,
            })
            continue

        amount = order.get("amount") or 1
        plain = float(item.get("cost") or 0)
        with_cb, used = effective_cost(item, cashback_min)

        order["cost"] = round(plain * amount, 2)
        order["cost_cashback"] = round(with_cb * amount, 2)
        order["profit"] = round(net - plain * amount, 2)
        order["profit_cashback"] = round(net - with_cb * amount, 2)
        order["cashback_used"] = used
        order["matched"] = item["title"]

    return orders
