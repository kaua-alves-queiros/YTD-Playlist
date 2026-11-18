const $ = (id) => document.getElementById(id);
const api = window.ytd;

const QUALITIES = {
  mp3: [['best', 'Melhor (≈320 kbps)'], ['low', 'Menor arquivo (≈130 kbps)']],
  mp4: [['2160', '4K (2160p)'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']],
};

const state = {
  ready: false,
  format: 'mp3',
  quality: 'best',
  outDir: '',
  url: '',
  playlist: null,
  items: new Map(), // index -> { el, entry, status }
  running: false,
  lastFile: null,
  saved: [],
};

// ---------- helpers ----------
function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
}
function log(text) {
  const pre = $('log');
  pre.textContent += text + '\n';
  pre.scrollTop = pre.scrollHeight;
}
function setEngine(text, cls = '') {
  const el = $('engine');
  el.textContent = text;
  el.className = 'pill ' + cls;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- opções ----------
function renderQuality() {
  const sel = $('quality');
  sel.innerHTML = '';
  for (const [v, label] of QUALITIES[state.format]) {
    const o = el('option', null, label);
    o.value = v;
    sel.appendChild(o);
  }
  if (!QUALITIES[state.format].some(([v]) => v === state.quality)) {
    state.quality = state.format === 'mp3' ? 'best' : '1080';
  }
  sel.value = state.quality;
  for (const b of $('formatSeg').children) b.classList.toggle('on', b.dataset.v === state.format);
}

$('formatSeg').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || state.running) return;
  state.format = v;
  renderQuality();
  markExisting(); // MP3 e MP4 são verificados separadamente
});
$('quality').addEventListener('change', (e) => (state.quality = e.target.value));

function renderOutDir() {
  $('outDir').textContent = state.outDir;
  $('outDir').title = state.outDir;
  $('setOutDir').textContent = state.outDir;
}
async function chooseOutDir() {
  const p = await api.chooseFolder(state.outDir);
  if (p) { state.outDir = p; renderOutDir(); loadLibrary(); }
}
$('setChooseDir').addEventListener('click', chooseOutDir);

// ---------- configurações ----------
function paintSeg(id, value) {
  for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === String(value));
}
$('themeSeg').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  paintSeg('themeSeg', v);
  api.setSetting('theme', v);
});
let parTimer;
function setParallel(v, now = false) {
  v = Math.max(1, Math.floor(Number(v)) || 1);
  $('parallelInput').value = v;
  clearTimeout(parTimer);
  parTimer = setTimeout(() => {
    api.setSetting('maxParallel', v);
    toast(`Até ${v} download${v === 1 ? '' : 's'} ao mesmo tempo`);
  }, now ? 0 : 500);
}
$('parMinus').addEventListener('click', () => setParallel(Number($('parallelInput').value) - 1));
$('parPlus').addEventListener('click', () => setParallel(Number($('parallelInput').value) + 1));
$('parallelInput').addEventListener('change', (e) => setParallel(e.target.value, true));
$('openDir').addEventListener('click', () => api.openPath(state.outDir));

const cleanErr = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- abas ----------
function showTab(name) {
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
  if (name === 'search') $('searchInput').focus();
  if (name === 'link') $('url').focus();
  if (name === 'library') loadLibrary();
}
$('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.tab;
  if (t) showTab(t);
});

// ---------- abrir playlist ----------
async function openPlaylist(url) {
  if (!url || state.running || !state.ready) return;
  $('url').value = url;
  showTab('link');
  $('urlError').hidden = true;
  $('fetchBtn').disabled = true;
  $('fetchBtn').textContent = 'Abrindo…';
  try {
    const info = await api.fetchInfo(url);
    state.url = url;
    state.playlist = info;
    renderList();
    const j = findJobFor(info);
    state.viewJobId = j?.id ?? null;
    applyJobToList(j);
    markExisting();
  } catch (err) {
    const msg = cleanErr(err);
    $('urlError').textContent = msg;
    $('urlError').hidden = false;
    log(msg);
  } finally {
    $('fetchBtn').disabled = !state.ready || state.running;
    $('fetchBtn').textContent = 'Abrir';
  }
}
$('urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  openPlaylist($('url').value.trim());
});

// ---------- cartões de playlist (busca e salvas) ----------
function isSaved(id) { return state.saved.some((s) => s.id === id); }

function plCard(p, { removable = false } = {}) {
  const card = el('div', 'pl');
  const img = el('img', 'thumb');
  img.alt = '';
  img.loading = 'lazy';
  if (p.thumb) img.src = p.thumb;
  img.addEventListener('click', () => openPlaylist(p.url));
  const body = el('div', 'body');
  const t = el('div', 't', p.title);
  t.title = p.title;
  body.append(t, el('div', 'c', [p.channel, p.count ? `${p.count} vídeos` : ''].filter(Boolean).join(' · ')));
  const row = el('div', 'row');
  const open = el('button', 'open', 'Abrir');
  open.addEventListener('click', () => openPlaylist(p.url));
  row.appendChild(open);
  if (removable) {
    const rm = el('button', 'danger', 'Remover');
    rm.addEventListener('click', async () => { await setSaved(p, false); });
    row.appendChild(rm);
  } else {
    const star = el('button', 'star');
    const paint = () => { const on = isSaved(p.id); star.textContent = on ? '★' : '☆'; star.classList.toggle('on', on); star.title = on ? 'Remover das salvas' : 'Salvar'; };
    paint();
    star.addEventListener('repaint', paint);
    star.addEventListener('click', async () => { await setSaved(p, !isSaved(p.id)); paint(); });
    row.appendChild(star);
  }
  body.appendChild(row);
  card.append(img, body);
  return card;
}

// ---------- buscador ----------
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q || !state.ready) return;
  const box = $('searchResults');
  $('searchError').hidden = true;
  $('searchBtn').disabled = true;
  box.innerHTML = '';
  box.appendChild(el('div', 'loading', 'Buscando playlists…'));
  try {
    const results = await api.searchPlaylists(q);
    box.innerHTML = '';
    if (!results.length) box.appendChild(el('div', 'loading', 'Nenhuma playlist encontrada.'));
    for (const r of results) box.appendChild(plCard(r));
  } catch (err) {
    box.innerHTML = '';
    $('searchError').textContent = cleanErr(err);
    $('searchError').hidden = false;
  } finally {
    $('searchBtn').disabled = !state.ready;
  }
});

// ---------- salvas ----------
async function setSaved(p, on) {
  state.saved = on
    ? await api.savedAdd({ id: p.id, url: p.url, title: p.title, channel: p.channel, thumb: p.thumb, count: p.count })
    : await api.savedRemove(p.id);
  renderSaved();
}
function renderSaved() {
  const box = $('savedList');
  box.innerHTML = '';
  for (const p of state.saved) box.appendChild(plCard(p, { removable: true }));
  $('savedEmpty').hidden = state.saved.length > 0;
  $('savedCount').textContent = state.saved.length ? `(${state.saved.length})` : '';
  paintSaveBtn();
  // mantém as estrelas da busca em sincronia
  for (const s of $('searchResults').querySelectorAll('.star')) s.dispatchEvent(new Event('repaint'));
}
function paintSaveBtn() {
  const pl = state.playlist;
  const btn = $('saveBtn');
  btn.hidden = !pl || !pl.isPlaylist;
  if (btn.hidden) return;
  const on = isSaved(pl.id);
  btn.textContent = on ? '★ Salva' : '☆ Salvar';
  btn.classList.toggle('on', on);
}
$('saveBtn').addEventListener('click', async () => {
  const pl = state.playlist;
  if (!pl?.isPlaylist) return;
  await setSaved({ ...pl, count: pl.entries.length }, !isSaved(pl.id));
});

function renderList() {
  const { title, channel, entries, isPlaylist } = state.playlist;
  $('empty').hidden = true;
  $('listCard').hidden = false;
  $('overall').hidden = true;
  $('plTitle').textContent = title;
  const total = entries.reduce((a, e) => a + (e.duration || 0), 0);
  $('plMeta').textContent = [
    channel,
    isPlaylist ? `${entries.length} vídeos` : '1 vídeo',
    total ? `duração total ${fmtDur(total)}` : '',
  ].filter(Boolean).join(' · ');

  const ul = $('items');
  ul.innerHTML = '';
  state.items.clear();
  for (const entry of entries) {
    const li = el('li', 'item' + (entry.unavailable ? ' unavailable' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !entry.unavailable;
    cb.disabled = entry.unavailable;
    cb.addEventListener('change', syncSelectAll);
    const info = el('div', 'info');
    info.append(
      el('div', 'title', entry.title),
      el('div', 'meta', [entry.channel, fmtDur(entry.duration)].filter(Boolean).join(' · ')),
    );
    const mini = el('div', 'mini');
    mini.appendChild(el('div'));
    info.appendChild(mini);
    const status = el('span', 'status', entry.unavailable ? 'indisponível' : '');
    li.append(cb, el('span', 'idx', String(entry.index)), info, status);
    ul.appendChild(li);
    state.items.set(entry.index, { li, cb, status, fill: mini.firstChild, meta: info.children[1], entry, state: 'idle' });
  }
  syncSelectAll();
  paintSaveBtn();
}

function selected() {
  return [...state.items.values()].filter((it) => it.cb.checked);
}
function syncSelectAll() {
  const avail = [...state.items.values()].filter((it) => !it.cb.disabled);
  const n = avail.filter((it) => it.cb.checked).length;
  $('selectAll').checked = n === avail.length && n > 0;
  $('selectAll').indeterminate = n > 0 && n < avail.length;
  $('downloadBtn').textContent = n ? `Baixar ${n}` : 'Baixar';
  $('downloadBtn').disabled = !n || state.running || !state.ready;
}
$('selectAll').addEventListener('change', (e) => {
  for (const it of state.items.values()) if (!it.cb.disabled) it.cb.checked = e.target.checked;
  syncSelectAll();
});

// ---------- download (fila) ----------
const jobsById = new Map();
state.viewJobId = null; // job ligado à playlist aberta na tela

const STATUS_TXT = {
  queued: 'Na fila', running: 'Baixando', done: 'Concluído', partial: 'Concluído com erros',
  cancelled: 'Cancelado', error: 'Erro',
};
const isActive = (j) => j && (j.status === 'running' || j.status === 'queued');

function setItem(it, cls, text, pct) {
  it.state = cls;
  it.li.classList.remove('active', 'done', 'failed');
  if (cls) it.li.classList.add(cls);
  it.status.textContent = text;
  if (pct != null) it.fill.style.width = pct + '%';
}
function showFile(it, file) {
  setItem(it, 'done', '', 100);
  it.status.append('✓ ');
  if (file) {
    const btn = el('button', null, 'Mostrar');
    btn.title = file;
    btn.addEventListener('click', () => api.openPath(file));
    it.status.append(btn);
  }
}

function findJobFor(pl) {
  const all = [...jobsById.values()].filter((j) => (pl.id && j.playlistId === pl.id) || j.url === state.url);
  return all.find(isActive) || all.sort((a, b) => b.id - a.id)[0] || null;
}

// Pinta a lista de músicas com o estado do job (ao abrir uma playlist que já está baixando).
function applyJobToList(j) {
  for (const it of state.items.values()) {
    const s = j?.states?.[it.entry.index];
    it.queued = s !== undefined;
    if (!s) setItem(it, '', it.entry.unavailable ? 'indisponível' : '', 0);
    else if (s === 'queued') setItem(it, '', 'na fila', 0);
    else if (s === 'active') setItem(it, 'active', 'baixando…', j.current?.index === it.entry.index ? j.current.percent : 0);
    else if (s === 'done') showFile(it, null);
    else if (s === 'failed') setItem(it, 'failed', '✕ erro');
    else if (s === 'cancelled') setItem(it, '', 'cancelado');
    else if (s === 'skipped') setItem(it, 'done', '✓ já baixado', 100);
  }
  updateViewHeader();
}

const folderTitleOf = (pl) => (pl?.isPlaylist ? pl.title : 'Downloads');

// Verifica ANTES de baixar quais músicas já estão na pasta (pelo ID do vídeo).
// Essas aparecem como "✓ já baixado" e ficam desmarcadas.
async function markExisting() {
  const pl = state.playlist;
  if (!pl) return;
  const format = state.format;
  const entries = [...state.items.values()]
    .filter((it) => !it.entry.unavailable)
    .map((it) => ({ index: it.entry.index, id: it.entry.id, title: it.entry.title }));
  let found = {};
  try { found = await api.checkExisting({ folderTitle: folderTitleOf(pl), format, entries }); } catch {}
  if (state.playlist !== pl || state.format !== format) return; // usuário trocou de playlist/formato no meio
  const job = jobsById.get(state.viewJobId);
  const busy = isActive(job);
  let n = 0;
  for (const it of state.items.values()) {
    const ex = found[it.entry.index];
    if (ex) {
      n++;
      it.existing = true;
      if (it.state === 'active' || (busy && job.states?.[it.entry.index] === 'queued')) continue;
      it.cb.checked = false;
      const other = ex.folder && ex.folder !== '.' && ex.folder !== it.existingFolderHint ? ex.folder : '';
      setItem(it, 'done', '', 100);
      it.status.append('✓ já baixado ');
      const btn = el('button', null, 'Mostrar');
      btn.title = ex.file;
      btn.addEventListener('click', () => api.openPath(ex.file));
      it.status.append(btn);
      if (other && norm(other) !== norm(folderTitleOf(pl))) it.status.title = `Já está em: ${other}`;
    } else if (it.existing) {
      // estava marcado como baixado (ex.: no outro formato) e não está mais
      it.existing = false;
      if (!busy) { setItem(it, '', '', 0); it.cb.checked = true; }
    }
  }
  syncSelectAll();
  if (n) toast(`${n} música${n > 1 ? 's' : ''} desta playlist já ${n > 1 ? 'estão baixadas' : 'está baixada'} em ${format.toUpperCase()} e não ${n > 1 ? 'serão baixadas' : 'será baixada'} de novo.`);
}
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function jobPct(j) {
  const cur = j.status === 'running' && j.current ? (j.current.percent || 0) / 100 : 0;
  return Math.min(100, ((j.done + j.failed + cur) / (j.total || 1)) * 100);
}

function updateViewHeader() {
  const j = jobsById.get(state.viewJobId);
  $('overall').hidden = !j;
  $('cancelBtn').hidden = !isActive(j);
  if (!j) return;
  $('overallFill').style.width = jobPct(j) + '%';
  $('overallText').textContent = `${STATUS_TXT[j.status]} · ${j.done} de ${j.total}` + (j.failed ? ` · ${j.failed} com erro` : '');
}

$('downloadBtn').addEventListener('click', async () => {
  const sel = selected();
  if (!sel.length || !state.playlist) return;
  const pl = state.playlist;
  const all = sel.length === [...state.items.values()].filter((i) => !i.entry.unavailable).length;
  try {
    const job = await api.startDownload({
      url: state.url,
      title: pl.title,
      playlistId: pl.isPlaylist ? pl.id : null,
      thumb: pl.thumb,
      format: state.format,
      quality: state.quality,
      outDir: state.outDir,
      items: pl.isPlaylist && !all ? sel.map((it) => it.entry.index) : null,
      folderTitle: folderTitleOf(pl),
      entries: sel.map((it) => ({ index: it.entry.index, id: it.entry.id, title: it.entry.title })),
    });
    jobsById.set(job.id, job);
    state.viewJobId = job.id;
    applyJobToList(job);
    renderDownloads();
    log(`"${pl.title}" adicionada aos downloads (${sel.length} item(ns), ${state.format.toUpperCase()}).`);
    toast(`Adicionada aos downloads: ${pl.title}`);
  } catch (err) {
    toast(cleanErr(err), true);
    log(cleanErr(err));
  }
});

$('cancelBtn').addEventListener('click', () => {
  if (state.viewJobId) api.cancelJob(state.viewJobId);
});

api.onEvent((ev) => {
  if (ev.type === 'finished') { loadLibrary(); return; }
  if (ev.type === 'error-line') log('ERRO: ' + ev.text);
  if (ev.type === 'log') log(ev.text);
  if (ev.jobId !== state.viewJobId) return;
  const it = state.items.get(ev.index);
  if (!it) return;
  switch (ev.type) {
    case 'start':
      setItem(it, 'active', 'baixando…', 0);
      it.li.scrollIntoView({ block: 'nearest' });
      break;
    case 'progress':
      if (it.state !== 'done') {
        const extra = [ev.speed, ev.eta].filter((x) => x && !/unknown/i.test(x)).join(' · ');
        setItem(it, 'active', `${ev.percent.toFixed(0)}%${extra ? ' · ' + extra : ''}`, ev.percent);
      }
      break;
    case 'converting':
      setItem(it, 'active', state.format === 'mp3' ? 'convertendo…' : 'finalizando…', 99);
      break;
    case 'done':
      showFile(it, ev.file);
      break;
    case 'error-line':
      if (it.state !== 'done') { setItem(it, 'failed', '✕ erro'); it.status.title = ev.text; }
      break;
  }
});

api.onJobUpdate((j) => {
  if (j.removed) jobsById.delete(j.id);
  else {
    const prev = jobsById.get(j.id);
    jobsById.set(j.id, j);
    // quando o job termina, marca na lista os que ficaram sem baixar
    if (j.id === state.viewJobId && prev && isActive(prev) && !isActive(j)) { applyJobToList(j); markExisting(); }
  }
  if (j.id === state.viewJobId) updateViewHeader();
  renderDownloads();
});

// ---------- página de downloads ----------
function renderDownloads() {
  const list = [...jobsById.values()].sort((a, b) => {
    const rank = (x) => (x.status === 'running' ? 0 : x.status === 'queued' ? 1 : 2);
    return rank(a) - rank(b) || b.id - a.id;
  });
  const active = list.filter(isActive).length;
  $('dlCount').textContent = active ? `(${active})` : '';
  $('dlTab').classList.toggle('busy', active > 0);
  $('jobsEmpty').hidden = list.length > 0;
  $('clearFinished').hidden = !list.some((j) => !isActive(j));

  const box = $('jobList');
  box.innerHTML = '';
  for (const j of list) {
    const card = el('div', 'job ' + j.status);
    const img = el('img', 'jthumb');
    img.alt = '';
    if (j.thumb) img.src = j.thumb;
    const body = el('div', 'jbody');

    const top = el('div', 'jtop');
    const t = el('div', 'jtitle', j.title);
    t.title = j.title;
    top.append(t, el('span', 'badge ' + j.status, STATUS_TXT[j.status]));

    const q = j.format === 'mp3' ? (j.quality === 'low' ? 'MP3 ~130k' : 'MP3 ~320k') : `MP4 ${j.quality}p`;
    const meta = el('div', 'jmeta',
      `${q} · ${j.done} de ${j.total} baixados` + (j.failed ? ` · ${j.failed} com erro` : ''));

    const bar = el('div', 'bar');
    const fill = el('div');
    fill.style.width = jobPct(j) + '%';
    bar.appendChild(fill);

    let curText = '';
    if (j.status === 'running' && j.current) {
      const c = j.current;
      const extra = [c.speed, c.eta].filter((x) => x && !/unknown/i.test(x)).join(' · ');
      curText = `▶ ${c.title} — ${Math.round(c.percent)}%${extra ? ' · ' + extra : ''}`;
    } else if (j.status === 'running') curText = 'Preparando…';
    else if (j.status === 'queued') curText = 'Aguardando outro download terminar…';
    else if (j.error) curText = j.error;
    const cur = el('div', 'jcur', curText);
    cur.title = curText;

    const row = el('div', 'jrow');
    const btn = (label, fn, cls) => { const b = el('button', cls || null, label); b.addEventListener('click', fn); row.appendChild(b); };
    btn('Ver músicas', () => openJobPlaylist(j));
    if (j.lastFile) btn('📂 Abrir pasta', () => api.openPath(j.lastFile));
    if (isActive(j)) btn('Cancelar', () => api.cancelJob(j.id), 'danger');
    else btn('Remover da lista', () => api.removeJob(j.id));

    body.append(top, meta, bar, cur, row);
    card.append(img, body);
    box.appendChild(card);
  }
}

async function openJobPlaylist(j) {
  await openPlaylist(j.url);
  if (state.playlist) {
    state.viewJobId = j.id;
    applyJobToList(jobsById.get(j.id));
  }
}

$('clearFinished').addEventListener('click', () => api.clearFinished());

// ---------- aviso rápido ----------
let toastTimer;
function toast(text, isErr = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}

// ---------- biblioteca ----------
const lib = { groups: [], loaded: false, closed: new Set() };

async function loadLibrary() {
  lib.groups = await api.libraryScan(state.outDir);
  lib.loaded = true;
  const total = lib.groups.reduce((a, g) => a + g.files.length, 0);
  $('libCount').textContent = total ? `(${total})` : '';
  renderLibrary();
}

function renderLibrary() {
  const box = $('libList');
  const f = $('libFilter').value.trim().toLowerCase();
  box.innerHTML = '';
  let shown = 0;
  for (const g of lib.groups) {
    const files = f ? g.files.filter((x) => (x.title + ' ' + g.folder).toLowerCase().includes(f)) : g.files;
    if (!files.length) continue;
    shown += files.length;
    const wrap = el('div', 'folder-g' + (lib.closed.has(g.folder) && !f ? ' closed' : ''));
    const head = el('div', 'folder-h');
    const playAll = el('button', null, '▶ Tocar');
    playAll.title = 'Tocar esta playlist';
    playAll.addEventListener('click', (e) => { e.stopPropagation(); playQueue(files, 0, g.folder); });
    head.append(el('span', 'chev', '▾'), el('span', 'fname', g.folder), el('span', 'fn', `${files.length}`), playAll);
    head.addEventListener('click', () => {
      wrap.classList.toggle('closed');
      if (wrap.classList.contains('closed')) lib.closed.add(g.folder); else lib.closed.delete(g.folder);
    });
    const ul = el('ul', 'tracks');
    files.forEach((file, i) => {
      const li = el('li', 'track');
      li.dataset.path = file.path;
      li.append(el('span', 'n', file.num ? String(file.num) : '•'), el('span', 'tt', file.title));
      li.appendChild(file.video ? el('span', 'tag', 'vídeo') : el('span'));
      li.title = file.name;
      li.addEventListener('click', () => playQueue(files, i, g.folder));
      ul.appendChild(li);
    });
    wrap.append(head, ul);
    box.appendChild(wrap);
  }
  $('libEmpty').hidden = shown > 0;
  $('libEmpty').textContent = f ? 'Nada encontrado com esse filtro.' : 'Nenhuma música baixada ainda nesta pasta.';
  markPlaying();
}
$('libFilter').addEventListener('input', renderLibrary);
$('libRefresh').addEventListener('click', loadLibrary);

// ---------- player ----------
const media = $('media');
const player = { queue: [], order: [], pos: -1, folder: '', shuffle: false, repeat: 'off', seeking: false };

function shuffled(n, first) {
  const a = [...Array(n).keys()].filter((i) => i !== first);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return [first, ...a];
}
function buildOrder(startIdx) {
  const n = player.queue.length;
  player.order = player.shuffle ? shuffled(n, startIdx) : [...Array(n).keys()];
  player.pos = player.order.indexOf(startIdx);
}
const current = () => player.queue[player.order[player.pos]];

function playQueue(files, idx, folder) {
  player.queue = files.slice();
  player.folder = folder;
  buildOrder(idx);
  loadCurrent(true);
}

function loadCurrent(autoplay) {
  const f = current();
  if (!f) return;
  $('player').hidden = false;
  document.body.classList.add('has-player');
  media.hidden = !f.video;
  media.src = api.mediaUrl(f.path);
  $('pTitle').textContent = f.title;
  $('pTitle').title = f.title;
  $('pSub').textContent = `${player.folder} · ${player.pos + 1} de ${player.queue.length}`;
  if (autoplay) media.play().catch((e) => log('Player: ' + e.message));
  markPlaying();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: f.title, album: player.folder, artist: '' });
  }
}

function markPlaying() {
  const p = current()?.path;
  for (const li of document.querySelectorAll('.track')) li.classList.toggle('playing', li.dataset.path === p);
}

function next(auto = false) {
  if (!player.queue.length) return;
  if (auto && player.repeat === 'one') { media.currentTime = 0; media.play(); return; }
  if (player.pos < player.order.length - 1) player.pos++;
  else if (player.repeat === 'all' || !auto) {
    if (player.shuffle) buildOrder(player.order[Math.floor(Math.random() * player.order.length)]);
    player.pos = 0;
  } else { media.pause(); return; }
  loadCurrent(true);
}
function prev() {
  if (!player.queue.length) return;
  if (media.currentTime > 3 || player.pos === 0) { media.currentTime = 0; return; }
  player.pos--;
  loadCurrent(true);
}
function togglePlay() {
  if (!media.src) return;
  if (media.paused) media.play(); else media.pause();
}

const fmtT = (s) => (Number.isFinite(s) ? fmtDur(s) || '0:00' : '0:00');
media.addEventListener('play', () => ($('pPlay').textContent = '⏸'));
media.addEventListener('pause', () => ($('pPlay').textContent = '▶'));
media.addEventListener('ended', () => next(true));
media.addEventListener('loadedmetadata', () => ($('pDur').textContent = fmtT(media.duration)));
media.addEventListener('timeupdate', () => {
  $('pCur').textContent = fmtT(media.currentTime);
  if (!player.seeking && media.duration) $('pSeek').value = Math.round((media.currentTime / media.duration) * 1000);
});
media.addEventListener('error', () => {
  log('Não foi possível tocar: ' + (current()?.name || ''));
  setTimeout(() => next(true), 800);
});

$('pPlay').addEventListener('click', togglePlay);
$('pNext').addEventListener('click', () => next());
$('pPrev').addEventListener('click', prev);
$('pSeek').addEventListener('input', () => {
  player.seeking = true;
  if (media.duration) $('pCur').textContent = fmtT(($('pSeek').value / 1000) * media.duration);
});
$('pSeek').addEventListener('change', () => {
  if (media.duration) media.currentTime = ($('pSeek').value / 1000) * media.duration;
  player.seeking = false;
});
$('pShuffle').addEventListener('click', () => {
  player.shuffle = !player.shuffle;
  $('pShuffle').classList.toggle('on', player.shuffle);
  if (player.queue.length) buildOrder(player.order[player.pos]);
  $('pSub').textContent = `${player.folder} · ${player.pos + 1} de ${player.queue.length}`;
});
$('pRepeat').addEventListener('click', () => {
  player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  $('pRepeat').textContent = player.repeat === 'one' ? '🔂' : '🔁';
  $('pRepeat').classList.toggle('on', player.repeat !== 'off');
  $('pRepeat').title = { off: 'Repetir: desligado', all: 'Repetir: todas', one: 'Repetir: esta' }[player.repeat];
});
function setVol(v) {
  media.volume = v / 100;
  media.muted = v === 0;
  $('pMute').textContent = v === 0 ? '🔇' : v < 40 ? '🔉' : '🔊';
}
$('pVol').addEventListener('input', (e) => setVol(Number(e.target.value)));
let lastVol = 80;
$('pMute').addEventListener('click', () => {
  const v = Number($('pVol').value);
  if (v) { lastVol = v; $('pVol').value = 0; setVol(0); } else { $('pVol').value = lastVol; setVol(lastVol); }
});
setVol(80);

// Espaço = tocar/pausar (fora de campos de texto); teclas de mídia do teclado.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || /INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) return;
  if (!media.src) return;
  e.preventDefault();
  togglePlay();
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => media.play());
  navigator.mediaSession.setActionHandler('pause', () => media.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

// ---------- atualização automática (em segundo plano, nunca bloqueia) ----------
const upd = { state: null, dismissed: false };

function renderUpdate(s) {
  if (!s) return;
  const prevStatus = upd.state?.status;
  upd.state = s;
  if (s.status !== prevStatus && (s.status === 'ready' || s.status === 'available')) upd.dismissed = false;

  const v = s.version ? `v${s.version}` : '';
  const STATUS = {
    idle: 'Ainda não verificado.',
    dev: 'Modo desenvolvimento: atualizações só funcionam no app instalado.',
    checking: 'Verificando…',
    latest: 'Você está na versão mais recente. ✓',
    downloading: `Baixando ${v} em segundo plano… ${s.percent || 0}%`,
    ready: `${v} pronta. Será instalada quando você fechar o app.`,
    available: `${v} disponível para download.`,
    error: `Não foi possível verificar agora (${s.error || 'erro'}).`,
  };
  $('updStatus').textContent = STATUS[s.status] || '';
  $('appVersion').textContent = `· versão atual v${s.current}`;
  $('updCheck').disabled = ['checking', 'downloading'].includes(s.status);

  // selo discreto no topo
  const pill = $('updPill');
  pill.hidden = !['downloading', 'ready', 'available'].includes(s.status);
  pill.textContent = s.status === 'downloading' ? `⬇ Atualizando ${s.percent || 0}%`
    : s.status === 'ready' ? `✓ ${v} pronta` : `★ ${v} disponível`;
  pill.title = STATUS[s.status] || '';

  // aviso (fechável) só quando há algo pra fazer
  const show = (s.status === 'ready' || s.status === 'available') && !upd.dismissed;
  $('updBar').hidden = !show;
  if (show) {
    $('updText').textContent = s.status === 'ready'
      ? `Atualização ${v} baixada. Ela é instalada sozinha quando você fechar o app, ou reinicie agora.`
      : `Nova versão ${v} disponível.`;
    $('updRestart').hidden = s.status !== 'ready';
    $('updDownload').hidden = s.status !== 'available';
  }
}

api.onUpdateState(renderUpdate);
$('updLater').addEventListener('click', () => { upd.dismissed = true; $('updBar').hidden = true; });
$('updPill').addEventListener('click', () => {
  if (upd.state?.status === 'downloading') { showTab('settings'); return; }
  upd.dismissed = false;
  renderUpdate(upd.state);
});
$('updRestart').addEventListener('click', () => {
  const busy = [...jobsById.values()].some(isActive);
  if (busy) {
    toast('Há downloads em andamento. A atualização será instalada quando você fechar o app.');
    return;
  }
  api.updateInstall();
});
$('updDownload').addEventListener('click', () => api.updateOpenPage());
$('updCheck').addEventListener('click', () => api.updateCheck());
$('autoUpdate').addEventListener('change', (e) => {
  api.setSetting('autoUpdate', e.target.checked);
  toast(e.target.checked ? 'Atualização automática ligada' : 'Atualização automática desligada');
});

// ---------- inicialização ----------
(async () => {
  const init = await api.init();
  state.outDir = init.outDir;
  state.format = init.format;
  state.quality = init.quality;
  renderQuality();
  renderOutDir();
  paintSeg('themeSeg', init.theme);
  $('parallelInput').value = init.maxParallel;
  $('autoUpdate').checked = init.autoUpdate;
  renderUpdate(init.update || { status: 'idle', current: init.version });
  state.saved = await api.savedList();
  renderSaved();
  loadLibrary();
  for (const j of await api.listJobs()) jobsById.set(j.id, j);
  renderDownloads();

  api.onSetupProgress((p) => {
    if (!state.ready) setEngine(`Baixando componente yt-dlp… ${Math.round(p * 100)}%`);
  });
  setEngine(init.hasYtDlp ? 'Verificando atualizações…' : 'Baixando componente yt-dlp…');
  try {
    const r = await api.ensureYtDlp();
    setEngine(r.status === 'updated' ? 'Pronto · yt-dlp atualizado' : 'Pronto', 'ok');
    state.ready = true;
    $('fetchBtn').disabled = false;
    $('searchBtn').disabled = false;
    syncSelectAll();
  } catch (err) {
    setEngine('Erro ao preparar o yt-dlp (verifique a internet)', 'err');
    log(String(err.message || err));
  }
  $('url').focus();
})();
