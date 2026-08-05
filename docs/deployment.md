# Деплой volta-demo.com

Прод: Hetzner Cloud, Ubuntu 24.04 LTS, `root@178.104.35.183` (IPv6
`2a01:4f8:1c19:e191::1`). Статику отдаёт host-nginx, TLS — Let's Encrypt,
бэкенд — Node-сервис под systemd (`volta-backend`), наружу не выставлен:
nginx проксирует `/ws` (WebSocket) и `/api` на `127.0.0.1:8090`.

## 0. Обновление уже развёрнутого прода — одна команда

```bash
ssh root@178.104.35.183 "bash /var/www/volta-demo.com/deploy/deploy.sh"
```

Всё, что ниже, — первичная настройка с нуля.

## 1. DNS (Cloudflare, режим DNS only — серое облачко)

| Тип  | Имя | Значение                | Proxy |
|------|-----|-------------------------|-------|
| A    | @   | 178.104.35.183          | DNS only |
| AAAA | @   | 2a01:4f8:1c19:e191::1   | DNS only |
| A    | www | 178.104.35.183          | DNS only |
| AAAA | www | 2a01:4f8:1c19:e191::1   | DNS only |

Проверка перед выпуском сертификата: `dig +short volta-demo.com A` должен
вернуть IP сервера. Пока не вернул — certbot не запускать.

## 2. Пакеты

```bash
apt update && apt upgrade -y
apt install -y nginx git certbot python3-certbot-nginx
```

### Node.js (нужен ≥ 22.5; ставим 24 LTS через NodeSource)

В репозиториях Ubuntu 24.04 только Node 18 — он не подходит (бэкенд
использует встроенный `node:sqlite`). Ставим NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node --version   # v24.x
```

## 3. Код сайта

Репозиторий приватный — на сервере используется deploy key (SSH-ключ только
на чтение; добавляется в GitHub → репозиторий → Settings → Deploy keys):

```bash
ssh-keygen -t ed25519 -f /root/.ssh/volta_deploy -N "" -C "deploy@volta-demo.com"
cat /root/.ssh/volta_deploy.pub    # → в Deploy keys на GitHub
printf 'Host github.com-volta\n    HostName github.com\n    IdentityFile /root/.ssh/volta_deploy\n    IdentitiesOnly yes\n' >> /root/.ssh/config

git clone git@github.com-volta:Daniel1209-art/Volta-Demo-2.git /var/www/volta-demo.com
```

## 4. Первый запуск

```bash
bash /var/www/volta-demo.com/deploy/deploy.sh
```

Скрипт установит зависимости, положит systemd-юнит и nginx-конфиг из
репозитория, поднимет сервис и перезагрузит nginx. Если сертификата ещё
нет — сначала временно поставить HTTP-конфиг без ssl-блоков и выпустить
сертификат (шаг 5), потом повторить `deploy.sh`.

## 5. HTTPS

```bash
certbot --nginx -d volta-demo.com -d www.volta-demo.com \
  --redirect -m kkornienko1601@gmail.com --agree-tos --no-eff-email
systemctl status certbot.timer      # автопродление активно
certbot renew --dry-run
```

`deploy/nginx/volta-demo.conf` в репозитории уже содержит certbot-блоки —
после выпуска сертификата конфиг из репозитория полностью совпадает с боевым.

## 6. Архитектура прода

```
браузер ── https ──> nginx ──> frontend/ (статика: index.html, звуки, музыка)
        └─ wss /ws ─>  │  ──> 127.0.0.1:8090  volta-backend (systemd, www-data)
                       │        └─> /var/www/volta-demo.com/data/volta.db (SQLite)
                       └──> /shared/engine.js (общий движок, alias)
```

- Бэкенд слушает только localhost; наружу — только через nginx (wss).
- `data/` не в git; это единственное место с состоянием (ники, раунды,
  ставки за день). Суточный сброс истории — `RESET_TZ` (по умолчанию UTC).
- Конфиг бэкенда: `backend/.env` (см. `.env.example`), секретов нет.

## 7. Нагрузочная ёмкость (перед всплеском трафика)

Каждый игрок держит одно живое WS-соединение. Два потолка нужно поднять до
публичного анонса — их видно только под нагрузкой, не в обычной эксплуатации.

**nginx — число соединений на воркер.** Дефолт Ubuntu — `worker_connections
768`; каждый проксируемый WS занимает 2 (клиент + upstream к Node), то есть
потолок ≈ 768 одновременных игроков на воркер. Правится в `/etc/nginx/nginx.conf`
(файл НЕ в репозитории — деплой его не трогает):

```nginx
# events { } в /etc/nginx/nginx.conf
worker_connections 4096;
multi_accept on;

# в корне nginx.conf (вне events/http), рядом с worker_processes:
worker_rlimit_nofile 8192;   # воркеру нужно больше FD, чем worker_connections
```

После правки: `nginx -t && systemctl reload nginx`.

**systemd — файловые дескрипторы бэкенда.** `LimitNOFILE=16384` задан в
`deploy/volta-backend.service` (деплоится через `deploy.sh`), поднимает дефолт
1024. Проверить на живом сервисе:
`cat /proc/$(pgrep -f backend/server.js)/limits | grep "open files"`.

**Флуд-лимиты приложения** (`backend/server.js`, env-переопределяемы):
`WS_MAX_CONN_PER_IP=50`, `WS_MSG_PER_SEC=25`, `WS_MAX_FRAME_BYTES=16384`.
За Cloudflare это лимиты на IP РЕАЛЬНОГО клиента — при условии, что real_ip
включён (см. ниже), иначе все игроки схлопнутся в один IP эджа.

## 8. Включение Cloudflare-проксирования (оранжевое облако)

Сейчас DNS-only (см. §1). Проксирование даёт кеш статики и поглощение
всплесков/L3-4, но меняет путь трафика. Порядок, чтобы не сломать HTTPS и
per-IP логику:

1. **real_ip уже подготовлен** — `deploy/nginx/cloudflare-real-ip.conf`
   подключён в оба server-блока и инертен при DNS-only. Перед включением
   свериться со свежим списком `https://www.cloudflare.com/ips` (CF меняет
   диапазоны редко) и `nginx -t`.
2. **SSL/TLS режим в панели Cloudflare → Full (strict)**, НЕ Flexible. На
   origin валидный Let's Encrypt; Flexible ходил бы к origin по HTTP и дал бы
   редирект-петлю (origin редиректит 80→443). Full (strict) проверяет
   сертификат origin — он настоящий, всё сойдётся.
3. **WebSocket** на CF включён по умолчанию; `/ws` не кешируется (это Upgrade).
   Убедиться, что нет правила кеширования, ломающего Upgrade.
4. Переключить записи A/AAAA (@ и www) в **Proxied** (оранжевое облако).
5. Проверить ПОСЛЕ включения: игра открывается по wss; в дашборде у игроков
   осмысленные страны и разные хеши IP (а не один эдж CF) — это подтверждает,
   что real_ip работает и лимитер входа снова считает по игроку.

> Если пропустить шаг 1, за прокси `X-Forwarded-For`/remote_addr станут IP
> эджа Cloudflare: лимитер входа сложит всех в одну корзину, а гео сломается.
> Поэтому real_ip и заведён заранее.
