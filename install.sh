#!/usr/bin/env bash
# drebol-funp :: installer for Ubuntu 20.04 / 22.04 / 24.04
# Usage: bash <(curl -sSL https://raw.githubusercontent.com/pratokwau/drebol-funp/main/install.sh)
set -Eeuo pipefail

REPO_URL="https://github.com/pratokwau/drebol-funp.git"
APP_DIR="/opt/drebol-funp"
SERVICE="drebol-funp"
SERVICE_USER="drebol"

C_R=$'\e[0m'; C_G=$'\e[1;32m'; C_Y=$'\e[1;33m'; C_B=$'\e[1;36m'; C_E=$'\e[1;31m'
log()  { echo -e "${C_B}[*]${C_R} $*"; }
ok()   { echo -e "${C_G}[+]${C_R} $*"; }
warn() { echo -e "${C_Y}[!]${C_R} $*"; }
die()  { echo -e "${C_E}[x]${C_R} $*" >&2; exit 1; }
trap 'die "Ошибка на строке $LINENO. Установка прервана."' ERR

[[ $EUID -eq 0 ]] || die "Запусти от root:  sudo bash <(curl -sSL https://raw.githubusercontent.com/pratokwau/drebol-funp/main/install.sh)"
[[ -r /etc/os-release ]] || die "Не Ubuntu/Debian система."
. /etc/os-release
[[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *debian* ]] || die "Поддерживается только Ubuntu/Debian."

cat <<'BANNER'
  ____  ____  _____ ____   ___  _       _____ _   _ _   _ ____
 |  _ \|  _ \| ____| __ ) / _ \| |     |  ___| | | | \ | |  _ \
 | | | | |_) |  _| |  _ \| | | | |     | |_  | | | |  \| | |_) |
 | |_| |  _ <| |___| |_) | |_| | |___  |  _| | |_| | |\  |  __/
 |____/|_| \_\_____|____/ \___/|_____| |_|    \___/|_| \_|_|
BANNER
echo

# ---------- вопросы ----------
read -rp "$(echo -e "${C_B}Домен сайта${C_R} (например funp.example.com, можно IP): ")" DOMAIN
DOMAIN="${DOMAIN// /}"
[[ -n "$DOMAIN" ]] || die "Домен обязателен."

read -rp "$(echo -e "${C_B}Внутренний порт сайта${C_R} [8080]: ")" PORT
PORT="${PORT:-8080}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || die "Порт должен быть числом 1-65535."

USE_SSL="no"; EMAIL=""
if [[ "$DOMAIN" =~ ^[0-9.]+$ || "$DOMAIN" == "localhost" ]]; then
  warn "Домен похож на IP/localhost — SSL-сертификат выпустить нельзя, ставлю только HTTP."
else
  read -rp "$(echo -e "${C_B}Выпустить SSL-сертификат Let's Encrypt?${C_R} [Y/n]: ")" a
  [[ "${a,,}" == "n" ]] || { USE_SSL="yes"; read -rp "$(echo -e "${C_B}E-mail для Let's Encrypt${C_R} (Enter — без почты): ")" EMAIL; }
fi

echo
log "Домен: $DOMAIN | порт приложения: $PORT | SSL: $USE_SSL"
echo

# ---------- пакеты ----------
log "Ставлю пакеты..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates python3 python3-venv python3-pip nginx openssl >/dev/null
[[ "$USE_SSL" == "yes" ]] && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
ok "Пакеты установлены."

# ---------- код ----------
if [[ -d "$APP_DIR/.git" ]]; then
  log "Обновляю код в $APP_DIR..."
  git -C "$APP_DIR" fetch --all -q && git -C "$APP_DIR" reset --hard -q origin/HEAD 2>/dev/null || git -C "$APP_DIR" pull -q
else
  log "Клонирую репозиторий в $APP_DIR..."
  rm -rf "$APP_DIR"
  git clone -q "$REPO_URL" "$APP_DIR"
fi
ok "Код на месте."

id -u "$SERVICE_USER" &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"

log "Ставлю python-зависимости..."
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
ok "Зависимости установлены."

# ---------- конфиг и пароль ----------
mkdir -p "$APP_DIR/data"
if [[ -f "$APP_DIR/.env" ]]; then
  warn ".env уже существует — логин и пароль оставляю прежние."
  # shellcheck disable=SC1091
  set -a; . "$APP_DIR/.env"; set +a
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
else
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  SECRET_KEY="$(openssl rand -hex 32)"
  cat > "$APP_DIR/.env" <<EOF
DOMAIN=$DOMAIN
PORT=$PORT
SECRET_KEY=$SECRET_KEY
ADMIN_LOGIN=admin
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
  ok "Сгенерирован пароль администратора."
fi
chmod 600 "$APP_DIR/.env"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

# ---------- systemd ----------
log "Настраиваю systemd-сервис..."
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=drebol-funp web panel
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $PORT
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"
ok "Сервис запущен."

# ---------- nginx ----------
log "Настраиваю nginx..."
cat > "/etc/nginx/sites-available/$SERVICE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
EOF
ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "Конфиг nginx не прошёл проверку."
systemctl reload nginx
ok "nginx настроен."

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  ok "Порты 80/443 открыты в ufw."
fi

# ---------- ssl ----------
SCHEME="http"
if [[ "$USE_SSL" == "yes" ]]; then
  log "Выпускаю SSL-сертификат..."
  if [[ -n "$EMAIL" ]]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect && SCHEME="https" || warn "Certbot не смог выпустить сертификат (проверь, что домен A-записью смотрит на этот сервер). Сайт работает по HTTP."
  else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect && SCHEME="https" || warn "Certbot не смог выпустить сертификат. Сайт работает по HTTP."
  fi
  [[ "$SCHEME" == "https" ]] && ok "SSL выпущен, автопродление включено (systemd timer certbot)."
fi

sleep 2
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "Сервис не поднялся, смотри лог выше."; }

echo
echo -e "${C_G}============================================================${C_R}"
echo -e "${C_G}  drebol-funp установлен${C_R}"
echo -e "  Адрес:  ${C_B}$SCHEME://$DOMAIN${C_R}"
echo -e "  Логин:  ${C_B}admin${C_R}"
echo -e "  Пароль: ${C_B}${ADMIN_PASSWORD:-см. $APP_DIR/.env}${C_R}"
echo -e "${C_G}============================================================${C_R}"
echo -e "  Пароль также печатается в консоль при старте сайта:"
echo -e "    ${C_Y}journalctl -u $SERVICE -n 50 --no-pager${C_R}"
echo -e "  Управление:"
echo -e "    ${C_Y}systemctl restart|stop|status $SERVICE${C_R}"
echo
