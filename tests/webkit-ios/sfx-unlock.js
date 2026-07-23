/* Разблокировка звуковых ЭФФЕКТОВ первым тапом, когда браузер РЕАЛЬНО блокирует
 * автозапуск — или, как iOS Safari, ВРЁТ про running при немом контексте.
 *
 * Option B: при загрузке sndAutostart создаёт контекст и по currentTime проверяет,
 * идут ли аудио-часы. Здесь init-скрипт ЭМУЛИРУЕТ ловушку iOS: у контекста,
 * созданного ДО первого доверенного жеста, currentTime заморожен на 0 (ровно так
 * немой iOS выдаёт «running»). Значит autostart ОБЯЗАН такой контекст отбросить
 * (ctx.close), а первый тап по любому месту — создать свежий рабочий. Тест не
 * зависит от того, как конкретная сборка Chromium трактует autoplay-флаг.
 *
 * Успех = до тапа контекста НЕТ (проба отбросила «немой»), но сэмплы предзагружены;
 * после ОДНОГО тапа по нейтральному месту (логотип, не тумблер) контекст running,
 * currentTime идёт, и на шине мастера есть измеримый сигнал.
 *
 * Положительную ветку (autoplay реально разрешён → звук сразу, без тапа) держит
 * sfx-autostart.js. Немоту именно iOS на железе проверяем только на устройстве.
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

  /* ЭМУЛЯЦИЯ НЕМОГО iOS: у AudioContext, созданного ДО первого доверенного жеста,
     currentTime заморожен на 0 — как на iOS, где контекст «running», но глухой.
     Ровно этот сигнал ловит currentTime-проба в sndAutostart и отбрасывает
     контекст. После жеста новый контекст ведёт себя нормально. */
  await page.addInitScript(() => {
    /* звук по умолчанию ВЫКЛ на первом визите — а этот тест про разблокировку,
       поэтому эмулируем ВОЗВРАТ игрока с сохранённым «звук включён» */
    try {
      localStorage.setItem('volta_snd', JSON.stringify({ on: true, vol: 0.8 }));
      localStorage.setItem('volta_mus', JSON.stringify({ on: true, track: 'Lantern Drift 1', vol: 0.5 }));
    } catch (e) {}
    let gestured = false;
    ['pointerdown','touchstart','touchend','mousedown','click','keydown'].forEach(ev =>
      addEventListener(ev, e => { if (e.isTrusted) gestured = true; }, { capture: true, passive: true }));
    const Real = window.AudioContext || window.webkitAudioContext;
    if (!Real) return;
    class Trap extends Real {
      constructor(...a){ super(...a); this.__pre = !gestured; }   // создан ли ДО жеста
      get currentTime(){ return (this.__pre && !gestured) ? 0 : super.currentTime; }
    }
    window.AudioContext = Trap;
    window.webkitAudioContext = Trap;
  });

  if (!/^https:\/\/volta-demo\.com/.test(URL)) {
    const path = require('path'), fs = require('fs');
    const engine = path.join(__dirname, '..', '..', 'shared', 'engine.js');
    if (fs.existsSync(engine))
      await page.route('**/shared/engine.js', r =>
        r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(engine, 'utf8') }));
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // ── 1. до жеста контекста быть не должно (проба отбросила «немой»), но сэмплы скачаны
  const before = await page.evaluate(() => ({
    ctx: !!SND.ctx, ctxState: SND.ctx ? SND.ctx.state : null, autostarted: SND.autostarted,
    prefetched: SND.raw ? Object.keys(SND.raw).length : null, total: SND.names.length,
  }));
  console.log('до тапа:', JSON.stringify(before));
  if (!before.autostarted)
    fail('sndAutostart не запускался при загрузке — попытки автозапуска нет');
  if (before.ctx)
    fail(`«немой» контекст не отброшен (state:${before.ctxState}) — currentTime-проба не сработала, на iOS звук останется глухим`);
  if (before.prefetched === null)
    fail('SND.raw отсутствует — предзагрузки сэмплов нет');
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
