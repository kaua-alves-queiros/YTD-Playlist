// Atualização automática a partir dos Releases do GitHub.
// Tudo roda em segundo plano: verifica, baixa e instala ao fechar o app.
// Nada aqui bloqueia o uso — a interface só recebe avisos discretos.
import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const OWNER = 'kaua-alves-queiros';
const REPO = 'YTD-Playlist';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000; // 4 horas

// Onde dá pra se atualizar sozinho:
// - Windows instalado (NSIS) e Linux AppImage: sim.
// - Windows portátil, .deb e macOS (sem assinatura paga): só avisa e abre a página de download.
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE);
  return false;
}

function isNewer(remote, current) {
  const parse = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const a = parse(remote), b = parse(current);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

export function setupUpdater({ send, getAutoUpdate }) {
  const mode = canSelfUpdate() ? 'auto' : 'manual';
  let state = { status: 'idle', mode, current: app.getVersion(), version: null, percent: 0, url: RELEASES_URL, error: null };
  const emit = (patch) => { state = { ...state, ...patch }; send('update-state', state); return state; };
  const shortErr = (e) => String(e?.message || e).split('\n')[0].slice(0, 200);

  if (mode === 'auto') {
    autoUpdater.autoDownload = true;          // baixa em paralelo, sem perguntar
    autoUpdater.autoInstallOnAppQuit = true;  // instala quando o usuário fechar o app
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => emit({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (i) => emit({ status: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => emit({ status: 'latest' }));
    autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => emit({ status: 'ready', version: i.version, percent: 100 }));
    autoUpdater.on('error', (e) => emit({ status: 'error', error: shortErr(e) }));
  }

  async function checkManual() {
    emit({ status: 'checking', error: null });
    try {
      const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'YTD-Playlist-updater' },
      });
      if (r.status === 404) return emit({ status: 'latest' }); // ainda não há releases
      if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
      const rel = await r.json();
      const v = String(rel.tag_name || '').replace(/^v/, '');
      return isNewer(v, state.current)
        ? emit({ status: 'available', version: v, url: rel.html_url || RELEASES_URL })
        : emit({ status: 'latest' });
    } catch (e) {
      return emit({ status: 'error', error: shortErr(e) });
    }
  }

  function check() {
    if (!app.isPackaged) return emit({ status: 'dev' });
    if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
    if (mode === 'auto') {
      // não esperamos: o resultado chega pelos eventos acima
      autoUpdater.checkForUpdates().catch((e) => emit({ status: 'error', error: shortErr(e) }));
      return emit({ status: 'checking', error: null });
    }
    checkManual();
    return state;
  }

  // Verificação automática: alguns segundos depois de abrir e depois a cada 4h.
  const auto = () => { if (getAutoUpdate()) check(); };
  setTimeout(auto, 8000);
  setInterval(auto, CHECK_EVERY_MS);

  return {
    getState: () => state,
    check,
    // reinicia já instalando (só quando o usuário pede)
    installNow: () => { if (state.status === 'ready') setImmediate(() => autoUpdater.quitAndInstall(true, true)); },
    openPage: () => shell.openExternal(state.url || RELEASES_URL),
  };
}
