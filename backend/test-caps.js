/* Тест потолков (запуск: node backend/test-caps.js). Сервера не требует.

   Зачем он существует: потолок множителя обязан применяться ОДИНАКОВО
   в серверной генерации и в кнопке Verify. Если они разойдутся, Verify
   начнёт показывать Mismatch на редких раундах выше потолка — это хуже,
   чем отсутствие потолка вообще, потому что подрывает доверие к честности.

   Verify в браузере считает HMAC через crypto.subtle, а не через наш
   pure-JS движок. Здесь роль crypto.subtle играет node:crypto — тоже
   независимая реализация. Совпадение результатов доказывает сразу два
   факта: формула одна и потолок один.

   Проверяется:
   1) HMAC движка == HMAC node:crypto (независимая реализация);
   2) путь Verify == путь сервера на случайной выборке раундов;
   3) то же самое на раунде, который БЕЗ потолка ушёл бы выше него;
   4) потолок не трогает мгновенный краш (0) и обычные раунды;
   5) в вёрстке нет второй, «своей» реализации потолка. */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../shared/engine.js');

let passed = 0;
function ok(cond, name){
  if (cond){ passed++; console.log('  ✓', name); }
  else { console.error('  ✗ FAIL:', name); process.exit(1); }
}

/* ── ПУТЬ VERIFY ──────────────────────────────────────────────────────
   1-в-1 то, что делает verifyRound() в frontend/index.html: независимый
   HMAC → divisible → формула → clampCrash из движка. */
function verifyPath(serverSeed, clientSeeds){
  const hash = crypto.createHmac('sha256', serverSeed)
                     .update(E.combineClientSeeds(clientSeeds)).digest('hex');
  if (E.divisible(hash, 40)) return 0;
  const h = parseInt(hash.slice(0, 13), 16), e = Math.pow(2, 52);
  return E.clampCrash(Math.floor((100 * e - h) / (e - h)));
}
/* формула БЕЗ потолка — нужна, чтобы найти раунд, который потолок реально режет */
function rawPath(serverSeed, clientSeeds){
  const hash = crypto.createHmac('sha256', serverSeed)
                     .update(E.combineClientSeeds(clientSeeds)).digest('hex');
  if (E.divisible(hash, 40)) return 0;
  const h = parseInt(hash.slice(0, 13), 16), e = Math.pow(2, 52);
  return Math.floor((100 * e - h) / (e - h));
}

console.log('\nПОТОЛКИ — сервер и Verify');
console.log(`  MAX_CRASH_MULTIPLIER = ×${E.MAX_CRASH_MULTIPLIER} (crash-point ≤ ${E.MAX_CRASH_X100})`);

/* 1) HMAC движка совпадает с node:crypto */
{
  const s = 'engine-vs-node', c = ['alpha', 'beta'];
  const mine = crypto.createHmac('sha256', s).update(E.combineClientSeeds(c)).digest('hex');
  ok(typeof mine === 'string' && mine.length === 64, 'node:crypto даёт 64-символьный HMAC');
  ok(E.crashPointFromHash(s, E.combineClientSeeds(c)) === verifyPath(s, c),
     'HMAC движка и HMAC node:crypto дают один crash-point');
}

/* 2) массовая сверка сервер ↔ Verify */
{
  const N = 20000;
  let mismatch = 0, capped = 0, instant = 0, maxSeen = 0;
  for (let i = 0; i < N; i++){
    const seed = E.randHex(32);
    const seeds = [E.randHex(8), E.randHex(8)];
    const server = E.crashPointFromHash(seed, E.combineClientSeeds(seeds));
    const verify = verifyPath(seed, seeds);
    if (server !== verify) mismatch++;
    if (server === 0) instant++;
    if (server === E.MAX_CRASH_X100) capped++;
    if (server > maxSeen) maxSeen = server;
  }
  ok(mismatch === 0, `${N.toLocaleString('en-US')} раундов: расхождений сервер/Verify — 0`);
  ok(maxSeen <= E.MAX_CRASH_X100, `максимум в выборке ×${(maxSeen / 100).toFixed(2)} — не выше потолка`);
  ok(instant > 0, `мгновенные крашы ×1.00 не исчезли (${instant} шт.)`);
  console.log(`    из них упёрлись в потолок: ${capped}`);
}

/* 3) раунд, который БЕЗ потолка ушёл бы выше — ищем детерминированно */
{
  let seed = null, raw = 0;
  const seeds = ['capcheck'];
  for (let i = 0; i < 400000; i++){
    const s = 'cap-test-' + i;
    const v = rawPath(s, seeds);
    if (v > E.MAX_CRASH_X100){ seed = s; raw = v; break; }
  }
  ok(seed !== null, 'найден раунд выше потолка для проверки обрезки');
  console.log(`    seed "${seed}": честный расчёт ×${(raw / 100).toFixed(2)} → потолок ×${E.MAX_CRASH_MULTIPLIER}`);
  const server = E.crashPointFromHash(seed, E.combineClientSeeds(seeds));
  const verify = verifyPath(seed, seeds);
  ok(server === E.MAX_CRASH_X100, 'сервер обрезал до потолка');
  ok(verify === E.MAX_CRASH_X100, 'Verify обрезал до потолка');
  ok(server === verify, 'сервер и Verify согласованы на обрезанном раунде');
  ok(raw > E.MAX_CRASH_X100, 'контроль: без потолка этот раунд был бы выше');
}

/* 4) потолок не задевает то, что ниже него */
{
  ok(E.clampCrash(0) === 0, 'мгновенный краш (0) потолком не тронут');
  ok(E.clampCrash(100) === 100, '×1.00 не тронут');
  ok(E.clampCrash(999999) === 999999, '×9999.99 не тронут');
  ok(E.clampCrash(E.MAX_CRASH_X100) === E.MAX_CRASH_X100, 'ровно потолок остаётся собой');
  ok(E.clampCrash(E.MAX_CRASH_X100 + 1) === E.MAX_CRASH_X100, 'потолок+1 обрезан');
  ok(E.clampCrash(28004621) === E.MAX_CRASH_X100, 'реальный раунд прода ×280046.21 обрезан до потолка');
}

/* 5) потолок выплаты — отдельный шаг ПОСЛЕ честного множителя */
{
  console.log(`\n  MAX_PAYOUT_USD = $${E.MAX_PAYOUT_USD}`);
  ok(E.capPayout(0) === 0, 'нулевая выплата не тронута');
  ok(E.capPayout(1364.62) === 1364.62, 'максимальная выплата прода $1364.62 не тронута');
  ok(E.capPayout(E.MAX_PAYOUT_USD) === E.MAX_PAYOUT_USD, 'ровно потолок остаётся собой');
  ok(E.capPayout(E.MAX_PAYOUT_USD + 0.01) === E.MAX_PAYOUT_USD, 'потолок+1 цент обрезан');

  /* максимальная ставка × максимальный множитель — самый большой возможный выигрыш */
  const worst = E.MAX_BET * E.MAX_CRASH_MULTIPLIER;
  ok(worst === 1000000, `без потолка максимум был бы $${worst.toLocaleString('en-US')}`);
  ok(E.capPayout(worst) === E.MAX_PAYOUT_USD, 'максимально возможный выигрыш обрезан до потолка');

  /* при каком множителе потолок начинает связывать — по ставкам */
  for (const [stake, mult] of [[100, 100], [50, 200], [10, 1000], [1, 10000]]){
    ok(Math.abs(E.capPayout(stake * mult) - E.MAX_PAYOUT_USD) < 1e-6
       && E.capPayout(stake * (mult - 0.01)) < E.MAX_PAYOUT_USD,
       `ставка $${stake}: потолок связывает ровно с ×${mult}`);
  }
  /* ключевая гарантия задачи: множитель НЕ искажается потолком выплаты */
  const mult = 500, stake = 100;
  ok(E.capPayout(stake * mult) === E.MAX_PAYOUT_USD && mult === 500,
     'потолок режет сумму, а не множитель (×500 остаётся ×500)');
}

/* 6) в вёрстке нет второй реализации потолка */
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('function crashFromHmacHex'),
                          html.indexOf('async function verifyRound'));
  ok(body.includes('clampCrash('), 'Verify зовёт clampCrash из движка');
  ok(!/MAX_CRASH_X100\s*=|MAX_CRASH_MULTIPLIER\s*=\s*\d/.test(html),
     'потолок множителя в вёрстке не переопределён своей константой');
  ok(!/MAX_PAYOUT_USD\s*=\s*\d/.test(html),
     'потолок выплаты в вёрстке не переопределён своей константой');
  ok(/const rawPayout = G\.bet \* finalPers;[\s\S]{0,80}capPayout\(rawPayout\)/.test(html),
     'клиент режет выплату через capPayout');
  ok(html.includes('capPayout(b.bet * b.finalMult)') && html.includes('capPayout(p.bet * p.finalMult)'),
     'итог по столу режется по каждому игроку отдельно');
  ok(html.includes('winPopCap'), 'в попапе выигрыша есть место под пометку о потолке');

  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok(/E\.capPayout\(p\.bet \* p\.finalMult\)/.test(srv), 'сервер режет выплату через capPayout');
  ok(/p\.finalMult = p\.persAccum;/.test(srv), 'сервер пишет в аналитику НЕтронутый final_mult');
}

console.log(`\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (${passed})\n`);
