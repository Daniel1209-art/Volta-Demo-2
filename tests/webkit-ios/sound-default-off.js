/* ЗВУК ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ НА ПЕРВОМ ВИЗИТЕ, СОХРАНЯЕТСЯ ПРИ ВОЗВРАТЕ.
 *
 * Часть 1 — первый визит на «немом» браузере (эмуляция iOS: currentTime заморожен
 *   до доверенного жеста, как в sfx-unlock). localStorage пуст → оба тумблера OFF,
 *   контекст НЕ создаётся, плашки «Tap for sound» нет, тишина. Затем игрок сам
 *   включает тумблер эффектов — этот доверенный тап разблокирует звук.
 * Часть 2 — возврат на сайт (в localStorage сохранён on:true) на браузере с
 *   разрешённым autoplay → музыка и эффекты играют СРАЗУ при загрузке, без клика.
 *
 *   node sound-default-off.js
 *   TARGET=http://localhost:8105 node sound-default-off.js
 */
const { chromium, devices } = require('playwright');
const URL = process.env.TARGET || 'https://volta-demo.com';
let bad = false;
const fail = m => { console.error('ПРОВАЛ: ' + m); bad = true; process.exitCode = 1; };

/* ставит window.__probeBet в странице: анализатор на шине мастера, фон → эффект.
   Передаётся в addInitScript как настоящая функция (сериализуется Playwright),
   без eval/new Function. */
const installProbe = () => {
  window.__probeBet = async () => {
    const an = SND.ctx.createAnalyser(); an.fftSize = 2048; SND.master.connect(an);
    const d = new Float32Array(an.fftSize);
    const peak = async ms => { let p = 0, t = performance.now();
      while (performance.now() - t < ms){ an.getFloatTimeDomainData(d);
        for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
        await new Promise(r => setTimeout(r, 10)); } return +p.toFixed(4); };
    const silence = await peak(120); sfx('bet'); const sound = await peak(400);
    SND.master.disconnect(an); return { silence, sound };
  };
};

(async () => {
  // ── ЧАСТЬ 1: первый визит, немой браузер, включение тумблером ──────────────
  {
    const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
    const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' });
    const page = await ctx.newPage();
    page.on('pageerror', e => fail('PAGEERROR: ' + e.message));
    await page.addInitScript(installProbe);
    await page.addInitScript(() => {
      try { localStorage.removeItem('volta_snd'); localStorage.removeItem('volta_mus'); } catch (e) {}
      let g = false;
      ['pointerdown','touchstart','touchend','mousedown','click','keydown'].forEach(ev =>
        addEventListener(ev, e => { if (e.isTrusted) g = true; }, { capture: true, passive: true }));
      const R = window.AudioContext || window.webkitAudioContext; if (!R) return;
      class T extends R { constructor(...a){ super(...a); this.__p = !g; } get currentTime(){ return (this.__p && !g) ? 0 : super.currentTime; } }
      window.AudioContext = T; window.webkitAudioContext = T;
    });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);

    const first = await page.evaluate(() => ({
      sndOn: SND.on, musOn: MUS.on, ctx: !!SND.ctx, autostarted: SND.autostarted,
      sc: document.getElementById('sndEnable').checked, mc: document.getElementById('musEnable').checked,
      hint: (() => { const h = document.getElementById('sndHint'); return h ? (!h.hidden && !h.classList.contains('hide')) : 'removed'; })(),
    }));
    console.log('первый визит:', JSON.stringify(first));
    if (first.sndOn || first.musOn) fail('на первом визите звук НЕ выключен');
    if (first.sc || first.mc) fail('тумблеры на первом визите не в OFF');
    if (first.ctx) fail('на первом визите создан AudioContext (не должен)');
    if (first.hint === true) fail('на первом визите показана плашка «Tap for sound» (не должна)');

    // реальный путь игрока: открыть панель звука, затем включить тумблер эффектов
    await page.locator('.info-btn[for="sndToggle"]').tap();
    await page.waitForTimeout(400);
    await page.locator('#sndEnable').locator('xpath=..').tap();   // доверенный тап по label
    await page.waitForTimeout(1500);
    const en = await page.evaluate(async () => {
      const probe = (SND.ctx && SND.master && SND.ready) ? await window.__probeBet() : null;
      return { sndOn: SND.on, ctx: SND.ctx ? SND.ctx.state : null, ready: SND.ready, probe };
    });
    console.log('после включения тумблера эффектов:', JSON.stringify(en));
    if (!en.sndOn) fail('тумблер не включил звук');
    if (en.ctx !== 'running') fail('после включения контекст не running: ' + en.ctx);
    if (!en.probe || en.probe.sound <= en.probe.silence + 0.03) fail('после включения нет сигнала эффекта');
    if (!bad) console.log('OK ч.1: первый визит тихий, включение тумблера разблокировало эффекты');
    await browser.close();
  }

  // ── ЧАСТЬ 2: возврат с сохранённым on, autoplay разрешён ───────────────────
  {
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    page.on('pageerror', e => fail('PAGEERROR: ' + e.message));
    await page.addInitScript(installProbe);
    await page.addInitScript(() => { try {
      localStorage.setItem('volta_snd', JSON.stringify({ on: true, vol: 0.8 }));
      localStorage.setItem('volta_mus', JSON.stringify({ on: true, track: 'Lantern Drift 1', vol: 0.5 }));
    } catch (e) {} });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2400);

    const ret = await page.evaluate(async () => {
      const probe = (SND.ctx && SND.master && SND.ready) ? await window.__probeBet() : null;
      return { sndOn: SND.on, musOn: MUS.on, sc: document.getElementById('sndEnable').checked,
        mc: document.getElementById('musEnable').checked, ctx: SND.ctx ? SND.ctx.state : null,
        ready: SND.ready, musPaused: MUS.el ? MUS.el.paused : 'no-el', probe };
    });
    console.log('возврат (сохранён on), autoplay разрешён, БЕЗ клика:', JSON.stringify(ret));
    if (!ret.sndOn || !ret.musOn) fail('сохранённые настройки не восстановлены');
    if (!ret.sc || !ret.mc) fail('тумблеры не отражают восстановлённое on');
    if (ret.ctx !== 'running') fail('эффекты не автозапустились при возврате: ' + ret.ctx);
    if (!ret.probe || ret.probe.sound <= ret.probe.silence + 0.03) fail('нет сигнала эффекта при возврате');
    if (ret.musPaused !== false) fail('музыка не заиграла сразу при возврате (paused=' + ret.musPaused + ')');
    if (!bad) console.log('OK ч.2: возврат с сохранённым on — музыка и эффекты играют сразу, без клика');
    await browser.close();
  }
})();
