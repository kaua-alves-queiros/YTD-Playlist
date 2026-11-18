// Gerencia o binário do yt-dlp (download/atualização) e monta os comandos.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

function assetName() {
  if (isWin) return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

export function ytdlpPath(binDir) {
  return path.join(binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp');
}

export async function downloadYtDlp(binDir, onProgress = () => {}) {
  const dest = ytdlpPath(binDir);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`;
  fs.mkdirSync(binDir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Falha ao baixar yt-dlp (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let last = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (total && Date.now() - last > 150) { last = Date.now(); onProgress(got / total); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(tmp, dest);
  if (!isWin) fs.chmodSync(dest, 0o755);
  return dest;
}

export function run(exe, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (isWin) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else proc.kill('SIGTERM');
}

export function buildDownloadArgs({ url, format, quality, outDir, items, ffmpeg, jsRuntime, archive }) {
  const args = [
    '--newline', '--progress', '--quiet', '--no-simulate',
    '--ignore-errors', '--yes-playlist', '--no-overwrites', '--windows-filenames',
    '--concurrent-fragments', '4',
    '--ffmpeg-location', ffmpeg,
    '-P', outDir,
    '-o', '%(playlist_title|Downloads)s/%(playlist_index|1)03d - %(title)s.%(ext)s',
    '--progress-template',
    'download:PROG|%(info.playlist_index|1)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'before_dl:START|%(playlist_index|1)s|%(title)s',
    '--print', 'post_process:CONV|%(playlist_index|1)s',
    '--print', 'after_move:DONE|%(playlist_index|1)s|%(filepath)s',
    '--embed-metadata',
  ];
  if (jsRuntime) args.push('--js-runtimes', jsRuntime);
  // IDs já baixados: o yt-dlp pula antes mesmo de começar o download
  if (archive) args.push('--download-archive', archive);
  if (items?.length) args.push('--playlist-items', items.join(','));

  if (format === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', quality === 'low' ? '5' : '0',
      '--embed-thumbnail', '--convert-thumbnails', 'jpg');
  } else {
    const h = Number(quality) || 1080;
    args.push(
      '-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      '--merge-output-format', 'mp4',
    );
  }
  args.push(url);
  return args;
}
