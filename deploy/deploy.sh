#!/usr/bin/env bash
# Обновление volta-demo.com. Запускать НА СЕРВЕРЕ от root:
#   bash /var/www/volta-demo.com/deploy/deploy.sh
#
# Что делает: подтягивает свежий код из git, возвращает права www-data,
# проверяет конфиг nginx и мягко перезагружает его (без обрыва соединений).
# Сбрасывать кеш браузеров не нужно: index.html отдаётся с Cache-Control no-cache.

set -euo pipefail

SITE_DIR=/var/www/volta-demo.com

cd "$SITE_DIR"
git pull --ff-only
chown -R www-data:www-data "$SITE_DIR"

nginx -t
systemctl reload nginx

echo "OK: https://volta-demo.com обновлён ($(git rev-parse --short HEAD))"
