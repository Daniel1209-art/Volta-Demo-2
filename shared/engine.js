/* ═══════════════════════════════════════════════════════════════════
   VOLTA — SHARED CRASH ENGINE (клиент + сервер)
   Математика перенесена 1-в-1 из монолитного frontend/index.html:
   константы, двухфазная кривая роста, crash-point из HMAC-SHA256.
   Подключается и в Node (backend/server.js), и в браузере
   (<script src="shared/engine.js"> → window.VoltaEngine) — один и тот
   же код, поэтому серверный таймлайн и клиентский рендер совпадают.
   НЕ МЕНЯТЬ формулы и константы: от них зависят RTP и тайминги.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoltaEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── BUSTABIT CONSTANTS ─────────────────────────────────────────── */
  const TICK_RATE      = 150;
  const AFTER_CRASH_MS = 3000;
  const RESTART_MS     = 5000;
  const CLIENT_SEED    = '000000000000000007a9a31ff7f07463d91af6b5454241d5faf282e5e0fe1b3a';
  const MAX_SWITCHES   = 4;
  const MAX_BET        = 100;      // максимальная ставка игрока — $100
  const DISPLAY_TICK   = 50;

  /* ── ПОТОЛКИ ────────────────────────────────────────────────────────
     Это НЕ часть provably-fair математики: честный результат считается
     формулой ниже без изменений, потолок применяется ПОВЕРХ него
     последним шагом. Поэтому и сервер, и кнопка Verify обязаны звать
     ОДНУ И ТУ ЖЕ функцию clampCrash — иначе Verify покажет Mismatch на
     редких раундах выше потолка. Второй реализации потолка в проекте
     быть не должно. */
  const MAX_CRASH_MULTIPLIER = 10000;                        // потолок множителя раунда, ×
  const MAX_CRASH_X100       = MAX_CRASH_MULTIPLIER * 100;   // тот же потолок в единицах crash-point (×100)
  function clampCrash(x100){                                  // 0 (мгновенный краш) ниже потолка — не трогается
    return x100 > MAX_CRASH_X100 ? MAX_CRASH_X100 : x100;
  }

  /* Потолок ВЫПЛАТЫ — принципиально другой шаг: он применяется ПОСЛЕ того,
     как честный личный множитель уже вычислен и показан игроку. Множитель
     на экране, в истории раундов и в Provably Fair НЕ искажается — режется
     только итоговая сумма к зачислению, и UI обязан сказать об этом явно. */
  const MAX_PAYOUT_USD = 10000;                              // потолок выплаты за раунд, $
  function capPayout(usd){
    return usd > MAX_PAYOUT_USD ? MAX_PAYOUT_USD : usd;
  }

  /* ── TWO-PHASE GROWTH (RTP-neutral; only stretches the early zone) ── */
  const R1 = 0.00003, T0 = 7000, R0 = 0.00006;
  const MJOIN = Math.exp(R1 * T0);

  function growthFunc(ms){
    if (ms <= 0) return 100;
    const M = ms <= T0 ? Math.exp(R1 * ms) : MJOIN * Math.exp(R0 * (ms - T0));
    return Math.floor(100 * M);
  }
  function inverseGrowth(result){
    const M = result / 100;
    if (M <= 1)     return 0;
    if (M <= MJOIN) return Math.log(M) / R1;
    return T0 + Math.log(M / MJOIN) / R0;
  }
  function divisible(hash, mod){
    let val = 0; const o = hash.length % 4;
    for (let i = o > 0 ? o - 4 : 0; i < hash.length; i += 4)
      val = ((val << 16) + parseInt(hash.substring(i, i + 4), 16)) % mod;
    return val === 0;
  }

  /* ── PURE-JS SHA-256 / HMAC-SHA256 ──────────────────────────────────
     Self-contained so the provably-fair core runs anywhere. Same
     algorithm Bustabit uses, so the math is identical. */
  const _K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function _sha256(msg){                                   // Uint8Array → Uint8Array(32)
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
        h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    const l = msg.length, bitLen = l * 8, withOne = l + 1;
    const pad = (56 - (withOne % 64) + 64) % 64, total = withOne + pad + 8;
    const m = new Uint8Array(total);
    m.set(msg); m[l] = 0x80;
    const lo = bitLen >>> 0, hi = Math.floor(bitLen / 0x100000000);
    m[total-8]=(hi>>>24)&255; m[total-7]=(hi>>>16)&255; m[total-6]=(hi>>>8)&255; m[total-5]=hi&255;
    m[total-4]=(lo>>>24)&255; m[total-3]=(lo>>>16)&255; m[total-2]=(lo>>>8)&255; m[total-1]=lo&255;
    const w = new Uint32Array(64);
    for (let i = 0; i < total; i += 64){
      for (let t = 0; t < 16; t++)
        w[t] = (m[i+t*4]<<24)|(m[i+t*4+1]<<16)|(m[i+t*4+2]<<8)|m[i+t*4+3];
      for (let t = 16; t < 64; t++){
        const s0 = rotr(w[t-15],7)^rotr(w[t-15],18)^(w[t-15]>>>3);
        const s1 = rotr(w[t-2],17)^rotr(w[t-2],19)^(w[t-2]>>>10);
        w[t] = (w[t-16]+s0+w[t-7]+s1)|0;
      }
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
      for (let t = 0; t < 64; t++){
        const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25), ch = (e&f)^((~e)&g);
        const t1 = (h+S1+ch+_K[t]+w[t])|0;
        const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22), maj = (a&b)^(a&c)^(b&c);
        const t2 = (S0+maj)|0;
        h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
      }
      h0=(h0+a)|0; h1=(h1+b)|0; h2=(h2+c)|0; h3=(h3+d)|0;
      h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0;
    }
    const out = new Uint8Array(32);
    [h0,h1,h2,h3,h4,h5,h6,h7].forEach((v,i)=>{
      out[i*4]=(v>>>24)&255; out[i*4+1]=(v>>>16)&255; out[i*4+2]=(v>>>8)&255; out[i*4+3]=v&255; });
    return out;
  }
  function _hmac(key, msg){                                // Uint8Array, Uint8Array → Uint8Array(32)
    if (key.length > 64) key = _sha256(key);
    const ip = new Uint8Array(64), op = new Uint8Array(64);
    for (let i = 0; i < 64; i++){ const k = i < key.length ? key[i] : 0; ip[i]=k^0x36; op[i]=k^0x5c; }
    const inner = new Uint8Array(64 + msg.length); inner.set(ip); inner.set(msg, 64);
    const ih = _sha256(inner);
    const outer = new Uint8Array(96); outer.set(op); outer.set(ih, 64);
    return _sha256(outer);
  }
  const _enc = new TextEncoder();
  const _hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

  /* Crash-point из HMAC-SHA256. КЛЮЧ — секретный serverSeed (зафиксирован
     хэшем до раунда), СООБЩЕНИЕ — client seed. Формула (divisible + деление)
     НЕ менялась: она проаудирована. Изменился только ИСТОЧНИК client seed —
     раньше это была одна зашитая константа CLIENT_SEED, теперь передаётся
     склейка seed-ов реальных игроков раунда (см. combineClientSeeds). При
     отсутствии аргумента поведение прежнее (константа) — обратная совместимость.
     RTP не зависит от client seed: при случайном serverSeed выход HMAC
     равномерен для любого фиксированного сообщения.
     ПОСЛЕДНИМ шагом — clampCrash: сама формула не изменилась, потолок
     накладывается на уже посчитанный честный результат. */
  function crashPointFromHash(serverSeed, clientSeed){
    const cs = clientSeed == null ? CLIENT_SEED : clientSeed;
    const hash = _hex(_hmac(_enc.encode(serverSeed), _enc.encode(cs)));
    if (divisible(hash, 40)) return 0;
    const h = parseInt(hash.slice(0, 13), 16), e = Math.pow(2, 52);
    return clampCrash(Math.floor((100 * e - h) / (e - h)));
  }

  /* Детерминированный порядок client seed-ов, выведенный из уже
     ЗАФИКСИРОВАННОГО serverSeed. Для игрока он «случайный» (до краша игрок
     видит только sha256(serverSeed)), но сервер его НЕ может грайндить —
     serverSeed связан хэш-commit'ом. Порядок полностью воспроизводим кнопкой
     Verify. Fisher–Yates, индекс шага берётся из sha256(serverSeed|i). */
  function orderBySeed(seeds, serverSeed){
    const a = seeds.slice();
    for (let i = a.length - 1; i > 0; i--){
      const h = _hex(_sha256(_enc.encode(serverSeed + '|' + i)));
      const j = parseInt(h.slice(0, 8), 16) % (i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  /* Склейка упорядоченных client seed-ов в одно сообщение HMAC. Разделитель
     '-' фиксирован, чтобы серверный расчёт и клиентская проверка совпадали. */
  function combineClientSeeds(seeds){ return seeds.join('-'); }
  function sha256hex(msg){ return _hex(_sha256(_enc.encode(msg))); }
  function randHex(n = 16){
    const b = new Uint8Array(n);
    const cr = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (cr && cr.getRandomValues) cr.getRandomValues(b);
    else for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
    return _hex(b);
  }

  return {
    TICK_RATE, AFTER_CRASH_MS, RESTART_MS, CLIENT_SEED, MAX_SWITCHES, MAX_BET, DISPLAY_TICK,
    MAX_CRASH_MULTIPLIER, MAX_CRASH_X100, clampCrash,
    MAX_PAYOUT_USD, capPayout,
    R1, T0, R0, MJOIN,
    SYSTEM_SEED: CLIENT_SEED,   // системный seed для однослойной схемы (0 реальных игроков)
    MAX_SEEDS: 5,               // максимум client seed-ов от реальных игроков в раунде
    growthFunc, inverseGrowth, divisible, crashPointFromHash, sha256hex, randHex,
    orderBySeed, combineClientSeeds,
  };
});
