"""Мин. цены: закупочные цены товаров и сопоставление их с продажами."""
from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
FILE = DATA_DIR / "pricing.json"
CHOICES_FILE = DATA_DIR / "cost_choices.json"   # номер заказа -> "cashback" | "plain"

DEFAULTS: dict = {
    "fee": 3.0,            # комиссия FunPay, %
    "cashback_min": 100.0,  # кэшбек в банке работает от этой суммы покупки
    "games": [],           # выбранные подкатегории профиля
    "items": {},           # ключ игры -> список товаров с закупочной ценой
}

_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
# слова и числа по отдельности: «170шт» -> ["170", "шт"]
_TOKEN_RE = re.compile(r"\d+|[^\W\d_]+", re.UNICODE)


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


def get_item(item_id: str) -> tuple[str, dict] | None:
    """(ключ игры, товар) или None."""
    for key, items in load()["items"].items():
        for item in items:
            if item["id"] == item_id:
                return key, item
    return None


def update_item(item_id: str, fields: dict) -> dict:
    data = load()
    for key, items in data["items"].items():
        for item in items:
            if item["id"] != item_id:
                continue
            title = fields.get("title")
            if title is not None:
                clash = next((i for i in items if i["id"] != item_id
                              and i["title"].strip().lower() == title.strip().lower()), None)
                if clash:
                    raise ValueError(f"В этой игре уже есть товар «{clash['title']}»")
            item.update({k: v for k, v in fields.items()
                         if k in ("title", "cost", "keywords", "cost_cashback", "has_cashback")})
            save(data)
            return {"key": key, "item": item, "items": items}
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


def variants(item: dict, cashback_min: float) -> tuple[float, float | None]:
    """Цены закупа товара: (без кэшбека, с кэшбеком или None).

    Второй вариант есть, только если он задан и покупка не меньше порога:
    банк не начисляет кэшбек на покупки дешевле cashback_min.
    """
    plain = float(item.get("cost") or 0)
    cashback = item.get("cost_cashback")
    if not item.get("has_cashback") or cashback is None or plain < cashback_min:
        return plain, None
    return plain, float(cashback)


def cashback_price(cost: float, percent: float, cashback_min: float) -> float | None:
    """Цена с кэшбеком так, как считает банк: процент от покупки,
    округлённый вниз до целого рубля, и только от порога.
    764.75 при 1% -> кэшбек 7 ₽ -> 757.75."""
    if cost < cashback_min or percent <= 0:
        return None
    back = math.floor(round(cost * percent / 100, 6))
    if back <= 0:
        return None
    return round(cost - back, 2)


def apply_cashback(key: str, percent: float, overwrite: bool = False) -> dict:
    """Проставляет цену с кэшбеком всем товарам игры по одному проценту."""
    data = load()
    cashback_min = float(data.get("cashback_min") or 0)
    items = data["items"].get(key)
    if items is None:
        raise ValueError("Такой игры нет в списке")

    stats = {"applied": 0, "below_min": 0, "kept": 0, "no_cost": 0}
    for item in items:
        cost = float(item.get("cost") or 0)
        if not cost:
            stats["no_cost"] += 1
            continue
        if item.get("has_cashback") and item.get("cost_cashback") is not None and not overwrite:
            stats["kept"] += 1
            continue
        price = cashback_price(cost, percent, cashback_min)
        if price is None:
            stats["below_min"] += 1
            continue
        item["cost_cashback"] = price
        item["has_cashback"] = True
        stats["applied"] += 1

    save(data)
    return {**stats, "items": data["items"][key]}


# ---------------------------- выбор закупа по заказу ----------------------------


def load_choices() -> dict:
    if CHOICES_FILE.exists():
        try:
            return json.loads(CHOICES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def set_choice(order_id: str, choice: str | None) -> dict:
    choices = load_choices()
    if choice in ("cashback", "plain"):
        choices[str(order_id)] = choice
    else:
        choices.pop(str(order_id), None)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CHOICES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(choices, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(CHOICES_FILE)
    return choices


# ---------------------------- сопоставление ----------------------------


def normalize(text: str) -> str:
    return _WORD_RE.sub(" ", (text or "").lower()).strip()


def tokens(text: str) -> list[str]:
    """Разбивает название на слова и числа.

    «Гемы 170шт» и «гемы 170 шт» дают одинаковые токены, а «50» и «500»
    остаются разными — иначе закуп от «500 голосов» цеплялся бы к «50 голосов».
    """
    return _TOKEN_RE.findall(normalize(text))


def _contains(haystack: list[str], needle: list[str]) -> bool:
    """Идут ли токены needle подряд внутри haystack."""
    if not needle or len(needle) > len(haystack):
        return False
    for i in range(len(haystack) - len(needle) + 1):
        if haystack[i:i + len(needle)] == needle:
            return True
    return False


def _all_items(data: dict) -> list[dict]:
    out = []
    for key, items in data["items"].items():
        for item in items:
            out.append({**item, "game_key": key})
    return out


def match(order_title: str, items: list[dict]) -> dict | None:
    """Ищет товар, подходящий под название заказа. Побеждает самое точное совпадение."""
    target = tokens(order_title)
    if not target:
        return None

    best, best_score = None, 0
    for item in items:
        title = tokens(item["title"])
        keys = tokens(item.get("keywords", ""))

        score = 0
        if _contains(target, title):
            # чем длиннее совпавшее название, тем оно точнее
            score = sum(len(t) for t in title) + len(title)
        elif keys and all(k in target for k in keys):
            score = sum(len(k) for k in keys)

        if score > best_score:
            best, best_score = item, score

    return best


def apply_to_orders(orders: list[dict]) -> list[dict]:
    """Дополняет заказы закупом и чистой прибылью.

    Если у товара две цены закупа (с кэшбеком и без), какая из них пошла
    в заказ, выбирает пользователь. Пока не выбрал — считаем без кэшбека,
    чтобы прибыль не оказалась завышенной.
    """
    data = load()
    items = _all_items(data)
    choices = load_choices()
    fee = float(data.get("fee") or 0) / 100
    cashback_min = float(data.get("cashback_min") or 0)

    for order in orders:
        item = match(order.get("title", ""), items) if items else None
        price = float(order.get("price") or 0)
        net = price * (1 - fee)
        order["net"] = round(net, 2)

        if not item:
            order.update({"cost": None, "profit": None, "matched": None,
                          "variants": None, "choice": None, "cashback_used": False})
            continue

        amount = order.get("amount") or 1
        plain, cashback = variants(item, cashback_min)
        choice = choices.get(str(order.get("id"))) if cashback is not None else None
        use_cb = choice == "cashback"
        cost = (cashback if use_cb else plain) * amount

        order["matched"] = item["title"]
        order["variants"] = ({"plain": round(plain * amount, 2), "cashback": round(cashback * amount, 2)}
                             if cashback is not None else None)
        order["choice"] = choice
        order["cashback_used"] = use_cb
        order["cost"] = round(cost, 2)
        order["profit"] = round(net - cost, 2)

    return orders
