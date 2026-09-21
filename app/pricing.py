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
OVERRIDES_FILE = DATA_DIR / "cost_overrides.json"  # номер заказа -> закуп за весь заказ, вписанный вручную
REFUND_STATUSES = {"refunded", "partially_refunded"}

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


def refresh_games(found: list[dict]) -> None:
    """После сканирования обновляем у добавленных игр число лотов и их названия."""
    data = load()
    by_key = {g["key"]: g for g in found}
    changed = False
    for game in data["games"]:
        fresh = by_key.get(game["key"])
        if fresh:
            game["lots"] = fresh.get("lots", game.get("lots"))
            game["lot_titles"] = fresh.get("lot_titles", game.get("lot_titles"))
            changed = True
    if changed:
        save(data)


def update_game_lots(key: str, count: int, titles: list[str]) -> None:
    data = load()
    for game in data["games"]:
        if game["key"] == key:
            game["lots"] = count
            game["lot_titles"] = titles
            save(data)
            return


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


# ---------------------------- ручной закуп в заказе ----------------------------


def load_overrides() -> dict:
    if OVERRIDES_FILE.exists():
        try:
            return json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def set_override(order_id: str, cost: float | None) -> dict:
    overrides = load_overrides()
    if cost is None:
        overrides.pop(str(order_id), None)
    else:
        overrides[str(order_id)] = round(float(cost), 2)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = OVERRIDES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(overrides, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(OVERRIDES_FILE)
    return overrides


# ---------------------------- выбор закупа по заказу ----------------------------


def load_choices() -> dict:
    if CHOICES_FILE.exists():
        try:
            return json.loads(CHOICES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def set_choice(order_id: str, choice: str | None) -> dict:
    return set_choices([order_id], choice)


def set_choices(order_ids: list[str], choice: str | None) -> dict:
    """Один и тот же выбор сразу для нескольких заказов — одна запись файла."""
    choices = load_choices()
    for order_id in order_ids:
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


def game_tokens(game: dict) -> set[str]:
    """Слова раздела: «Standoff 2» + «Золото»."""
    return set(tokens(f"{game.get('game', '')} {game.get('name', '')}"))


def game_for_category(data: dict, category: str) -> str | None:
    """Ключ игры, к которой относится раздел заказа.

    FunPay пишет в заказе «Standoff 2, Золото» — сверяем со словами раздела,
    чтобы «100 золота» из другой игры не подхватился.
    """
    wanted = set(tokens(category or ""))
    if not wanted:
        return None

    best, best_size = None, 0
    for game in data["games"]:
        mine = game_tokens(game)
        if not mine:
            continue
        # раздел подходит, если слова совпали целиком или одно множество внутри другого
        if mine == wanted or mine <= wanted or wanted <= mine:
            if len(mine) > best_size:
                best, best_size = game["key"], len(mine)
    return best


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

    Порядок, от главного к второстепенному:
    1. Возврат — прибыли нет, заказ не участвует в суммах.
    2. Закуп, вписанный вручную в этом заказе.
    3. Закуп из «Мин. цен»; если у товара две цены — по выбору в заказе,
       а пока не выбрано — без кэшбека, чтобы прибыль не оказалась завышенной.
    """
    data = load()
    items = _all_items(data)
    by_game: dict[str, list[dict]] = {}
    for item in items:
        by_game.setdefault(item["game_key"], []).append(item)
    choices = load_choices()
    overrides = load_overrides()
    fee = float(data.get("fee") or 0) / 100
    cashback_min = float(data.get("cashback_min") or 0)

    for order in orders:
        oid = str(order.get("id"))
        category = order.get("category") or ""
        game_key = game_for_category(data, category)

        # ищем товар только внутри раздела заказа; без раздела — по всем играм
        if game_key:
            pool = by_game.get(game_key, [])
        elif category:
            pool = []          # раздел есть, но такой игры в мин. ценах нет
        else:
            pool = items

        item = match(order.get("title", ""), pool) if pool else None
        price = float(order.get("price") or 0)
        net = price * (1 - fee)
        amount = order.get("amount") or 1
        order["net"] = round(net, 2)
        order["matched"] = item["title"] if item else None
        order["matched_game"] = game_key
        # раздел у заказа есть, а такой игры в мин. ценах нет — её стоит добавить
        order["game_missing"] = bool(category) and game_key is None
        order["refunded"] = order.get("status_code") in REFUND_STATUSES
        order["override"] = overrides.get(oid)
        order["manual"] = order["override"] is not None
        order["variants"] = None
        order["choice"] = None
        order["cashback_used"] = False
        order["base_cost"] = None

        # закуп, который дала бы автоматика — нужен, чтобы вернуться к нему после сброса ручного
        if item:
            plain, cashback = variants(item, cashback_min)
            if cashback is not None:
                order["variants"] = {"plain": round(plain * amount, 2), "cashback": round(cashback * amount, 2)}
                order["choice"] = choices.get(oid)
            use_cb = order["choice"] == "cashback"
            order["base_cost"] = round((cashback if use_cb else plain) * amount, 2)

        if order["refunded"]:
            order["cost"] = None
            order["profit"] = None
            continue

        if order["manual"]:
            cost = float(order["override"])
        elif item:
            cost = order["base_cost"]
            order["cashback_used"] = order["choice"] == "cashback" and order["variants"] is not None
        else:
            order["cost"] = None
            order["profit"] = None
            continue

        order["cost"] = round(cost, 2)
        order["profit"] = round(net - cost, 2)

    return orders
