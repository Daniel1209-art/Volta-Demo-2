/* Ползунок громкости музыки на движке Safari (WebKit), iPhone-вьюпорт.
 *
 * Регрессия на баг: громкость музыки менялась через HTMLMediaElement.volume,
 * а на iOS Safari это свойство фактически только для чтения (громкость там
 * меняют лишь аппаратные кнопки) → ползунок музыки на iPhone был мёртвым.
 * Теперь <audio> идёт через createMediaElementSource → собственный GainNode →
 * destination, и громкость задаётся гейном. Успех = гейн реально меняется,
 * el.volume при этом равен 1, а гейн музыки НЕ связан с мастером эффектов.
 *
 *   node music-volume.js
 *   TARGET=http://localhost:8105 node music-volume.js
 */
const { webkit, devices } = require('playwright');

const URL = process.env.TARGET || 'https://volta-demo.com';
const fail = msg => { console.error('ПРОВАЛ: ' + msg); process.exitCode = 1; };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  /* на проде nginx отдаёт /shared/ алиасом, локальному серверу это надо подставить */
  if (!/^https:\/\/volta-demo\.com/.test(URL)) {
    const path = require('path'), fs = require('fs');
    const engine = path.join(__dirname, '..', '..', 'shared', 'engine.js');
    if (fs.existsSync(engine))
      await page.route('**/shared/engine.js', r =>
        r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(engine, 'utf8') }));
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // первый жест — будит AudioContext и снимает autoplay-блокировку
  const hint = page.locator('#sndHint');
  if (await hint.isVisible()) await hint.tap();
  else await page.locator('.logo-wm').tap();
  await page.waitForTimeout(600);

  await page.locator('.info-btn[for="sndToggle"]').tap();
  await page.waitForTimeout(400);

  // добиться, чтобы музыка реально играла
  for (let i = 0; i < 4; i++) {
    if (await page.evaluate(() => !window.musEl().paused)) break;
    await page.locator('#musEnable').locator('xpath=..').tap();
    await page.waitForTimeout(1500);
  }
  if (!await page.evaluate(() => !window.musEl().paused))
    return fail('музыка не запустилась — проверка громкости невозможна'), browser.close();

  /* ВАЖНО: headless-WebKit из Playwright на Windows вообще НЕ имеет Web Audio
     (window.AudioContext отсутствует). Там проверять нечего — работает
     запасной путь el.volume; сам граф проверяется в Chrome и на устройстве. */
  if (!await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext))) {
    console.log('ПРОПУСК: в этой сборке WebKit нет Web Audio — граф музыки проверить нельзя.');
    console.log('Проверяю только запасной путь: громкость должна идти через el.volume.');
    const fb = await page.evaluate(() => {
      window.musSetVolume(30);
      return { elVolume: +musEl().volume.toFixed(2), gain: !!MUS.gain };
    });
    console.log('фолбэк:', JSON.stringify(fb));
    if (fb.gain) fail('гейн создан без Web Audio — так быть не может');
    if (!near(fb.elVolume, 0.3)) fail('запасной путь el.volume не сработал: ' + fb.elVolume);
    if (errors.length) fail('ошибки JS: ' + errors.join(' | '));
    if (!process.exitCode) console.log('OK (частично): запасной путь исправен');
    return void browser.close();
  }

  // ── 1. музыка должна идти через Web Audio, а не через el.volume
  const graph = await page.evaluate(() => {
    window.musSetVolume(60);                       // движение ползунка подключает граф
    return { hasGain: !!MUS.gain, hasNode: !!MUS.node,
             elVolume: musEl().volume, ctxState: SND.ctx && SND.ctx.state };
  });
  console.log('граф:', JSON.stringify(graph));
  if (!graph.hasGain || !graph.hasNode)
    return fail('музыка НЕ подключена к Web Audio — на iOS громкость останется неуправляемой'),
           browser.close();
  if (!near(graph.elVolume, 1))
    fail('при живом графе el.volume должен быть 1 (громкость целиком на гейне), получено ' + graph.elVolume);

  // ── 2. ползунок реально двигает гейн
  const steps = [];
  for (const v of [20, 80, 0, 50]) {
    steps.push(await page.evaluate(pct => {
      const sl = document.getElementById('musVol');
      sl.value = pct;
      sl.dispatchEvent(new Event('input', { bubbles: true }));   // как настоящее перетаскивание
      return { pct, gain: +MUS.gain.gain.value.toFixed(3), elVolume: musEl().volume };
    }, v));
  }
  console.log('ползунок:', JSON.stringify(steps));
  for (const s of steps)
    if (!near(s.gain, s.pct / 100)) fail(`ползунок ${s.pct}% → гейн ${s.gain}, ожидался ${s.pct / 100}`);

  // ── 3. независимость от эффектов: выключение SFX не трогает музыку
  const indep = await page.evaluate(async () => {
    const before = +MUS.gain.gain.value.toFixed(3);
    window.sndSetEnabled(false);
    await new Promise(r => setTimeout(r, 300));
    const afterOff = { mus: +MUS.gain.gain.value.toFixed(3), musPlaying: !musEl().paused,
                       sfxMaster: +SND.master.gain.value.toFixed(3) };
    window.sndSetEnabled(true);
    await new Promise(r => setTimeout(r, 300));
    return { before, afterOff, sameNode: MUS.gain !== SND.master };
  });
  console.log('независимость от эффектов:', JSON.stringify(indep));
  if (!indep.sameNode) fail('гейн музыки совпадает с мастером эффектов — тумблеры будут глушить друг друга');
  if (!near(indep.afterOff.mus, indep.before)) fail('выключение эффектов изменило громкость музыки');
  if (!indep.afterOff.musPlaying) fail('выключение эффектов остановило музыку');

  // ── 4. смена трека без перезагрузки + громкость сохраняется в localStorage
  const track = await page.evaluate(async () => {
    const before = musEl().src;
    window.musSelectTrack('Volta Circuit 1');
    await new Promise(r => setTimeout(r, 1200));
    return { changed: musEl().src !== before, playing: !musEl().paused,
             saved: JSON.parse(localStorage.getItem('volta_mus') || '{}') };
  });
  console.log('смена трека:', JSON.stringify(track));
  if (!track.changed) fail('трек не сменился');
  if (!track.playing) fail('после смены трека музыка не играет');
  if (!near(track.saved.vol, 0.5)) fail('громкость не сохранилась в localStorage: ' + JSON.stringify(track.saved));

  // ── 5. настройки восстанавливаются после перезагрузки
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const restored = await page.evaluate(() => ({ vol: MUS.vol, slider: +document.getElementById('musVol').value }));
  console.log('после перезагрузки:', JSON.stringify(restored));
  if (!near(restored.vol, 0.5) || restored.slider !== 50) fail('громкость не восстановилась после перезагрузки');

  if (errors.length) fail('ошибки JS: ' + errors.join(' | '));
  if (!process.exitCode) console.log('OK: громкость музыки управляется гейном Web Audio и независима от эффектов');
  await browser.close();
})();
