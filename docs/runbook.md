# Runbook — volta-demo.com

Шпаргалка по эксплуатации. Всё выполняется на сервере: `ssh root@178.104.35.183`.

## Деплой обновлений

```bash
bash /var/www/volta-demo.com/deploy/deploy.sh
```

Кеш браузеров сбрасывать не нужно (`index.html` — no-cache). Аудио кешируется
30 дней: заменяя звук, дай файлу новое имя (и поправь путь в `index.html`).

## Бэкенд (volta-backend)

```bash
systemctl status volta-backend        # жив ли
systemctl restart volta-backend       # перезапуск (игроки переподключатся сами)
journalctl -u volta-backend -n 100    # логи сервиса
journalctl -u volta-backend -f        # логи в реальном времени
curl -s localhost:8090/api/health     # health: фаза, номер раунда, онлайн
```

После рестарта текущий раунд обрывается и начинается новый — история ставок
и ники при этом сохраняются (SQLite в `/var/www/volta-demo.com/data/`).

## nginx

```bash
nginx -t                    # проверить конфиг ПЕРЕД перезагрузкой
systemctl reload nginx      # мягкая перезагрузка (без обрыва соединений)
systemctl status nginx
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

Боевой конфиг = `deploy/nginx/volta-demo.conf` из репозитория (deploy.sh
синхронизирует). Править на сервере руками — нельзя, правки затрутся.

## Сертификат Let's Encrypt

Продлевается автоматически (`certbot.timer`).

```bash
systemctl status certbot.timer
certbot certificates
certbot renew --dry-run
```

## База данных (SQLite)

```bash
ls -lh /var/www/volta-demo.com/data/           # volta.db (+ wal/shm)
sqlite3 /var/www/volta-demo.com/data/volta.db 'SELECT COUNT(*) FROM players;'
```

История ставок игроков живёт один календарный день (UTC) и чистится фоном;
раунды хранятся последние ~600.

## Бэкап

- Код и конфиги — в git; сервер восстанавливается по `docs/deployment.md`.
- Состояние (ники/история дня) — один файл:
  `scp root@178.104.35.183:/var/www/volta-demo.com/data/volta.db ./backup/`
- Перед крупными изменениями — снапшот в панели Hetzner (Server → Snapshots).

## Быстрая диагностика «игра не идёт»

1. `curl -s localhost:8090/api/health` — если пусто, смотри
   `journalctl -u volta-backend -n 50`.
2. `nginx -t && systemctl status nginx`.
3. В браузере F12 → Network → WS: соединение `wss://volta-demo.com/ws`
   должно быть зелёным и получать сообщения `starting/started/crash`.
