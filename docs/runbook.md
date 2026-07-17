# Runbook — volta-demo.com

Шпаргалка по эксплуатации. Всё выполняется на сервере: `ssh root@178.104.35.183`.

## nginx

```bash
nginx -t                    # проверить конфиг ПЕРЕД перезагрузкой
systemctl reload nginx      # мягкая перезагрузка (без обрыва соединений)
systemctl restart nginx     # жёсткий перезапуск — только если reload не помог
systemctl status nginx      # жив ли
```

Конфиг сайта: `/etc/nginx/sites-available/volta-demo.conf`.

## Логи

```bash
tail -f /var/log/nginx/access.log    # кто заходит
tail -f /var/log/nginx/error.log     # ошибки nginx
journalctl -u nginx --since today    # системный журнал nginx
```

## Обновление сайта

```bash
bash /var/www/volta-demo.com/deploy/deploy.sh
```

Кеш браузеров сбрасывать не нужно: `index.html` отдаётся с `no-cache`.
Если менялись только аудиофайлы с теми же именами — у посетителей они могут
кешироваться до 30 дней; надёжный способ обновить — дать файлу новое имя
(потребует правки пути в `index.html`).

## Сертификат Let's Encrypt

Продлевается автоматически (`certbot.timer`), вручную ничего делать не нужно.

```bash
systemctl status certbot.timer   # таймер активен?
certbot certificates             # срок действия
certbot renew --dry-run          # репетиция продления
certbot renew                    # форс-продление (если до истечения < 30 дней)
```

## Бэкап

Код и конфиг nginx уже в git — сервер восстанавливается по `docs/deployment.md`
с нуля за ~10 минут. Дополнительно рекомендуются снапшоты в панели Hetzner
(Server → Snapshots) перед крупными изменениями.

Быстрый ручной бэкап конфигурации на локальную машину:

```bash
scp root@178.104.35.183:/etc/nginx/sites-available/volta-demo.conf ./backup/
```
