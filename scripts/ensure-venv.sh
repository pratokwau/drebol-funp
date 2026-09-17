#!/usr/bin/env bash
# Проверяет venv перед стартом сервиса и пересобирает, если его нет.
# Вызывается из systemd как ExecStartPre — панель чинит себя сама.
set -Eeuo pipefail

APP_DIR="${1:-/root/drebol-funp}"

[[ -x "$APP_DIR/venv/bin/uvicorn" ]] && exit 0

echo "drebol-funp: venv отсутствует или битый — пересобираю..."
rm -rf "$APP_DIR/venv"
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
echo "drebol-funp: venv пересобран."
