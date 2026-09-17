# drebol-funp

Веб-панель для работы с FunPay. Ставится на чистый Ubuntu одной командой:
скрипт сам спросит домен и порт, поставит nginx, выпустит SSL-сертификат,
создаст systemd-сервис и сгенерирует пароль администратора.

## Установка

```bash
sudo bash <(curl -sSL https://raw.githubusercontent.com/pratokwau/drebol-funp/main/install.sh)
```

Скрипт спросит:

| Вопрос | Пример | Что делает |
|---|---|---|
| Домен сайта | `funp.example.com` | на него выпускается SSL и настраивается nginx |
| Внутренний порт | `8080` | порт приложения на 127.0.0.1, наружу торчит только nginx (80/443) |
| SSL Let's Encrypt | `Y` | certbot + автоматический редирект на HTTPS и автопродление |

> Перед запуском поверни A-запись домена на IP сервера — без этого Let's Encrypt
> не выдаст сертификат и сайт останется на HTTP.

## Вход

После установки скрипт напечатает данные:

```
  Адрес:  https://твой-домен
  Логин:  admin
  Пароль: <сгенерированный>
```

Тот же пароль печатается в консоль при каждом старте сайта:

```bash
journalctl -u drebol-funp -n 50 --no-pager
```

## Что ставится

- `/opt/drebol-funp` — код и виртуальное окружение
- `/opt/drebol-funp/.env` — логин, пароль, секретный ключ (права 600)
- `drebol-funp.service` — systemd-сервис, автозапуск и рестарт при падении
- nginx-конфиг `/etc/nginx/sites-available/drebol-funp` — реверс-прокси на порт приложения
- certbot с автопродлением сертификата

## Управление

```bash
systemctl status drebol-funp     # состояние
systemctl restart drebol-funp    # перезапуск
journalctl -u drebol-funp -f     # живой лог
```

Сменить пароль: отредактировать `ADMIN_PASSWORD` в `/opt/drebol-funp/.env`
и перезапустить сервис.

Повторный запуск установщика обновляет код из git и сохраняет существующий `.env`
(логин и пароль не меняются).

## Стек

Python 3 + FastAPI + uvicorn, nginx, certbot, systemd. Фронтенд — статика без сборки.

## Структура

```
install.sh          установщик для Ubuntu
app/main.py         бэкенд: авторизация, сессии, API
web/index.html      страница входа
web/dashboard.html  панель
web/static/         css и js
```
