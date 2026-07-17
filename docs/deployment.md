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
