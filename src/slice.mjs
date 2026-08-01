// Atlas slice pipeline: parse -> crop -> per-piece upscale -> repack.
//
// Implements the "slice-first" hi-res strategy (better than whole-sheet):
//   1. Every region is cropped from the texture page and de-rotated, so the
//      upscaler sees each sprite upright and isolated (no neighbor bleed, no
//      attention wasted on transparent gaps).
//   2. Each piece is padded with a transparent border before upscaling so the
//      engine never reconstructs the sprite edge from its own border mode,
//      then the padding is cropped back to the exact scaled size.
//   3. Pieces are shelf-packed into a new page with transparent gaps, and a
//      new .atlas is written (xy/size/orig/offset scaled, rotate=false), so
//      the Spine renderer samples clean, bleeding-free regions.

import { decodePng, encodePng } from './png.mjs';

const MAX_SHEET = 8192;

// ---------------------------------------------------------------------------
// atlas parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Spine 3.8 .atlas text into pages and regions.
 * @param {string} atlasText
 * @returns {{pages: Array<{name: string, header: Array<{indent: string, line: string}>, size: [number, number]}>, regions: Array<object>}}
 */
export function parseAtlasRegions(atlasText) {
  const pages = [];
  const regions = [];
  let page = null;
  let region = null;
  for (const raw of String(atlasText).split(/\r?\n/)) {
    const indentMatch = raw.match(/^(\s*)(.*)$/);
    const indent = indentMatch ? indentMatch[1] : '';
    const line = indentMatch ? indentMatch[2] : raw;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith('.png') && !trimmed.includes(':')) {
      page = { name: trimmed, size: [0, 0], header: [] };
      pages.push(page);
      region = null;
      continue;
    }
    const attr = trimmed.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
    if (attr) {
      const key = attr[1].toLowerCase();
      const value = attr[2].trim();
      if (region) {
        if (key === 'xy') region.xy = value.split(',').map((v) => parseInt(v, 10));
        else if (key === 'size') region.size = value.split(',').map((v) => parseInt(v, 10));
        else if (key === 'orig') region.orig = value.split(',').map((v) => parseInt(v, 10));
        else if (key === 'offset') region.offset = value.split(',').map((v) => parseInt(v, 10));
        else if (key === 'rotate') region.rotate = value === 'true';
        else if (key === 'index') region.index = parseInt(value, 10);
        else if (key === 'split') region.split = value;
        else if (key === 'pad') region.pad = value;
        else region.attrs.push({ key, value, indent });
      } else if (key === 'size' && page) {
        page.size = value.split(',').map((v) => parseInt(v, 10));
        page.header.push({ indent, line: raw });
      } else if (page) {
        page.header.push({ indent, line: raw });
      }
      continue;
    }
    // otherwise: a region name (trimmed, indentation preserved)
    region = {
      name: trimmed,
      indent,
      page: pages.length - 1,
      xy: [0, 0],
      size: [0, 0],
      orig: null,
      offset: null,
      rotate: false,
      index: null,
      split: null,
      pad: null,
      attrs: [],
    };
    regions.push(region);
  }
  return { pages, regions };
}

// ---------------------------------------------------------------------------
// pixel helpers
// ---------------------------------------------------------------------------

/** Rotate an RGBA buffer 90 degrees counter-clockwise (dst W = src H). */
export function rotateCcw(rgba, w, h) {
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const dx = h - 1 - y;
      const dy = x;
      const di = (dy * h + dx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/** Rotate an RGBA buffer 90 degrees clockwise. */
export function rotateCw(rgba, w, h) {
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const dx = y;
      const dy = w - 1 - x;
      const di = (dy * h + dx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// shelf packing
// ---------------------------------------------------------------------------

/**
 * Shelf-pack rects into a square-ish sheet.
 * @param {Array<{name: string, w: number, h: number}>} items
 * @param {{gap?: number, maxW?: number}} [opts]
 * @returns {{width: number, height: number, slots: Array<{name: string, x: number, y: number, w: number, h: number}>}}
 */
export function packShelf(items, { gap = 2, maxW = MAX_SHEET } = {}) {
  const sorted = [...items].sort((a, b) => b.h - a.h);
  const totalArea = sorted.reduce((s, it) => s + it.w * it.h, 0);
  const maxItemW = sorted.reduce((s, it) => Math.max(s, it.w), 0);
  let width = Math.min(maxW, Math.max(maxItemW, Math.ceil(Math.sqrt(totalArea) * 1.15)));
  const slots = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let usedW = 0;
  for (const it of sorted) {
    if (it.w > width) {
      width = Math.min(maxW, it.w + gap);
      slots.length = 0;
      x = 0; y = 0; rowH = 0; usedW = 0;
    }
    if (x + it.w > width + gap) {
      if (rowH === 0) throw new Error('piece wider than sheet cap');
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    slots.push({ name: it.name, x, y, w: it.w, h: it.h });
    x += it.w + gap;
    usedW = Math.max(usedW, x - gap);
    rowH = Math.max(rowH, it.h);
  }
  const height = y + rowH;
  if (height > maxW || usedW > maxW) throw new Error('packed sheet exceeds cap');
  return { width: usedW, height, slots };
}

// ---------------------------------------------------------------------------
// slice orchestration
// ---------------------------------------------------------------------------

/**
 * Slice one texture page, upscale every piece, repack into a new sheet.
 * @param {object} opts
 * @param {Buffer} opts.rgba            source page RGBA
 * @param {number} opts.pageW
 * @param {number} opts.pageH
 * @param {Array<object>} opts.regions  parsed regions belonging to this page
 * @param {number} opts.scale           final synchronized scale
 * @param {Function} opts.upscalePiece  async (rgba, w, h, targetW, targetH) => Buffer
 * @param {number} [opts.pad]           transparent padding in source pixels (default 4)
 * @param {string} [opts.rotateDir]     de-rotation direction for rotate:true
 *   regions: 'ccw' (default) or 'cw' (also via env SLICE_ROT_DIR)
 * @param {number} [opts.gap]           gap between pieces in output pixels (default 2)
 * @param {number} [opts.concurrency]   how many pieces are upscaled in parallel (default 1)
 * @param {boolean} [opts.batch]        batch pieces into group sheets so each
 *   engine call covers many pieces (huge speedup; default true)
 * @param {number} [opts.batchGap]      transparent gap between pieces inside a
 *   batch sheet in source pixels (default 8)
 * @param {number} [opts.batchArea]     max source pixels per batch group (default 810000)
 * @param {(m: string) => void} [opts.onLog]
 * @param {(p: {done: number, total: number}) => void} [opts.onProgress]  per-piece progress
 * @returns {Promise<{png: Buffer, width: number, height: number, slots: Array<object>}>}
 */
export async function slicePage({ rgba, pageW, pageH, regions, scale, upscalePiece, pad = 4, gap = 2, rotateDir, concurrency = 1, batch = true, batchGap = 8, batchArea = 810000, onLog = () => {}, onProgress = null }) {
  if (!regions.length) throw new Error('page has no regions');
  // Phase 1: crop / de-rotate / pad each region (cheap, synchronous)
  const jobs = [];
  for (const r of regions) {
    const [x, y] = r.xy;
    const [w, h] = r.size;
    if (w <= 0 || h <= 0) continue;
    // Spine 3.8: rotate:true 时，atlas size 是正立尺寸(w x h)，纹理中存储的
    // 是旋转 90° 的矩形，宽度 = h、高度 = w（见 spine-player TextureAtlas.load）
    const cropW = r.rotate ? h : w;
    const cropH = r.rotate ? w : h;
    if (x < 0 || y < 0 || x + cropW > pageW || y + cropH > pageH) {
      onLog('[slice] 区域越界，跳过 ' + r.name);
      continue;
    }
    let piece = Buffer.alloc(cropW * cropH * 4);
    for (let yy = 0; yy < cropH; yy++) {
      const src = ((y + yy) * pageW + x) * 4;
      rgba.copy(piece, yy * cropW * 4, src, src + cropW * 4);
    }
    let pw = cropW;
    let ph = cropH;
    if (r.rotate) {
      const dir = rotateDir || process.env.SLICE_ROT_DIR || 'ccw';
      piece = dir === 'cw' ? rotateCw(piece, cropW, cropH) : rotateCcw(piece, cropW, cropH);
      pw = cropH;
      ph = cropW;
    }
    // pad with transparency
    const fullW = pw + pad * 2;
    const fullH = ph + pad * 2;
    const padded = Buffer.alloc(fullW * fullH * 4);
    for (let yy = 0; yy < ph; yy++) {
      const src = yy * pw * 4;
      piece.copy(padded, ((yy + pad) * fullW + pad) * 4, src, src + pw * 4);
    }
    jobs.push({
      name: r.name,
      padded,
      fullW,
      fullH,
      targetW: Math.max(1, Math.round(fullW * scale)),
      targetH: Math.max(1, Math.round(fullH * scale)),
      scale,
      pad,
      orig: r.orig ? r.orig.map((v) => Math.round(v * scale)) : null,
      offset: r.offset ? r.offset.map((v) => Math.round(v * scale)) : null,
      index: r.index,
      attrs: r.attrs,
    });
  }
  if (!jobs.length) throw new Error('no usable regions');
  // Phase 2: upscale pieces concurrently — several engine processes run at
  // once so the GPU/CPU stays busy instead of idling between tiny pieces.
  const total = jobs.length;
  let done = 0;
  const items = [];
  const report = () => {
    if (onProgress) onProgress({ done, total });
    else onLog('[slice] 放大进度 ' + done + '/' + total);
  };
  const pushPiece = (job, up, outW, sx0, sy0) => {
    const px = Math.round(job.pad * job.scale);
    const tw = Math.max(1, Math.round((job.fullW - job.pad * 2) * job.scale));
    const th = Math.max(1, Math.round((job.fullH - job.pad * 2) * job.scale));
    const inner = Buffer.alloc(tw * th * 4);
    for (let yy = 0; yy < th; yy++) {
      const src = ((sy0 + yy + px) * outW + (sx0 + px)) * 4;
      up.copy(inner, yy * tw * 4, src, src + tw * 4);
    }
    items.push({ name: job.name, w: tw, h: th, rgba: inner, orig: job.orig, offset: job.offset, index: job.index, attrs: job.attrs });
    done += 1;
    report();
  };
  const workOne = async (job) => {
    let up;
    try {
      up = await upscalePiece(job.padded, job.fullW, job.fullH, job.targetW, job.targetH);
      if (up.length !== job.targetW * job.targetH * 4) throw new Error('wrong output size');
    } catch (e) {
      onLog('[slice] ' + job.name + ' 单片放大失败，跳过该片: ' + (e && e.message || e));
      return;
    }
    pushPiece(job, up, job.targetW, 0, 0);
  };
  const runPool = async (work, n) => {
    let cursor = 0;
    const worker = async () => { while (cursor < n) { const i = cursor++; await work(i); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency || 1, n)) }, worker));
  };

  const useBatch = batch && process.env.ZDXR_SLICE_NO_BATCH !== '1';
  if (useBatch) {
    // Batch mode: greedy-area groups -> one engine call per group sheet. This
    // amortizes engine process startup over many pieces (order-of-magnitude
    // speedup). If a group fails, fall back to per-piece for that group.
    const sorted = [...jobs].sort((a, b) => (b.fullW * b.fullH) - (a.fullW * a.fullH));
    const groups = [];
    let cur = [], curArea = 0;
    for (const j of sorted) {
      const area = (j.fullW + batchGap) * (j.fullH + batchGap);
      if (cur.length && curArea + area > batchArea) { groups.push(cur); cur = []; curArea = 0; }
      cur.push(j); curArea += area;
    }
    if (cur.length) groups.push(cur);
    await runPool(async (gi) => {
      const group = groups[gi];
      const items2 = group.map((j) => ({ name: j.name, w: j.fullW, h: j.fullH }));
      const packed = packShelf(items2, { gap: batchGap });
      const sheet = Buffer.alloc(packed.width * packed.height * 4);
      const byName = new Map(group.map((j) => [j.name, j]));
      for (const s of packed.slots) {
        const j = byName.get(s.name);
        for (let yy = 0; yy < j.fullH; yy++) j.padded.copy(sheet, ((s.y + yy) * packed.width + s.x) * 4, yy * j.fullW * 4, (yy + 1) * j.fullW * 4);
      }
      let up;
      try {
        up = await upscalePiece(sheet, packed.width, packed.height, packed.width * scale, packed.height * scale);
        if (up.length !== packed.width * scale * packed.height * scale * 4) throw new Error('wrong output size');
      } catch (e) {
        onLog('[slice] 第 ' + (gi + 1) + ' 组批量放大失败，该组 ' + group.length + ' 片回退单片放大: ' + (e && e.message || e));
        for (const j of group) await workOne(j);
        return;
      }
      for (const s of packed.slots) {
        const j = byName.get(s.name);
        pushPiece(j, up, packed.width * scale, s.x * scale, s.y * scale);
      }
    }, groups.length);
  } else {
    await runPool(async (i) => { await workOne(jobs[i]); }, jobs.length);
  }
  if (!items.length) throw new Error('all pieces failed');
  // Phase 3: pack
  const packed = packShelf(items, { gap });
  const sheet = Buffer.alloc(packed.width * packed.height * 4);
  const byName = new Map(items.map((it) => [it.name, it]));
  const slots = [];
  for (const s of packed.slots) {
    const it = byName.get(s.name);
    for (let yy = 0; yy < it.h; yy++) {
      const src = yy * it.w * 4;
      it.rgba.copy(sheet, ((s.y + yy) * packed.width + s.x) * 4, src, src + it.w * 4);
    }
    slots.push({ name: s.name, x: s.x, y: s.y, w: it.w, h: it.h, orig: it.orig, offset: it.offset, index: it.index, attrs: it.attrs });
  }
  return { png: encodePng(sheet, packed.width, packed.height), width: packed.width, height: packed.height, slots };
}

/**
 * Build a new .atlas text for one repacked page.
 * @param {object} opts
 * @param {string} opts.pageName     output texture filename
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {string} [opts.filter]     "Linear, Linear" style filter line
 * @param {string} [opts.repeat]     "none" / "x" / "y" / "xy"
 * @param {Array<object>} opts.slots packed slots with region metadata
 * @returns {string}
 */
export function buildAtlasText({ pageName, width, height, format, filter, repeat, slots }) {
  const out = [];
  out.push(pageName);
  out.push('size: ' + width + ', ' + height);
  out.push('format: ' + (format || 'RGBA8888'));
  out.push('filter: ' + (filter || 'Linear, Linear'));
  out.push('repeat: ' + (repeat || 'none'));
  for (const s of slots) {
    out.push(s.name);
    out.push('  rotate: false');
    out.push('  xy: ' + s.x + ', ' + s.y);
    out.push('  size: ' + s.w + ', ' + s.h);
    if (s.orig) out.push('  orig: ' + s.orig[0] + ', ' + s.orig[1]);
    if (s.offset) out.push('  offset: ' + s.offset[0] + ', ' + s.offset[1]);
    if (s.index !== null && s.index !== undefined) out.push('  index: ' + s.index);
    for (const a of s.attrs) out.push('  ' + a.key + ': ' + a.value);
  }
  return out.join('\n');
}

/**
 * Slice-and-repack a whole atlas (all pages).
 * @param {object} opts
 * @param {string} opts.atlasText
 * @param {(pageName: string) => Buffer} opts.readPage  returns PNG buffer for a page
 * @param {(pageName: string, index: number) => string} opts.outNameFor  output PNG name
 * @param {number} opts.scale
 * @param {Function} opts.upscalePiece
 * @param {number} [opts.pad]
 * @param {number} [opts.gap]
 * @param {(m: string) => void} [opts.onLog]
 * @returns {Promise<{atlasText: string, pages: Array<{name: string, buffer: Buffer}>}>}
 */
export async function sliceAtlas({ atlasText, readPage, outNameFor, scale, upscalePiece, pad = 4, gap = 2, rotateDir, concurrency = 1, onLog = () => {}, onProgress = null }) {
  const { pages, regions } = parseAtlasRegions(atlasText);
  if (!pages.length || !regions.length) throw new Error('atlas 无可解析的页面/区域');
  const nineSlice = regions.find((r) => r.split || r.pad);
  if (nineSlice) throw new Error('9-slice region (split/pad) not supported in slice mode: ' + nineSlice.name);
  const pagesOut = [];
  const outTexts = [];
  let pageIdx = 0;
  for (const pg of pages) {
    const own = regions.filter((r) => r.page === pages.indexOf(pg));
    if (!own.length) continue;
    const buf = readPage(pg.name);
    const { width, height, rgba } = decodePng(buf);
    const { png, width: outW, height: outH, slots } = await slicePage({
      rgba, pageW: width, pageH: height, regions: own, scale, upscalePiece, pad, gap, rotateDir, concurrency, onLog, onProgress,
    });
    const outName = outNameFor(pg.name, pageIdx);
    pageIdx += 1;
    let format = 'RGBA8888';
    let filter = 'Linear, Linear';
    let repeat = 'none';
    const sizeLine = pg.header.find((h) => /^size\s*:/i.test(h.line.trim()));
    if (sizeLine) {
      const fm = pg.header.find((h) => /^format\s*:/i.test(h.line.trim()));
      const f = pg.header.find((h) => /^filter\s*:/i.test(h.line.trim()));
      const r = pg.header.find((h) => /^repeat\s*:/i.test(h.line.trim()));
      if (fm) format = fm.line.trim().replace(/^format\s*:\s*/i, '');
      if (f) filter = f.line.trim().replace(/^filter\s*:\s*/i, '');
      if (r) repeat = r.line.trim().replace(/^repeat\s*:\s*/i, '');
    }
    outTexts.push(buildAtlasText({ pageName: outName, width: outW, height: outH, format, filter, repeat, slots }));
    pagesOut.push({ name: outName, buffer: png });
  }
  if (!pagesOut.length) throw new Error('atlas 无有效页面');
  return { atlasText: outTexts.join('\n\n'), pages: pagesOut };
}
