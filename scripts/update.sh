#!/usr/bin/env bash
# Обновление панели с GitHub. Запускается из веб-интерфейса, живёт отдельно от сервиса.
set -Eeuo pipefail

# Папку панели передаёт вызывающий: скрипт запускается копией из /tmp,
# потому что git reset --hard перезаписывает его собственный файл.
APP_DIR="${1:-${DREBOL_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
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

# venv, data и .env не должны попадать под git — иначе их унесёт при обновлении
if [[ -d "$APP_DIR/.git" ]]; then
  mkdir -p "$APP_DIR/.git/info"
  for pat in "venv/" "data/" ".env" "__pycache__/" "*.pyc"; do
    grep -qxF "$pat" "$APP_DIR/.git/info/exclude" 2>/dev/null \
      || echo "$pat" >> "$APP_DIR/.git/info/exclude"
  done
fi

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

# ВАЖНО: без -u. Флаг -u прячет неотслеживаемые файлы, а это venv/ и data/,
# если в репозитории вдруг нет .gitignore — панель после такого не запускается.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  say "Есть локальные правки в файлах репозитория — прячу их в git stash"
  git stash push -m "drebol-auto-$(date +%s)" || true
fi

git reset --hard -q "$REF"
AFTER="$(git rev-parse --short HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  say "Обновлений нет, версия прежняя: $AFTER"
else
  say "Код обновлён: $BEFORE → $AFTER"
  git log --oneline --no-decorate -5 | sed 's/^/    /'
fi

rollback() {
  local why="$1"
  say "$why"
  if [[ "$BEFORE" == "?" || "$BEFORE" == "$AFTER" ]]; then
    say "Откатываться некуда. Чини руками: journalctl -u $SERVICE -n 50"
    exit 1
  fi
  say "Откатываюсь на прошлую версию $BEFORE..."
  git reset --hard -q "$BEFORE"
  [[ -x "$APP_DIR/venv/bin/pip" ]] && "$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt" >/dev/null 2>&1 || true
  if command -v systemctl >/dev/null && systemctl cat "$SERVICE" >/dev/null 2>&1; then
    systemctl restart "$SERVICE" || true
    sleep 4
    if systemctl is-active --quiet "$SERVICE"; then
      say "Откат удался — сайт снова работает на версии $BEFORE."
    else
      say "Откат не помог. Смотри: journalctl -u $SERVICE -n 50"
    fi
  fi
  say "Обновление НЕ применено: сначала почини код, потом обновляйся снова."
  exit 1
}

if [[ -x "$APP_DIR/venv/bin/pip" ]]; then
  say "Проверяю зависимости..."
  if "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt" 2>&1 | tail -n 8 | sed 's/^/    /'; then
    say "Зависимости в порядке."
  else
    rollback "ОШИБКА: не удалось поставить зависимости (вывод pip выше)."
  fi
else
  say "venv не найден — пропускаю установку зависимостей."
fi

chmod +x "$APP_DIR/scripts/"*.sh 2>/dev/null || true

# venv мог пропасть (например, его унесло прошлой версией апдейтера) — чиним
if [[ ! -x "$APP_DIR/venv/bin/uvicorn" ]]; then
  say "venv отсутствует или битый — пересобираю..."
  rm -rf "$APP_DIR/venv"
  if python3 -m venv "$APP_DIR/venv" >/dev/null 2>&1 \
     && "$APP_DIR/venv/bin/pip" install -q --upgrade pip >/dev/null 2>&1 \
     && "$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"; then
    say "venv пересобран."
  else
    say "ОШИБКА: не удалось собрать venv. Запусти установщик:"
    say "  cd /root && curl -sSL https://raw.githubusercontent.com/pratokwau/drebol-funp/main/install.sh -o install.sh && bash install.sh"
    exit 1
  fi
fi

if ! command -v systemctl >/dev/null; then
  say "systemctl не найден — перезапусти сайт вручную. Код обновлён до $AFTER"
  exit 0
fi

# аварийное восстановление юнита, если файл сервиса куда-то делся
restore_unit() {
  local port
  port="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"
  [[ -n "$port" ]] || { say "В .env нет PORT — не могу пересоздать юнит."; return 1; }
  cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=drebol-funp web panel
Wants=network-online.target
After=network-online.target nginx.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStartPre=-/bin/bash $APP_DIR/scripts/ensure-venv.sh $APP_DIR
ExecStart=$APP_DIR/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $port
Restart=always
RestartSec=3
TimeoutStartSec=600
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable -q "$SERVICE"
  say "Юнит пересоздан (порт приложения $port)."
}

# юнит мог остаться от старой версии — обновляем его вместе с кодом
if systemctl cat "$SERVICE" 2>/dev/null | grep -q "ExecStart="; then
  if ! systemctl cat "$SERVICE" 2>/dev/null | grep -q "ensure-venv.sh"; then
    say "Обновляю systemd-юнит (добавляю самопроверку venv)..."
    restore_unit || say "Не вышло обновить юнит — не страшно, работаем со старым."
  fi
fi

if ! systemctl cat "$SERVICE" >/dev/null 2>&1; then
  say "ВНИМАНИЕ: systemd не знает сервис $SERVICE — файл юнита пропал. Пересоздаю..."
  if ! restore_unit; then
    say "Восстанови панель установщиком:"
    say "  cd /root && curl -sSL https://raw.githubusercontent.com/pratokwau/drebol-funp/main/install.sh -o install.sh && bash install.sh"
    exit 1
  fi
fi

say "Перезапускаю сервис $SERVICE..."
systemctl restart "$SERVICE" || true
sleep 4

if systemctl is-active --quiet "$SERVICE"; then
  say "Готово. Сайт работает на версии $AFTER"
  exit 0
fi

# --- сервис не поднялся: откатываемся на прошлую версию ---
say "Последние строки лога сервиса:"
journalctl -u "$SERVICE" -n 15 --no-pager 2>/dev/null | sed 's/^/    /' || true
rollback "ОШИБКА: сервис не поднялся на версии $AFTER."
