# VOLTA Demo — Lamp Game

Crash-игра «лампа»: зажги лампу, дай множителю расти, выключи **до** того, как
колба перегорит. Статический прототип: чистый HTML5 + CSS + vanilla JS в одном
файле, без фреймворков, сборщиков и бэкенда. Честность раундов — provably-fair
на Web Crypto API (`crypto.subtle`, HMAC-SHA256).

> ⚠️ Это **демо-симуляция**: баланс, сиды и выплаты считаются в браузере.
> Для игры на реальные деньги обязателен серверный движок и лицензия.

**Прод:** <https://volta-demo.com>

## Стек

| Слой | Технология |
|------|-----------|
| Игра | один файл `frontend/index.html` (разметка + стили + движок) |
| Звук | Web Audio API: эффекты `frontend/sounds/*.wav`, музыка `frontend/Music/*.mp3` |
| Честность | Web Crypto API (`crypto.subtle`) — работает только в secure context (HTTPS или localhost) |
| Хостинг | Hetzner Cloud, Ubuntu 24.04, nginx, Let's Encrypt |

## Быстрый старт (локально)

```bash
# любой статик-сервер из папки frontend/
npx serve frontend        # → http://localhost:3000
# или
python -m http.server 8000 --directory frontend
```

Открывать через `http://localhost:...` — localhost считается secure context,
поэтому `crypto.subtle` доступен. Запуск двойным кликом (`file://`) **не
работает**: Web Crypto в этом режиме недоступен.

## Структура репозитория

```
volta-demo/
├── frontend/              # корень статики — деплоится на сервер как есть
│   ├── index.html         # игра целиком (точка входа)
│   ├── Music/             # фоновые треки .mp3 (пути захардкожены в index.html)
│   └── sounds/            # звуковые эффекты .wav (аналогично)
├── deploy/
│   ├── nginx/volta-demo.conf   # server-block: статика, gzip, кеш, security-заголовки
│   └── deploy.sh               # обновление сайта на сервере (git pull + права + reload)
├── docs/
│   ├── deployment.md      # как развёрнут прод: DNS, nginx, certbot
│   └── runbook.md         # эксплуатация: перезапуск, логи, сертификат, бэкап
├── LICENSE                # проприетарная — использование без разрешения запрещено
└── README.md
```

> Папки `Music/` и `sounds/` намеренно лежат рядом с `index.html` и не
> переименованы: пути к ним зашиты в коде игры (`fetch('sounds/…')`,
> `'Music/' + track + '.mp3'`).

## Деплой

Кратко (подробности — в [docs/deployment.md](docs/deployment.md)):

1. Код живёт в `/var/www/volta-demo.com` на сервере (git clone этого репозитория).
2. nginx отдаёт `/var/www/volta-demo.com/frontend` как статику — конфиг
   в [deploy/nginx/volta-demo.conf](deploy/nginx/volta-demo.conf).
3. HTTPS — Let's Encrypt (certbot), автопродление через `certbot.timer`.
4. Обновление: `bash deploy/deploy.sh` на сервере (git pull + reload).

## Происхождение

Код перенесён 1-в-1 из монолитного прототипа `VOLTA4-3D.html`: геймплей,
тайминги, звук и вероятности не менялись — файл только переименован в
`index.html`, ассеты скопированы без изменений.
