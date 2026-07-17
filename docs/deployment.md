# Деплой volta-demo.com

Прод: Hetzner Cloud, Ubuntu 24.04 LTS, `root@178.104.35.183` (IPv6
`2a01:4f8:1c19:e191::1`). Статика отдаётся host-nginx, TLS — Let's Encrypt.

## 1. DNS (Cloudflare, режим DNS only — серое облачко)

| Тип  | Имя | Значение                | Proxy |
|------|-----|-------------------------|-------|
| A    | @   | 178.104.35.183          | DNS only |
| AAAA | @   | 2a01:4f8:1c19:e191::1   | DNS only |
| A    | www | 178.104.35.183          | DNS only |
| AAAA | www | 2a01:4f8:1c19:e191::1   | DNS only |

Проверка перед выпуском сертификата:

```bash
dig +short volta-demo.com A
dig +short volta-demo.com AAAA
dig +short www.volta-demo.com A
```

Все ответы должны указывать на IP сервера. Пока не указывают — certbot не запускать.

## 2. Пакеты на сервере

```bash
apt update && apt upgrade -y
apt install -y nginx git certbot python3-certbot-nginx
```

## 3. Код сайта

Репозиторий приватный, поэтому на сервере используется deploy key (SSH-ключ
только на чтение, добавляется в GitHub → Settings → Deploy keys репозитория):

```bash
ssh-keygen -t ed25519 -f /root/.ssh/volta_deploy -N "" -C "deploy@volta-demo.com"
cat /root/.ssh/volta_deploy.pub   # этот ключ добавить в Deploy keys на GitHub
```

`/root/.ssh/config`:

```
Host github.com-volta
    HostName github.com
    IdentityFile /root/.ssh/volta_deploy
```

Клонирование и права:

```bash
git clone git@github.com-volta:Daniel1209-art/Volta-Demo-2.git /var/www/volta-demo.com
chown -R www-data:www-data /var/www/volta-demo.com
```

## 4. nginx

```bash
cp /var/www/volta-demo.com/deploy/nginx/volta-demo.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/volta-demo.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Проверка: `http://volta-demo.com` должен отдавать игру (Web Crypto по http ещё
не работает — это нормально, чинится следующим шагом).

## 5. HTTPS

```bash
certbot --nginx -d volta-demo.com -d www.volta-demo.com \
  --redirect -m kkornienko1601@gmail.com --agree-tos --no-eff-email
```

Автопродление ставится из коробки, проверка:

```bash
systemctl status certbot.timer
certbot renew --dry-run
```

## 6. Обновление кода

```bash
bash /var/www/volta-demo.com/deploy/deploy.sh
```
