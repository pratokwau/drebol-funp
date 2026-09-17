#!/usr/bin/env bash
# drebol-funp :: installer for Ubuntu 20.04 / 22.04 / 24.04
# Usage: sudo bash <(curl -sSL https://raw.githubusercontent.com/pratokwau/drebol-funp/main/install.sh)
set -Eeuo pipefail

REPO_URL="https://github.com/pratokwau/drebol-funp.git"
APP_DIR="/opt/drebol-funp"
SERVICE="drebol-funp"
SERVICE_USER="drebol"
WEBROOT="/var/www/certbot"

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

echo -e "${C_Y}Порт, на котором будет открываться сайт: https://$DOMAIN:<порт>${C_R}"
echo -e "${C_Y}443 — стандартный, тогда адрес без порта. Любой другой, например 8443 — адрес с портом.${C_R}"
read -rp "$(echo -e "${C_B}Порт сайта${C_R} [443]: ")" SITE_PORT
SITE_PORT="${SITE_PORT:-443}"
[[ "$SITE_PORT" =~ ^[0-9]+$ ]] && (( SITE_PORT > 0 && SITE_PORT < 65536 )) || die "Порт должен быть числом 1-65535."

USE_SSL="no"; EMAIL=""
if [[ "$DOMAIN" =~ ^[0-9.]+$ || "$DOMAIN" == "localhost" ]]; then
  warn "Домен похож на IP/localhost — Let's Encrypt такое не подписывает, ставлю только HTTP."
elif [[ "$SITE_PORT" == "80" ]]; then
  warn "Порт 80 — это чистый HTTP, SSL на нём не бывает. Ставлю без сертификата."
else
  read -rp "$(echo -e "${C_B}Выпустить SSL-сертификат Let's Encrypt?${C_R} [Y/n]: ")" a
  [[ "${a,,}" == "n" ]] || { USE_SSL="yes"; read -rp "$(echo -e "${C_B}E-mail для Let's Encrypt${C_R} (Enter — без почты): ")" EMAIL; }
fi
[[ "$USE_SSL" == "no" && "$SITE_PORT" == "443" ]] && warn "Без сертификата сайт будет на http://$DOMAIN:443 — так можно, но лучше выбрать 80 или включить SSL."

# внутренний порт приложения (наружу не торчит) — берём первый свободный
APP_PORT=""
for p in $(seq 8080 8130); do
  (( p == SITE_PORT )) && continue
  if ! ss -ltn 2>/dev/null | grep -q ":$p\b"; then APP_PORT="$p"; break; fi
done
[[ -n "$APP_PORT" ]] || die "Не нашёл свободный внутренний порт в диапазоне 8080-8130."

SCHEME="http"; [[ "$USE_SSL" == "yes" ]] && SCHEME="https"
if { [[ "$SCHEME" == "https" && "$SITE_PORT" == "443" ]] || [[ "$SCHEME" == "http" && "$SITE_PORT" == "80" ]]; }; then
  SITE_URL="$SCHEME://$DOMAIN"
else
  SITE_URL="$SCHEME://$DOMAIN:$SITE_PORT"
fi

echo
log "Сайт будет здесь: ${C_G}$SITE_URL${C_R}"
log "Внутренний порт приложения (127.0.0.1): $APP_PORT"
echo

# ---------- пакеты ----------
log "Ставлю пакеты..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates python3 python3-venv python3-pip nginx openssl iproute2 >/dev/null
[[ "$USE_SSL" == "yes" ]] && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
ok "Пакеты установлены."

# ---------- код ----------
if [[ -d "$APP_DIR/.git" ]]; then
  log "Обновляю код в $APP_DIR..."
  git -C "$APP_DIR" fetch --all -q
  git -C "$APP_DIR" reset --hard -q origin/HEAD 2>/dev/null || git -C "$APP_DIR" pull -q
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
  KEEP_PASS="${ADMIN_PASSWORD:-}"; KEEP_SECRET="${SECRET_KEY:-$(openssl rand -hex 32)}"
else
  KEEP_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  KEEP_SECRET="$(openssl rand -hex 32)"
  ok "Сгенерирован пароль администратора."
fi
ADMIN_PASSWORD="$KEEP_PASS"
cat > "$APP_DIR/.env" <<EOF
DOMAIN=$DOMAIN
SITE_PORT=$SITE_PORT
SITE_URL=$SITE_URL
PORT=$APP_PORT
SECRET_KEY=$KEEP_SECRET
ADMIN_LOGIN=admin
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
chmod 600 "$APP_DIR/.env"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

# ---------- systemd ----------
log "Настраиваю systemd-сервис..."
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=drebol-funp web panel
Wants=network-online.target
After=network-online.target nginx.service
# не сдаваться после серии быстрых падений — перезапускать бесконечно
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $APP_PORT
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
systemctl is-enabled -q nginx || systemctl enable -q nginx
systemctl is-enabled -q "$SERVICE" || die "Не удалось добавить $SERVICE в автозагрузку."
ok "Сервис $SERVICE запущен и добавлен в автозагрузку (стартует сам после ребута)."

# ---------- nginx ----------
mkdir -p "$WEBROOT"

proxy_block() {
  cat <<EOF
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
EOF
}

write_nginx_http() {
  # этап 1: только HTTP — отдаёт сайт (без SSL) либо ACME-челлендж и редирект (с SSL)
  {
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    echo "    server_name $DOMAIN;"
    echo "    location /.well-known/acme-challenge/ { root $WEBROOT; }"
    if [[ "$USE_SSL" == "yes" ]]; then
      echo "    location / { return 301 $SITE_URL\$request_uri; }"
    elif [[ "$SITE_PORT" == "80" ]]; then
      proxy_block
    else
      echo "    location / { return 301 $SITE_URL\$request_uri; }"
    fi
    echo "}"
    if [[ "$USE_SSL" == "no" && "$SITE_PORT" != "80" ]]; then
      echo
      echo "server {"
      echo "    listen $SITE_PORT;"
      echo "    listen [::]:$SITE_PORT;"
      echo "    server_name $DOMAIN;"
      proxy_block
      echo "}"
    fi
  } > "/etc/nginx/sites-available/$SERVICE"
}

write_nginx_ssl() {
  local extra=""
  [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] && extra+="    include /etc/letsencrypt/options-ssl-nginx.conf;"$'\n'
  [[ -f /etc/letsencrypt/ssl-dhparams.pem ]] && extra+="    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"$'\n'
  {
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    echo "    server_name $DOMAIN;"
    echo "    location /.well-known/acme-challenge/ { root $WEBROOT; }"
    echo "    location / { return 301 $SITE_URL\$request_uri; }"
    echo "}"
    echo
    echo "server {"
    echo "    listen $SITE_PORT ssl;"
    echo "    listen [::]:$SITE_PORT ssl;"
    echo "    server_name $DOMAIN;"
    echo
    echo "    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;"
    echo "    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;"
    printf '%s' "$extra"
    echo
    proxy_block
    echo "}"
  } > "/etc/nginx/sites-available/$SERVICE"
}

log "Настраиваю nginx..."
write_nginx_http
ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || { nginx -t; die "Конфиг nginx не прошёл проверку."; }
systemctl reload nginx
ok "nginx настроен."

# ---------- firewall ----------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow "$SITE_PORT/tcp" >/dev/null 2>&1 || true
  ok "Порты 80 и $SITE_PORT открыты в ufw."
else
  warn "ufw выключен — если у хостера есть свой файрвол, открой в нём порты 80 и $SITE_PORT."
fi

# ---------- ssl ----------
if [[ "$USE_SSL" == "yes" ]]; then
  log "Выпускаю SSL-сертификат (проверка домена идёт по порту 80)..."
  CB=(certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos
      --deploy-hook "systemctl reload nginx")
  if [[ -n "$EMAIL" ]]; then CB+=(-m "$EMAIL"); else CB+=(--register-unsafely-without-email); fi
  if "${CB[@]}"; then
    write_nginx_ssl
    nginx -t >/dev/null 2>&1 || { nginx -t; die "Конфиг nginx с SSL не прошёл проверку."; }
    systemctl reload nginx
    ok "SSL выпущен, автопродление включено (systemd timer certbot)."
  else
    warn "Certbot не смог выпустить сертификат — проверь, что A-запись домена смотрит на этот сервер и порт 80 открыт."
    SCHEME="http"
    SITE_URL="http://$DOMAIN:$SITE_PORT"
    [[ "$SITE_PORT" == "80" ]] && SITE_URL="http://$DOMAIN"
    USE_SSL="no"
    write_nginx_http
    sed -i "s|^SITE_URL=.*|SITE_URL=$SITE_URL|" "$APP_DIR/.env"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    systemctl restart "$SERVICE"
    warn "Сайт поднят по HTTP: $SITE_URL"
  fi
fi

sleep 2
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "Сервис не поднялся, смотри лог выше."; }

echo
echo -e "${C_G}============================================================${C_R}"
echo -e "${C_G}  drebol-funp установлен${C_R}"
echo -e "  Адрес:  ${C_B}$SITE_URL${C_R}"
echo -e "  Логин:  ${C_B}admin${C_R}"
echo -e "  Пароль: ${C_B}${ADMIN_PASSWORD:-см. $APP_DIR/.env}${C_R}"
echo -e "${C_G}============================================================${C_R}"
echo -e "  Пароль также печатается в консоль при старте сайта:"
echo -e "    ${C_Y}journalctl -u $SERVICE -n 50 --no-pager${C_R}"
echo -e "  Автозагрузка: ${C_G}включена${C_R} — сайт поднимется сам после ребута"
echo -e "  и перезапустится через 3 сек, если процесс упадёт."
echo -e "  Управление:"
echo -e "    ${C_Y}systemctl restart|stop|status $SERVICE${C_R}"
echo -e "    ${C_Y}systemctl is-enabled $SERVICE${C_R}   # проверить автозагрузку"
echo
