// Atlas + PNG synchronized upscaling.
//
// Implements the "atlas enlargement" technique from
//   https://github.com/yiyuxi123/Enlargement-software-for-Arknights-atlas-files
// with three improvements:
//   1. `offset` / `split` / `pad` are scaled too (the original tool missed
//      offset, which breaks alignment for rotated / offset-packed regions).
//   2. The PNG texture page is enlarged together with the atlas (the original
//      tool only rewrote the atlas text), so region coordinates always stay
//      in sync with the texture.
//   3. PNG enlargement uses high-quality Lanczos3 (alpha-premultiplied)
//      resampling instead of naive nearest/bilinear.
//
// `rotate` / `index` / `filter` / `repeat` / `format` are never touched.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

// ---------------------------------------------------------------------------
// atlas text scaling
// ---------------------------------------------------------------------------

// Region attributes that live in texture-pixel space and must scale together
// with the texture page.
const SCALED_ATLAS_KEYS = new Set(['xy', 'size', 'orig', 'offset', 'split', 'pad']);

/**
 * Scale every texture-space number in an Spine .atlas text.
 * @param {string} atlasText
 * @param {number} scale
 * @param {{pageName?: string}} [opts] pageName: rewrite the page filename line
 *   (used when the enlarged PNG is saved under a different basename).
 * @returns {{text: string, pages: string[]}}
 */
export function scaleAtlasText(atlasText, scale, { pageName } = {}) {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`scale must be a positive number, got ${scale}`);
  }
  const pages = [];
  const out = [];
  for (const line of String(atlasText).split(/\r?\n/)) {
    // page filename line (e.g. "build_char_002_amiya.png")
    let m = line.match(/^([^:\r\n]+\.png)\s*$/i);
    if (m) {
      pages.push(m[1]);
      out.push(pageName || line);
      continue;
    }
    m = line.match(/^(\s*)([A-Za-z]+)\s*:\s*(.*)$/);
    if (m && SCALED_ATLAS_KEYS.has(m[2])) {
      const indent = m[1];
      const scaled = m[3]
        .split(',')
        .map((raw) => {
          const v = raw.match(/^(\s*)([-+]?\d+(?:\.\d+)?)(.*)$/);
          if (!v) return raw;
          return v[1] + String(Math.round(parseFloat(v[2]) * scale)) + v[3];
        })
        .join(',');
      out.push(indent + m[2] + ': ' + scaled);
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), pages };
}

// ---------------------------------------------------------------------------
// Lanczos3 resampling (RGBA, alpha-premultiplied to avoid dark fringes)
// ---------------------------------------------------------------------------

const LANCZOS_A = 3;

function lanczos(x) {
  if (x === 0) return 1;
  if (x <= -LANCZOS_A || x >= LANCZOS_A) return 0;
  const px = Math.PI * x;
  return (LANCZOS_A * Math.sin(px) * Math.sin(px / LANCZOS_A)) / (px * px);
}

// Per-output-pixel tap tables: [{src, weight}] normalized.
function buildTaps(srcLen, dstLen) {
  const ratio = srcLen / dstLen;
  const tables = new Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) * ratio - 0.5;
    const start = Math.max(0, Math.ceil(center - LANCZOS_A));
    const end = Math.min(srcLen - 1, Math.floor(center + LANCZOS_A));
    const taps = [];
    let total = 0;
    for (let s = start; s <= end; s++) {
      const w = lanczos(center - s);
      if (w !== 0) {
        taps.push([s, w]);
        total += w;
      }
    }
    if (total !== 0) {
      for (const tap of taps) tap[1] /= total;
    }
    tables[d] = taps;
  }
  return tables;
}

/**
 * Resize an RGBA8 buffer to dstW x dstH with Lanczos3.
 * Filtering is done on premultiplied alpha, so translucent sprite edges keep
 * their color instead of turning into dark halos.
 * @param {Uint8Array} rgba
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Buffer} dstW*dstH*4 RGBA8
 */
export function resizeRgba(rgba, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return Buffer.from(rgba);
  const xTaps = buildTaps(srcW, dstW);
  const yTaps = buildTaps(srcH, dstH);

  // horizontal pass -> premultiplied float buffer (dstW x srcH)
  const tmp = new Float32Array(dstW * srcH * 4);
  for (let y = 0; y < srcH; y++) {
    const rowIn = y * srcW * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of xTaps[x]) {
        const i = rowIn + s * 4;
        const sa = rgba[i + 3] / 255;
        r += rgba[i] * sa * w;
        g += rgba[i + 1] * sa * w;
        b += rgba[i + 2] * sa * w;
        a += sa * w;
      }
      const o = (y * dstW + x) * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }

  // vertical pass -> unpremultiply
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let x = 0; x < dstW; x++) {
    for (let y = 0; y < dstH; y++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of yTaps[y]) {
        const i = (s * dstW + x) * 4;
        r += tmp[i] * w;
        g += tmp[i + 1] * w;
        b += tmp[i + 2] * w;
        a += tmp[i + 3] * w;
      }
      const o = (y * dstW + x) * 4;
      const inv = a > 0 ? 1 / a : 0;
      out[o] = Math.max(0, Math.min(255, Math.round(r * inv)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g * inv)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b * inv)));
      out[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  return out;
}

/**
 * Decode + enlarge + re-encode a PNG texture page.
 * @param {Buffer} pngBuffer
 * @param {number} scale
 * @returns {Buffer}
 */
export function upscalePng(pngBuffer, scale) {
  const { width, height, rgba } = decodePng(pngBuffer);
  const dstW = Math.max(1, Math.round(width * scale));
  const dstH = Math.max(1, Math.round(height * scale));
  const resized = resizeRgba(rgba, width, height, dstW, dstH);
  return encodePng(resized, dstW, dstH);
}

// ---------------------------------------------------------------------------
// orchestration: build a render-ready hi-res asset set
// ---------------------------------------------------------------------------

/**
 * Prepare a synchronized hi-res copy of the character assets:
 *   - atlas text: all texture-space numbers scaled by `scale`
 *   - png page(s): enlarged by `scale` (Lanczos3, or an AI engine when `sr` is
 *     provided — see src/sr.mjs)
 * Written into `outDir` with the page filename rewritten to the enlarged PNG
 * basename so the Spine renderer loads exactly one texture per page.
 *
 * @param {object} opts
 * @param {string} opts.atlasPath
 * @param {string} opts.pngPath
 * @param {number} opts.scale          final synchronized scale (>=1)
 * @param {string} opts.outDir         directory for the enlarged assets
 * @param {boolean} [opts.slice]       slice-first mode: crop regions, upscale each
 *   piece (with transparent padding), repack into a new page + atlas.
 *   Best quality with AI engines; slightly slower. Falls back to the
 *   whole-sheet path when the atlas has 9-slice regions or no regions.
 * @param {number} [opts.sliceJobs]     parallel engine processes during slice
 *   upscale (default 4) — saturates GPU/CPU instead of idling between pieces
 * @param {object|null} [opts.sr]      resolved SR engine handle (from sr.mjs)
 * @param {number} [opts.srScale]      engine's own scale; 0 = engine default
 * @param {number} [opts.srGpu]        engine GPU id (default 0)
 * @param {number} [opts.srTile]       engine tile size (0 = auto)
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {Promise<{atlas: string, png: string}>}
 */
export async function prepareUpscaledAssets({
  atlasPath,
  pngPath,
  scale,
  outDir,
  sr = null,
  srScale = 0,
  srGpu = 0,
  srTile = 0,
  slice = false,
  sliceJobs = 6,
  onLog = () => {},
}) {
  const atlasText = fs.readFileSync(atlasPath, 'utf8');

  if (slice) {
    const { alignAssetsInPlace } = await import('./align.mjs');
    try { alignAssetsInPlace({ atlasPath, pngPath, onLog }); } catch (e) { onLog('[slice] 对齐跳过: ' + e.message); }
    const { sliceAtlas } = await import('./slice.mjs');
    const srcDir0 = path.dirname(pngPath);
    const srcName0 = path.basename(pngPath);
    fs.mkdirSync(outDir, { recursive: true });
    let pieceNo = 0;
    const upscalePiece = sr
      ? async (rgba, w, h, targetW, targetH) => {
          const inFile = path.join(outDir, '.piece-' + pieceNo + '.png');
          const srOut = path.join(outDir, '.piece-sr-' + pieceNo + '.png');
          pieceNo += 1;
          fs.writeFileSync(inFile, encodePng(rgba, w, h));
          const engineScale = srScale > 0 ? srScale : sr.defaultScale;
          const res = await sr.run({ input: fs.readFileSync(inFile), outputFile: srOut, scale: engineScale, gpu: srGpu, tile: srTile });
          fs.rmSync(inFile, { force: true });
          if (!res.ok) throw new Error('SR engine failed: ' + res.error);
          const { width: ew, height: eh, rgba: ergba } = decodePng(fs.readFileSync(srOut));
          fs.rmSync(srOut, { force: true });
          if (ew === targetW && eh === targetH) return Buffer.from(ergba);
          return resizeRgba(ergba, ew, eh, targetW, targetH);
        }
      : (rgba, w, h, targetW, targetH) => resizeRgba(rgba, w, h, targetW, targetH);
    try {
      const result = await sliceAtlas({
        atlasText,
        readPage: (pageName) => {
          const p = path.join(srcDir0, pageName);
          if (fs.existsSync(p)) return fs.readFileSync(p);
          return fs.readFileSync(pngPath);
        },
        outNameFor: (pageName, i) => (i === 0 ? srcName0 : pageName),
        scale,
        upscalePiece,
        concurrency: sliceJobs,
        onLog,
        onProgress: (p) => onLog('[slice] 放大进度 ' + p.done + '/' + p.total),
      });
      for (const pg of result.pages) {
        fs.writeFileSync(path.join(outDir, pg.name), pg.buffer);
        onLog('[slice] ' + pg.name + ' 重组完成 ' + (pg.buffer.length > 0 ? '' : ''));
      }
      fs.writeFileSync(path.join(outDir, path.basename(atlasPath)), result.atlasText);
      const firstPage = result.pages[0];
      return { atlas: path.join(outDir, path.basename(atlasPath)), png: path.join(outDir, firstPage.name) };
    } catch (err) {
      const fallback = String(err && err.message || err);
      if (fallback.includes('9-slice') || fallback.includes('无可解析') || fallback.includes('exceeds cap') || fallback.includes('wider than')) {
        onLog('[slice] 该图集不适合切片模式（' + fallback + '），回退为整图放大');
      } else {
        throw err;
      }
    }
  }

  const parsed = scaleAtlasText(atlasText, scale);
  const srcDir = path.dirname(pngPath);
  const srcName = path.basename(pngPath);

  fs.mkdirSync(outDir, { recursive: true });
  const pageOutNames = [];
  const pageInNames = parsed.pages.length > 0 ? parsed.pages : [srcName];

  for (const pageName of pageInNames) {
    const srcPage = path.join(srcDir, pageName);
    const srcPageBytes = fs.existsSync(srcPage) ? fs.readFileSync(srcPage) : fs.readFileSync(pngPath);
    const outName = pageInNames.length === 1 ? srcName : pageName;
    const outFile = path.join(outDir, outName);

    if (sr) {
      onLog(`[sr] ${sr.label} ${srcPageBytes.length > 0 ? pageName : srcName} (${sr.name}) ...`);
      const engineScale = srScale > 0 ? srScale : sr.defaultScale;
      const srOut = path.join(outDir, `.sr-${pageName}.png`);
      const engineResult = await sr.run({ input: srcPageBytes, outputFile: srOut, scale: engineScale, gpu: srGpu, tile: srTile });
      if (engineResult.ok) {
        // bridge engine output to the exact synchronized scale
        if (engineScale !== scale) {
          const { width: ew, height: eh, rgba: ergba } = decodePng(fs.readFileSync(srOut));
          const dstW = Math.max(1, Math.round(ew * (scale / engineScale)));
          const dstH = Math.max(1, Math.round(eh * (scale / engineScale)));
          fs.writeFileSync(outFile, encodePng(resizeRgba(ergba, ew, eh, dstW, dstH), dstW, dstH));
        } else {
          fs.copyFileSync(srOut, outFile);
        }
        fs.rmSync(srOut, { force: true });
      } else {
        onLog(`[sr] 引擎失败（${engineResult.error}），回退 Lanczos3`);
        fs.writeFileSync(outFile, upscalePng(srcPageBytes, scale));
      }
    } else {
      onLog(`[upscale] Lanczos3 ${srcName} x${scale} -> ${outName}`);
      fs.writeFileSync(outFile, upscalePng(srcPageBytes, scale));
    }
    pageOutNames.push(outName);
  }

  // Rewrite atlas page names to the files we actually wrote.
  let finalAtlas = parsed.text;
  if (pageInNames.length === pageOutNames.length) {
    for (let i = 0; i < pageInNames.length; i++) {
      if (pageInNames[i] !== pageOutNames[i]) {
        finalAtlas = finalAtlas.split(pageInNames[i]).join(pageOutNames[i]);
      }
    }
  } else if (pageInNames.length > 1) {
    for (const pageName of pageInNames) {
      finalAtlas = finalAtlas.split(pageName).join(srcName);
    }
  }
  const atlasOut = path.join(outDir, path.basename(atlasPath));
  fs.writeFileSync(atlasOut, finalAtlas);
  return { atlas: atlasOut, png: path.join(outDir, pageOutNames[0]) };
}

// ---------------------------------------------------------------------------
// standalone CLI: node src/upscale.mjs --atlas a.atlas --png a.png --scale 2
// ---------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
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
  if (args.help || !args.atlas || !args.png) {
    console.log(`
用法: node src/upscale.mjs --atlas <file.atlas> --png <file.png> --scale 2 [--out DIR] [--sr] [--sr-engine PATH]

  --atlas PATH      源 .atlas（会同步放大 size/xy/orig/offset/split/pad）
  --png PATH        源 PNG 贴图页（Lanczos3 放大；--sr 时改用 AI 超分引擎）
  --scale N         放大倍数（整数，默认 2）
  --slice           切片模式：按 atlas 逐片放大后重组（质量更佳，推荐）
  --slice-jobs N    切片放大并发引擎进程数（默认 4，榨干 GPU/CPU）
  --out DIR         输出目录（默认与源文件同目录下的 <name>-hi/）
  --sr              使用 AI 超分引擎放大 PNG（默认 Real-ESRGAN anime6B）
  --sr-engine PATH  指定已下载的 ncnn-vulkan 引擎 exe 路径
  --sr-scale N      引擎自身放大倍数（默认用引擎原生倍数）
`);
    return args.help ? 0 : 1;
  }
  const scale = parseInt(args.scale || '2', 10) || 2;
  const atlasPath = path.resolve(args.atlas);
  const pngPath = path.resolve(args.png);
  const outDir = args.out
    ? path.resolve(args.out)
    : path.join(path.dirname(pngPath), path.basename(pngPath, path.extname(pngPath)) + '-hi');

  let srHandle = null;
  if (args.sr || args['sr-engine']) {
    const { resolveEngine } = await import('./sr.mjs');
    srHandle = await resolveEngine(args['sr-engine'] || null, { onLog: (m) => console.log(m) });
  }
  const result = await prepareUpscaledAssets({
    atlasPath,
    pngPath,
    scale,
    outDir,
    sr: srHandle,
    srScale: parseInt(args['sr-scale'] || '0', 10) || 0,
    slice: !!args.slice,
    sliceJobs: parseInt(args['slice-jobs'] || '6', 10) || 6,
    onLog: (m) => console.log(m),
  });
  console.log(`[done] 同步放大 x${scale} 完成:`);
  console.log('  ', result.atlas);
  console.log('  ', result.png);
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
