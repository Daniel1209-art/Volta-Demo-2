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

/* ── АНАЛИТИКА ────────────────────────────────────────────────────────
   Дашборд считает метрики скользящими окнами 1д/7д/30д, поэтому история
   должна пережить месяц: прежняя чистка резала ставки по календарному дню,
   а раунды — до последних 600 (≈4 часа), и окна длиннее суток были
   принципиально нерасчитуемы. Суточный сброс «My Game History» на это не
   завязан: клиентская выборка и так фильтрует по сегодняшнему дню. */
const RETENTION_DAYS  = parseInt(process.env.RETENTION_DAYS || '35', 10);
/* сессия логическая: возврат в это окно продолжает прежнюю, а не заводит новую,
   иначе перезагрузка страницы и обрыв мобильной сети дробят «время в игре» */
const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_MS || String(30 * 60 * 1000), 10);
const GEOIP_CSV       = process.env.GEOIP_CSV || path.join(__dirname, '..', 'data', 'geoip.csv');

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
    round_id     INTEGER PRIMARY KEY,
    hash         TEXT NOT NULL,
    seed         TEXT NOT NULL,
    crash_point  INTEGER NOT NULL,
    crashed_at   INTEGER NOT NULL,
    client_seeds TEXT,               -- JSON-массив использованных client seed-ов раунда
    seed_mode    TEXT                -- 'multi' (реальные игроки) | 'single' (системный seed)
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
  CREATE INDEX IF NOT EXISTS bets_created    ON bets(created_at);

  /* Игровая сессия — ЛОГИЧЕСКАЯ: несколько ws-соединений (вкладки, переподключения)
     одного игрока в пределах SESSION_IDLE_MS склеиваются в одну строку.
     ended_at пустой = сессия ещё идёт; last_seen_at двигают ws-пинги.
     Сырой IP не хранится: только ip_hash = SHA256(IP + серверная соль) и гео. */
  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id    TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ended_at     INTEGER,
    ip_hash      TEXT,
    country      TEXT,
    region       TEXT,
    is_bot       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sessions_player  ON sessions(player_id, started_at);
  CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);

  /* Сырая последовательность переключений лампы: пишется В МОМЕНТ события,
     задним числом порядок ON/OFF восстановить нечем. seq — номер события
     внутри раунда у игрока, src: 'free' (бесплатное включение на старте,
     переключение не тратит) | 'manual' | 'auto'. Столбец назван lamp_on,
     потому что ON — зарезервированное слово SQLite. */
  CREATE TABLE IF NOT EXISTS lamp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id   INTEGER NOT NULL,
    player_id  TEXT NOT NULL,
    session_id INTEGER,
    seq        INTEGER NOT NULL,
    lamp_on    INTEGER NOT NULL,
    mult       REAL NOT NULL,
    src        TEXT NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lamp_events_round ON lamp_events(round_id, player_id);
  CREATE INDEX IF NOT EXISTS lamp_events_at    ON lamp_events(at);
`);
/* миграция: у ранее созданной таблицы rounds могло не быть столбцов PF */
{
  const cols = db.prepare('PRAGMA table_info(rounds)').all().map(c => c.name);
  if (!cols.includes('client_seeds')) db.exec('ALTER TABLE rounds ADD COLUMN client_seeds TEXT');
  if (!cols.includes('seed_mode'))    db.exec('ALTER TABLE rounds ADD COLUMN seed_mode TEXT');
}
/* миграция: аналитические столбцы ставки. crash_point дублируется в строку
   ставки намеренно — метрика «личный множитель против финала раунда» не должна
   ломаться, когда раунд выпадет из retention раньше ставки. */
{
  const cols = db.prepare('PRAGMA table_info(bets)').all().map(c => c.name);
  const add = (name, decl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE bets ADD COLUMN ${name} ${decl}`); };
  add('session_id',    'INTEGER');
  add('crash_point',   'INTEGER');            // глобальный краш раунда, ×100 (0 = мгновенный ×1.00)
  add('cashout_mult',  'REAL');               // глобальный множитель в момент последнего OFF; NULL = не выключал
  add('switches_used', 'INTEGER NOT NULL DEFAULT 0');   // из MAX_SWITCHES (=4); бесплатный старт не считается
  add('on_count',      'INTEGER NOT NULL DEFAULT 0');
  add('off_count',     'INTEGER NOT NULL DEFAULT 0');
  add('had_off',       'INTEGER NOT NULL DEFAULT 0');   // хотя бы один OFF за раунд
  add('auto_bet',      'INTEGER NOT NULL DEFAULT 0');   // ставка сделана при включённом автопилоте
  add('auto_switches', 'INTEGER NOT NULL DEFAULT 0');   // из них выполнено автопилотом
  add('is_bot',        'INTEGER NOT NULL DEFAULT 0');
}
const q = {
  getPlayer:  db.prepare('SELECT id, nick FROM players WHERE id = ?'),
  nickTaken:  db.prepare('SELECT 1 FROM players WHERE nick = ?'),
  addPlayer:  db.prepare('INSERT INTO players (id, nick, created_at) VALUES (?, ?, ?)'),
  addRound:   db.prepare('INSERT INTO rounds (round_id, hash, seed, crash_point, crashed_at, client_seeds, seed_mode) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  lastRounds: db.prepare('SELECT round_id, crash_point FROM rounds ORDER BY round_id DESC LIMIT ?'),
  pfRounds:   db.prepare('SELECT round_id, hash, seed, crash_point, crashed_at, client_seeds, seed_mode FROM rounds ORDER BY round_id DESC LIMIT ?'),
  maxRound:   db.prepare('SELECT COALESCE(MAX(round_id), 0) AS m FROM rounds'),
  addBet:     db.prepare(`INSERT INTO bets (player_id, round_id, day, amount, final_mult, win, payout, created_at,
                            session_id, crash_point, cashout_mult, switches_used, on_count, off_count,
                            had_off, auto_bet, auto_switches, is_bot)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?)`),
  myBetsDay:  db.prepare('SELECT round_id, amount, final_mult, win, payout, created_at FROM bets WHERE player_id = ? AND day = ? ORDER BY id DESC LIMIT 200'),
  addLamp:    db.prepare('INSERT INTO lamp_events (round_id, player_id, session_id, seq, lamp_on, mult, src, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  lastSess:   db.prepare('SELECT id, last_seen_at FROM sessions WHERE player_id = ? ORDER BY id DESC LIMIT 1'),
  addSess:    db.prepare('INSERT INTO sessions (player_id, started_at, last_seen_at, ip_hash, country, region, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  /* возврат в окно склейки: сессия «оживает», гео/хеш дописываются только если их не было */
  resumeSess: db.prepare(`UPDATE sessions SET last_seen_at = ?, ended_at = NULL,
                            ip_hash = COALESCE(ip_hash, ?), country = COALESCE(country, ?), region = COALESCE(region, ?)
                          WHERE id = ?`),
  touchSess:  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?'),
  endSess:    db.prepare('UPDATE sessions SET ended_at = ?, last_seen_at = ? WHERE id = ? AND ended_at IS NULL'),
  /* соединение оборвалось без close (спящий телефон, убитый Wi-Fi) — закрываем по последнему пингу */
  sweepSess:  db.prepare('UPDATE sessions SET ended_at = last_seen_at WHERE ended_at IS NULL AND last_seen_at < ?'),
  purgeBets:  db.prepare('DELETE FROM bets WHERE created_at < ?'),
  purgeRounds:db.prepare('DELETE FROM rounds WHERE crashed_at < ?'),
  purgeLamp:  db.prepare('DELETE FROM lamp_events WHERE at < ?'),
  purgeSess:  db.prepare('DELETE FROM sessions WHERE started_at < ?'),
};

/* календарный день в настроенной TZ (по умолчанию UTC) — ключ суточного сброса */
const dayFmt = new Intl.DateTimeFormat('en-CA',
  { timeZone: RESET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayStr = (ts = Date.now()) => dayFmt.format(ts);

/* ── IP: ХЕШ + ГЕО, СЫРОЙ АДРЕС НЕ ХРАНИТСЯ ────────────────────────────
   ip_hash = SHA256(соль + IP): различает уникальных посетителей и повторные
   визиты, но обратно в адрес не разворачивается. Соль генерируется один раз
   рядом с БД (0600) — её потеря просто рвёт связь со старыми хешами, игровых
   данных не касается. Сырой IP живёт только внутри обработчика соединения:
   в БД уходят уже хеш и страна/регион. */
const IP_SALT = (() => {
  if (process.env.IP_SALT) return process.env.IP_SALT;
  const f = path.join(path.dirname(DB_PATH), '.ip_salt');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch (e) { /* первый запуск */ }
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, s, { mode: 0o600 }); }
  catch (e) { console.error('ip salt not persisted (хеши не переживут рестарт):', e.message); }
  return s;
})();
function clientIp(req){
  /* за nginx реальный адрес приходит в X-Forwarded-For; первый элемент — клиент */
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '';
}
function ipHash(ip){ return ip ? crypto.createHash('sha256').update(IP_SALT + '|' + ip).digest('hex') : null; }

/* IPv4 и IPv6 приводим к одной 32-символьной hex-шкале (v4 — как v4-mapped),
   тогда диапазоны гео-таблицы сравниваются обычным строковым сравнением */
function ipKey(ip){
  if (!ip) return null;
  let s = String(ip).split('%')[0];                       // отбрасываем zone-id (fe80::1%eth0)
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (s.includes('.')){
    const p = s.split('.');
    if (p.length !== 4) return null;
    let hex = '';
    for (const x of p){
      const n = Number(x);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      hex += n.toString(16).padStart(2, '0');
    }
    return '00000000000000000000ffff' + hex;
  }
  if (!s.includes(':')) return null;
  let parts;
  if (s.includes('::')){
    const [head, tail = ''] = s.split('::');
    const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
    if (a.length + b.length > 8) return null;
    parts = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  } else parts = s.split(':');
  if (parts.length !== 8) return null;
  let hex = '';
  for (const g of parts){
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    hex += g.toLowerCase().padStart(4, '0');
  }
  return hex;
}

/* Офлайновая гео-таблица: CSV-диапазонник (DB-IP lite «IP to Country» —
   start,end,country; либо city-уровень — start,end,continent,country,region,city).
   Файла нет → страна/регион остаются NULL, всё остальное работает как обычно. */
const GEO = (() => {
  const rows = [];
  try {
    for (const line of fs.readFileSync(GEOIP_CSV, 'utf8').split('\n')){
      const f = line.trim().replace(/"/g, '').split(',');
      if (f.length < 3) continue;
      const a = ipKey(f[0]), b = ipKey(f[1]);
      if (!a || !b) continue;
      rows.push(f.length >= 6 ? [a, b, f[3], f[4] || null] : [a, b, f[2], null]);
    }
    rows.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
    console.log(`geoip: ${rows.length} диапазонов из ${GEOIP_CSV}`);
  } catch (e) {
    console.log(`geoip: ${GEOIP_CSV} не найден — страна/регион не заполняются`);
  }
  return rows;
})();
function geoLookup(ip){
  const k = ipKey(ip);
  if (!k || !GEO.length) return { country: null, region: null };
  let lo = 0, hi = GEO.length - 1, hit = null;
  while (lo <= hi){                                   // последний диапазон со start <= k
    const mid = (lo + hi) >> 1;
    if (GEO[mid][0] > k) hi = mid - 1; else { hit = GEO[mid]; lo = mid + 1; }
  }
  if (!hit || hit[1] < k) return { country: null, region: null };
  return { country: hit[2] || null, region: hit[3] || null };
}

/* ── СЕССИИ ───────────────────────────────────────────────────────────
   is_bot: боты-заполнители стола живут только в памяти (spawnBots) и в БД не
   попадают — сегодня в sessions/bets по определению только реальный трафик.
   Флаг заведён, чтобы контракт дашборда не менялся, если источник трафика
   появится позже; ЕДИНСТВЕННОЕ место, где его надо будет проставлять. */
function openSession(playerId, net){
  const now = Date.now();
  const last = q.lastSess.get(playerId);
  if (last && now - last.last_seen_at <= SESSION_IDLE_MS){
    q.resumeSess.run(now, net.hash, net.country, net.region, last.id);
    return last.id;
  }
  return Number(q.addSess.run(playerId, now, now, net.hash, net.country, net.region, 0).lastInsertRowid);
}

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
  clientSeeds: null,         // упорядоченные client seed-ы раунда (задаются при закрытии окна ставок)
  seedMode: null,            // 'multi' (реальные игроки) | 'single' (системный seed)
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
           clientSeed: null,          // персональный provably-fair seed игрока (приходит с клиента)
           sessionId: null,           // логическая сессия (склейка SESSION_IDLE_MS)
           bet: null, lampOn: false, lampEver: false,
           switchesLeft: E.MAX_SWITCHES, persAccum: 1.0, persOnEntry: 1.0,
           settled: false, win: null, finalMult: null,
           /* аналитика раунда — живёт ровно один раунд, сбрасывается вместе с остальным */
           autoBet: 0, lampSeq: 0, onCount: 0, offCount: 0, autoSwitches: 0, cashoutMult: null };
}
function resetPlayerRound(p){
  p.bet = null; p.lampOn = false; p.lampEver = false;
  p.switchesLeft = E.MAX_SWITCHES; p.persAccum = 1.0; p.persOnEntry = 1.0;
  p.settled = false; p.win = null; p.finalMult = null;
  p.autoBet = 0; p.lampSeq = 0; p.onCount = 0; p.offCount = 0; p.autoSwitches = 0; p.cashoutMult = null;
}
/* аналитика не должна ронять раунд: запись события — best effort */
function logLamp(p, on, mult, src){
  p.lampSeq++;
  try { q.addLamp.run(R.roundId, p.id, p.sessionId, p.lampSeq, on ? 1 : 0, mult, src, Date.now()); }
  catch (e) { console.error('lamp event not logged:', e.message); }
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
   Поведение (кубический перекос off, 32% повторного включения) — как у
   прежних клиентских ботов; ставки — в пределах MAX_BET, как у живых игроков.
   Ники — в едином формате Volta-gamer#####. Сервер отдаёт ПОРОГИ один раз
   на раунд; клиенты детерминированно симулируют ботов от общего таймлайна,
   поэтому у всех зрителей боты ведут себя одинаково. */
/* ставки ботов подчиняются тому же лимиту MAX_BET, что и у живых игроков */
const BET_TIERS = [5,10,15,20,25,30,50,75,90,100].map(v => Math.min(v, E.MAX_BET));
function spawnBots(){
  const target = 12 + Math.floor(Math.random() * 19);         // размер «живого» стола 12–30 (варьируется каждый раунд)
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
  R.hash         = E.sha256hex(R.serverSeed);           // публикуется ДО раунда (commit)
  /* crash-point ЗДЕСЬ ещё НЕ считаем: client seed соберём от реальных ставок,
     пришедших за окно ставок, и вычислим crash-point при его ЗАКРЫТИИ
     (startRound). serverSeed уже зафиксирован хэшем — сервер не может
     подобрать его под ещё не существующие client seed-ы. */
  R.crashPoint   = null;
  R.gameDuration = null;
  R.clientSeeds  = null;
  R.seedMode     = null;
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

  /* ── ОКНО СТАВОК ЗАКРЫТО → формируем client seed раунда ───────────────
     Берём seed-ы ТОЛЬКО реальных игроков, реально поставивших ставку
     (боты — визуальная лента, в математику не входят). Порядок выводим
     из уже зафиксированного serverSeed (случайный для игрока, не грайндибелен
     сервером, воспроизводим Verify). До 5 seed-ов. Если реальных ставок нет —
     однослойная схема: serverSeed + системный seed (UI покажет это честно). */
  const realSeeds = [...players.values()]
    .filter(p => p.bet && p.clientSeed)
    .map(p => p.clientSeed);
  if (realSeeds.length === 0){
    R.seedMode    = 'single';
    R.clientSeeds = [E.SYSTEM_SEED];
  } else {
    R.seedMode    = 'multi';
    R.clientSeeds = E.orderBySeed(realSeeds, R.serverSeed).slice(0, E.MAX_SEEDS);
  }
  const combined = E.combineClientSeeds(R.clientSeeds);
  R.crashPoint   = E.crashPointFromHash(R.serverSeed, combined);   // только на сервере до краша
  R.gameDuration = R.crashPoint === 0 ? 0 : Math.ceil(E.inverseGrowth(R.crashPoint + 1));

  /* free start ON — как у клиента: не тратит переключение */
  for (const p of players.values()){
    if (p.bet){
      p.lampOn = true; p.lampEver = true; p.persOnEntry = 1.0; p.persAccum = 1.0;
      logLamp(p, 1, 1.0, 'free');            // бесплатный старт: событие есть, переключение не тратится
    }
  }
  broadcast({ t: 'started', roundId: R.roundId, startTime: R.startTime, serverNow: Date.now() });
  console.log(`[round ${R.roundId}] seed mode ${R.seedMode}, ${R.clientSeeds.length} client seed(s)`);

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
    q.addBet.run(p.id, R.roundId, today, p.bet, p.finalMult, p.win ? 1 : 0, payout, Date.now(),
                 p.sessionId, R.crashPoint, p.cashoutMult,
                 E.MAX_SWITCHES - p.switchesLeft, p.onCount, p.offCount,
                 p.offCount > 0 ? 1 : 0, p.autoBet, p.autoSwitches, 0);
  }

  q.addRound.run(R.roundId, R.hash, R.serverSeed, R.crashPoint, R.endedAt,
                 JSON.stringify(R.clientSeeds || []), R.seedMode || 'single');
  history.unshift({ roundId: R.roundId, m: crashMult });
  history = history.slice(0, HISTORY_LEN);

  /* seed раскрывается только сейчас — клиенты сверяют sha256(seed) с хэшем раунда
     и crash-point = crashPointFromHash(seed, склейка client seed-ов) */
  broadcast({ t: 'crash', roundId: R.roundId, crashPoint: R.crashPoint,
              serverSeed: R.serverSeed, clientSeeds: R.clientSeeds, seedMode: R.seedMode,
              serverNow: Date.now(),
              players: [...players.values()].filter(p => p.bet).map(pubPlayer) });
  console.log(`[round ${R.roundId}] crash ×${crashMult.toFixed(2)}`);

  clearTimeout(R.timer);
  R.timer = setTimeout(prepRound, E.AFTER_CRASH_MS);
}

/* ── ДЕЙСТВИЯ ИГРОКА ──────────────────────────────────────────────── */
function handleBet(p, amount, auto){
  if (R.phase !== 'STARTING' || p.bet) return;
  const a = Math.floor(Number(amount));
  if (!Number.isFinite(a) || a < 1) return;
  p.bet = Math.min(a, E.MAX_BET);
  p.autoBet = auto ? 1 : 0;            // чисто аналитический признак, на расчёт не влияет
  broadcast({ t: 'bet', nick: p.nick, amount: p.bet });
}
function handleLamp(p, on, claimedMult, src){
  if (R.phase !== 'IN_PROGRESS' || !p.bet || p.settled) return;
  /* анти-чит: клиентская заявка множителя не может опережать серверный таймлайн */
  const sm = serverMult();
  let m = Number(claimedMult);
  if (!Number.isFinite(m) || m < 1) m = sm;
  m = Math.min(m, sm);
  const source = src === 'auto' ? 'auto' : 'manual';
  if (on){
    if (p.lampOn || p.switchesLeft <= 0) return;
    p.lampOn = true; p.lampEver = true;
    p.switchesLeft--; p.persOnEntry = Math.max(m, 1);
    p.onCount++;
  } else {
    if (!p.lampOn) return;
    const gain = p.persOnEntry > 0 ? Math.max(m, p.persOnEntry) / p.persOnEntry : 1.0;
    p.persAccum *= gain;
    p.lampOn = false; p.persOnEntry = m;
    p.offCount++; p.cashoutMult = m;   // глобальный множитель в момент фиксации (последний OFF)
  }
  if (source === 'auto') p.autoSwitches++;
  logLamp(p, p.lampOn, m, source);
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

/* client seed игрока: только «безопасные» символы, ограниченная длина */
function sanitizeSeed(s){
  if (typeof s !== 'string') return null;
  const clean = s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  return clean.length >= 4 ? clean : null;
}

/* Provably Fair: последние завершённые раунды с полным набором для проверки */
function handlePF(ws, limit){
  const n = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const rows = q.pfRounds.all(n).map(r => {
    /* legacy-раунды (записаны ДО миграции) не имеют client_seeds: тогда
       использовался системный seed как единственный client seed — отдаём его,
       чтобы независимый пересчёт множителя сходился и на старой истории. */
    if (r.client_seeds == null){
      return { roundId: r.round_id, hash: r.hash, serverSeed: r.seed,
               crashPoint: r.crash_point, crashedAt: r.crashed_at,
               clientSeeds: [E.SYSTEM_SEED], seedMode: 'single' };
    }
    let seeds = [];
    try { seeds = JSON.parse(r.client_seeds); } catch (e) { seeds = []; }
    if (!seeds.length) seeds = [E.SYSTEM_SEED];
    return { roundId: r.round_id, hash: r.hash, serverSeed: r.seed,
             crashPoint: r.crash_point, crashedAt: r.crashed_at,
             clientSeeds: seeds, seedMode: r.seed_mode || 'single' };
  });
  send(ws, { t: 'pf', rows });
}

/* ── ЧИСТКА ПО СРОКУ ХРАНЕНИЯ ─────────────────────────────────────────
   Всё живёт RETENTION_DAYS суток — этого требуют окна дашборда 1д/7д/30д.
   «My Game History» по-прежнему суточная: она отбирает строки по day =
   сегодня (RESET_TZ), а не полагается на удаление вчерашних. */
setInterval(() => {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    q.purgeBets.run(cutoff);
    q.purgeRounds.run(cutoff);
    q.purgeLamp.run(cutoff);
    q.purgeSess.run(cutoff);
    q.sweepSess.run(Date.now() - SESSION_IDLE_MS);
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

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  /* сырой IP дальше этой строки не живёт: в замыкании остаются только хеш и гео */
  const net = (() => { const ip = clientIp(req); return { hash: ipHash(ip), ...geoLookup(ip) }; })();
  ws.on('pong', () => {
    ws.isAlive = true;
    if (ws.sessionId) q.touchSess.run(Date.now(), ws.sessionId);   // ws-пинг раз в 30 с двигает «время в игре»
  });
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
      me.clientSeed = sanitizeSeed(msg.clientSeed);   // персональный provably-fair seed игрока
      ws.clientId = clientId;
      me.sessionId = ws.sessionId = openSession(clientId, net);
      const ended = R.phase === 'ENDED';
      send(ws, {
        t: 'hello', serverNow: Date.now(), nick: me.nick,
        phase: R.phase, roundId: R.roundId, hash: R.hash,
        startsAt: R.startsAt, startTime: R.startTime, endedAt: R.endedAt,
        crashPoint:  ended ? R.crashPoint  : null,   // до краша crash-point не покидает сервер
        serverSeed:  ended ? R.serverSeed  : null,   // раскрытый seed последнего завершённого раунда
        clientSeeds: ended ? R.clientSeeds : null,
        seedMode:    ended ? R.seedMode    : null,
        history: history.map(h => h.m),
        bots: R.bots,
        players: [...players.values()].filter(p => p.bet && p.id !== clientId).map(pubPlayer),
        you: pubPlayer(me),
      });
      return;
    }
    if (msg.t === 'ping'){
      if (ws.sessionId) q.touchSess.run(Date.now(), ws.sessionId);
      send(ws, { t: 'pong', now: msg.now, serverNow: Date.now() }); return;
    }
    if (!me) return;                   // остальные сообщения — только после hello
    if (msg.t === 'bet')       handleBet(me, msg.amount, msg.auto);
    else if (msg.t === 'lamp') handleLamp(me, !!msg.on, msg.mult, msg.src);
    else if (msg.t === 'myhistory') handleMyHistory(me, ws);
    else if (msg.t === 'seed')      me.clientSeed = sanitizeSeed(msg.clientSeed);   // игрок сменил client seed
    else if (msg.t === 'pf')        handlePF(ws, msg.limit);
  });

  ws.on('close', () => {
    if (!me) return;
    me.sockets.delete(ws);
    /* состояние раунда держим до конца раунда даже при обрыве —
       переподключившийся игрок продолжит с того же места */
    if (me.sockets.size === 0 && me.sessionId){
      /* закрыли последнюю вкладку — сессия помечается завершённой, но возврат
         в пределах SESSION_IDLE_MS снова снимет ended_at (та же строка) */
      const now = Date.now();
      q.endSess.run(now, now, me.sessionId);
    }
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
