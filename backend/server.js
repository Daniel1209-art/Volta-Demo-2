/* ═══════════════════════════════════════════════════════════════════
   VOLTA — GAME SERVER (единый таймлайн раундов для всех игроков)

   Источник правды: серверный game-loop с ТОЙ ЖЕ математикой, что у
   клиента (shared/engine.js — общий модуль, формулы не дублируются).
   Фазы и тайминги идентичны монолитному клиенту:
     STARTING (RESTART_MS) → IN_PROGRESS → crash → пауза (AFTER_CRASH_MS) → …

   Provably fair: sha256(serverSeed) публикуется ДО раунда ('starting'),
   serverSeed и crash-point уходят клиентам только в момент краша —
   до этого crash-point знает только сервер (анти-чит).

   Транспорт: WebSocket /ws (в проде — wss:// через nginx-прокси).
   Хранилище: SQLite (node:sqlite, встроен в Node ≥22 — без нативных
   зависимостей): игроки (ник↔id), история раундов, ставки за день.
   Демо на игровые деньги: баланс игрока живёт на клиенте, сервер
   платежей не ведёт.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer, WebSocket } = require('ws');

const E = require('../shared/engine.js');   // общая crash-математика (не менять!)

/* ── КОНФИГ (env / .env; секретов нет) ────────────────────────────── */
loadDotEnv(path.join(__dirname, '.env'));
const PORT         = parseInt(process.env.PORT || '8090', 10);
const HOST         = process.env.HOST || '127.0.0.1';
const DB_PATH      = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'volta.db');
const RESET_TZ     = process.env.RESET_TZ || 'UTC';        // TZ суточного сброса «My Game History»
const HISTORY_LEN  = parseInt(process.env.HISTORY_LEN || '50', 10);   // чипы истории для клиента
const SERVE_STATIC = process.env.SERVE_STATIC === '1';     // локальная разработка без nginx

function loadDotEnv(file){
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')){
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (e) { /* .env не обязателен */ }
}

/* ── БАЗА ─────────────────────────────────────────────────────────── */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS players (
    id         TEXT PRIMARY KEY,
    nick       TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rounds (
    round_id    INTEGER PRIMARY KEY,
    hash        TEXT NOT NULL,
    seed        TEXT NOT NULL,
    crash_point INTEGER NOT NULL,
    crashed_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  TEXT NOT NULL,
    round_id   INTEGER NOT NULL,
    day        TEXT NOT NULL,
    amount     REAL NOT NULL,
    final_mult REAL NOT NULL,
    win        INTEGER NOT NULL,
    payout     REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bets_player_day ON bets(player_id, day);
`);
const q = {
  getPlayer:  db.prepare('SELECT id, nick FROM players WHERE id = ?'),
  nickTaken:  db.prepare('SELECT 1 FROM players WHERE nick = ?'),
  addPlayer:  db.prepare('INSERT INTO players (id, nick, created_at) VALUES (?, ?, ?)'),
  addRound:   db.prepare('INSERT INTO rounds (round_id, hash, seed, crash_point, crashed_at) VALUES (?, ?, ?, ?, ?)'),
  lastRounds: db.prepare('SELECT round_id, crash_point FROM rounds ORDER BY round_id DESC LIMIT ?'),
  maxRound:   db.prepare('SELECT COALESCE(MAX(round_id), 0) AS m FROM rounds'),
  addBet:     db.prepare('INSERT INTO bets (player_id, round_id, day, amount, final_mult, win, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  myBetsDay:  db.prepare('SELECT round_id, amount, final_mult, win, payout, created_at FROM bets WHERE player_id = ? AND day = ? ORDER BY id DESC LIMIT 200'),
  purgeBets:  db.prepare('DELETE FROM bets WHERE day < ?'),
  purgeRounds:db.prepare('DELETE FROM rounds WHERE round_id <= ?'),
};

/* календарный день в настроенной TZ (по умолчанию UTC) — ключ суточного сброса */
const dayFmt = new Intl.DateTimeFormat('en-CA',
  { timeZone: RESET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayStr = (ts = Date.now()) => dayFmt.format(ts);

/* ── НИКИ: Volta-gamer + 5 СЛУЧАЙНЫХ цифр, стабильны между заходами ── */
function randDigits5(){ return String(crypto.randomInt(0, 100000)).padStart(5, '0'); }
function newNick(){
  for (let i = 0; i < 50; i++){
    const nick = 'Volta-gamer' + randDigits5();
    if (!q.nickTaken.get(nick)) return nick;
  }
  return 'Volta-gamer' + String(Date.now()).slice(-5);   // 100k занятых — крайне маловероятно
}
function getOrCreatePlayer(clientId){
  const row = q.getPlayer.get(clientId);
  if (row) return row;
  const nick = newNick();
  q.addPlayer.run(clientId, nick, Date.now());
  return { id: clientId, nick };
}

/* ── СОСТОЯНИЕ РАУНДА ─────────────────────────────────────────────── */
const R = {
  phase: 'ENDED',            // STARTING | IN_PROGRESS | ENDED
  roundId: q.maxRound.get().m,
  serverSeed: null, hash: null, crashPoint: null, gameDuration: null,
  startsAt: 0, startTime: 0, endedAt: 0,
  bots: [],                  // заполнители стола: пороги детерминируют поведение
  timer: null,
};
/* история последних раундов (для полосы чипов) — из БД, живёт через рестарт */
let history = q.lastRounds.all(HISTORY_LEN)
  .map(r => ({ roundId: r.round_id, m: r.crash_point === 0 ? 1.0 : r.crash_point / 100 }));

/* ── ИГРОКИ ───────────────────────────────────────────────────────────
   Ключ — clientId (стабилен между заходами). Несколько вкладок одного
   игрока делят одно игровое состояние. Поля ставки/лампы — зеркало
   клиентской механики (free start ON, MAX_SWITCHES, persAccum). */
const players = new Map();   // clientId → P
function P(id, nick){
  return { id, nick, sockets: new Set(),
           bet: null, lampOn: false, lampEver: false,
           switchesLeft: E.MAX_SWITCHES, persAccum: 1.0, persOnEntry: 1.0,
           settled: false, win: null, finalMult: null };
}
function resetPlayerRound(p){
  p.bet = null; p.lampOn = false; p.lampEver = false;
  p.switchesLeft = E.MAX_SWITCHES; p.persAccum = 1.0; p.persOnEntry = 1.0;
  p.settled = false; p.win = null; p.finalMult = null;
}
function pubPlayer(p){
  return { nick: p.nick, bet: p.bet, on: p.lampOn,
           persAccum: p.persAccum, persOnEntry: p.persOnEntry,
           settled: p.settled, win: p.win, finalMult: p.finalMult };
}
function serverMult(){
  if (R.phase !== 'IN_PROGRESS') return 1.0;
  return E.growthFunc(Date.now() - R.startTime) / 100;
}

/* ── БОТЫ-ЗАПОЛНИТЕЛИ ─────────────────────────────────────────────────
   Распределение то же, что было у клиентских ботов (BET_TIERS, кубический
   перекос off, 32% повторного включения) — поведение стола не изменилось.
   Ники — в едином формате Volta-gamer#####. Сервер отдаёт ПОРОГИ один раз
   на раунд; клиенты детерминированно симулируют ботов от общего таймлайна,
   поэтому у всех зрителей боты ведут себя одинаково. */
const BET_TIERS = [50,100,150,200,300,500,750,1000,1500,2000];
function spawnBots(){
  const target = 11 + Math.floor(Math.random() * 7);          // размер «живого» стола 11–17
  const real = [...players.values()].filter(p => p.sockets.size > 0).length;
  const n = Math.max(0, target - real);
  const used = new Set([...players.values()].map(p => p.nick));
  const bots = [];
  for (let i = 0; i < n; i++){
    let nick;
    do { nick = 'Volta-gamer' + randDigits5(); } while (used.has(nick));
    used.add(nick);
    const bet = BET_TIERS[Math.floor(Math.random() * BET_TIERS.length)];
    const r = Math.random();
    const off = +(1.15 + r * r * r * 9).toFixed(2);           // кубический перекос → чаще ранние выходы
    const reOn  = Math.random() < 0.32 ? +(off + 0.3 + Math.random() * 2).toFixed(2) : null;
    const reOff = reOn ? +(reOn + 0.5 + Math.random() * Math.random() * 8).toFixed(2) : null;
    bots.push({ nick, bet, off, reOn, reOff });
  }
  return bots;
}

/* ── РАССЫЛКА ─────────────────────────────────────────────────────── */
let wss = null;
function send(ws, obj){ if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj){
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

/* ── GAME LOOP — фазы и тайминги 1-в-1 с монолитным клиентом ──────── */
function prepRound(){
  R.roundId++;
  R.phase = 'STARTING';
  R.serverSeed   = E.randHex(32);                       // crypto-стойкий rand (webcrypto Node)
  R.hash         = E.sha256hex(R.serverSeed);           // публикуется ДО раунда
  R.crashPoint   = E.crashPointFromHash(R.serverSeed);  // остаётся ТОЛЬКО на сервере до краша
  R.gameDuration = R.crashPoint === 0 ? 0 : Math.ceil(E.inverseGrowth(R.crashPoint + 1));
  R.startsAt     = Date.now() + E.RESTART_MS;
  R.bots         = spawnBots();
  for (const p of players.values()) resetPlayerRound(p);

  broadcast({ t: 'starting', roundId: R.roundId, hash: R.hash, startsAt: R.startsAt,
              serverNow: Date.now(), bots: R.bots });
  console.log(`[round ${R.roundId}] open, hash ${R.hash.slice(0, 12)}…`);

  clearTimeout(R.timer);
  R.timer = setTimeout(startRound, E.RESTART_MS);
}

function startRound(){
  R.phase = 'IN_PROGRESS';
  R.startTime = Date.now();
  /* free start ON — как у клиента: не тратит переключение */
  for (const p of players.values()){
    if (p.bet){ p.lampOn = true; p.lampEver = true; p.persOnEntry = 1.0; p.persAccum = 1.0; }
  }
  broadcast({ t: 'started', roundId: R.roundId, startTime: R.startTime, serverNow: Date.now() });

  clearTimeout(R.timer);
  R.timer = setTimeout(crashRound, Math.max(0, R.gameDuration));
}

function crashRound(){
  R.phase = 'ENDED';
  R.endedAt = Date.now();
  const crashMult = R.crashPoint === 0 ? 1.0 : R.crashPoint / 100;

  /* расчёт реальных игроков — та же логика, что в клиентском handleCrash */
  const today = dayStr();
  for (const p of players.values()){
    if (!p.bet || p.settled) continue;
    if (p.lampOn){                                   // лампа горела в момент краша → ставка сгорает
      const gain = p.persOnEntry > 0 ? crashMult / p.persOnEntry : 1.0;
      p.finalMult = p.persAccum * gain;
      p.win = false;
    } else if (!p.lampEver){                         // ни разу не включал
      p.finalMult = 1.0;
      p.win = false;
    } else {                                         // выключил вовремя → выплата bet × persAccum
      p.finalMult = p.persAccum;
      p.win = true;
    }
    p.settled = true;
    const payout = p.win ? p.bet * p.finalMult : 0;
    q.addBet.run(p.id, R.roundId, today, p.bet, p.finalMult, p.win ? 1 : 0, payout, Date.now());
  }

  q.addRound.run(R.roundId, R.hash, R.serverSeed, R.crashPoint, R.endedAt);
  history.unshift({ roundId: R.roundId, m: crashMult });
  history = history.slice(0, HISTORY_LEN);

  /* seed раскрывается только сейчас — клиенты сверяют sha256(seed) с хэшем раунда */
  broadcast({ t: 'crash', roundId: R.roundId, crashPoint: R.crashPoint,
              serverSeed: R.serverSeed, serverNow: Date.now(),
              players: [...players.values()].filter(p => p.bet).map(pubPlayer) });
  console.log(`[round ${R.roundId}] crash ×${crashMult.toFixed(2)}`);

  clearTimeout(R.timer);
  R.timer = setTimeout(prepRound, E.AFTER_CRASH_MS);
}

/* ── ДЕЙСТВИЯ ИГРОКА ──────────────────────────────────────────────── */
function handleBet(p, amount){
  if (R.phase !== 'STARTING' || p.bet) return;
  const a = Math.floor(Number(amount));
  if (!Number.isFinite(a) || a < 1) return;
  p.bet = Math.min(a, E.MAX_BET);
  broadcast({ t: 'bet', nick: p.nick, amount: p.bet });
}
function handleLamp(p, on, claimedMult){
  if (R.phase !== 'IN_PROGRESS' || !p.bet || p.settled) return;
  /* анти-чит: клиентская заявка множителя не может опережать серверный таймлайн */
  const sm = serverMult();
  let m = Number(claimedMult);
  if (!Number.isFinite(m) || m < 1) m = sm;
  m = Math.min(m, sm);
  if (on){
    if (p.lampOn || p.switchesLeft <= 0) return;
    p.lampOn = true; p.lampEver = true;
    p.switchesLeft--; p.persOnEntry = Math.max(m, 1);
  } else {
    if (!p.lampOn) return;
    const gain = p.persOnEntry > 0 ? Math.max(m, p.persOnEntry) / p.persOnEntry : 1.0;
    p.persAccum *= gain;
    p.lampOn = false; p.persOnEntry = m;
  }
  broadcast({ t: 'lamp', nick: p.nick, on: p.lampOn,
              persAccum: p.persAccum, persOnEntry: p.persOnEntry });
}
function handleMyHistory(p, ws){
  const day = dayStr();
  const rows = q.myBetsDay.all(p.id, day).map(r => ({
    roundId: r.round_id, amount: r.amount, finalMult: r.final_mult,
    win: !!r.win, payout: r.payout, at: r.created_at }));
  send(ws, { t: 'myhistory', day, tz: RESET_TZ, rows });
}

/* ── СУТОЧНЫЙ СБРОС + ЧИСТКА ──────────────────────────────────────────
   История ставок хранится по календарному дню (RESET_TZ): выборка всегда
   за «сегодня», а строки прошлых дней физически удаляются фоновой чисткой.
   Данные в SQLite → сегодняшняя история переживает рестарт сервера. */
setInterval(() => {
  try {
    q.purgeBets.run(dayStr());
    const m = q.maxRound.get().m;
    if (m > 600) q.purgeRounds.run(m - 600);
  } catch (e) { console.error('purge failed:', e.message); }
}, 10 * 60 * 1000);

/* ── HTTP (health + статика для локальной разработки) ─────────────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' };
const FRONT = path.join(__dirname, '..', 'frontend');
const SHARED = path.join(__dirname, '..', 'shared');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/health'){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, phase: R.phase, roundId: R.roundId,
                             players: [...players.values()].filter(p => p.sockets.size).length }));
    return;
  }
  if (!SERVE_STATIC){ res.writeHead(404); res.end('not found'); return; }
  /* статика только для localhost-разработки; в проде её отдаёт nginx */
  let file = url.startsWith('/shared/')
    ? path.join(SHARED, url.slice('/shared/'.length))
    : path.join(FRONT, url === '/' ? 'index.html' : decodeURIComponent(url));
  const base = url.startsWith('/shared/') ? SHARED : FRONT;
  file = path.normalize(file);
  if (!file.startsWith(base)){ res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err){ res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ── WEBSOCKET ────────────────────────────────────────────────────── */
wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let me = null;                       // P после hello

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (typeof msg !== 'object' || !msg) return;

    if (msg.t === 'hello'){
      const clientId = String(msg.clientId || '').slice(0, 64);
      if (!/^[a-f0-9]{8,64}$/.test(clientId)){ send(ws, { t: 'error', error: 'bad clientId' }); return; }
      const rec = getOrCreatePlayer(clientId);
      me = players.get(clientId);
      if (!me){ me = P(clientId, rec.nick); players.set(clientId, me); }
      me.sockets.add(ws);
      ws.clientId = clientId;
      send(ws, {
        t: 'hello', serverNow: Date.now(), nick: me.nick,
        phase: R.phase, roundId: R.roundId, hash: R.hash,
        startsAt: R.startsAt, startTime: R.startTime, endedAt: R.endedAt,
        crashPoint: R.phase === 'ENDED' ? R.crashPoint : null,   // до краша crash-point не покидает сервер
        history: history.map(h => h.m),
        bots: R.bots,
        players: [...players.values()].filter(p => p.bet && p.id !== clientId).map(pubPlayer),
        you: pubPlayer(me),
      });
      return;
    }
    if (msg.t === 'ping'){ send(ws, { t: 'pong', now: msg.now, serverNow: Date.now() }); return; }
    if (!me) return;                   // остальные сообщения — только после hello
    if (msg.t === 'bet')       handleBet(me, msg.amount);
    else if (msg.t === 'lamp') handleLamp(me, !!msg.on, msg.mult);
    else if (msg.t === 'myhistory') handleMyHistory(me, ws);
  });

  ws.on('close', () => {
    if (!me) return;
    me.sockets.delete(ws);
    /* состояние раунда держим до конца раунда даже при обрыве —
       переподключившийся игрок продолжит с того же места */
  });
});

/* реап мёртвых соединений */
setInterval(() => {
  for (const c of wss.clients){
    if (!c.isAlive){ c.terminate(); continue; }
    c.isAlive = false;
    try { c.ping(); } catch (e) {}
  }
}, 30 * 1000);

/* ── СТАРТ ────────────────────────────────────────────────────────── */
server.listen(PORT, HOST, () => {
  console.log(`VOLTA backend on http://${HOST}:${PORT} (ws /ws), db ${DB_PATH}, reset TZ ${RESET_TZ}` +
              (SERVE_STATIC ? ', serving static (dev)' : ''));
  prepRound();                         // запускаем вечный цикл раундов
});

process.on('SIGTERM', () => { clearTimeout(R.timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
process.on('SIGINT',  () => process.emit('SIGTERM'));
