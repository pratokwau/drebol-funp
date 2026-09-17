"""Обновление панели с GitHub: версия, проверка новых коммитов, запуск апдейта."""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
UPDATE_LOG = DATA_DIR / "update.log"
UPDATE_SCRIPT = BASE_DIR / "scripts" / "update.sh"


def git(*args: str, timeout: int = 60) -> tuple[int, str]:
    try:
        p = subprocess.run(
            ["git", *args],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 1, str(e)
    return p.returncode, (p.stdout or p.stderr).strip()


def upstream_ref() -> str:
    """origin/HEAD, иначе origin/<текущая ветка>, иначе origin/main."""
    code, out = git("symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")
    if code == 0 and out:
        return out
    code, branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if code == 0 and branch and branch != "HEAD":
        code, _ = git("rev-parse", "--verify", "-q", f"origin/{branch}")
        if code == 0:
            return f"origin/{branch}"
    return "origin/main"


def version() -> dict:
    code, commit = git("rev-parse", "--short", "HEAD")
    if code != 0:
        return {"ok": False, "error": "Папка панели — не git-репозиторий, обновление недоступно"}
    _, branch = git("rev-parse", "--abbrev-ref", "HEAD")
    _, date = git("log", "-1", "--format=%cI")
    _, subject = git("log", "-1", "--format=%s")
    return {
        "ok": True,
        "commit": commit,
        "branch": branch,
        "date": date,
        "subject": subject,
    }


def check() -> dict:
    """Спрашивает GitHub, есть ли новые коммиты."""
    info = version()
    if not info.get("ok"):
        return info

    code, out = git("fetch", "--all", "-q", timeout=120)
    if code != 0:
        return {**info, "error": f"Не удалось связаться с GitHub: {out}"}

    ref = upstream_ref()
    code, count = git("rev-list", "--count", f"HEAD..{ref}")
    behind = int(count) if code == 0 and count.isdigit() else 0
    _, log = git("log", "--oneline", "--no-decorate", "-10", f"HEAD..{ref}")
    _, dirty = git("status", "--porcelain")
    return {
        **info,
        "behind": behind,
        "commits": [line for line in log.splitlines() if line],
        "dirty": bool(dirty),
        "upstream": ref,
    }


def is_running() -> bool:
    lock = DATA_DIR / "update.lock"
    if not lock.exists():
        return False
    # замок старше 10 минут считаем протухшим
    if time.time() - lock.stat().st_mtime > 600:
        lock.unlink(missing_ok=True)
        return False
    return True


def start() -> dict:
    """Запускает update.sh отдельным процессом — он переживёт рестарт сервиса."""
    if not UPDATE_SCRIPT.exists():
        return {"ok": False, "error": f"Нет скрипта обновления: {UPDATE_SCRIPT}"}
    if is_running():
        return {"ok": False, "error": "Обновление уже идёт"}

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPDATE_LOG.write_text("", encoding="utf-8")
    subprocess.Popen(
        ["/bin/bash", str(UPDATE_SCRIPT)],
        cwd=BASE_DIR,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )
    return {"ok": True}


def log_tail(lines: int = 60) -> dict:
    if not UPDATE_LOG.exists():
        return {"running": is_running(), "log": ""}
    text = UPDATE_LOG.read_text(encoding="utf-8", errors="replace")
    return {"running": is_running(), "log": "\n".join(text.splitlines()[-lines:])}
