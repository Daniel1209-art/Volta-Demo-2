#!/usr/bin/env bash
# Обновление volta-demo.com ОДНОЙ КОМАНДОЙ. Запускать НА СЕРВЕРЕ от root:
#   bash /var/www/volta-demo.com/deploy/deploy.sh
#
# Шаги: git pull → npm ci в backend/ → обновление systemd-юнита и
# nginx-конфига из репозитория → рестарт бэкенда → nginx -t → reload.
# Кеш браузеров сбрасывать не нужно: index.html отдаётся с no-cache.

set -euo pipefail

SITE_DIR=/var/www/volta-demo.com
SERVICE=volta-backend

command -v node >/dev/null || {
  echo "ОШИБКА: node не найден. Установи Node 24 LTS (см. docs/deployment.md, раздел «Node.js»)"; exit 1; }

cd "$SITE_DIR"
git pull --ff-only

# зависимости бэкенда (только прод, без dev)
cd "$SITE_DIR/backend"
npm ci --omit=dev --no-audit --no-fund

# папка данных SQLite (переживает деплой; в git не попадает)
mkdir -p "$SITE_DIR/data"

# systemd-юнит: обновляем из репозитория, если изменился
if ! cmp -s "$SITE_DIR/deploy/volta-backend.service" /etc/systemd/system/$SERVICE.service; then
  cp "$SITE_DIR/deploy/volta-backend.service" /etc/systemd/system/$SERVICE.service
  systemctl daemon-reload
fi

# nginx-конфиг: обновляем из репозитория, если изменился
if ! cmp -s "$SITE_DIR/deploy/nginx/volta-demo.conf" /etc/nginx/sites-available/volta-demo.conf; then
  cp "$SITE_DIR/deploy/nginx/volta-demo.conf" /etc/nginx/sites-available/volta-demo.conf
fi
ln -sf /etc/nginx/sites-available/volta-demo.conf /etc/nginx/sites-enabled/volta-demo.conf

# права: статикой и данными владеет www-data (бэкенд работает от него)
chown -R www-data:www-data "$SITE_DIR"

systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

nginx -t
systemctl reload nginx

sleep 1
systemctl is-active --quiet "$SERVICE" || { echo "ОШИБКА: $SERVICE не поднялся — journalctl -u $SERVICE -n 50"; exit 1; }
# бэкенд читает гео-базу ДО listen (≈4 с на базе DB-IP), поэтому health-check
# ждёт готовности, а не бьёт один раз: иначе живой деплой выглядит как упавший
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:8090/api/health >/dev/null && break
  [ "$i" -eq 30 ] && { echo "ОШИБКА: health-check бэкенда не отвечает"; exit 1; }
  sleep 1
done

echo "OK: https://volta-demo.com обновлён ($(git -C "$SITE_DIR" rev-parse --short HEAD)), бэкенд жив"
