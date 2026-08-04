# Бэкап: конфигурация лампы на 4 переключения

**Что это.** Снимок игровой конфигурации переключений лампы, действовавшей
**до отката до 2 переключений (2026-08-04)**. Файл существует ровно для того,
чтобы вернуть 4 переключения за пару минут, не разбирая `git log`.

Лежит в `docs/`, а не в отдельной `config/`: в этом проекте вся письменная
конфигурация и описания схем живут в `docs/` (`analytics.md`, `deployment.md`,
`runbook.md`), отдельная папка ради одного файла ломала бы это соглашение.

Последний коммит с 4 переключениями: **`3ff2975`**.

---

## Как откатиться (4 шага, ~2 минуты)

### 1. Константа — источник правды

`shared/engine.js`:

```js
const MAX_SWITCHES   = 2;   // ← вернуть 4
```

Одна эта строка возвращает игровую механику: и сервер
(`backend/server.js`: `switchesLeft`, гейт `p.switchesLeft <= 0`, колонка
`switches_used`), и клиент (`frontend/index.html`: гейт `lampOn`, disable
кнопки ON, счётчик остатка), и знаменатель метрики `avgSwitchUsage` в
дашборде (`backend/dashboard.js` получает значение через
`createDashboard({ maxSwitches })`) читают её же. Хардкода `4` или `2` в
игровой логике нет — если появится, это баг.

### 2. Индикатор остатка

`frontend/index.html`, блок `#swRow` — число точек должно совпадать с
`MAX_SWITCHES` (их красит `updSwitches()`):

```html
<div class="sw-row" id="swRow">
  <div class="sw u"></div><div class="sw u"></div><div class="sw u"></div><div class="sw u"></div>
</div>
```

### 3. Панель автопилота — вернуть ступени 3 и 4

`frontend/index.html`, внутри `.auto-grid`, после ступени 2:

```html
<div class="astage" id="autoStage3">
  <label class="as-num-tog"><input type="checkbox" class="stage-en" id="autoStageEn3" checked onchange="renderAutoStatus()"><span class="as-num">3</span></label>
  <div class="as-field"><label class="as-lbl off">off &times;</label><input class="as-input off-in" id="autoOff3" type="text" inputmode="decimal" value="4.00" step="any" min="1.01" onchange="renderAutoStatus()"></div>
  <div class="as-field"><label class="as-lbl on">on &times;</label><input class="as-input on-in" id="autoOn3" type="text" inputmode="decimal" value="5.00" step="any" min="1.01" onchange="renderAutoStatus()"></div>
</div>
<div class="astage" id="autoStage4">
  <label class="as-num-tog"><input type="checkbox" class="stage-en" id="autoStageEn4" checked onchange="renderAutoStatus()"><span class="as-num">4</span></label>
  <div class="as-field"><label class="as-lbl off">off &times;</label><input class="as-input off-in" id="autoOff4" type="text" inputmode="decimal" value="7.00" step="any" min="1.01" onchange="renderAutoStatus()"></div>
  <div class="as-field"><label class="as-lbl on">on &times;</label><input class="as-input on-in" id="autoOn4" type="text" inputmode="decimal" value="8.00" step="any" min="1.01" onchange="renderAutoStatus()"></div>
</div>
```

И вернуть номер строки Final OFF: `<span class="as-num">3</span>` → `5`
(в блоке `.auto-final`, `#autoFinalRow`).

Цикл сборки плана уже завязан на константу и правку не потребует:

```js
for (let n = 1; n <= MAX_SWITCHES; n++){   // было жёстко n <= 4
```

Диагностический дамп внизу файла перечисляет ступени явно — там тоже
`[1, 2]` вернуть в `[1, 2, 3, 4]`.

### 4. Правила игры

`frontend/index.html`, модалка «How to play — VOLTA», раздел **Re-toggling**:
число переключений указано текстом, поменять на 4.

Плюс cache-busting: поднять версию в `<script src="shared/engine.js?v=N">`.

---

## Полная конфигурация на момент снимка

| Параметр | Значение |
|---|---|
| `MAX_SWITCHES` | **4** (повторные включения; бесплатный стартовый ON лимит не тратит) |
| Максимум ON-периодов за раунд | 5 (стартовый + 4 повторных) |
| Ступеней автопилота | 4 пары OFF/ON + отдельный Final OFF |
| Максимум OFF-порогов в плане | 5 |
| Точек в индикаторе `#swRow` | 4 |

Дефолтные значения полей автопилота:

| Ступень | off × | on × |
|---|---|---|
| 1 | 1.50 | 1.70 |
| 2 | 2.50 | 3.00 |
| 3 | 4.00 | 5.00 |
| 4 | 7.00 | 8.00 |
| Final OFF | 12.00 | — |

При откате до 2 переключений ступени 1 и 2 и Final OFF сохранены с этими же
значениями — менялся только состав ступеней, не дефолты.

---

## Что откат НЕ меняет

- **RTP и математику.** Лимит переключений — это про доступную игроку
  стратегию, а не про распределение crash-point. Ожидаемая отдача при
  выходе на ×m равна `m · P(crash ≥ m)` независимо от числа переключений.
- **Provably fair.** Схема commit-reveal и формула HMAC от числа
  переключений не зависят.
- **Схему БД.** Колонка `bets.switches_used` хранит фактически
  израсходованное число, а не лимит. Строки, записанные при лимите 4,
  остаются валидными; несопоставимой становится только метрика
  `avgSwitchUsage` (доля от лимита) между периодами с разным лимитом —
  см. отметку о сбросе данных в `docs/analytics.md`.
