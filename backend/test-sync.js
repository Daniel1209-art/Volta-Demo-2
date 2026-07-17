/* Интеграционный тест приёмки (запуск: node backend/test-sync.js).
   Проверяет на живом сервере:
   1) два клиента, подключившиеся В РАЗНОЕ ВРЕМЯ, видят один и тот же
      раунд: одинаковые roundId/hash/startTime → одинаковый множитель;
   2) crash-point НЕ доступен клиенту до краша (в сообщениях его нет);
   3) provably fair: sha256(seed) == хэш, объявленный до раунда, и
      crashPointFromHash(seed) == объявленный crash-point;
   4) ники в формате Volta-gamer##### (и у ботов тоже);
   5) ставка попадает в «My Game History» и переживает РЕСТАРТ сервера;
   6) ник стабилен между заходами (тот же clientId → тот же ник).
   Длительность: 1-2 полных раунда (обычно < 90 с). */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const WebSocket = require('ws');
const E = require('../shared/engine.js');

const PORT = 8991;
const DB = path.join(os.tmpdir(), 'volta-test-' + Date.now() + '.db');
let srv = null;
let passed = 0;

function ok(cond, name){
  if (cond){ passed++; console.log('  ✓', name); }
  else { console.error('  ✗ FAIL:', name); cleanup(1); }
}
function cleanup(code){
  if (srv) try { srv.kill(); } catch (e) {}
  try { fs.rmSync(DB); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch (e) {}
  process.exit(code);
}
function startServer(){
  srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: DB, RESET_TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  srv.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  return new Promise(res => setTimeout(res, 800));
}
function connect(clientId){
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, clientId, msgs: [], waiters: [] };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    c.waiters = c.waiters.filter(w => !(w.t === m.t && w.res(m)));
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', clientId })));
  c.next = (t, pred = () => true, timeout = 180000) => new Promise((res, rej) => {
    const seen = c.msgs.find(m => m.t === t && !m._used && pred(m));
    if (seen){ seen._used = true; return res(seen); }
    const w = { t, res: m => { if (!pred(m)) return false; m._used = true; res(m); return true; } };
    c.waiters.push(w);
    setTimeout(() => rej(new Error('timeout waiting ' + t)), timeout);
  });
  c.send = o => ws.send(JSON.stringify(o));
  return c;
}
const NICK_RE = /^Volta-gamer\d{5}$/;

(async () => {
  console.log('— старт сервера —');
  await startServer();

  const idA = 'a'.repeat(32), idB = 'b'.repeat(32);
  console.log('— клиент A подключается —');
  const A = connect(idA);
  const helloA = await A.next('hello');
  ok(NICK_RE.test(helloA.nick), `ник A в формате Volta-gamer#####: ${helloA.nick}`);
  ok(Array.isArray(helloA.history), 'hello содержит историю раундов');
  ok(helloA.crashPoint === null || helloA.phase === 'ENDED',
     'crash-point не раскрывается вне паузы');

  console.log('— ждём открытия раунда (starting) —');
  const st = await A.next('starting');
  ok(/^[0-9a-f]{64}$/.test(st.hash), 'хэш раунда опубликован ДО старта');
  ok(!('crashPoint' in st) && !('serverSeed' in st), 'в starting нет crash-point/seed');
  ok(st.bots.every(b => NICK_RE.test(b.nick)), 'боты-заполнители в том же формате ников');

  A.send({ t: 'bet', amount: 10 });
  const betEcho = await A.next('bet');
  ok(betEcho.nick === helloA.nick && betEcho.amount === 10, 'ставка A разошлась по столу');

  console.log('— ждём старт раунда —');
  const started = await A.next('started', m => m.roundId === st.roundId);
  ok(started.roundId === st.roundId, 'started соответствует открытому раунду');

  console.log('— клиент B подключается ПОСЛЕ старта (посреди раунда) —');
  await new Promise(r => setTimeout(r, 700));
  const B = connect(idB);
  const helloB = await B.next('hello');
  if (helloB.phase === 'IN_PROGRESS'){
    ok(helloB.roundId === st.roundId, 'B видит ТОТ ЖЕ раунд, что A');
    ok(helloB.hash === st.hash, 'B получил тот же pre-hash');
    ok(helloB.startTime === started.startTime, 'B получил тот же серверный startTime');
    ok(helloB.crashPoint === null, 'B посреди раунда не знает crash-point');
    const pA = helloB.players.find(p => p.nick === helloA.nick);
    ok(!!pA && pA.bet === 10, 'B видит игрока A с его ставкой в лидерборде');
    /* одинаковый множитель: обе стороны считают от одного серверного startTime */
    const t = Date.now();
    const mA = E.growthFunc(t - started.startTime) / 100;
    const mB = E.growthFunc(t - helloB.startTime) / 100;
    ok(mA === mB, `множитель совпадает у A и B (×${mA.toFixed(2)})`);
  } else {
    console.log('  (раунд оказался мгновенным — краш до подключения B; сверим следующий)');
  }

  /* A выключает лампу почти сразу → почти наверняка успевает до краша */
  A.send({ t: 'lamp', on: false, mult: E.growthFunc(Date.now() - started.startTime) / 100 });

  console.log('— ждём краш —');
  const crash = await A.next('crash', m => m.roundId === st.roundId);
  const crashB = await B.next('crash', m => m.roundId === st.roundId, 5000).catch(() => null);
  ok(!crashB || (crashB.roundId === crash.roundId && crashB.crashPoint === crash.crashPoint),
     'краш у A и B одинаковый (roundId + crash-point)');
  ok(E.sha256hex(crash.serverSeed) === st.hash, 'provably fair: sha256(seed) == pre-hash');
  ok(E.crashPointFromHash(crash.serverSeed) === crash.crashPoint,
     'provably fair: crash-point выводится из seed той же математикой');

  console.log('— My Game History —');
  A.send({ t: 'myhistory' });
  const hist1 = await A.next('myhistory');
  ok(hist1.rows.length === 1 && hist1.rows[0].amount === 10 && hist1.rows[0].roundId === st.roundId,
     'ставка A записана в историю за сегодня');

  console.log('— рестарт сервера: история должна пережить —');
  A.ws.close(); B.ws.close();
  srv.kill(); await new Promise(r => setTimeout(r, 500));
  await startServer();
  const A2 = connect(idA);
  const helloA2 = await A2.next('hello');
  ok(helloA2.nick === helloA.nick, `ник стабилен между заходами: ${helloA2.nick}`);
  ok(helloA2.history.length >= 1, 'история раундов пережила рестарт');
  A2.send({ t: 'myhistory' });
  const hist2 = await A2.next('myhistory');
  ok(hist2.rows.length === 1 && hist2.rows[0].amount === 10,
     'сегодняшняя история ставок пережила рестарт');

  console.log(`\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (${passed})`);
  cleanup(0);
})().catch(e => { console.error('✗ TEST ERROR:', e.message); cleanup(1); });
