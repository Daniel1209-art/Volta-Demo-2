/* Автопилот на движке Safari (WebKit), iPhone-вьюпорт, локаль ru-RU.
 *
 * Регрессия на баг: поля ступеней были <input type="number">, и на локали с
 * запятой iOS отдавал пустой value → parseFloat = NaN → условие off > 1
 * отбрасывало ВСЕ ступени, автопилот молча не работал. Поэтому здесь значения
 * вводятся именно с запятой, а успехом считается реальное переключение лампы.
 *
 *   node autopilot.js                                (против прода)
 *   TARGET=http://localhost:8097 node autopilot.js   (против локальной сборки)
 */
const { webkit, devices } = require('playwright');

const URL = process.env.TARGET || 'https://volta-demo.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.error('ПРОВАЛ: ' + msg); process.exitCode = 1; };

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // плашка звука перехватывает тапы — убираем, она проверяется отдельно
  await page.evaluate(() => { const h = document.getElementById('sndHint'); if (h) h.remove(); });

  // ── 1. поле ступени должно быть text/decimal, иначе запятая не прочитается
  const field = await page.evaluate(() => {
    const el = document.getElementById('autoOff1');
    return { type: el.type, inputmode: el.getAttribute('inputmode') };
  });
  if (field.type !== 'text' || field.inputmode !== 'decimal')
    fail(`поле ступени должно быть type=text inputmode=decimal, получено ${JSON.stringify(field)}`);

  // ── 2. настройка плана значениями С ЗАПЯТОЙ
  await page.evaluate(() => { document.getElementById('autoToggle').checked = true; });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('autoOff1', '1,10');
    set('autoOn1', '1,20');
    set('autoFinalOff', '1,50');
    for (const n of [2, 3, 4]) {
      const c = document.getElementById('autoStageEn' + n);
      c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const plan = await page.evaluate(() => window.buildAutoActions());
  console.log('план:', JSON.stringify(plan));
  const want = [{ type: 'off', m: 1.1 }, { type: 'on', m: 1.2 }, { type: 'off', m: 1.5 }];
  if (plan.length !== 3 || want.some((w, i) => plan[i].type !== w.type || Math.abs(plan[i].m - w.m) > 1e-9))
    fail('запятая не распарсилась в план автопилота');

  // ── 3. мастер-тумблер настоящим тапом (не программно)
  await page.locator('.auto-head label.toggle').tap();
  await page.waitForTimeout(200);
  if (!await page.evaluate(() => document.getElementById('autoEnable').checked))
    fail('мастер-тумблер autoplay не переключился по тапу');

  await page.evaluate(() => { document.getElementById('autoToggle').checked = false; });
  await page.waitForTimeout(500);

  // ── 4. ставка и наблюдение за лампой в живом раунде.
  // Раунд может крашнуться раньше ×1,20 — это нормальная механика игры, а не
  // баг, поэтому пробуем несколько раундов, пока один не доживёт до второй ступени.
  const at = e => parseFloat(e.at.replace('×', ''));
  let off = null, on = null, ev = [];

  for (let round = 1; round <= 5 && !on; round++) {
    console.log(`— раунд ${round}: жду окно ставок...`);
    await page.waitForFunction(() => !document.getElementById('betBtn').disabled, null, { timeout: 150000 });
    await page.locator('#betBtn').tap();
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      window.__ev = [];
      const svg = document.querySelector('.lamp-svg');
      let last = svg.classList.contains('is-on');
      window.__obs && window.__obs.disconnect();
      window.__obs = new MutationObserver(() => {
        const now = svg.classList.contains('is-on');
        if (now !== last) {
          last = now;
          window.__ev.push({ state: now ? 'ON' : 'OFF',
            at: document.getElementById('multEl').textContent.trim() });
        }
      });
      window.__obs.observe(svg, { attributes: true, attributeFilter: ['class'] });
    });

    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const st = await page.evaluate(() => ({
        ev: window.__ev,
        crashed: document.querySelector('.lamp-card').classList.contains('crashed'),
      }));
      ev = st.ev;
      if (st.crashed || ev.length >= 3) break;
    }
    console.log('  переходы лампы:', JSON.stringify(ev));
    off = off || ev.find(e => e.state === 'OFF' && at(e) >= 1.10);
    on = ev.find(e => e.state === 'ON' && at(e) >= 1.20);
    if (!on) console.log('  раунд закончился до ×1,20 — пробую следующий');
  }

  // лампа должна погаснуть на 1.10 и снова зажечься на 1.20
  if (!off) fail('лампа не погасла на ×1,10 — автопилот не сработал');
  else if (!on) fail('лампа ни разу не зажглась обратно на ×1,20 за 5 раундов');
  else console.log('OK: автопилот отработал ступени, введённые с запятой');

  if (errors.length) fail('ошибки JS: ' + errors.join(' | '));
  await browser.close();
})();
