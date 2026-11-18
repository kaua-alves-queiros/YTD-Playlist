import { app, BrowserWindow, ipcMain, dialog, shell, protocol, nativeTheme } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { ytdlpPath, downloadYtDlp, run, killTree, buildDownloadArgs } from './ytdlp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Permite rodar uma instância isolada (testes) sem tocar nos dados normais.
if (process.env.YTD_USER_DATA) app.setPath('userData', process.env.YTD_USER_DATA);
// Dentro do pacote, o ffmpeg fica fora do .asar (asarUnpack).
const ffmpeg = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
const binDir = path.join(app.getPath('userData'), 'bin');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

// O YouTube exige um runtime JavaScript para o yt-dlp. Usamos o próprio Electron
// como Node (ELECTRON_RUN_AS_NODE), assim o usuário não precisa instalar nada.
const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
const jsRuntime = `node:${process.execPath}`;

let win;

// Pasta única de downloads: só muda em Configurações. Tudo é salvo aqui dentro.
const defaultOutDir = () => path.join(app.getPath('downloads'), 'YTD Playlist');
function getOutDir() {
  const d = loadSettings().outDir;
  // ignora pastas temporárias ou inválidas e volta pro padrão
  if (!d || !path.isAbsolute(d)) return defaultOutDir();
  // (instâncias isoladas via YTD_USER_DATA podem usar pastas temporárias)
  if (!process.env.YTD_USER_DATA && isInside(path.resolve(d), path.resolve(app.getPath('temp')))) return defaultOutDir();
  return d;
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsFile, JSON.stringify({ ...loadSettings(), ...s }, null, 2)); } catch {}
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 640,
    minHeight: 520,
    title: 'YTD Playlist',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  // Avisa antes de fechar se ainda há downloads em andamento.
  win.on('close', (e) => {
    const n = activeJobs().length;
    if (!n) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Continuar baixando', 'Sair mesmo assim'],
      defaultId: 0, cancelId: 0,
      title: 'Downloads em andamento',
      message: `Há ${n} playlist(s) baixando ou na fila.`,
      detail: 'Se sair agora, os downloads param. Depois é só baixar de novo: o que já terminou não é baixado outra vez.',
    });
    if (r === 0) e.preventDefault();
  });
  // Links externos abrem no navegador padrão.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- IPC ----------

ipcMain.handle('init', async () => {
  const s = loadSettings();
  return {
    outDir: getOutDir(),
    format: s.format || 'mp3',
    quality: s.quality || 'best',
    hasYtDlp: fs.existsSync(ytdlpPath(binDir)),
    theme: s.theme || 'system',
    maxParallel,
    platform: process.platform,
  };
});

// ---------- configurações ----------
const THEMES = ['light', 'dark', 'system'];
function applyTheme(t) {
  nativeTheme.themeSource = THEMES.includes(t) ? t : 'system';
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#111318' : '#f4f5f7');
}
ipcMain.handle('set-setting', (_e, key, value) => {
  if (key === 'theme' && THEMES.includes(value)) {
    saveSettings({ theme: value });
    applyTheme(value);
  } else if (key === 'maxParallel') {
    maxParallel = Math.max(1, Math.floor(Number(value)) || 1);
    saveSettings({ maxParallel });
    pump(); // se aumentou, já começa os que estavam esperando
  }
  return true;
});

ipcMain.handle('ensure-ytdlp', async () => {
  const exe = ytdlpPath(binDir);
  if (!fs.existsSync(exe)) {
    await downloadYtDlp(binDir, (p) => send('setup-progress', p));
    return { status: 'downloaded' };
  }
  // Atualiza em segundo plano (o YouTube muda com frequência).
  const r = await run(exe, ['-U'], childEnv).catch(() => null);
  const updated = r && /Updated yt-dlp to/i.test(r.stdout + r.stderr);
  return { status: updated ? 'updated' : 'ok' };
});

ipcMain.handle('fetch-info', async (_e, url) => {
  const exe = ytdlpPath(binDir);
  const r = await run(exe, ['--flat-playlist', '-J', '--no-warnings', '--js-runtimes', jsRuntime, url], childEnv);
  if (r.code !== 0 || !r.stdout.trim()) {
    const msg = (r.stderr.match(/ERROR:.*$/m) || [r.stderr.trim() || 'Não foi possível ler o link.'])[0];
    throw new Error(msg);
  }
  const info = JSON.parse(r.stdout);
  const raw = Array.isArray(info.entries) ? info.entries : [info];
  const entries = raw.filter(Boolean).map((e, i) => ({
    index: i + 1,
    id: e.id,
    title: e.title || e.id,
    duration: e.duration || null,
    channel: e.channel || e.uploader || '',
    unavailable: !e.title || /^\[(private|deleted|unavailable)/i.test(e.title),
  }));
  const isPlaylist = Array.isArray(info.entries);
  return {
    id: info.id,
    url: isPlaylist ? (info.webpage_url || url) : url,
    title: info.title || info.playlist_title || 'Vídeo',
    channel: info.channel || info.uploader || '',
    thumb: pickThumb(info.thumbnails) || (entries[0] ? `https://i.ytimg.com/vi/${entries[0].id}/mqdefault.jpg` : ''),
    isPlaylist,
    entries,
  };
});

function pickThumb(thumbs) {
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const ok = thumbs.filter((t) => t.url && /^https:\/\/i\d?\.ytimg\.com\//.test(t.url));
  const mid = ok.find((t) => (t.width || 0) >= 300) || ok[ok.length - 1];
  return mid?.url || '';
}

// ---------- buscador de playlists ----------
ipcMain.handle('search-playlists', async (_e, query) => {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return [];
  // sp=EgIQAw== é o filtro "Playlists" da busca do YouTube.
  const url = `https://www.youtube.com/results?search_query=${q}&sp=EgIQAw%253D%253D`;
  const r = await run(ytdlpPath(binDir),
    ['--flat-playlist', '-J', '--no-warnings', '--playlist-end', '30', '--js-runtimes', jsRuntime, url], childEnv);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error((r.stderr.match(/ERROR:.*$/m) || ['A busca falhou. Tente novamente.'])[0]);
  }
  const info = JSON.parse(r.stdout);
  return (info.entries || [])
    .filter((e) => e && e.url && e.id)
    .map((e) => ({
      id: e.id,
      url: e.url,
      title: e.title || e.id,
      channel: e.channel || e.uploader || '',
      thumb: pickThumb(e.thumbnails),
    }));
});

// ---------- playlists salvas ----------
const savedFile = path.join(app.getPath('userData'), 'saved-playlists.json');
function readSaved() {
  try { return JSON.parse(fs.readFileSync(savedFile, 'utf8')); } catch { return []; }
}
function writeSaved(list) {
  fs.mkdirSync(path.dirname(savedFile), { recursive: true });
  fs.writeFileSync(savedFile, JSON.stringify(list, null, 2));
  return list;
}
ipcMain.handle('saved-list', () => readSaved());
ipcMain.handle('saved-add', (_e, p) => {
  const list = readSaved().filter((x) => x.id !== p.id);
  list.unshift({
    id: String(p.id), url: String(p.url), title: String(p.title || ''),
    channel: String(p.channel || ''), thumb: String(p.thumb || ''),
    count: Number(p.count) || null, savedAt: new Date().toISOString(),
  });
  return writeSaved(list);
});
ipcMain.handle('saved-remove', (_e, id) => writeSaved(readSaved().filter((x) => x.id !== id)));

ipcMain.handle('choose-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  saveSettings({ outDir: r.filePaths[0] });
  return r.filePaths[0];
});

ipcMain.handle('open-path', async (_e, p) => {
  if (!p) return;
  if (fs.existsSync(p) && fs.statSync(p).isFile()) shell.showItemInFolder(p);
  else {
    fs.mkdirSync(p, { recursive: true });
    await shell.openPath(p);
  }
});

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

// ---------- fila de downloads ----------
// Cada "job" é uma playlist (ou parte dela). Até maxParallel (configurável) baixam ao mesmo tempo; o resto espera na fila.
let maxParallel = Math.max(1, Math.floor(Number(loadSettings().maxParallel)) || 2);
const jobs = new Map();
let jobSeq = 0;

function publicJob(j) {
  return {
    id: j.id, title: j.title, url: j.url, playlistId: j.playlistId, thumb: j.thumb,
    format: j.format, quality: j.quality, outDir: j.outDir,
    status: j.status, total: j.total, done: j.done, failed: j.failed,
    current: j.current, lastFile: j.lastFile, error: j.error,
    createdAt: j.createdAt, finishedAt: j.finishedAt,
    states: Object.fromEntries(j.states),
  };
}
const activeJobs = () => [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued');

let pushTimer = null;
const dirty = new Set();
function pushJob(j, now = false) {
  dirty.add(j.id);
  if (now) return flushJobs();
  if (!pushTimer) pushTimer = setTimeout(flushJobs, 250);
}
function flushJobs() {
  clearTimeout(pushTimer);
  pushTimer = null;
  for (const id of dirty) {
    const j = jobs.get(id);
    send('job-update', j ? publicJob(j) : { id, removed: true });
  }
  dirty.clear();
}

function pump() {
  let running = [...jobs.values()].filter((j) => j.status === 'running').length;
  for (const j of jobs.values()) {
    if (running >= maxParallel) break;
    if (j.status === 'queued') { runJob(j); running++; }
  }
}

function runJob(j) {
  j.status = 'running';
  pushJob(j, true);
  const args = buildDownloadArgs({ ...j.opts, ffmpeg, jsRuntime });
  const proc = spawn(ytdlpPath(binDir), args, { env: childEnv, windowsHide: true });
  j.proc = proc;
  const ev = (data) => send('dl-event', { jobId: j.id, ...data });
  const setState = (index, s) => {
    const prev = j.states.get(index);
    if (prev === 'done' || prev === 'failed') return;
    j.states.set(index, s);
    if (s === 'done') j.done++;
    if (s === 'failed') j.failed++;
  };

  const handleLine = (line) => {
    line = line.trim();
    if (!line) return;
    const [kind, idx, ...rest] = line.split('|');
    const index = Number(idx) || 1;
    switch (kind) {
      case 'START': {
        const title = rest.join('|');
        setState(index, 'active');
        j.current = { index, title, percent: 0, speed: '', eta: '' };
        ev({ type: 'start', index, title });
        break;
      }
      case 'PROG': {
        const [pct, speed, eta] = rest;
        const p = { percent: parseFloat(pct) || 0, speed: (speed || '').trim(), eta: (eta || '').trim() };
        if (j.current?.index === index) Object.assign(j.current, p);
        ev({ type: 'progress', index, ...p });
        break;
      }
      case 'CONV':
        if (j.current?.index === index) Object.assign(j.current, { percent: 99, speed: '', eta: 'convertendo' });
        ev({ type: 'converting', index });
        break;
      case 'DONE':
        setState(index, 'done');
        j.lastFile = rest.join('|');
        ev({ type: 'done', index, file: j.lastFile });
        break;
      default:
        ev({ type: 'log', text: line });
    }
    pushJob(j);
  };

  const lineReader = (stream, isErr) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        if (!isErr) { handleLine(l); continue; }
        const t = l.trim();
        if (!t) continue;
        const m = t.match(/^ERROR: \[[^\]]+\] ([\w-]{6,}):\s*(.*)$/);
        const index = m && j.idToIndex.get(m[1]);
        if (index) { setState(index, 'failed'); pushJob(j); }
        ev({ type: 'error-line', id: m?.[1], index, text: m ? m[2] : t });
      }
    });
  };
  lineReader(proc.stdout, false);
  lineReader(proc.stderr, true);

  const finish = (code, error) => {
    if (j.status !== 'running') return;
    j.proc = null;
    j.current = null;
    j.finishedAt = Date.now();
    for (const index of j.indexes) {
      const s = j.states.get(index);
      if (s === 'done' || s === 'failed') continue;
      if (j.cancelled) j.states.set(index, 'cancelled');
      else setState(index, 'failed');
    }
    j.status = j.cancelled ? 'cancelled' : error ? 'error' : j.failed ? 'partial' : 'done';
    j.error = error || null;
    ev({ type: 'finished', code, cancelled: j.cancelled, error });
    pushJob(j, true);
    pump();
  };
  proc.on('error', (err) => finish(-1, err.message));
  proc.on('close', (code) => finish(code));
}

ipcMain.handle('start-download', async (_e, opts) => {
  opts = { ...opts, outDir: getOutDir() }; // sempre a pasta das Configurações
  const dup = activeJobs().find((j) => j.url === opts.url && j.format === opts.format);
  if (dup) throw new Error('Essa playlist já está na fila de downloads neste formato.');
  saveSettings({ format: opts.format, quality: opts.quality });
  fs.mkdirSync(opts.outDir, { recursive: true });
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const j = {
    id: ++jobSeq,
    title: String(opts.title || 'Playlist'),
    url: opts.url, playlistId: opts.playlistId || null, thumb: opts.thumb || '',
    format: opts.format, quality: opts.quality, outDir: opts.outDir,
    opts: { url: opts.url, format: opts.format, quality: opts.quality, outDir: opts.outDir, items: opts.items },
    indexes: entries.map((e) => e.index),
    idToIndex: new Map(entries.map((e) => [e.id, e.index])),
    total: entries.length || 1, done: 0, failed: 0,
    states: new Map(entries.map((e) => [e.index, 'queued'])),
    status: 'queued', current: null, lastFile: null, error: null, cancelled: false,
    createdAt: Date.now(), finishedAt: null, proc: null,
  };
  jobs.set(j.id, j);
  pushJob(j, true);
  pump();
  return publicJob(j);
});

ipcMain.handle('list-jobs', () => [...jobs.values()].map(publicJob));

ipcMain.handle('cancel-job', (_e, id) => {
  const j = jobs.get(id);
  if (!j) return;
  if (j.status === 'queued') {
    j.status = 'cancelled';
    j.finishedAt = Date.now();
    for (const index of j.indexes) j.states.set(index, 'cancelled');
    send('dl-event', { jobId: j.id, type: 'finished', cancelled: true });
    pushJob(j, true);
  } else if (j.status === 'running') {
    j.cancelled = true;
    killTree(j.proc);
  }
});

ipcMain.handle('remove-job', (_e, id) => {
  const j = jobs.get(id);
  if (!j || j.status === 'running' || j.status === 'queued') return;
  jobs.delete(id);
  pushJob({ id }, true);
});

ipcMain.handle('clear-finished', () => {
  for (const j of [...jobs.values()]) {
    if (j.status !== 'running' && j.status !== 'queued') { jobs.delete(j.id); dirty.add(j.id); }
  }
  flushJobs();
});

// ---------- biblioteca / player ----------
const MEDIA_EXT = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.ogg': 'audio/ogg',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.wav': 'audio/wav', '.flac': 'audio/flac',
};
const allowedRoots = new Set(); // só servimos arquivos de pastas que a biblioteca escaneou

function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

ipcMain.handle('library-scan', async (_e, root) => {
  root = path.resolve(String(root || ''));
  if (!fs.existsSync(root)) return [];
  allowedRoots.add(root);
  const groups = new Map();
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
      const ext = path.extname(d.name).toLowerCase();
      if (!MEDIA_EXT[ext]) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const folder = path.relative(root, dir) || '(pasta principal)';
      if (!groups.has(folder)) groups.set(folder, []);
      const base = path.basename(d.name, ext);
      groups.get(folder).push({
        path: full,
        name: d.name,
        title: base.replace(/^\d{1,4} - /, ''),
        num: Number((base.match(/^(\d{1,4}) - /) || [])[1]) || null,
        video: MEDIA_EXT[ext].startsWith('video/'),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  };
  walk(root, 0);
  return [...groups.entries()]
    .map(([folder, files]) => ({
      folder,
      files: files.sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.name.localeCompare(b.name)),
      mtime: Math.max(...files.map((f) => f.mtime)),
    }))
    .sort((a, b) => b.mtime - a.mtime);
});

// ytd-media://file/<caminho codificado> — com suporte a Range (para poder avançar na música).
protocol.registerSchemesAsPrivileged([
  { scheme: 'ytd-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

function serveMedia(request) {
  const u = new URL(request.url);
  const file = path.resolve(decodeURIComponent(u.pathname.slice(1)));
  const type = MEDIA_EXT[path.extname(file).toLowerCase()];
  if (!type || ![...allowedRoots].some((r) => isInside(file, r)) || !fs.existsSync(file)) {
    return new Response('not found', { status: 404 });
  }
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!range[1] && range[2]) { start = Math.max(0, size - Number(range[2])); end = size - 1; }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) },
  });
}

// ---------- ciclo de vida ----------

app.whenReady().then(() => {
  protocol.handle('ytd-media', serveMedia);
  applyTheme(loadSettings().theme);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const j of jobs.values()) if (j.proc) { j.cancelled = true; killTree(j.proc); }
  if (process.platform !== 'darwin') app.quit();
});
