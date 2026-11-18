// Registro do que já foi baixado, por ID do vídeo (que nunca muda no YouTube).
// Fica em <pasta de downloads>/.ytd-index.json, então acompanha as músicas se a pasta for movida.
//
// Uma música conta como "já baixada" se:
//  1. o ID está no registro e o arquivo ainda existe no disco; ou
//  2. (para arquivos baixados antes do registro existir) há um arquivo com o mesmo título
//     na pasta da playlist — nesse caso ele é adicionado ao registro.
// Se você apagar o arquivo, a música volta a poder ser baixada.
import fs from 'node:fs';
import path from 'node:path';

const INDEX_NAME = '.ytd-index.json';
export const FORMAT_EXT = { mp3: ['.mp3'], mp4: ['.mp4', '.mkv', '.webm'] };

// Compara nomes ignorando acentuação de largura, símbolos, emojis e caixa
// (o yt-dlp troca caracteres proibidos no Windows por variantes Unicode).
export const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const stripNum = (base) => base.replace(/^\d{1,4} - /, '');

function readIndex(outDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(outDir, INDEX_NAME), 'utf8'));
    return { mp3: j.mp3 || {}, mp4: j.mp4 || {} };
  } catch {
    return { mp3: {}, mp4: {} };
  }
}
function writeIndex(outDir, idx) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, INDEX_NAME), JSON.stringify(idx, null, 1));
  } catch {}
}

function findPlaylistFolder(outDir, folderTitle) {
  const want = norm(folderTitle);
  if (!want) return null;
  try {
    for (const d of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (d.isDirectory() && norm(d.name) === want) return path.join(outDir, d.name);
    }
  } catch {}
  return null;
}

/**
 * Descobre quais entradas já estão baixadas.
 * @returns Map<index, { id, file, folder }>
 */
export function findExisting(outDir, { folderTitle, format, entries }) {
  const exts = FORMAT_EXT[format] || FORMAT_EXT.mp3;
  const idx = readIndex(outDir);
  const reg = idx[format] || (idx[format] = {});
  const found = new Map();
  let changed = false;

  // 1) pelo ID
  for (const e of entries) {
    const rel = e.id && reg[e.id];
    if (!rel) continue;
    const abs = path.join(outDir, rel);
    if (fs.existsSync(abs)) found.set(e.index, { id: e.id, file: abs, folder: path.dirname(rel) });
    else { delete reg[e.id]; changed = true; } // arquivo apagado: pode baixar de novo
  }

  // 2) pelo título, na pasta desta playlist (downloads antigos, sem registro)
  const folder = findPlaylistFolder(outDir, folderTitle);
  if (folder) {
    const byTitle = new Map();
    try {
      for (const f of fs.readdirSync(folder)) {
        const ext = path.extname(f).toLowerCase();
        if (!exts.includes(ext)) continue;
        byTitle.set(norm(stripNum(path.basename(f, ext))), path.join(folder, f));
      }
    } catch {}
    for (const e of entries) {
      if (found.has(e.index) || !e.id) continue;
      const abs = byTitle.get(norm(e.title));
      if (!abs) continue;
      const rel = path.relative(outDir, abs);
      reg[e.id] = rel;
      changed = true;
      found.set(e.index, { id: e.id, file: abs, folder: path.dirname(rel) });
    }
  }

  if (changed) writeIndex(outDir, idx);
  return found;
}

/** Registra um download concluído. */
export function recordDownload(outDir, format, id, file) {
  if (!id || !file) return;
  const rel = path.relative(outDir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const idx = readIndex(outDir);
  (idx[format] || (idx[format] = {}))[id] = rel;
  writeIndex(outDir, idx);
}
