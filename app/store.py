"""Хранилище настроек панели: data/settings.json с правами 600."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

DEFAULTS: dict = {
    "golden_key": "",
    "user_agent": DEFAULT_UA,
    "updated_at": 0,
}


def load() -> dict:
    data = dict(DEFAULTS)
    if SETTINGS_FILE.exists():
        try:
            data.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass
    return data


def save(data: dict) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = int(time.time())
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(SETTINGS_FILE)
    os.chmod(SETTINGS_FILE, 0o600)
    return data


def mask(key: str) -> str:
    """golden_key для показа в интерфейсе: видны только края."""
    if not key:
        return ""
    if len(key) <= 10:
        return "•" * len(key)
    return f"{key[:4]}{'•' * 12}{key[-4:]}"
