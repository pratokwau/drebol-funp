#!/usr/bin/env bash
# drebol-funp :: installer for Ubuntu 20.04 / 22.04 / 24.04
# Usage: curl -sSL https://raw.githubusercontent.com/pratokwau/drebol-funp/main/install.sh -o install.sh && bash install.sh
set -Eeuo pipefail

REPO_URL="https://github.com/pratokwau/drebol-funp.git"
APP_DIR="/root/drebol-funp"
DISABLED_DIR="/root/drebol-funp-disabled-nginx"
OLD_DIR="/opt/drebol-funp"
SERVICE="drebol-funp"
WEBROOT="/var/www/certbot"

C_R=$'\e[0m'; C_G=$'\e[1;32m'; C_Y=$'\e[1;33m'; C_B=$'\e[1;36m'; C_E=$'\e[1;31m'
log()  { echo -e "${C_B}[*]${C_R} $*"; }
ok()   { echo -e "${C_G}[+]${C_R} $*"; }
warn() { echo -e "${C_Y}[!]${C_R} $*"; }
die()  { echo -e "${C_E}[x]${C_R} $*" >&2; exit 1; }
trap 'die "Ошибка на строке $LINENO. Установка прервана."' ERR

[[ $EUID -eq 0 ]] || die "Запусти от root:  sudo bash install.sh"
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

# ---------- кто занимает порты ----------
busy_on() { ss -ltnp 2>/dev/null | grep -E "[:.]$1[[:space:]]" || true; }
B80="$(busy_on 80)"
if [[ -n "$B80" ]] && ! grep -q "nginx" <<<"$B80"; then
  warn "Порт 80 уже кем-то занят — nginx может не встать:"
  echo "$B80"
  warn "Если это apache2, останови его:  systemctl disable --now apache2"
fi
BSITE="$(busy_on "$SITE_PORT")"
if [[ -n "$BSITE" ]] && ! grep -q "nginx" <<<"$BSITE"; then
  warn "Порт $SITE_PORT уже занят:"
  echo "$BSITE"
  die "Выбери другой порт сайта или освободи этот."
fi
B443="$(busy_on 443)"
if [[ -n "$B443" ]] && ! grep -q "nginx" <<<"$B443"; then
  warn "Порт 443 занят не-nginx процессом:"
  echo "$B443"
  warn "Если в /etc/nginx есть конфиг с 'listen 443', nginx не стартанёт и установка пакета сломается."
fi

# диагностика, когда nginx отказывается стартовать
nginx_report() {
  echo "----------------------------------------------------------"
  warn "nginx не поднялся. Кто занимает порты:"
  ss -ltnp 2>/dev/null | grep -E "[:.](80|443|$SITE_PORT)[[:space:]]" || echo "  (ничего не слушает)"
  warn "Проверка конфигов:"
  nginx -t 2>&1 | sed 's/^/  /' || true
  warn "Какие порты просят конфиги:"
  grep -rn "listen" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sed 's/^/  /' || true
  echo "----------------------------------------------------------"
  warn "Чаще всего помогает одно из:"
  warn "  1) отключить чужой сайт:  rm /etc/nginx/sites-enabled/<имя> && systemctl restart nginx"
  warn "  2) остановить того, кто держит порт (apache2, другая панель, docker)"
  warn "  3) перезапустить начисто:  systemctl stop nginx; pkill -x nginx; systemctl start nginx"
}

# чужие конфиги nginx, которые просят порт, занятый не-nginx процессом
# (типичный случай: 3x-ui/xray сидит на 443, а старый конфиг nginx тоже хочет 443)
nginx_conflicts() {
  local f base port who out=""
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"
    [[ "$base" == "$SERVICE" ]] && continue
    for port in $(grep -hoE "^[[:space:]]*listen[[:space:]]+[^;]*" "$f" 2>/dev/null | grep -oE "[0-9]{1,5}" | sort -un); do
      (( port == SITE_PORT )) && continue
      who="$(busy_on "$port")"
      [[ -n "$who" ]] && ! grep -q "nginx" <<<"$who" && out+="$f|$port"$'\n'
    done
  done
  printf '%s' "$out"
}

nginx_fix_conflicts() {
  local list; list="$(nginx_conflicts)"
  [[ -z "$list" ]] && return 0

  echo
  warn "Нашёл конфиги nginx, которые просят уже занятые порты:"
  local f port
  while IFS='|' read -r f port; do
    [[ -z "$f" ]] && continue
    echo "  $f  →  порт $port занят:"
    busy_on "$port" | sed 's/^/      /'
  done <<< "$list"
  echo
  warn "Пока они включены, nginx не запустится вообще — и твой сайт тоже."
  warn "Твоя панель их не трогает, она будет на порту $SITE_PORT."
  read -rp "$(echo -e "${C_B}Отключить эти конфиги?${C_R} (копии сохраню) [Y/n]: ")" ans
  if [[ "${ans,,}" == "n" ]]; then
    die "Тогда освободи порты сам и запусти установщик заново."
  fi

  mkdir -p "$DISABLED_DIR"
  while IFS='|' read -r f port; do
    [[ -z "$f" ]] && continue
    [[ -e "$f" ]] || continue
    cp -a "$(readlink -f "$f")" "$DISABLED_DIR/" 2>/dev/null || true
    if [[ -L "$f" ]]; then rm -f "$f"; else mv "$f" "$f.disabled-by-drebol"; fi
    ok "Отключён: $f (копия в $DISABLED_DIR)"
  done <<< "$list"
}

nginx_apply() {
  if ! nginx -t >>"$APT_LOG" 2>&1; then
    nginx -t 2>&1 | sed 's/^/  /' || true
    die "Конфиг nginx не прошёл проверку."
  fi
  systemctl reload nginx 2>/dev/null && return 0
  systemctl restart nginx 2>/dev/null && return 0
  nginx_report
  die "nginx не запускается — разберись с конфликтом портов и запусти установщик заново."
}

# ---------- пакеты ----------
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
APT_LOG="/tmp/drebol-apt.log"
: > "$APT_LOG"

apt_try() {
  apt-get install -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef "$@" >>"$APT_LOG" 2>&1
}

apt_repair() {
  log "Чиню состояние dpkg..."
  dpkg --configure -a >>"$APT_LOG" 2>&1 || true
  apt-get -f install -y >>"$APT_LOG" 2>&1 || true
  apt-get update -qq >>"$APT_LOG" 2>&1 || true
}

apt_install() {
  log "Ставлю: $*"
  apt_try "$@" && return 0

  warn "apt/dpkg вернул ошибку. Последние строки лога:"
  echo "----------------------------------------------------------"
  tail -n 25 "$APT_LOG"
  echo "----------------------------------------------------------"

  apt_repair
  if apt_try "$@"; then ok "Со второй попытки установилось."; return 0; fi

  warn "Ставлю пакеты по одному, чтобы найти виновника..."
  local pkg failed=()
  for pkg in "$@"; do
    dpkg -s "$pkg" &>/dev/null && continue
    apt_try "$pkg" || failed+=("$pkg")
  done
  if (( ${#failed[@]} )); then
    echo
    warn "Не установились: ${failed[*]}"
    echo "----------------------------------------------------------"
    tail -n 40 "$APT_LOG"
    echo "----------------------------------------------------------"
    die "Почини apt (полный лог: $APT_LOG) и запусти установщик заново."
  fi
  ok "Остальное встало по одному."
}

log "Обновляю списки пакетов..."
apt-get update -qq >>"$APT_LOG" 2>&1 || { warn "apt-get update ругнулся:"; tail -n 15 "$APT_LOG"; apt_repair; }
apt_install git curl ca-certificates python3 python3-venv python3-pip nginx openssl iproute2
if ! systemctl is-active --quiet nginx; then
  warn "nginx установлен, но не запущен — разбираюсь..."
  nginx_fix_conflicts
  systemctl start nginx 2>/dev/null || { nginx_report; die "Сначала освободи порт для nginx, потом запусти установщик заново."; }
  ok "nginx поднялся."
fi
[[ "$USE_SSL" == "yes" ]] && apt_install certbot python3-certbot-nginx
ok "Пакеты установлены."

PYV="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "0.0")"
PYMAJ="${PYV%%.*}"; PYMIN="${PYV##*.}"
if (( PYMAJ < 3 || ( PYMAJ == 3 && PYMIN < 10 ) )); then
  warn "У тебя python $PYV, а библиотеке FunPayAPI нужен 3.10 или новее."
  die "Обнови систему до Ubuntu 22.04+ либо поставь python3.10+ и запусти установщик заново."
fi
ok "Python $PYV подходит."

# Локальный игнор на случай, если .gitignore не залит в репозиторий
# (веб-интерфейс GitHub не загружает файлы, начинающиеся с точки).
# .git/info/exclude работает как .gitignore, но живёт только на сервере.
ensure_git_exclude() {
  local dir="$1" ex="$1/.git/info/exclude" pat
  [[ -d "$dir/.git" ]] || return 0
  mkdir -p "$dir/.git/info"
  for pat in "venv/" "data/" ".env" "__pycache__/" "*.pyc"; do
    grep -qxF "$pat" "$ex" 2>/dev/null || echo "$pat" >> "$ex"
  done
}

# ---------- код ----------
if [[ -d "$OLD_DIR" && ! -d "$APP_DIR" ]]; then
  log "Нашёл старую установку в $OLD_DIR — переношу в $APP_DIR..."
  mv "$OLD_DIR" "$APP_DIR"
  rm -rf "$APP_DIR/venv"
  ok "Перенесено (логин и пароль сохранены)."
fi

if [[ -d "$APP_DIR/.git" ]]; then
  log "Обновляю код в $APP_DIR..."
  git -C "$APP_DIR" fetch --all -q
  git -C "$APP_DIR" reset --hard -q origin/HEAD 2>/dev/null || git -C "$APP_DIR" pull -q
else
  log "Клонирую репозиторий в $APP_DIR..."
  rm -rf "$APP_DIR"
  git clone -q "$REPO_URL" "$APP_DIR"
fi
chmod +x "$APP_DIR/scripts/"*.sh 2>/dev/null || true
ensure_git_exclude "$APP_DIR"
ok "Код на месте."

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
chmod 700 "$APP_DIR"
chown -R root:root "$APP_DIR"

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
User=root
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
# знак "-" — если скрипта нет, старт всё равно продолжится
ExecStartPre=-/bin/bash $APP_DIR/scripts/ensure-venv.sh $APP_DIR
ExecStart=$APP_DIR/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $APP_PORT
Restart=always
RestartSec=3
TimeoutStartSec=600
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"
systemctl is-enabled -q nginx || systemctl enable -q nginx
id -u drebol &>/dev/null && userdel drebol 2>/dev/null || true
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
nginx_fix_conflicts
write_nginx_http
ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
rm -f /etc/nginx/sites-enabled/default
nginx_apply
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
    nginx_apply
    ok "SSL выпущен, автопродление включено (systemd timer certbot)."
  else
    warn "Certbot не смог выпустить сертификат — проверь, что A-запись домена смотрит на этот сервер и порт 80 открыт."
    SCHEME="http"
    SITE_URL="http://$DOMAIN:$SITE_PORT"
    [[ "$SITE_PORT" == "80" ]] && SITE_URL="http://$DOMAIN"
    USE_SSL="no"
    write_nginx_http
    sed -i "s|^SITE_URL=.*|SITE_URL=$SITE_URL|" "$APP_DIR/.env"
    nginx_apply
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
echo -e "  Папка:  ${C_B}$APP_DIR${C_R}"
echo -e "  Автозагрузка: ${C_G}включена${C_R} — сайт поднимется сам после ребута"
echo -e "  и перезапустится через 3 сек, если процесс упадёт."
echo -e "  Управление:"
echo -e "    ${C_Y}systemctl restart|stop|status $SERVICE${C_R}"
echo -e "    ${C_Y}systemctl is-enabled $SERVICE${C_R}   # проверить автозагрузку"
echo
