"""Отчёт по чистой прибыли из локального кэша заказов."""
from __future__ import annotations

import copy
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import orders_store, pricing

PERIODS = {
    "today": "Сегодня",
    "yesterday": "Вчера",
    "7d": "7 дней",
    "30d": "30 дней",
    "90d": "90 дней",
    "month": "Этот месяц",
    "prev_month": "Прошлый месяц",
    "year": "Этот год",
    "all": "Всё время",
    "custom": "Свой период",
}
STATUS_KEYS = {"closed", "paid", "refunded", "partially_refunded", "unpaid"}
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


def _range(period: str, date_from: str, date_to: str, now: datetime) -> tuple[date | None, date | None]:
    """Границы периода включительно. None — без ограничения."""
    today = now.date()
    if period == "today":
        return today, today
    if period == "yesterday":
        d = today - timedelta(days=1)
        return d, d
    if period in ("7d", "30d", "90d"):
        days = int(period[:-1])
        return today - timedelta(days=days - 1), today
    if period == "month":
        return today.replace(day=1), today
    if period == "prev_month":
        last = today.replace(day=1) - timedelta(days=1)
        return last.replace(day=1), last
    if period == "year":
        return today.replace(month=1, day=1), today
    if period == "custom":
        def parse(v: str) -> date | None:
            try:
                return date.fromisoformat(v) if v else None
            except ValueError:
                return None
        a, b = parse(date_from), parse(date_to)
        if a and b and a > b:
            a, b = b, a
        return a, b
    return None, None


def _bucket(d: date, group: str) -> tuple[str, str]:
    """Ключ и подпись интервала для графика."""
    if group == "month":
        return d.strftime("%Y-%m"), f"{MONTHS[d.month - 1]} {d.year}"
    if group == "week":
        start = d - timedelta(days=d.weekday())
        return start.isoformat(), f"с {start.day:02d}.{start.month:02d}"
    return d.isoformat(), f"{d.day:02d}.{d.month:02d}"


def _next_bucket(d: date, group: str) -> date:
    if group == "month":
        return (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    if group == "week":
        return d - timedelta(days=d.weekday()) + timedelta(days=7)
    return d + timedelta(days=1)


def _auto_group(a: date | None, b: date | None, first: date | None) -> str:
    start = a or first
    if not start or not b:
        return "day"
    span = (b - start).days + 1
    if span <= 45:
        return "day"
    if span <= 200:
        return "week"
    return "month"


def _money(v: float) -> float:
    return round(v, 2)


def report(period: str = "30d", date_from: str = "", date_to: str = "",
           statuses: str = "closed,paid", game: str = "", only_matched: bool = False,
           group: str = "", now: datetime | None = None) -> dict:
    now = now or datetime.now()
    period = period if period in PERIODS else "30d"
    wanted = {s for s in statuses.split(",") if s in STATUS_KEYS} or {"closed", "paid"}

    cache = orders_store.load()
    raw = list(cache["orders"].values())
    orders = pricing.apply_to_orders(copy.deepcopy(raw))

    for o in orders:
        o["_dt"] = orders_store._parse_date(o.get("date"))
    orders = [o for o in orders if o["_dt"]]

    categories = sorted({o.get("category") or "" for o in orders} - {""})
    first_date = min((o["_dt"].date() for o in orders), default=None)

    a, b = _range(period, date_from, date_to, now)
    b = b or now.date()

    def in_period(o: dict) -> bool:
        d = o["_dt"].date()
        return (a is None or d >= a) and d <= b

    def in_game(o: dict) -> bool:
        return not game or (o.get("category") or "") == game

    scoped = [o for o in orders if in_period(o) and in_game(o)]
    refunds = [o for o in scoped if o.get("status_code") in ("refunded", "partially_refunded")]
    picked = [o for o in scoped if o.get("status_code") in wanted]
    if only_matched:
        picked = [o for o in picked if o.get("matched")]

    # закуп уже выбран по каждому заказу (с кэшбеком или без) в pricing.apply_to_orders
    def profit_of(o: dict) -> float | None:
        return o.get("profit")

    def cost_of(o: dict) -> float:
        return float(o.get("cost") or 0)

    def summarize(rows: list[dict]) -> dict:
        matched = [o for o in rows if profit_of(o) is not None]
        revenue = sum(float(o.get("price") or 0) for o in rows)
        net = sum(float(o.get("net") or 0) for o in rows)
        m_revenue = sum(float(o.get("price") or 0) for o in matched)
        m_net = sum(float(o.get("net") or 0) for o in matched)
        cost = sum(cost_of(o) for o in matched)
        profit = sum(profit_of(o) for o in matched)
        saved = sum(o["variants"]["plain"] - o["variants"]["cashback"]
                    for o in matched if o.get("cashback_used") and o.get("variants"))
        return {
            "orders": len(rows),
            "revenue": _money(revenue),
            "fee": _money(revenue - net),
            "net": _money(net),
            "matched": len(matched),
            "unmatched": len(rows) - len(matched),
            "matched_revenue": _money(m_revenue),
            "cost": _money(cost),
            "profit": _money(profit),
            "margin": round(profit / m_revenue * 100, 2) if m_revenue else None,
            "roi": round(profit / cost * 100, 2) if cost else None,
            "avg_check": _money(revenue / len(rows)) if rows else 0,
            "avg_profit": _money(profit / len(matched)) if matched else 0,
            "zero_cost": sum(1 for o in matched if not cost_of(o)),
            "cashback_orders": sum(1 for o in matched if o.get("cashback_used")),
            "undecided": sum(1 for o in matched if o.get("variants") and not o.get("choice")),
            "cashback_saved": _money(saved),
            "loss_orders": sum(1 for o in matched if profit_of(o) < 0),
            "net_matched": _money(m_net),
        }

    totals = summarize(picked)

    # сравнение с предыдущим таким же периодом
    prev = None
    if a is not None:
        span = (b - a).days + 1
        pa, pb = a - timedelta(days=span), a - timedelta(days=1)
        prev_rows = [o for o in orders if pa <= o["_dt"].date() <= pb and in_game(o)
                     and o.get("status_code") in wanted and (not only_matched or o.get("matched"))]
        p = summarize(prev_rows)
        prev = {"from": pa.isoformat(), "to": pb.isoformat(),
                "profit": p["profit"], "revenue": p["revenue"], "orders": p["orders"]}

    # динамика
    start = a or (min((o["_dt"].date() for o in picked), default=b))
    grp = group if group in ("day", "week", "month") else _auto_group(a, b, first_date)
    buckets: dict[str, dict] = {}
    cursor = date.fromisoformat(_bucket(start, grp)[0] + ("-01" if grp == "month" else ""))
    guard = 0
    while cursor <= b and guard < 1000:
        k, label = _bucket(cursor, grp)
        buckets.setdefault(k, {"key": k, "label": label, "revenue": 0.0, "profit": 0.0,
                               "orders": 0, "matched": 0})
        cursor = _next_bucket(cursor, grp)
        guard += 1
    for o in picked:
        k, label = _bucket(o["_dt"].date(), grp)
        row = buckets.setdefault(k, {"key": k, "label": label, "revenue": 0.0, "profit": 0.0,
                                     "orders": 0, "matched": 0})
        row["revenue"] += float(o.get("price") or 0)
        row["orders"] += 1
        p = profit_of(o)
        if p is not None:
            row["profit"] += p
            row["matched"] += 1
    series = sorted(buckets.values(), key=lambda r: r["key"])
    for r in series:
        r["revenue"], r["profit"] = _money(r["revenue"]), _money(r["profit"])

    # разрезы
    def group_by(field_fn, limit: int | None = None) -> list[dict]:
        acc: dict[str, dict] = defaultdict(lambda: {"orders": 0, "revenue": 0.0, "cost": 0.0,
                                                    "profit": 0.0, "matched": 0})
        for o in picked:
            k = field_fn(o)
            if not k:
                continue
            row = acc[k]
            row["orders"] += 1
            row["revenue"] += float(o.get("price") or 0)
            p = profit_of(o)
            if p is not None:
                row["profit"] += p
                row["cost"] += cost_of(o)
                row["matched"] += 1
        out = []
        for k, r in acc.items():
            out.append({
                "name": k, "orders": r["orders"], "matched": r["matched"],
                "revenue": _money(r["revenue"]), "cost": _money(r["cost"]),
                "profit": _money(r["profit"]),
                "margin": round(r["profit"] / r["revenue"] * 100, 2) if r["revenue"] and r["matched"] else None,
            })
        out.sort(key=lambda r: (r["profit"], r["revenue"]), reverse=True)
        return out[:limit] if limit else out

    products = group_by(lambda o: o.get("matched"))
    unmatched = group_by(lambda o: None if o.get("matched") else (o.get("title") or "без названия"), 15)
    unmatched.sort(key=lambda r: r["revenue"], reverse=True)
    games = group_by(lambda o: o.get("category") or "Без раздела")
    buyers = group_by(lambda o: o.get("buyer"), 10)

    losses = sorted((o for o in picked if (profit_of(o) or 0) < 0), key=profit_of)[:10]
    losses = [{"id": o["id"], "title": o.get("title"), "price": o.get("price"),
               "cost": cost_of(o), "profit": profit_of(o), "date": o.get("date"),
               "link": o.get("link")} for o in losses]

    heat = [[0] * 24 for _ in range(7)]
    heat_profit = [[0.0] * 24 for _ in range(7)]
    for o in picked:
        dt = o["_dt"]
        heat[dt.weekday()][dt.hour] += 1
        p = profit_of(o)
        if p is not None:
            heat_profit[dt.weekday()][dt.hour] += p

    weekdays = [{"name": WEEKDAYS[i], "orders": sum(heat[i]),
                 "profit": _money(sum(heat_profit[i]))} for i in range(7)]

    return {
        "ok": True,
        "period": {"key": period, "label": PERIODS[period],
                   "from": a.isoformat() if a else (first_date.isoformat() if first_date else None),
                   "to": b.isoformat()},
        "statuses": sorted(wanted),
        "group": grp,
        "game": game,
        "totals": totals,
        "prev": prev,
        "refunds": {"count": len(refunds),
                    "sum": _money(sum(float(o.get("price") or 0) for o in refunds))},
        "series": series,
        "products": products,
        "unmatched": unmatched,
        "games": games,
        "buyers": buyers,
        "losses": losses,
        "heat": heat,
        "weekdays": weekdays,
        "categories": categories,
        "fee_percent": pricing.load()["fee"],
        "cache": orders_store.status(),
    }
