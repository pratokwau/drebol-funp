#!/usr/bin/env bash
# Обновление панели с GitHub. Запускается из веб-интерфейса, живёт отдельно от сервиса.
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="drebol-funp"
LOG="$APP_DIR/data/update.log"
LOCK="$APP_DIR/data/update.lock"

mkdir -p "$APP_DIR/data"
exec >>"$LOG" 2>&1
: > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

say() { echo "[$(date '+%H:%M:%S')] $*"; }

say "Старт обновления в $APP_DIR"
cd "$APP_DIR"

BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
say "Текущая версия: $BEFORE"

say "Забираю изменения с GitHub..."
git fetch --all -q

REF="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
if [[ -z "$REF" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if git rev-parse --verify -q "origin/$BRANCH" >/dev/null; then REF="origin/$BRANCH"; else REF="origin/main"; fi
fi
say "Обновляюсь до $REF"

if [[ -n "$(git status --porcelain)" ]]; then
  say "Есть локальные правки — прячу их в git stash"
  git stash push -u -m "drebol-auto-$(date +%s)" || true
fi

git reset --hard -q "$REF"
AFTER="$(git rev-parse --short HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  say "Обновлений нет, версия прежняя: $AFTER"
else
  say "Код обновлён: $BEFORE → $AFTER"
  git log --oneline --no-decorate -5 | sed 's/^/    /'
fi

if [[ -x "$APP_DIR/venv/bin/pip" ]]; then
  say "Проверяю зависимости..."
  "$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt" && say "Зависимости в порядке."
else
  say "venv не найден — пропускаю установку зависимостей."
fi

chmod +x "$APP_DIR/scripts/"*.sh 2>/dev/null || true

if ! command -v systemctl >/dev/null; then
  say "systemctl не найден — перезапусти сайт вручную. Код обновлён до $AFTER"
  exit 0
fi

say "Перезапускаю сервис $SERVICE..."
systemctl restart "$SERVICE"
sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  say "Готово. Сайт работает на версии $AFTER"
else
  say "ОШИБКА: сервис не поднялся. Смотри: journalctl -u $SERVICE -n 50"
fi
