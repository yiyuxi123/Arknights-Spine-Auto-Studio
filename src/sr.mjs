// Optional AI super-resolution engine integration (ncnn-vulkan family).
//
// These are portable single-folder executables (no pip / no CUDA / no npm):
//   - Real-ESRGAN (default):  anime-optimized RealESRGAN_x4plus_anime_6B,
//     the community-standard model for anime/cartoon upscaling.
//   - waifu2x: classic anime upscaler (nihui build, updated 2025).
//   - realcugan: anime upscaler with 2x/3x/4x models.
//
// The engine is downloaded on demand (like vendor/ffmpeg) and cached under
// vendor/<name>/. Two CLI conventions exist in the ncnn-vulkan family:
//   waifu2x / realesrgan:  <exe> -i in -o out -s N -m <modelsDir> -n <model> -g <gpu>
//   realcugan:             <exe> -i in -o out -s N -m <modelPathPrefix> -g <gpu>
//
// Requirements: a Vulkan-capable GPU (most Intel/AMD/NVIDIA Windows drivers).
// If the engine fails (no Vulkan etc.) callers should fall back to Lanczos3.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(root, 'vendor');

// ---------------------------------------------------------------------------
// engine registry
// ---------------------------------------------------------------------------
const ENGINES = {
  realesrgan: {
    label: 'Real-ESRGAN (anime6B)',
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
    sizeBytes: 45474481,
    exe: 'realesrgan-ncnn-vulkan.exe',
    defaultScale: 4,
    modelHints: ['x4plus-anime', 'anime6b', 'anime'],
  },
  waifu2x: {
    label: 'waifu2x (cunet)',
    url: 'https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/20250915/waifu2x-ncnn-vulkan-20250915-windows.zip',
    sizeBytes: 35497352,
    exe: 'waifu2x-ncnn-vulkan.exe',
    defaultScale: 2,
    modelHints: ['cunet'],
  },
  realcugan: {
    label: 'Real-CUGAN (anime)',
    url: 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip',
    sizeBytes: 45977449,
    exe: 'realcugan-ncnn-vulkan.exe',
    defaultScale: 4,
    // dirs: models-se (2x/3x/4x) > models-pro > models-nose (2x only)
    modelHints: ['models-se', 'models-pro', 'models-nose'],
    // realcugan CLI: -m <model-path-prefix> (no -n model name option)
    argMode: 'dir-only',
  },
};

export function listEngines() {
  return Object.entries(ENGINES).map(([name, spec]) => ({
    name,
    label: spec.label,
    defaultScale: spec.defaultScale,
    url: spec.url,
    sizeMb: (spec.sizeBytes / 1048576).toFixed(1),
  }));
}

// ---------------------------------------------------------------------------
// minimal pure-JS zip reader (deflate entries, no zip64)
// ---------------------------------------------------------------------------
export function unzipEntries(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`zip: bad central directory entry ${n}`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = new Map();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (buf.readUInt32LE(entry.localOff) !== 0x04034b50) {
      throw new Error(`zip: bad local header for ${entry.name}`);
    }
    const lNameLen = buf.readUInt16LE(entry.localOff + 26);
    const lExtraLen = buf.readUInt16LE(entry.localOff + 28);
    const dataStart = entry.localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + entry.compSize);
    let raw;
    if (entry.method === 0) raw = Buffer.from(data);
    else if (entry.method === 8) raw = inflateRawSync(data);
    else throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
    out.set(entry.name, raw);
  }
  return out;
}

function safeJoin(base, rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error(`zip: unsafe path ${rel}`);
  return path.join(base, ...parts);
}

function extractZip(entries, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const [name, data] of entries) {
    const target = safeJoin(destDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(target);
  }
  return written;
}

// ---------------------------------------------------------------------------
// download with progress
// ---------------------------------------------------------------------------
async function downloadToFile(url, dest, { onProgress = () => {} } = {}) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const total = Number(resp.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    received += value.length;
    onProgress(received, total);
  }
  const buf = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// model discovery (handles both layouts: <exe>/models/ and <exe>/models-cunet/)
// ---------------------------------------------------------------------------
function pickModel(modelsDir, hints = []) {
  if (!fs.existsSync(modelsDir)) return null;
  const params = fs.readdirSync(modelsDir).filter((f) => f.endsWith('.param'));
  if (params.length === 0) return null;
  const strip = (p) => p.slice(0, -'.param'.length);
  const lower = params.map((p) => p.toLowerCase());
  for (const hint of [...hints, 'scale2.0x_model', 'scale2.0x']) {
    const i = lower.findIndex((p) => p.includes(hint.toLowerCase()));
    if (i >= 0) return strip(params[i]);
  }
  return strip(params[0]);
}

function locateModelsDir(exeDir, hints = []) {
  const hasParams = (dir) => {
    try { return fs.readdirSync(dir).some((f) => f.endsWith('.param')); } catch { return false; }
  };
  const direct = path.join(exeDir, 'models');
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    if (hasParams(direct)) return direct;
    const inner = fs.readdirSync(direct, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(direct, d.name))
      .find(hasParams);
    if (inner) return inner;
  }
  const subdirs = fs.readdirSync(exeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const hint of hints) {
    const hit = subdirs.find((d) => d.toLowerCase().includes(hint.toLowerCase()));
    if (hit && hasParams(path.join(exeDir, hit))) return path.join(exeDir, hit);
  }
  for (const d of subdirs) {
    const dir = path.join(exeDir, d);
    if (hasParams(dir)) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// engine resolution / installation
// ---------------------------------------------------------------------------
function findFile(entries, matcher) {
  for (const name of entries.keys()) {
    if (matcher(name)) return name;
  }
  return null;
}

async function ensureInstalled(name, spec, { force = false, onLog = () => {}, onProgress } = {}) {
  const destDir = path.join(vendorDir, name);
  const existing = fs.existsSync(destDir)
    ? fs.readdirSync(destDir, { recursive: true }).find((f) => f.toLowerCase().endsWith('.exe'))
    : null;
  if (existing && !force) {
    return { exePath: path.join(destDir, existing) };
  }
  const zipName = path.basename(new URL(spec.url).pathname);
  const zipPath = path.join(destDir, zipName);
  onLog(`[sr] 下载 ${spec.label}（${(spec.sizeBytes / 1048576).toFixed(0)} MB）...`);
  let lastPct = 0;
  await downloadToFile(spec.url, zipPath, {
    onProgress: (received, total) => {
      if (onProgress) onProgress(received, total);
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct >= lastPct + 10) {
        lastPct = pct;
        onLog(`  [sr] ${pct}% (${(received / 1048576).toFixed(0)} MB)`);
      }
    },
  });
  onLog(`[sr] 解压 ${zipName} ...`);
  const entries = unzipEntries(fs.readFileSync(zipPath));
  const exeEntry = findFile(entries, (n) => n.toLowerCase().endsWith(spec.exe.toLowerCase()));
  if (!exeEntry) throw new Error(`zip 中未找到 ${spec.exe}`);
  if (existing) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  extractZip(entries, destDir);
  fs.rmSync(zipPath, { force: true });
  return { exePath: path.join(destDir, exeEntry) };
}

/**
 * Resolve an SR engine handle.
 * @param {string|null} spec  engine name ('realesrgan'|'waifu2x'|'realcugan')
 *                            or a path to an existing ncnn-vulkan exe.
 * @returns {Promise<object>} handle with .run({input, outputFile, scale, gpu, tile})
 */
export async function resolveEngine(spec = null, { force = false, onLog = () => {}, onProgress } = {}) {
  let name, label, exePath, defaultScale, modelHints = [], argMode = 'dir-name';
  if (spec && !ENGINES[spec]) {
    // custom exe path
    exePath = path.resolve(spec);
    if (!fs.existsSync(exePath)) throw new Error(`SR 引擎不存在: ${exePath}`);
    name = 'custom';
    label = path.basename(exePath);
    defaultScale = 4;
  } else {
    name = spec || 'realesrgan';
    const engine = ENGINES[name];
    if (!engine) {
      throw new Error(`未知 SR 引擎 "${name}"，可用: ${Object.keys(ENGINES).join(', ')}`);
    }
    label = engine.label;
    defaultScale = engine.defaultScale;
    modelHints = engine.modelHints;
    argMode = engine.argMode || 'dir-name';
    const installed = await ensureInstalled(name, engine, { force, onLog, onProgress });
    exePath = installed.exePath;
  }
  const modelsDir = locateModelsDir(path.dirname(exePath), modelHints);
  onLog(modelsDir
    ? `[sr] 引擎就绪: ${label} (${exePath}) 模型目录=${modelsDir}`
    : `[sr] 引擎就绪: ${label} (${exePath})（未发现模型目录）`);

  // Scale-aware model selection: realcugan ships up2x/up3x/up4x model sets.
  const pickForScale = (scale) => {
    if (argMode === 'prefix' && scale) {
      return pickModel(modelsDir, [`up${scale}x-no-denoise`, `up${scale}x-conservative`, `up${scale}x`]) || pickModel(modelsDir, modelHints);
    }
    return pickModel(modelsDir, modelHints);
  };

  return {
    name,
    label,
    defaultScale,
    async run({ input, outputFile, scale, gpu = 0, tile = 0 }) {
      const tmpIn = path.join(path.dirname(outputFile), `.sr-input-${Date.now()}.png`);
      fs.writeFileSync(tmpIn, input);
      // realcugan selects the model internally from -m <dir> (no -n option);
      // waifu2x/realesrgan take -m <dir> -n <model>.
      const model = argMode === 'dir-only' ? null : pickForScale(scale);
      const args = ['-i', tmpIn, '-o', outputFile, '-s', String(scale), '-g', String(gpu), '-t', String(tile)];
      if (argMode === 'dir-only') {
        if (modelsDir) args.push('-m', modelsDir);
      } else if (modelsDir && model) {
        args.push('-m', modelsDir, '-n', model);
      }
      try {
        const res = await runEngine(exePath, args, 180000);
        if (!res.ok || !fs.existsSync(outputFile) || fs.statSync(outputFile).size === 0) {
          return { ok: false, error: (res.error || 'engine produced no output').slice(0, 400) };
        }
        return { ok: true, output: fs.readFileSync(outputFile) };
      } finally {
        try { fs.rmSync(tmpIn, { force: true }); } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// async engine runner
// ---------------------------------------------------------------------------
// Never blocks the event loop: a stuck GPU call must not freeze the whole
// server. On timeout the entire process tree is killed.
function runEngine(exePath, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    let child = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      resolve({ ok: false, error: 'engine timed out after ' + Math.round(timeoutMs / 1000) + 's' });
    }, timeoutMs);
    try {
      child = spawn(exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
      return;
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 2e6) stdout = stdout.slice(-2e6); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 2e6) stderr = stderr.slice(-2e6); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, error: (stderr || stdout).trim().slice(0, 400), code });
    });
  });
}
function killTree(child) {
  if (!child || child.pid == null) return;
  try { child.kill(); } catch {}
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// standalone CLI: node src/sr.mjs <engine> <in.png> <out.png> [scale]
// ---------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const [engineName, input, output, scaleArg] = argv;
  if (!engineName || engineName === '--help' || !input || !output) {
    console.log(`
用法: node src/sr.mjs <引擎名|exe路径> <in.png> <out.png> [scale]

引擎:
${listEngines().map((e) => `  ${e.name.padEnd(12)} ${e.label}（原生 x${e.defaultScale}，${e.sizeMb} MB）`).join('\n')}
首次使用会自动下载并缓存到 vendor/<引擎名>/（需要 Vulkan 显卡）。
`);
    return 1;
  }
  const handle = await resolveEngine(engineName, { onLog: (m) => console.log(m) });
  const scale = parseInt(scaleArg || '0', 10) || handle.defaultScale;
  const result = await handle.run({ input: fs.readFileSync(path.resolve(input)), outputFile: path.resolve(output), scale });
  if (!result.ok) {
    console.error('[sr] 失败:', result.error);
    return 1;
  }
  console.log(`[done] ${output} (x${scale})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error('\n[error]', err.stack || err.message || err);
      process.exit(1);
    },
  );
}
