/* АВТОЗАПУСК ЭФФЕКТОВ БЕЗ ЖЕСТА там, где браузер РЕАЛЬНО разрешает autoplay.
 *
 * Пара к sfx-unlock.js. Тот проверяет ЗАБЛОКИРОВАННЫЙ браузер (эффекты ждут
 * первого тапа). Этот — РАЗРЕШЁННЫЙ: Chromium с --autoplay-policy=no-user-
 * gesture-required. Здесь sndAutostart обязан:
 *   • создать контекст при загрузке,
 *   • по currentTime убедиться, что аудио-часы реально идут (а не «running,
 *     но немой», как врёт iOS вне жеста),
 *   • ПРИНЯТЬ контекст и декодировать сэмплы — всё БЕЗ единого клика.
 * Успех = до любого жеста ctx:'running', ready, currentTime растёт, и sfx()
 * поднимает уровень на шине мастера.
 *
 * currentTime-пробу нельзя проверить на живучесть в Chromium (он не врёт про
 * running, как iOS) — поэтому здесь мы доказываем ПОЛОЖИТЕЛЬНУЮ ветку (autoplay
 * разрешён → звук идёт сразу), а отрицательную (blocked → ждём тап) держит
 * sfx-unlock.js. Немоту именно iOS воспроизвести можно только на устройстве.
 *
 *   node sfx-autostart.js
 *   TARGET=http://localhost:8105 node sfx-autostart.js
 */
const { chromium } = require('playwright');
const URL = process.env.TARGET || 'https://volta-demo.com';
const fail = m => { console.error('ПРОВАЛ: ' + m); process.exitCode = 1; };

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);   // проба автозапуска (240мс) + декод, БЕЗ клика

  const st = await page.evaluate(async () => {
    const t0 = SND.ctx ? SND.ctx.currentTime : null;
    await new Promise(r => setTimeout(r, 200));
    let probe = null;
    if (SND.ctx && SND.master && SND.ready) {
      const an = SND.ctx.createAnalyser(); an.fftSize = 2048; SND.master.connect(an);
      const d = new Float32Array(an.fftSize);
      const peak = async ms => { let p = 0, t = performance.now();
        while (performance.now() - t < ms) { an.getFloatTimeDomainData(d);
          for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
          await new Promise(r => setTimeout(r, 10)); } return +p.toFixed(4); };
      const silence = await peak(120); sfx('bet'); const sound = await peak(400);
      SND.master.disconnect(an); probe = { silence, sound };
    }
    return { autostarted: SND.autostarted, ctx: SND.ctx ? SND.ctx.state : null,
      advancing: SND.ctx ? SND.ctx.currentTime > t0 : null, ready: SND.ready,
      fromFile: Object.values(SND.src).filter(v => v === 'file').length,
      total: SND.names.length, probe };
  });
  console.log('БЕЗ клика, autoplay разрешён:', JSON.stringify(st));

  if (st.ctx !== 'running') fail('контекст не принят при загрузке: ' + st.ctx);
  if (!st.advancing) fail('currentTime не идёт — контекст не звучит (проба должна была его отбросить)');
  if (!st.ready) fail('сэмплы не готовы');
  if (st.fromFile !== st.total) fail(`из файла декодировано ${st.fromFile} из ${st.total}`);
  if (!st.probe || st.probe.sound <= st.probe.silence + 0.03)
    fail(`эффект не поднял уровень над фоном (фон ${st.probe && st.probe.silence}, звук ${st.probe && st.probe.sound})`);
  else console.log(`OK: эффекты автозапустились на загрузке БЕЗ жеста, пик ${st.probe.sound} при фоне ${st.probe.silence}`);

  if (errors.length) fail('ошибки JS: ' + errors.join(' | '));
  await browser.close();
})();
