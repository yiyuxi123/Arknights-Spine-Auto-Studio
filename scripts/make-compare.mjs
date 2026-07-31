// make-compare.mjs — build a labeled multi-panel quality comparison image.
//
// Usage:
//   node scripts/make-compare.mjs --atlas assets/amiya/amiya.atlas --png assets/amiya/amiya.png
//                                 [--scale 4] [--out out/compare.png] [--region F_Face]
//                                 [--engines realesrgan,waifu2x] [--no-labels]
//
// Panels: 1. 原图 (nearest) | 2. Lanczos3 xN | 3..N. AI engines (xN, via native
// scale + Lanczos bridge). Each panel gets a colored top bar (always, pure JS);
// FFmpeg drawtext adds text labels on top when available.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decodePng, encodePng } from '../src/png.mjs';
import { resizeRgba } from '../src/upscale.mjs';
import { atlasPageSize } from '../src/align.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 面板顶部色条（纯 JS 绘制，保证无 ffmpeg 时也能区分方案；顺序与面板一致）
const BAR_COLORS = [
  [140, 148, 160], // 1. 原图      灰
  [64, 148, 255],  // 2. Lanczos3  蓝
  [0, 200, 130],   // 3. Real-ESRGAN 绿
  [180, 120, 255], // 4. Waifu2x   紫
];
const BAR_H = 24;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    let value = eq >= 0 ? arg.slice(eq + 1) : null;
    if (value === null && i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
    args[key] = value === null ? true : value;
  }
  return args;
}

function readRegionRect(atlasText, regionName) {
  const lines = atlasText.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === regionName);
  if (idx < 0) throw new Error(`atlas 中未找到区域 ${regionName}`);
  const block = {};
  for (let j = idx + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
    const m = lines[j].match(/^\s*([A-Za-z]+):\s*(.*)$/);
    if (m) block[m[1]] = m[2];
  }
  if (!block.xy || !block.size) throw new Error(`区域 ${regionName} 缺少 xy/size`);
  const xy = block.xy.split(',').map((v) => parseInt(v, 10));
  const size = block.size.split(',').map((v) => parseInt(v, 10));
  return { x: xy[0], y: xy[1], w: size[0], h: size[1], rotate: block.rotate === 'true' };
}

// 自动挑选对比区域：优先名字含 face/head/头/脸 的区域，否则取面积最大的区域。
function pickRegion(atlasText) {
  const lines = atlasText.split(/\r?\n/);
  const regions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || line.startsWith(' ')) continue;
    if (t.includes(':')) continue;                 // 页面级属性（size:/format:...）
    if (/\.(png|jpg|jpeg|webp)$/i.test(t)) continue; // 页面文件名行
    const block = {};
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith(' ')) {
      const m = lines[j].match(/^\s*([A-Za-z]+):\s*(.*)$/);
      if (m) block[m[1]] = m[2];
      j++;
    }
    if (block.xy && block.size) {
      const xy = block.xy.split(',').map((v) => parseInt(v, 10));
      const size = block.size.split(',').map((v) => parseInt(v, 10));
      regions.push({ name: t, x: xy[0], y: xy[1], w: size[0], h: size[1], rotate: block.rotate === 'true' });
    }
    i = j - 1;
  }
  if (!regions.length) throw new Error('atlas 中未解析到任何区域');
  const prio = /face|head|头|脸/i;
  const hit = regions.filter((r) => prio.test(r.name)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return hit || regions.sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

function cropRgba(rgba, W, x0, y0, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

function rotateCCW(rgba, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = (x * h + (h - 1 - y)) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

function nearestUp(rgba, cw, ch, s) {
  const out = new Uint8Array(cw * s * ch * s * 4);
  for (let y = 0; y < ch * s; y++) {
    for (let x = 0; x < cw * s; x++) {
      const si = ((y / s | 0) * cw + (x / s | 0)) * 4;
      const di = (y * cw * s + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

// 灰色占位面板（引擎不可用时）
function placeholderPanel(w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const di = i * 4;
    out[di] = 210; out[di + 1] = 210; out[di + 2] = 214; out[di + 3] = 255;
  }
  return out;
}

async function renderLabels(inputFile, outputFile, labels) {
  if (!labels.length) return outputFile;
  const ffmpegCandidates = [
    path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe'),
    'ffmpeg',
  ];
  let ffmpeg = null;
  for (const c of ffmpegCandidates) {
    const probe = spawnSync(c, ['-version'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) { ffmpeg = c; break; }
  }
  if (!ffmpeg) {
    console.log('[compare] 未找到 ffmpeg，仅保留彩色色条标识（无文字）');
    return outputFile;
  }
  const fonts = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyh.ttf', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/arial.ttf'];
  const font = fonts.find((f) => fs.existsSync(f));
  const vf = labels
    .map((label, i) => {
      const esc = String(label.text).replace(/:/g, '\\:').replace(/'/g, '\\\'');
      return `drawtext=${font ? `fontfile=${font.replace(/:/g, '\\:')}:` : ''}text='${esc}':x=${label.x}:y=${label.y}:fontsize=30:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8`;
    })
    .join(',');
  const res = spawnSync(ffmpeg, ['-y', '-i', inputFile, '-vf', vf, '-q:v', '2', outputFile], {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  if (res.status !== 0) {
    console.log('[compare] 标注失败，保留色条版本:', (res.stderr || '').split('\n')[0]);
    return inputFile;
  }
  return outputFile;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.atlas || !args.png) {
    console.log(`
用法: node scripts/make-compare.mjs --atlas a.atlas --png a.png [--scale 4] [--out out.png]
                                    [--region F_Face] [--engines realesrgan,waifu2x] [--no-labels]

  --atlas PATH       源 .atlas（用于定位对比区域）
  --png PATH         源 PNG 贴图页
  --scale N          对比放大倍数（默认 4）
  --region NAME      截取哪个贴图区域（默认 F_Face，不存在时自动选最大区域）
  --engines LIST     参与对比的 AI 引擎，逗号分隔（默认 realesrgan,waifu2x）
  --out PATH         输出 PNG（默认 out/compare-<name>.png）
  --no-labels        不画文字标注（色条标识始终绘制）
`);
    return 1;
  }
  const scale = parseInt(args.scale || '4', 10) || 4;
  const regionName = args.region || 'F_Face';
  const engines = (args.engines === true || args.engines === '') ? [] : String(args.engines || 'realesrgan,waifu2x').split(',').map((s) => s.trim()).filter(Boolean);
  const atlasPath = path.resolve(args.atlas);
  const pngPath = path.resolve(args.png);
  if (!fs.existsSync(atlasPath) || !fs.existsSync(pngPath)) {
    console.error(`[compare] 文件不存在: ${atlasPath} / ${pngPath}`);
    return 2;
  }

  const orig = decodePng(fs.readFileSync(pngPath));
  const atlasText = fs.readFileSync(atlasPath, 'utf8');

  // 默认区域（F_Face）有时只是小配件：优先采用名称命中 face/head/头/脸 且面积更大的区域
  let rect = null;
  let preferred = null;
  try { preferred = pickRegion(atlasText); } catch { /* 空 atlas 由下方统一报错 */ }
  try {
    const named = readRegionRect(atlasText, regionName);
    if (
      preferred &&
      preferred.name !== regionName &&
      /face|head|头|脸/i.test(preferred.name) &&
      preferred.w * preferred.h > named.w * named.h
    ) {
      console.log('[compare] ' + regionName + ' 面积偏小（可能是配件），改用 ' + preferred.name + ' ' + preferred.w + 'x' + preferred.h);
      rect = preferred;
    } else {
      rect = named;
    }
  } catch {
    if (preferred) {
      console.log('[compare] 未找到 ' + regionName + '，自动选择区域 ' + preferred.name + '@(' + preferred.x + ',' + preferred.y + ') ' + preferred.w + 'x' + preferred.h);
      rect = preferred;
    }
  }
  if (!rect) throw new Error('atlas 中未解析到任何区域');

  // PRTS 贴图可能被降采样（如 368x368 vs atlas 548x548）：按 PNG 实际尺寸换算坐标，
  // 避免裁切越界/错位产生黑条。换算后再裁切，四个方案始终基于同一区域。
  try {
    const a = atlasPageSize(atlasText);
    const coordScale = Math.max(orig.width / a.width, orig.height / a.height);
    if (Math.abs(coordScale - 1) > 0.001) {
      console.log(`[compare] PNG ${orig.width}x${orig.height} 与 atlas ${a.width}x${a.height} 不匹配，区域坐标已按 x${coordScale.toFixed(3)} 换算`);
      rect = { x: Math.round(rect.x * coordScale), y: Math.round(rect.y * coordScale), w: Math.round(rect.w * coordScale), h: Math.round(rect.h * coordScale) };
    }
  } catch { /* 解析失败时按 1:1 处理 */ }

    // rotate:true 的区域在贴图里是旋转存放的：先裁出 (h x w) 块，再逆时针旋转回正
  let work = { rgba: orig.rgba, width: orig.width, height: orig.height };
  if (rect.rotate) {
    const block = cropRgba(orig.rgba, orig.width, rect.x, rect.y, rect.h, rect.w);
    const upright = rotateCCW(block, rect.h, rect.w);
    work = { rgba: upright, width: rect.w, height: rect.h };
    rect = { x: 0, y: 0, w: rect.w, h: rect.h, rotate: false };
    console.log('[compare] rotate=true 区域已旋转回正 (' + work.width + 'x' + work.height + ')');
  }

  const C = Math.min(128, work.width, work.height);
  const cx = Math.max(0, Math.min(work.width - C, rect.x + Math.max(0, ((rect.w - C) / 2) | 0)));
  const cy = Math.max(0, Math.min(work.height - C, rect.y + Math.max(0, ((rect.h - C) / 2) | 0)));
  console.log('[compare] 区域 ' + regionName + '@(' + rect.x + ',' + rect.y + ') -> 裁切 (' + cx + ',' + cy + ') x' + C);

  const P = C * scale;
  const panels = [];
  const labels = [];
  panels.push(nearestUp(cropRgba(work.rgba, work.width, cx, cy, C, C), C, C, scale));
  labels.push({ text: '1. 原图 (nearest)', x: 16, y: BAR_H + 8 });

  const lanczosFull = resizeRgba(work.rgba, work.width, work.height, work.width * scale, work.height * scale);
  panels.push(cropRgba(lanczosFull, work.width * scale, cx * scale, cy * scale, P, P));
  labels.push({ text: `2. Lanczos3 x${scale}`, x: P + 16, y: BAR_H + 8 });

  const { resolveEngine } = await import('../src/sr.mjs');
  for (const engineName of engines) {
    console.log(`[compare] 引擎 ${engineName} ...`);
    let handle;
    try {
      handle = await resolveEngine(engineName, { onLog: (m) => console.log('  ', m) });
    } catch (err) {
      console.log(`  [compare] 引擎 ${engineName} 不可用：${err.message}，使用占位面板`);
      panels.push(placeholderPanel(P, P));
      labels.push({ text: `${panels.length}. ${engineName} 不可用`, x: (panels.length - 1) * P + 16, y: BAR_H + 8 });
      continue;
    }
    const srOut = path.join(os.tmpdir(), `.compare-${engineName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
      const result = await handle.run({
        input: fs.readFileSync(pngPath),
        outputFile: srOut,
        scale: handle.defaultScale,
      });
      if (!result.ok) {
        console.log(`  [compare] ${engineName} 失败（${result.error}），使用占位面板`);
        panels.push(placeholderPanel(P, P));
        labels.push({ text: `${panels.length}. ${engineName} 失败`, x: (panels.length - 1) * P + 16, y: BAR_H + 8 });
        continue;
      }
      const dec = decodePng(fs.readFileSync(srOut));
      let full;
      if (dec.width === orig.width * scale && dec.height === orig.height * scale) {
        full = dec.rgba;
      } else {
        const targetW = orig.width * scale;
        const targetH = orig.height * scale;
        full = resizeRgba(dec.rgba, dec.width, dec.height, targetW, targetH);
      }
      panels.push(cropRgba(full, orig.width * scale, cx * scale, cy * scale, P, P));
      labels.push({ text: `${panels.length}. ${handle.label} x${scale}`, x: (panels.length - 1) * P + 16, y: BAR_H + 8 });
    } catch (err) {
      console.log(`  [compare] ${engineName} 处理失败：${err.message}，使用占位面板`);
      panels.push(placeholderPanel(P, P));
      labels.push({ text: `${panels.length}. ${engineName} 失败`, x: (panels.length - 1) * P + 16, y: BAR_H + 8 });
    } finally {
      fs.rmSync(srOut, { force: true });
    }
  }

  // 合成并绘制顶部色条（每格独立颜色，无 ffmpeg 也能区分）
  const W = P * panels.length;
  const tile = new Uint8Array(W * P * 4);
  for (let p = 0; p < panels.length; p++) {
    const bar = BAR_COLORS[p % BAR_COLORS.length];
    for (let y = 0; y < P; y++) {
      for (let x = 0; x < P; x++) {
        const si = (y * P + x) * 4;
        const di = (y * W + (p * P + x)) * 4;
        if (y < BAR_H) {
          tile[di] = bar[0]; tile[di + 1] = bar[1]; tile[di + 2] = bar[2]; tile[di + 3] = 255;
        } else if (y === BAR_H) {
          tile[di] = 10; tile[di + 1] = 10; tile[di + 2] = 12; tile[di + 3] = 255;
        } else {
          tile[di] = panels[p][si]; tile[di + 1] = panels[p][si + 1]; tile[di + 2] = panels[p][si + 2]; tile[di + 3] = 255;
        }
      }
    }
  }
  const stem = path.basename(pngPath, path.extname(pngPath));
  const rawOut = path.resolve(args.out || path.join(root, 'out', `compare-${stem}.png`));
  fs.mkdirSync(path.dirname(rawOut), { recursive: true });
  fs.writeFileSync(rawOut, encodePng(tile, W, P));
  console.log(`[compare] ${W}x${P} -> ${rawOut}`);
  if (!args['no-labels']) {
    const labeled = rawOut.slice(0, -'.png'.length) + '-labeled.png';
    const final = await renderLabels(rawOut, labeled, labels);
    if (final !== rawOut) fs.rmSync(rawOut, { force: true });
    console.log(`[compare] 标注版 -> ${final}`);
  }
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