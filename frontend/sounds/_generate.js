/* VOLTA — генератор звуковых эффектов.
   Синтезирует все эффекты игры в .wav (22050 Гц, моно, 16-бит) рядом со скриптом.
   Запуск:  node _generate.js
   Та же функция renderSfx встроена в VOLTA4-3D.html как fallback для file:// —
   если правишь звук здесь, продублируй правку там (sndRender). */
const fs = require('fs'), path = require('path');
const SR = 22050;

function renderSfx(name){
  const mk  = s => new Float32Array(Math.round(s * SR));
  const rnd = () => Math.random() * 2 - 1;
  const TAU = Math.PI * 2;
  let d;
  if (name === 'lamp_on' || name === 'lamp_off'){
    // щелчок реле + короткий подъём (on) / спад (off)
    const up = name === 'lamp_on';
    d = mk(0.2);
    for (let i = 0; i < SR * 0.01; i++) d[i] += rnd() * Math.exp(-i / (SR * 0.002)) * 0.9;
    let ph = 0;
    for (let i = 0; i < d.length; i++){
      const t = i / SR, k = Math.min(1, t / 0.13);
      const f = up ? 220 + 520 * k : 640 - 460 * k;
      ph += TAU * f / SR;
      d[i] += Math.sin(ph) * Math.exp(-t * 17) * 0.5;
    }
  } else if (name === 'bet'){
    // подтверждающий «динь»: две быстрые ноты
    d = mk(0.18);
    let ph = 0;
    for (let i = 0; i < d.length; i++){
      const t = i / SR, f = t < 0.05 ? 880 : 1318.5;
      ph += TAU * f / SR;
      const seg = t < 0.05 ? t : t - 0.05;
      d[i] = Math.sin(ph) * Math.exp(-seg * 42) * 0.55;
    }
  } else if (name === 'tick' || name === 'tick_hi'){
    // тик отсчёта; tick_hi — выше тоном для 3-2-1
    const f = name === 'tick' ? 1000 : 1480;
    d = mk(0.07);
    let ph = 0;
    for (let i = 0; i < d.length; i++){
      const t = i / SR; ph += TAU * f / SR;
      d[i] = Math.sin(ph) * Math.exp(-t * 85) * 0.55;
    }
    for (let i = 0; i < SR * 0.004; i++) d[i] += rnd() * Math.exp(-i / (SR * 0.001)) * 0.25;
  } else if (name === 'round_start'){
    // энергетический power-up: подъём 120→900 Гц + шумовой свелл + «зажигание»
    d = mk(0.55);
    let ph = 0, ph2 = 0;
    for (let i = 0; i < d.length; i++){
      const t = i / SR, p = Math.min(1, t / 0.4);
      const f = 120 * Math.pow(7.5, p);
      ph += TAU * f / SR;
      const saw = 2 * ((ph / TAU) % 1) - 1;
      const amp = p * Math.exp(-Math.max(0, t - 0.4) * 14);
      d[i] = (saw * 0.26 * (0.25 + 0.75 * p) + Math.sin(ph) * 0.22 + rnd() * 0.12 * p) * amp;
    }
    const at = Math.round(0.4 * SR);
    for (let i = 0; i < SR * 0.14; i++){
      const t = i / SR, f = 180 * Math.exp(-t * 9);
      ph2 += TAU * f / SR;
      const j = at + i; if (j >= d.length) break;
      d[j] += Math.sin(ph2) * Math.exp(-t * 20) * 0.7;
    }
  } else if (name === 'cashout'){
    // КАССА «ча-чинь»: низкий стук ящика + два звонка + сыплются монеты
    d = mk(1.05);
    let phd = 0;
    for (let i = 0; i < SR * 0.12; i++){                    // стук выдвижного ящика
      const t = i / SR, f = 90 * Math.exp(-t * 6);
      phd += TAU * f / SR;
      d[i] += Math.sin(phd) * Math.exp(-t * 16) * 0.4;
    }
    [{ f: 1245, at: 0 }, { f: 1660, at: 0.09 }].forEach(({ f, at }) => {   // два звонка кассы
      const a0 = Math.round(at * SR);
      [1, 2.76, 5.4].forEach((mul, pi) => {
        const g = [0.5, 0.25, 0.12][pi];
        let ph = 0;
        for (let i = 0; i < SR * 0.5; i++){
          const t = i / SR; ph += TAU * f * mul / SR;
          const j = a0 + i; if (j >= d.length) break;
          d[j] += Math.sin(ph) * Math.exp(-t * (7 + pi * 4)) * g;
        }
      });
    });
    for (let c = 0; c < 9; c++){                            // звон монет
      const at = Math.round((0.12 + Math.random() * 0.42) * SR);
      const f = 2200 + Math.random() * 3800;
      let ph = 0;
      for (let i = 0; i < SR * 0.18; i++){
        const t = i / SR; ph += TAU * f / SR;
        const j = at + i; if (j >= d.length) break;
        d[j] += Math.sin(ph) * Math.exp(-t * 30) * 0.1;
      }
    }
  } else if (name === 'crash'){
    // электро-зап (падающая рычащая пила) + звон стекла (яркие партиалы, ретриггеры)
    d = mk(1.1);
    let ph = 0;
    for (let i = 0; i < SR * 0.3; i++){
      const t = i / SR, f = 500 * Math.pow(0.1, t / 0.3);
      ph += TAU * f / SR;
      const saw = 2 * ((ph / TAU) % 1) - 1;
      d[i] += Math.tanh(saw * 3) * Math.exp(-t * 8) * 0.5 + rnd() * 0.25 * Math.exp(-t * 10);
    }
    [0, 0.05, 0.11, 0.19, 0.3].forEach((at0, k) => {
      const at = Math.round(at0 * SR);
      for (let p = 0; p < 6; p++){
        const f = 1800 + Math.random() * 4200, dec = 14 + Math.random() * 22, g = 0.12 * (1 - k * 0.13);
        let phg = 0;
        for (let i = 0; i < SR * 0.35; i++){
          const t = i / SR; phg += TAU * f / SR;
          const j = at + i; if (j >= d.length) break;
          d[j] += Math.sin(phg) * Math.exp(-t * dec) * g;
        }
      }
      for (let i = 0; i < SR * 0.03; i++){
        const j = at + i; if (j < d.length) d[j] += rnd() * Math.exp(-i / (SR * 0.008)) * 0.2;
      }
    });
  } else if (name === 'voltage_loop'){
    // гул напряжения: 55/110/165 Гц + лёгкий «шип»; все частоты дают целое число
    // циклов за 2.0 с → бесшовный луп
    d = mk(2);
    for (let i = 0; i < d.length; i++){
      const t = i / SR;
      const am  = 0.75 + 0.25 * Math.sin(TAU * 2 * t);
      const am2 = 0.8  + 0.2  * Math.sin(TAU * 7 * t);
      d[i] = (Math.sin(TAU * 55 * t) * 0.42 + Math.sin(TAU * 110 * t) * 0.2 + Math.sin(TAU * 165 * t) * 0.1) * am
           + (Math.sin(TAU * 1650 * t) * 0.02 + Math.sin(TAU * 2210 * t) * 0.013) * am2;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * 1.15) * 0.9;   // мягкий клип
  return d;
}

function toWav(f32){
  const n = f32.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f32[i])) * 32767), 44 + i * 2);
  return b;
}

const names = ['lamp_on','lamp_off','bet','tick','tick_hi','round_start','cashout','crash','voltage_loop'];
for (const n of names){
  fs.writeFileSync(path.join(__dirname, n + '.wav'), toWav(renderSfx(n)));
  console.log('ok', n + '.wav');
}
