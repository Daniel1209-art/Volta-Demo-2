/* Разблокировка звуковых ЭФФЕКТОВ первым тапом по любому месту интерфейса.
 *
 * Регрессия на баг: AudioContext создавался при ЗАГРУЗКЕ страницы, вне жеста.
 * На iOS Safari такой контекст после resume() рапортует state:'running', но
 * остаётся немым — эффекты не слышны, сколько ни тапай, а музыка при этом
 * играет, потому что идёт отдельным <audio> мимо контекста. Теперь контекст
 * рождается на первом касании (sndInit(true)), а при загрузке только
 * предзагружаются сэмплы (sndPrefetch).
 *
 * Успех = до тапа контекста НЕТ; после ОДНОГО тапа по нейтральному месту
 * (логотип, не тумблер звука) контекст running и на шине мастера есть
 * измеримый сигнал.
 *
 * Движок: Chromium с --autoplay-policy=user-gesture-required — это настоящая
 * политика браузера, а не заглушка. WebKit из Playwright здесь непригоден: в
 * его сборке под Windows нет window.AudioContext вообще (см. music-volume.js).
 * Поэтому финальная проверка на живом iPhone всё равно обязательна.
 *
 *   node sfx-unlock.js
 *   TARGET=http://localhost:8105 node sfx-unlock.js
 */
const { chromium, devices } = require('playwright');

const URL = process.env.TARGET || 'https://volta-demo.com';
const fail = msg => { console.error('ПРОВАЛ: ' + msg); process.exitCode = 1; };

/* меряем пик на шине мастера эффектов: врезаем анализатор и слушаем, что реально
   выходит из графа — это доказательство звука, а не рапорт «состояние running» */
const PROBE = async (name) => {
  const an = SND.ctx.createAnalyser(); an.fftSize = 2048;
  SND.master.connect(an);
  const data = new Float32Array(an.fftSize);
  const peakOver = async (ms) => { let peak = 0; const t0 = performance.now();
    while (performance.now() - t0 < ms){ an.getFloatTimeDomainData(data);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      await new Promise(r => setTimeout(r, 10)); }
    return +peak.toFixed(4); };
  const silence = await peakOver(150);
  sfx(name);
  const sound = await peakOver(500);
  SND.master.disconnect(an);
  return { silence, sound };
};

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  if (!/^https:\/\/volta-demo\.com/.test(URL)) {
    const path = require('path'), fs = require('fs');
    const engine = path.join(__dirname, '..', '..', 'shared', 'engine.js');
    if (fs.existsSync(engine))
      await page.route('**/shared/engine.js', r =>
        r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(engine, 'utf8') }));
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // ── 1. до жеста контекста быть не должно, но сэмплы уже скачаны
  const before = await page.evaluate(() => ({
    ctx: !!SND.ctx, ctxState: SND.ctx ? SND.ctx.state : null,
    prefetched: SND.raw ? Object.keys(SND.raw).length : null, total: SND.names.length,
  }));
  console.log('до тапа:', JSON.stringify(before));
  if (before.ctx)
    fail(`AudioContext создан ДО жеста (state:${before.ctxState}) — именно из-за этого на iOS он остаётся немым`);
  if (before.prefetched === null)
    fail('SND.raw отсутствует — предзагрузки сэмплов нет, значит контекст создаётся при загрузке по-старому');
  else if (before.prefetched !== before.total)
    fail(`предзагружено ${before.prefetched} из ${before.total} сэмплов — к первому тапу звук будет не готов`);

  // ── 2. ОДИН тап по нейтральному месту (логотип), тумблер звука не трогаем
  await page.locator('.logo-wm').tap();
  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => ({
    ctx: SND.ctx ? SND.ctx.state : null, ready: SND.ready,
    decoded: Object.keys(SND.buf).length,
    fromFile: Object.values(SND.src).filter(v => v === 'file').length,
  }));
  console.log('после одного тапа по логотипу:', JSON.stringify(after));
  if (after.ctx !== 'running') return fail('контекст не запустился после тапа: ' + after.ctx), browser.close();
  if (!after.ready) return fail('сэмплы не готовы после тапа'), browser.close();
  if (after.fromFile !== before.total)
    fail(`из файлов декодировано ${after.fromFile} из ${before.total} — предзагруженные данные потерялись`);

  // ── 3. главное: на шине мастера реально есть сигнал
  /* Базовый уровень НЕ обязан быть нулём: если на проде идёт раунд, по шине
     непрерывно идёт гул напряжения (voltage_loop). Поэтому проверяем, что
     эффект поднимает уровень НАД фоном, а не что до него была тишина. */
  const bet = await page.evaluate(PROBE, 'bet');
  console.log('эффект bet:', JSON.stringify(bet));
  if (bet.sound < 0.05) fail(`эффект не дал звука (пик ${bet.sound}) — граф немой`);
  else if (bet.sound <= bet.silence + 0.03)
    fail(`эффект не поднял уровень над фоном (фон ${bet.silence}, с эффектом ${bet.sound})`);
  else console.log(`OK: после ОДНОГО тапа по логотипу эффект звучит, пик ${bet.sound} при фоне ${bet.silence}`);

  // ── 4. тумблер эффектов глушит именно эффекты и не трогает музыку
  const off = await page.evaluate(async () => {
    window.sndSetEnabled(false);
    await new Promise(r => setTimeout(r, 250));
    return { musPlaying: MUS.el ? !MUS.el.paused : null };
  });
  const offPeak = await page.evaluate(PROBE, 'bet');
  await page.evaluate(async () => { window.sndSetEnabled(true); await new Promise(r => setTimeout(r, 250)); });
  const onPeak = await page.evaluate(PROBE, 'bet');
  console.log('тумблер эффектов off/on:', JSON.stringify({ off: offPeak.sound, on: onPeak.sound, ...off }));
  if (offPeak.sound > 0.01) fail('эффекты звучат при выключенном тумблере');
  if (onPeak.sound < 0.05) fail('эффекты не вернулись после включения тумблера');

  if (errors.length) fail('ошибки JS: ' + errors.join(' | '));
  await browser.close();
})();
