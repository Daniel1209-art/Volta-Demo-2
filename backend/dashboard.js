/* ═══════════════════════════════════════════════════════════════════
   VOLTA — READ-ONLY API ДАШБОРДА  (/api/dashboard/*)

   Отдельный модуль и ОТДЕЛЬНОЕ подключение к БД, открытое только на
   чтение: на уровне драйвера ни один эндпоинт дашборда не может ничего
   записать или изменить в игровых данных. Игровой цикл, генерация
   раундов и provably-fair схема этот модуль не видит вовсе.

   Схема и определения метрик — docs/analytics.md, он канонический.

   Авторизация: пароль из DASHBOARD_PASSWORD меняется на короткоживущий
   токен (POST /login), дальше Authorization: Bearer. Пароль не задан —
   дашборд ОТКЛЮЧЁН целиком (503), чтобы открытый доступ не мог уехать
   в прод по недосмотру.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const TOKEN_TTL_MS  = parseInt(process.env.DASHBOARD_TTL_MS || String(12 * 60 * 60 * 1000), 10);
const LOGIN_MAX_FAIL = 10;                       // неудачных попыток входа…
const LOGIN_LOCK_MS  = 15 * 60 * 1000;           // …за это окно → 429

/* окна метрик: скользящие от текущего момента (docs/analytics.md) */
const PERIODS = { '1d': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '1m': 30 * 24 * 3600e3 };

/* Теоретический RTP зафиксирован аудитом в docs/analytics.md и от периода не
   зависит — за окно считается только фактический. Переиспользовать в коде было
   нечего: константы RTP нет ни в shared/engine.js, ни в конфиге (README
   называет лишь диапазон «~96.5–97.5%»), поэтому значение из документа живёт
   здесь единственным местом. */
const THEORETICAL_RTP = Number(process.env.THEORETICAL_RTP || 0.9653);

/* доли (0..1), а не проценты — форматирует потребитель */
const share = (part, total) => (total > 0 ? +(part / total).toFixed(6) : null);
const round2 = (v) => (v === null || v === undefined ? null : +Number(v).toFixed(2));
const round4 = (v) => (v === null || v === undefined ? null : +Number(v).toFixed(4));
/* crash_point лежит ×100 целым, 0 = мгновенный краш ×1.00 */
const CRASH_X100 = 'CASE WHEN crash_point = 0 THEN 100 ELSE crash_point END';

function createDashboard({ dbPath, clientIp, ipHash, maxSwitches }){
  const MAX_SWITCHES = maxSwitches;            // из shared/engine.js, знаменатель метрики 4б
  const password = process.env.DASHBOARD_PASSWORD || '';
  const enabled  = password.length > 0;

  /* Соединение только на чтение — жёсткая гарантия read-only.
     Открывается лениво: при старте бэкенда файл БД может ещё не существовать. */
  let ro = null;
  function db(){
    if (!ro) ro = new DatabaseSync(dbPath, { readOnly: true });
    return ro;
  }

  const tokens = new Map();                      // token → expiresAt
  const fails  = new Map();                      // ip_hash → { n, until }

  function sweep(now){
    for (const [t, exp] of tokens) if (exp <= now) tokens.delete(t);
    for (const [k, f] of fails) if (f.until <= now) fails.delete(k);
  }
  function issueToken(){
    const now = Date.now();
    sweep(now);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + TOKEN_TTL_MS;
    tokens.set(token, expiresAt);
    return { token, expiresAt };
  }
  function checkToken(req){
    const h = String(req.headers['authorization'] || '');
    const m = h.match(/^Bearer\s+([a-f0-9]{64})$/i);
    if (!m) return null;
    const token = m[1].toLowerCase();
    const exp = tokens.get(token);
    if (!exp) return null;
    if (exp <= Date.now()){ tokens.delete(token); return null; }
    return { token, expiresAt: exp };
  }
  /* сравнение через дайджесты фиксированной длины: timingSafeEqual требует
     одинакового размера, а сравнивать пароли по длине — само по себе утечка */
  function samePassword(given){
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  function readJson(req, limit = 1024){
    return new Promise((resolve) => {
      let n = 0; const chunks = [];
      req.on('data', (c) => {
        n += c.length;
        if (n > limit){ req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  /* period → границы окна; null, если период не из списка */
  function windowOf(url){
    const p = url.searchParams.get('period') || '1d';
    if (!(p in PERIODS)) return null;
    const to = Date.now();
    return { period: p, from: to - PERIODS[p], to };
  }

  async function handleLogin(req, res){
    const key = ipHash(clientIp(req)) || 'unknown';
    const now = Date.now();
    sweep(now);
    const f = fails.get(key);
    if (f && f.n >= LOGIN_MAX_FAIL && f.until > now)
      return json(res, 429, { error: 'too_many_attempts', retryAfterMs: f.until - now });

    const body = await readJson(req);
    if (!body || typeof body.password !== 'string')
      return json(res, 400, { error: 'password_required' });

    if (!samePassword(body.password)){
      const cur = f && f.until > now ? f : { n: 0, until: now + LOGIN_LOCK_MS };
      cur.n++; cur.until = now + LOGIN_LOCK_MS;
      fails.set(key, cur);
      return json(res, 401, { error: 'bad_password' });
    }
    fails.delete(key);
    return json(res, 200, issueToken());
  }

  /* подготовленные запросы переиспользуются между вызовами */
  const stmts = new Map();
  const sql = (text) => {
    let s = stmts.get(text);
    if (!s){ s = db().prepare(text); stmts.set(text, s); }
    return s;
  };

  /* Таблица маршрутов. Значение — функция (req, res, url, session). */
  const routes = new Map();
  const badPeriod = (res) => json(res, 400, { error: 'bad_period', allowed: Object.keys(PERIODS) });

  /* ── 1. ИГРОКИ ─────────────────────────────────────────────────────
     Реальные игроки (is_bot = 0) с пагинацией. Попадает всякий, у кого в окне
     есть хотя бы одна ставка ИЛИ хотя бы одна сессия: зашедший, но не
     поставивший — тоже посетитель, у него просто нет RTP.
     ip_hash и страна берутся из ПОСЛЕДНЕЙ сессии игрока: адрес может меняться.
     Время в игре — сумма по сессиям, COALESCE(ended_at, last_seen_at) −
     started_at (docs/analytics.md), склейка 30 минут уже учтена тем, что
     возврат продолжает ту же строку sessions, а не заводит новую.
     period необязателен: без него — вся сохранённая история (retention). */
  const PLAYER_SORT = {
    volume:   'COALESCE(b.volume, 0)',
    bets:     'COALESCE(b.bets, 0)',
    payout:   'COALESCE(b.payout, 0)',
    rtp:      'CASE WHEN COALESCE(b.volume, 0) > 0 THEN b.payout / b.volume END',
    winrate:  'CASE WHEN COALESCE(b.bets, 0) > 0 THEN CAST(b.wins AS REAL) / b.bets END',
    playtime: 'COALESCE(s.playtime, 0)',
  };
  const PLAYERS_FROM = `
    FROM players p
    LEFT JOIN (SELECT player_id, COUNT(*) AS bets, SUM(amount) AS volume,
                      SUM(payout) AS payout, SUM(win) AS wins
               FROM bets WHERE created_at >= ? AND created_at <= ? AND is_bot = 0
               GROUP BY player_id) b ON b.player_id = p.id
    LEFT JOIN (SELECT player_id, COUNT(*) AS sessions, MAX(last_seen_at) AS lastSeen,
                      SUM(COALESCE(ended_at, last_seen_at) - started_at) AS playtime
               FROM sessions WHERE started_at >= ? AND started_at <= ? AND is_bot = 0
               GROUP BY player_id) s ON s.player_id = p.id
    WHERE b.player_id IS NOT NULL OR s.player_id IS NOT NULL`;

  routes.set('players', (req, res, url) => {
    const p = url.searchParams.get('period');
    let from = 0, to = Date.now(), period = null;
    if (p !== null){
      const w = windowOf(url);
      if (!w) return badPeriod(res);
      ({ from, to, period } = w);
    }
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
    const sortKey = url.searchParams.get('sort') || 'volume';
    if (!(sortKey in PLAYER_SORT))
      return json(res, 400, { error: 'bad_sort', allowed: Object.keys(PLAYER_SORT) });
    const dir = (url.searchParams.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const args = [from, to, from, to];
    const total = sql(`SELECT COUNT(*) AS c ${PLAYERS_FROM}`).get(...args).c;
    const rows = sql(`
      SELECT p.id AS playerId, p.nick,
             (SELECT x.ip_hash FROM sessions x WHERE x.player_id = p.id ORDER BY x.started_at DESC LIMIT 1) AS ipHash,
             (SELECT x.country FROM sessions x WHERE x.player_id = p.id ORDER BY x.started_at DESC LIMIT 1) AS country,
             COALESCE(b.bets, 0) AS bets, COALESCE(b.volume, 0) AS volume,
             COALESCE(b.payout, 0) AS payout, COALESCE(b.wins, 0) AS wins,
             COALESCE(s.sessions, 0) AS sessions, COALESCE(s.playtime, 0) AS playtime, s.lastSeen
      ${PLAYERS_FROM}
      ORDER BY ${PLAYER_SORT[sortKey]} ${dir}, p.id ASC
      LIMIT ? OFFSET ?`).all(...args, limit, offset);

    json(res, 200, {
      period, from, to, total, limit, offset,
      players: rows.map(r => ({
        playerId: r.playerId, nick: r.nick, ipHash: r.ipHash, country: r.country,
        bets: r.bets, volume: round2(r.volume), payout: round2(r.payout),
        rtp: share(r.payout, r.volume),
        wins: r.wins, winrate: share(r.wins, r.bets),
        sessions: r.sessions, playtimeMs: r.playtime, lastSeen: r.lastSeen,
      })),
    });
  });

  /* ── 2. МНОЖИТЕЛИ УРОВНЯ РАУНДА ─────────────────────────────────────
     MAX и AVG глобального crash_point за окно — по времени КРАША раунда
     (rounds.crashed_at), а не по времени ставки. */
  routes.set('multiplier-stats', (req, res, url) => {
    const w = windowOf(url);
    if (!w) return badPeriod(res);
    const r = sql(`SELECT COUNT(*) AS rounds,
                          MAX(${CRASH_X100}) AS mx,
                          AVG(${CRASH_X100}) AS av,
                          SUM(CASE WHEN crash_point = 0 THEN 1 ELSE 0 END) AS busts
                   FROM rounds WHERE crashed_at >= ? AND crashed_at <= ?`).get(w.from, w.to);
    json(res, 200, {
      period: w.period, from: w.from, to: w.to,
      rounds: r.rounds,
      max: r.rounds ? round2(r.mx / 100) : null,
      avg: r.rounds ? +(r.av / 100).toFixed(4) : null,
      instantBusts: r.busts || 0,            // мгновенные ×1.00, они же crash_point = 0
    });
  });

  /* ── 3. RTP ────────────────────────────────────────────────────────
     Фактический — по ставкам окна; теоретический отдаётся константой. */
  routes.set('rtp', (req, res, url) => {
    const w = windowOf(url);
    if (!w) return badPeriod(res);
    const r = sql(`SELECT COUNT(*) AS bets,
                          COALESCE(SUM(amount), 0) AS volume,
                          COALESCE(SUM(payout), 0) AS payout
                   FROM bets WHERE created_at >= ? AND created_at <= ? AND is_bot = 0`).get(w.from, w.to);
    json(res, 200, {
      period: w.period, from: w.from, to: w.to,
      bets: r.bets, volume: round2(r.volume), payout: round2(r.payout),
      actualRtp: share(r.payout, r.volume),
      theoreticalRtp: THEORETICAL_RTP,
    });
  });

  /* ── 4. ИСПОЛЬЗОВАНИЕ ЛАМПЫ ────────────────────────────────────────
     а) доля ставок хотя бы с одним OFF против «лампа провисела ON весь раунд»;
     б) средний процент израсходованных переключений из MAX_SWITCHES.
     Оба считаются по готовым колонкам bets, а не агрегацией lamp_events:
     switches_used тождественно равен числу ON-событий с src != 'free'
     (бесплатный старт переключение не тратит), проверено на данных прода. */
  routes.set('lamp-usage', (req, res, url) => {
    const w = windowOf(url);
    if (!w) return badPeriod(res);
    const r = sql(`SELECT COUNT(*) AS bets,
                          COALESCE(SUM(had_off), 0) AS withOff,
                          COALESCE(SUM(switches_used), 0) AS switches
                   FROM bets WHERE created_at >= ? AND created_at <= ? AND is_bot = 0`).get(w.from, w.to);
    const withoutOff = r.bets - r.withOff;
    const avgSwitches = r.bets ? r.switches / r.bets : null;
    json(res, 200, {
      period: w.period, from: w.from, to: w.to,
      bets: r.bets,
      withOff: r.withOff,
      withoutOff,                                     // лампа горела до самого краша
      shareWithOff: share(r.withOff, r.bets),
      shareWithoutOff: share(withoutOff, r.bets),
      avgSwitchesUsed: round4(avgSwitches),
      avgSwitchUsage: avgSwitches === null ? null : +(avgSwitches / MAX_SWITCHES).toFixed(6),
      maxSwitches: MAX_SWITCHES,
    });
  });

  /* ── 5. ПРОНИКНОВЕНИЕ АВТОПИЛОТА ───────────────────────────────────
     Две РАЗНЫЕ величины, обе нужны и обе есть готовыми колонками:
       auto_switches > 0 — автопилот реально дёрнул лампу (= есть событие
         lamp_events с src='auto');
       auto_bet = 1      — ставка сделана при включённом автопилоте, но раунд
         мог рухнуть раньше первой ступени, и тогда переключений не было.
     Смешивать их нельзя: первая мерит применение, вторая — намерение. */
  routes.set('autopilot-adoption', (req, res, url) => {
    const w = windowOf(url);
    if (!w) return badPeriod(res);
    const r = sql(`SELECT COUNT(*) AS bets,
                          SUM(CASE WHEN auto_switches > 0 THEN 1 ELSE 0 END) AS withAutoSwitch,
                          COALESCE(SUM(auto_bet), 0) AS withAutopilotOn,
                          COALESCE(SUM(auto_switches), 0) AS autoSwitches
                   FROM bets WHERE created_at >= ? AND created_at <= ? AND is_bot = 0`).get(w.from, w.to);
    const withAuto = r.withAutoSwitch || 0;
    json(res, 200, {
      period: w.period, from: w.from, to: w.to,
      bets: r.bets,
      withAutoSwitch: withAuto,
      fullyManual: r.bets - withAuto,                 // только free/manual за весь раунд
      shareWithAutoSwitch: share(withAuto, r.bets),
      shareFullyManual: share(r.bets - withAuto, r.bets),
      withAutopilotEnabled: r.withAutopilotOn,
      shareWithAutopilotEnabled: share(r.withAutopilotOn, r.bets),
      /* переключения, выполненные автопилотом, — это события ON И OFF, тогда как
         switches_used считает только ON, поэтому доли одного от другого тут нет:
         величины в разных единицах, и их отношение ничего не значит */
      autoSwitches: r.autoSwitches,
    });
  });

  /* ── 6. ЛИЧНЫЙ МНОЖИТЕЛЬ ПРОТИВ ФИНАЛА РАУНДА ──────────────────────
     Два блока по согласованию, потому что это разные вопросы:
       cashoutVsCrash — где игрок нажал OFF против того, где раунд рухнул
         («рано ли вышел»); строки без единого OFF сюда не входят, у них
         cashout_mult = NULL;
       finalVsCrash  — выплатной множитель против пика («сколько в итоге взял»).
     Категории берутся из готового bets.win, заново не пересчитываются. */
  routes.set('personal-vs-crash', (req, res, url) => {
    const w = windowOf(url);
    if (!w) return badPeriod(res);
    const where = 'created_at >= ? AND created_at <= ? AND is_bot = 0';
    /* внешние скобки обязательны: без них «cashout_mult / crash» разворачивается
       в (cashout_mult / crash_point) / 100 — деление левоассоциативно */
    const crash = `((${CRASH_X100}) / 100.0)`;
    const g = sql(`SELECT COUNT(*) AS bets, COALESCE(SUM(win), 0) AS wins
                   FROM bets WHERE ${where}`).get(w.from, w.to);
    const a = sql(`SELECT COUNT(*) AS bets, AVG(cashout_mult) AS avgCashout, AVG(${crash}) AS avgCrash,
                          AVG(cashout_mult - ${crash}) AS avgDev, AVG(cashout_mult / ${crash}) AS avgRatio
                   FROM bets WHERE ${where} AND cashout_mult IS NOT NULL`).get(w.from, w.to);
    const b = sql(`SELECT COUNT(*) AS bets, AVG(final_mult) AS avgFinal, AVG(${crash}) AS avgCrash,
                          AVG(final_mult - ${crash}) AS avgDev
                   FROM bets WHERE ${where}`).get(w.from, w.to);
    const busted = g.bets - g.wins;
    json(res, 200, {
      period: w.period, from: w.from, to: w.to,
      bets: g.bets,
      distribution: {
        cashedOut: g.wins,                            // зафиксировались раньше пика
        busted,                                       // держали до краша и сгорели
        cashedOutShare: share(g.wins, g.bets),
        bustedShare: share(busted, g.bets),
      },
      cashoutVsCrash: {
        bets: a.bets,
        avgCashoutMult: round4(a.avgCashout),
        avgCrashMult: round4(a.avgCrash),
        avgDeviation: round4(a.avgDev),               // < 0 — вышел раньше пика
        avgRatio: round4(a.avgRatio),                 // доля пика, взятая игроком
      },
      finalVsCrash: {
        bets: b.bets,
        avgFinalMult: round4(b.avgFinal),
        avgCrashMult: round4(b.avgCrash),
        avgDeviation: round4(b.avgDev),
      },
    });
  });

  async function handle(req, res, url){
    if (!url.pathname.startsWith('/api/dashboard/')) return false;

    if (!enabled){
      json(res, 503, { error: 'dashboard_disabled',
                       hint: 'задайте DASHBOARD_PASSWORD в backend/.env и перезапустите бэкенд' });
      return true;
    }

    const path = url.pathname.slice('/api/dashboard/'.length);

    if (path === 'login'){
      if (req.method !== 'POST') json(res, 405, { error: 'method_not_allowed' });
      else await handleLogin(req, res);
      return true;
    }

    const session = checkToken(req);
    if (!session){
      res.setHeader('WWW-Authenticate', 'Bearer realm="volta-dashboard"');
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    if (path === 'logout'){
      if (req.method !== 'POST') json(res, 405, { error: 'method_not_allowed' });
      else { tokens.delete(session.token); json(res, 200, { ok: true }); }
      return true;
    }
    if (path === 'me'){
      json(res, 200, { ok: true, expiresAt: session.expiresAt });
      return true;
    }

    const route = routes.get(path);
    if (!route){ json(res, 404, { error: 'unknown_endpoint' }); return true; }
    if (req.method !== 'GET'){ json(res, 405, { error: 'method_not_allowed' }); return true; }

    try {
      route(req, res, url, session);
    } catch (e) {
      console.error(`dashboard ${path} failed:`, e.message);
      json(res, 500, { error: 'internal_error' });      // наружу — без деталей
    }
    return true;
  }

  return { handle, enabled, routes, db, json, windowOf, PERIODS };
}

module.exports = { createDashboard };
