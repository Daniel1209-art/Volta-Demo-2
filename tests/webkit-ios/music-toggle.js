/* Тумблер музыки на движке Safari (WebKit), iPhone-вьюпорт.
 *
 * Регрессия на баг: pause() был колбэком в конце фейда громкости, поэтому
 * музыка доигрывала ~334 мс после переключения (а на iOS, где volume только
 * для чтения, фейд не завершался никогда и пауза не наступала вовсе).
 * Успех = paused и muted выставлены В ТОМ ЖЕ ТИКЕ, без ожидания.
 *
 *   node music-toggle.js
 *   TARGET=http://localhost:8097 node music-toggle.js
 */
const { webkit, devices } = require('playwright');

const URL = process.env.TARGET || 'https://volta-demo.com';
const fail = msg => { console.error('ПРОВАЛ: ' + msg); process.exitCode = 1; };

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  /* На проде nginx отдаёт /shared/ алиасом, у простого локального сервера этого
     нет — подставляем файл с диска, иначе скрипт страницы падает на старте. */
  if (!/^https:\/\/volta-demo\.com/.test(URL)) {
    const path = require('path'), fs = require('fs');
    const engine = path.join(__dirname, '..', '..', 'shared', 'engine.js');
    if (fs.existsSync(engine))
      await page.route('**/shared/engine.js', r =>
        r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(engine, 'utf8') }));
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // первый жест — снимает autoplay-блокировку
  const hint = page.locator('#sndHint');
  if (await hint.isVisible()) await hint.tap();
  else await page.locator('.logo-wm').tap();      // любой тап снимает блокировку
  await page.waitForTimeout(400);

  await page.locator('.info-btn[for="sndToggle"]').tap();
  await page.waitForTimeout(400);

  // добиться того, чтобы музыка реально играла
  let playing = false;
  for (let i = 0; i < 4 && !playing; i++) {
    playing = await page.evaluate(() => !window.musEl().paused);
    if (playing) break;
    await page.locator('#musEnable').locator('xpath=..').tap();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1000);
  if (!await page.evaluate(() => !window.musEl().paused))
    return fail('не удалось запустить музыку — проверка выключения невозможна'), browser.close();

  // выключение: состояние читаем СРАЗУ после dispatch, в том же тике
  const res = await page.evaluate(() => {
    const el = window.musEl();
    const t0 = performance.now();
    const cb = document.getElementById('musEnable');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return { pausedImmediately: el.paused, mutedImmediately: el.muted,
             ms: Math.round(performance.now() - t0) };
  });
  console.log('сразу после переключения:', JSON.stringify(res));

  if (!res.pausedImmediately) fail('музыка не встала на паузу синхронно (доигрывает после тумблера)');
  else if (!res.mutedImmediately) fail('muted не выставлен синхронно — на iOS громкость иначе не заглушить');
  else console.log(`OK: пауза и mute выставлены за ${res.ms} мс, без ожидания фейда`);

  // включение обратно должно снимать mute
  await page.locator('#musEnable').locator('xpath=..').tap();
  await page.waitForTimeout(1500);
  const back = await page.evaluate(() => ({ paused: window.musEl().paused, muted: window.musEl().muted }));
  console.log('после обратного включения:', JSON.stringify(back));
  if (back.muted) fail('после включения музыка осталась заглушённой (muted не снят)');

  if (errors.length) fail('ошибки JS: ' + errors.join(' | '));
  await browser.close();
})();
