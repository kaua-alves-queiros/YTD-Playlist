// Player em tela cheia com espectro + mixer (equalizador de 10 bandas, pré-amp e balanço).
// Usa o mesmo <video id="media"> do player normal; o áudio passa por um grafo Web Audio:
//   media → pré-amp → 10 filtros → balanço → analisador → saída
// (depende de variáveis globais de renderer.js: media, player, current, next, prev, togglePlay, fmtT, $, api)

// ---------------- motor de áudio ----------------
const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const BAND_LABEL = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const PRESETS = {
  'Normal':        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Graves+':       [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Rock':          [5, 3, 1, -1, -2, -1, 1, 3, 4, 5],
  'Pop':           [-1, 1, 3, 4, 3, 1, -1, -1, 0, 1],
  'Eletrônica':    [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  'Funk / Hip-hop':[6, 5, 3, 1, -1, -1, 1, 1, 2, 3],
  'Vocal':         [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  'Acústico':      [3, 3, 2, 1, 1, 1, 2, 3, 2, 1],
  'Agudos+':       [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Fone de ouvido':[3, 2, 1, 0, -1, 0, 1, 2, 3, 3],
};
const MX_KEY = 'ytd-mixer';
const mx = (() => {
  const def = { on: true, preset: 'Normal', bands: PRESETS.Normal.slice(), pre: 0, bal: 0 };
  try { return { ...def, ...JSON.parse(localStorage.getItem(MX_KEY) || '{}') }; } catch { return def; }
})();
const saveMx = () => { try { localStorage.setItem(MX_KEY, JSON.stringify(mx)); } catch {} };

const AX = { ctx: null, pre: null, filters: [], pan: null, analyser: null, freq: null, wave: null };

function ensureAudio() {
  if (AX.ctx) {
    if (AX.ctx.state === 'suspended') AX.ctx.resume();
    return AX;
  }
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(media);
    const pre = ctx.createGain();
    const filters = BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      return b;
    });
    const pan = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.72;
    src.connect(pre);
    let node = pre;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(pan);
    pan.connect(analyser);
    analyser.connect(ctx.destination);
    Object.assign(AX, {
      ctx, pre, filters, pan, analyser,
      freq: new Uint8Array(analyser.frequencyBinCount),
      wave: new Float32Array(analyser.fftSize),
    });
    applyMixer();
  } catch (e) {
    log('Áudio avançado indisponível: ' + e.message);
  }
  return AX;
}

function applyMixer() {
  if (!AX.ctx) return;
  const t = AX.ctx.currentTime;
  const on = mx.on;
  AX.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? mx.bands[i] : 0, t, 0.03));
  AX.pre.gain.setTargetAtTime(on ? Math.pow(10, mx.pre / 20) : 1, t, 0.03);
  AX.pan.pan.setTargetAtTime(on ? mx.bal : 0, t, 0.03);
}

// O grafo é criado no primeiro "play" (precisa de um gesto do usuário).
media.addEventListener('play', ensureAudio);

// ---------------- mixer (interface) ----------------
const mxSliders = [];
(function buildMixer() {
  const box = $('mxBands');
  BANDS.forEach((_, i) => {
    const col = el('div', 'mx-col');
    const val = el('span', 'mx-val');
    const s = el('input', 'vslider');
    Object.assign(s, { type: 'range', min: -12, max: 12, step: 0.5 });
    s.addEventListener('input', () => {
      mx.bands[i] = Number(s.value);
      mx.preset = 'Personalizado';
      paintMixer();
      applyMixer();
      saveMx();
    });
    col.append(val, s, el('span', 'mx-lbl', BAND_LABEL[i]));
    box.appendChild(col);
    mxSliders.push({ s, val });
  });
  const sel = $('mxPreset');
  for (const name of [...Object.keys(PRESETS), 'Personalizado']) {
    const o = el('option', null, name);
    o.value = name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    if (!PRESETS[sel.value]) return;
    mx.preset = sel.value;
    mx.bands = PRESETS[sel.value].slice();
    paintMixer(); applyMixer(); saveMx();
  });
  $('mxPre').addEventListener('input', (e) => { mx.pre = Number(e.target.value); paintMixer(); applyMixer(); saveMx(); });
  $('mxBal').addEventListener('input', (e) => { mx.bal = Number(e.target.value); paintMixer(); applyMixer(); saveMx(); });
  $('mxOn').addEventListener('change', (e) => { mx.on = e.target.checked; paintMixer(); applyMixer(); saveMx(); });
  $('mxReset').addEventListener('click', () => {
    Object.assign(mx, { preset: 'Normal', bands: PRESETS.Normal.slice(), pre: 0, bal: 0 });
    paintMixer(); applyMixer(); saveMx();
  });
  const toggle = () => {
    const m = $('mixer');
    m.hidden = !m.hidden;
    $('pMixer').classList.toggle('on', !m.hidden);
    if (!m.hidden) ensureAudio();
  };
  $('pMixer').addEventListener('click', toggle);
  $('fsMixer').addEventListener('click', toggle);
  $('mxClose').addEventListener('click', toggle);
  paintMixer();
})();

function paintMixer() {
  const fmt = (v) => (v > 0 ? '+' : '') + v + ' dB';
  mxSliders.forEach(({ s, val }, i) => { s.value = mx.bands[i]; val.textContent = fmt(mx.bands[i]); });
  $('mxPreset').value = mx.preset;
  $('mxPre').value = mx.pre;
  $('mxPreVal').textContent = fmt(mx.pre);
  $('mxBal').value = mx.bal;
  $('mxBalVal').textContent = Math.abs(mx.bal) < 0.03 ? 'Centro'
    : `${Math.round(Math.abs(mx.bal) * 100)}% ${mx.bal < 0 ? 'esq.' : 'dir.'}`;
  $('mxOn').checked = mx.on;
  $('mixer').classList.toggle('off', !mx.on);
  $('pMixer').title = mx.on ? `Mixer: ${mx.preset}` : 'Mixer (desligado)';
}

// ---------------- capas ----------------
const coverCache = new Map();
async function coverFor(file) {
  if (!file) return null;
  if (coverCache.has(file.path)) return coverCache.get(file.path);
  let url = null;
  try {
    const p = await api.getCover(file.path);
    url = p ? api.mediaUrl(p) : null;
  } catch {}
  coverCache.set(file.path, url);
  return url;
}
function setImg(img, url) {
  if (url) { img.src = url; img.hidden = false; img.classList.add('on'); }
  else { img.removeAttribute('src'); img.hidden = true; img.classList.remove('on'); }
}

// Sempre que muda de faixa: capa no mini player e no fullscreen.
media.addEventListener('loadstart', async () => {
  const f = current();
  if (!f) return;
  syncFsInfo();
  const url = await coverFor(f);
  if (current() !== f) return;
  setImg($('pCover'), url);
  setImg($('fsCover'), url);
  setImg($('fsBg'), url);
  $('fsBg').hidden = false;
});

// ---------------- tela cheia ----------------
const FS_STYLES = [['radial', '◎ Circular'], ['bars', '▮▮ Barras'], ['wave', '∿ Onda']];
const fs = {
  open: false, raf: 0, style: (() => { try { return localStorage.getItem('ytd-fs-style') || 'radial'; } catch { return 'radial'; } })(),
  sm: new Float32Array(72), peaks: new Float32Array(72), bins: null, particles: [], hue: 0, idleT: 0,
};
const canvas = $('fsCanvas');
const g = canvas.getContext('2d');

function openFs() {
  if (fs.open || !current()) return;
  fs.open = true;
  ensureAudio();
  $('fs').hidden = false;
  document.body.classList.add('fs-open');
  const f = current();
  if (f?.video) { $('fs').appendChild(media); $('fs').classList.add('video'); }
  setStyle(fs.style);
  syncFsInfo();
  syncFsState();
  resizeCanvas();
  $('fs').requestFullscreen?.().catch(() => {});
  poke();
  fs.raf = requestAnimationFrame(draw);
}
function closeFs() {
  if (!fs.open) return;
  fs.open = false;
  cancelAnimationFrame(fs.raf);
  $('fs').hidden = true;
  $('fs').classList.remove('video', 'idle');
  document.body.classList.remove('fs-open');
  if (media.parentElement !== $('player')) $('player').insertBefore(media, $('player').firstChild);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
const toggleFs = () => (fs.open ? closeFs() : openFs());

function setStyle(s) {
  fs.style = s;
  try { localStorage.setItem('ytd-fs-style', s); } catch {}
  const fsEl = $('fs');
  fsEl.classList.remove('radial', 'bars', 'wave');
  fsEl.classList.add(s);
  $('fsStyle').textContent = FS_STYLES.find(([k]) => k === s)[1];
}
function cycleStyle() {
  const i = FS_STYLES.findIndex(([k]) => k === fs.style);
  setStyle(FS_STYLES[(i + 1) % FS_STYLES.length][0]);
}

function syncFsInfo() {
  const f = current();
  if (!f) return;
  $('fsTitle').textContent = f.title;
  $('fsSub').textContent = `${player.folder} · ${player.pos + 1} de ${player.queue.length}`;
  if (fs.open) {
    const fsEl = $('fs');
    if (f.video && media.parentElement !== fsEl) { fsEl.appendChild(media); }
    if (!f.video && media.parentElement === fsEl) $('player').insertBefore(media, $('player').firstChild);
    fsEl.classList.toggle('video', Boolean(f.video));
  }
}
function syncFsState() {
  $('fsPlay').textContent = media.paused ? '▶' : '⏸';
  $('fs').classList.toggle('playing', !media.paused);
  $('fsShuffle').classList.toggle('on', player.shuffle);
  $('fsRepeat').classList.toggle('on', player.repeat !== 'off');
  $('fsRepeat').textContent = player.repeat === 'one' ? '🔂' : '🔁';
}
media.addEventListener('play', syncFsState);
media.addEventListener('pause', syncFsState);
media.addEventListener('loadedmetadata', () => ($('fsDur').textContent = fmtT(media.duration)));
media.addEventListener('timeupdate', () => {
  if (!fs.open) return;
  $('fsCur').textContent = fmtT(media.currentTime);
  if (!fs.seeking && media.duration) $('fsSeek').value = Math.round((media.currentTime / media.duration) * 1000);
});

$('pFull').addEventListener('click', openFs);
$('pCoverBtn').addEventListener('click', openFs);
$('fsClose').addEventListener('click', closeFs);
$('fsStyle').addEventListener('click', cycleStyle);
$('fsPlay').addEventListener('click', togglePlay);
$('fsPrev').addEventListener('click', prev);
$('fsNext').addEventListener('click', () => next());
$('fsShuffle').addEventListener('click', () => { $('pShuffle').click(); syncFsState(); syncFsInfo(); });
$('fsRepeat').addEventListener('click', () => { $('pRepeat').click(); syncFsState(); });
$('fsSeek').addEventListener('input', () => {
  fs.seeking = true;
  if (media.duration) $('fsCur').textContent = fmtT(($('fsSeek').value / 1000) * media.duration);
});
$('fsSeek').addEventListener('change', () => {
  if (media.duration) media.currentTime = ($('fsSeek').value / 1000) * media.duration;
  fs.seeking = false;
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && fs.open) closeFs(); // saiu pelo Esc/F11
});
window.addEventListener('resize', () => fs.open && resizeCanvas());

// esconde os controles quando o mouse fica parado
function poke() {
  $('fs').classList.remove('idle');
  clearTimeout(fs.idleT);
  fs.idleT = setTimeout(() => fs.open && !media.paused && $('fs').classList.add('idle'), 2800);
}
$('fs').addEventListener('mousemove', poke);

// atalhos
document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
  const k = e.key;
  if ((k === 'f' || k === 'F') && current()) { e.preventDefault(); toggleFs(); return; }
  if (!fs.open) return;
  if (k === 'Escape') closeFs();
  else if (k === 'v' || k === 'V') cycleStyle();
  else if (k === 'ArrowRight') media.currentTime = Math.min(media.duration || 0, media.currentTime + 10);
  else if (k === 'ArrowLeft') media.currentTime = Math.max(0, media.currentTime - 10);
  else if (k === 'ArrowUp') { $('pVol').value = Math.min(100, Number($('pVol').value) + 5); setVol(Number($('pVol').value)); }
  else if (k === 'ArrowDown') { $('pVol').value = Math.max(0, Number($('pVol').value) - 5); setVol(Number($('pVol').value)); }
  else return;
  poke();
});

// ---------------- desenho do espectro ----------------
function resizeCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  fs.bins = null;
}

// Faixas logarítmicas de frequência (32 Hz → 16 kHz) para cada barra.
function buildBins(n) {
  const sr = AX.ctx.sampleRate, size = AX.analyser.fftSize, hz = sr / size;
  const lo = 32, hi = 16000, out = [];
  for (let i = 0; i < n; i++) {
    const f0 = lo * Math.pow(hi / lo, i / n), f1 = lo * Math.pow(hi / lo, (i + 1) / n);
    const b0 = Math.max(1, Math.floor(f0 / hz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / hz));
    out.push([b0, Math.min(b1, AX.freq.length)]);
  }
  return out;
}

function readSpectrum() {
  const n = fs.sm.length;
  if (!AX.analyser) { fs.sm.fill(0); return 0; }
  if (!fs.bins) fs.bins = buildBins(n);
  AX.analyser.getByteFrequencyData(AX.freq);
  for (let i = 0; i < n; i++) {
    const [a, b] = fs.bins[i];
    let m = 0;
    for (let j = a; j < b; j++) if (AX.freq[j] > m) m = AX.freq[j];
    let v = m / 255;
    v = Math.pow(v, 1.7) * (0.85 + 0.6 * (i / n)); // realça um pouco os agudos
    v = Math.min(1, v);
    fs.sm[i] = v > fs.sm[i] ? v * 0.7 + fs.sm[i] * 0.3 : fs.sm[i] * 0.9 + v * 0.1;
    fs.peaks[i] = Math.max(fs.peaks[i] - 0.008, fs.sm[i]);
  }
  let bass = 0;
  for (let i = 0; i < 6; i++) bass += fs.sm[i];
  return bass / 6;
}

const color = (i, n, a = 1, l = 62) => `hsla(${(fs.hue + (i / n) * 150) % 360}, 95%, ${l}%, ${a})`;

function draw(t) {
  if (!fs.open) return;
  fs.raf = requestAnimationFrame(draw);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const bass = readSpectrum();
  fs.hue = (t / 90) % 360;
  g.clearRect(0, 0, w, h);

  // pulso da capa com o grave
  const disc = $('fsDisc');
  disc.style.setProperty('--s', (1 + bass * 0.09).toFixed(3));
  disc.style.setProperty('--glow', Math.round(bass * 90) + 'px');

  if (fs.style === 'radial' && !$('fs').classList.contains('video')) drawRadial(w, h, bass);
  else if (fs.style === 'wave') drawWave(w, h, bass);
  else drawBars(w, h);
  drawParticles(w, h, bass);
}

function discCenter(w, h) {
  const r = $('fsDisc').getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: r.width / 2 };
}

function drawRadial(w, h, bass) {
  const { cx, cy, R } = discCenter(w, h);
  const n = fs.sm.length, maxLen = Math.min(w, h) * 0.2;
  const r0 = R + 14;
  const lw = Math.max(2.5, ((Math.PI * r0) / n) * 0.55);
  g.save();
  g.lineCap = 'round';
  g.lineWidth = lw;
  g.shadowBlur = 16;
  for (let i = 0; i < n; i++) {
    const len = 4 + fs.sm[i] * maxLen;
    const c = color(i, n);
    g.strokeStyle = c;
    g.shadowColor = c;
    for (const side of [-1, 1]) {
      const ang = -Math.PI / 2 + side * ((i + 0.5) / n) * Math.PI;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      g.beginPath();
      g.moveTo(cx + cos * r0, cy + sin * r0);
      g.lineTo(cx + cos * (r0 + len), cy + sin * (r0 + len));
      g.stroke();
    }
  }
  // anel que brilha com o grave
  g.shadowBlur = 30;
  g.shadowColor = color(0, n, 0.9);
  g.strokeStyle = color(0, n, 0.25 + bass * 0.6, 70);
  g.lineWidth = 2 + bass * 4;
  g.beginPath();
  g.arc(cx, cy, R + 6, 0, Math.PI * 2);
  g.stroke();
  g.restore();
}

function drawBars(w, h) {
  const n = fs.sm.length, total = w * 0.86, x0 = (w - total) / 2;
  const gap = Math.max(2, total / n * 0.22), bw = total / n - gap;
  const base = h * 0.74, maxH = h * 0.38;
  g.save();
  g.shadowBlur = 14;
  for (let i = 0; i < n; i++) {
    const bh = 3 + fs.sm[i] * maxH, x = x0 + i * (bw + gap);
    const c = color(i, n);
    const grad = g.createLinearGradient(0, base - bh, 0, base);
    grad.addColorStop(0, color(i, n, 1, 72));
    grad.addColorStop(1, color(i, n, 0.85, 45));
    g.fillStyle = grad;
    g.shadowColor = c;
    roundRect(x, base - bh, bw, bh, Math.min(bw / 2, 6));
    // reflexo
    g.shadowBlur = 0;
    g.fillStyle = color(i, n, 0.13);
    roundRect(x, base + 4, bw, bh * 0.35, Math.min(bw / 2, 6));
    // picos que caem devagar
    g.fillStyle = color(i, n, 0.95, 80);
    g.fillRect(x, base - 3 - fs.peaks[i] * maxH - 6, bw, 3);
    g.shadowBlur = 14;
  }
  g.restore();
}
function roundRect(x, y, w, h, r) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
  g.fill();
}

function drawWave(w, h, bass) {
  if (!AX.analyser) return drawBars(w, h);
  AX.analyser.getFloatTimeDomainData(AX.wave);
  const data = AX.wave, step = Math.floor(data.length / 900) || 1;
  const mid = h * 0.7, amp = h * (0.16 + bass * 0.12);
  g.save();
  g.lineJoin = 'round';
  [[0, 4, 1], [60, 2, 0.6], [140, 1.5, 0.35]].forEach(([dh, lw, a], k) => {
    g.beginPath();
    g.lineWidth = lw;
    const c = `hsla(${(fs.hue + dh) % 360}, 95%, 64%, ${a})`;
    g.strokeStyle = c;
    g.shadowColor = c;
    g.shadowBlur = 22;
    const off = k * 37;
    for (let i = 0, x = 0; i < data.length; i += step, x += w / (data.length / step)) {
      const y = mid + data[(i + off) % data.length] * amp * (1 - k * 0.15);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  });
  g.restore();
}

function drawParticles(w, h, bass) {
  const P = fs.particles;
  if (bass > 0.42 && P.length < 160 && !media.paused) {
    const { cx, cy, R } = fs.style === 'radial' && !$('fs').classList.contains('video') ? discCenter(w, h) : { cx: w / 2, cy: h * 0.7, R: 20 };
    for (let k = 0; k < 4; k++) {
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 3.5 * bass;
      P.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, hue: fs.hue + Math.random() * 120, s: 1 + Math.random() * 2.5 });
    }
  }
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.vy *= 0.99; p.life -= 0.012;
    if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) { P.splice(i, 1); continue; }
    g.fillStyle = `hsla(${p.hue % 360}, 95%, 70%, ${p.life * 0.8})`;
    g.beginPath();
    g.arc(p.x, p.y, p.s, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}
