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

function createDashboard({ dbPath, clientIp, ipHash }){
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

  /* Таблица маршрутов заполняется блоками метрик ниже. Значение —
     функция (req, res, url, session). */
  const routes = new Map();

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
