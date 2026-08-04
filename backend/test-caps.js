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

/* 5) в вёрстке нет второй реализации потолка */
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('function crashFromHmacHex'),
                          html.indexOf('async function verifyRound'));
  ok(body.includes('clampCrash('), 'Verify зовёт clampCrash из движка');
  ok(!/MAX_CRASH_X100\s*=|MAX_CRASH_MULTIPLIER\s*=\s*\d/.test(html),
     'потолок в вёрстке не переопределён своей константой');
}

console.log(`\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (${passed})\n`);
