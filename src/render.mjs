// Headless renderer: Chrome (CDP) + render/index.html -> RGBA frames -> GIF.
// No Playwright / Puppeteer / FFmpeg required.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession, rmrfRetry } from './cdp.mjs';
import { GifWorkerPool } from './gif-pool.mjs';
import { buildGifHeader, buildGifFrame, gifTrailer, medianCut, quantize, lzwEncode, straightenRgba } from './gif.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function renderTimelineToGif({
  rootDir,
  assets,
  assetsList,
  timeline,
  outFile,
  width = 640,
  height = 640,
  fps = 30,
  background = '00000000',
  mix = 0.2,
  chromePath,
  onFrame,
} = {}) {
  if (!timeline || !Array.isArray(timeline.timeline) || timeline.timeline.length === 0) {
    throw new Error('timeline must contain a non-empty timeline array');
  }
  const pendingBatches = new Map(); // batchId -> Buffer[]
  const batchWaiters = new Map(); // batchId -> resolve
  const server = await startStaticServer(rootDir, { onPost: (pathname, body, res, url) => {
    if (pathname === '/frame') {
      const id = Number(url.searchParams.get('batch'));
      const count = Number(url.searchParams.get('count'));
      const size = width * height * 4;
      const pieces = [];
      for (let i = 0; i < count; i++) pieces.push(Buffer.from(body.subarray(i * size, (i + 1) * size))); // copy: each frame gets an independent transferable buffer
      pendingBatches.set(id, pieces);
      const w = batchWaiters.get(id);
      if (w) { batchWaiters.delete(id); w(pieces); }
      try { res.writeHead(200); res.end('ok'); } catch {}
      return;
    }
    try { res.writeHead(404); res.end('not found'); } catch {}
  } });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-studio-'));
  const chrome = launchChrome({ chromePath, userDataDir, width, height });

  let cdp = null;
  try {
    cdp = new CdpClient(await chrome.wsUrl());
    await cdp.open();
    const rel = (p) => '/' + String(p).replace(/\\/g, '/').replace(/^\/?/, '');
    const views = Array.isArray(assetsList) && assetsList.length
      ? assetsList.map((a) => ({ name: a.name || 'default', skel: rel(a.skel), atlas: rel(a.atlas), png: rel(a.png) }))
      : [{ name: 'default', skel: rel(assets.skel), atlas: rel(assets.atlas), png: rel(assets.png) }];
    const query = new URLSearchParams({
      skel: views[0].skel,
      atlas: views[0].atlas,
      png: views[0].png,
      views: JSON.stringify(views),
      w: String(width),
      h: String(height),
      bg: background,
      mix: String(mix),
    });
    const pageUrl = `${server.origin}/render/index.html?${query}`;
    const { sessionId } = await newPageSession(cdp, pageUrl);
    const send = (m, p) => cdp.send(m, p, sessionId);

    const load = await evalJs(send, 'studio.load()');
    if (!load || !load.ok) {
      throw new Error('studio.load failed: ' + (load && load.error));
    }
    const gpuInfo = String(await evalJs(send, "(function(){try{var c=document.createElement('canvas');var gl=c.getContext('webgl')||c.getContext('experimental-webgl');if(!gl)return 'no-webgl';var ext=gl.getExtension('WEBGL_debug_renderer_info');var name=ext?String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)):'webgl';return /swiftshader|llvmpipe|software/i.test(name)?name+' (software)':name+' (gpu)';}catch(e){return 'webgl-error'}})()"));
    const gpuTag = gpuInfo.includes('(software)') ? gpuInfo.replace(' (software)', '') + '（软件渲染，设置 ZDXR_SWIFTSHADER=1 可强制）' : gpuInfo.replace(' (gpu)', '') + '（GPU 加速）';
    console.log('[render] 渲染后端: ' + gpuTag);
    const segments = timeline.timeline;
    const segDuration = (seg) => (seg.duration || 0) * Math.max(1, parseInt(seg.repeat, 10) || 1);
    const total = segments.reduce((sum, seg) => sum + segDuration(seg), 0);
    const frameCount = Math.max(1, Math.round(total * fps));
    const delay = Math.max(1, Math.round(100 / fps));
    const pool = new GifWorkerPool(Math.max(2, Math.min(8, (os.cpus?.() || [1, 2, 3, 4]).length - 1)));
    const frameBytes = width * height * 4;

    const segStateAt = (t) => {
      let segIndex = 0, segmentStart = 0;
      while (segIndex < segments.length - 1 && t >= segmentStart + segDuration(segments[segIndex])) {
        segmentStart += segDuration(segments[segIndex]);
        segIndex++;
      }
      const seg = segments[segIndex];
      const repeatN = Math.max(1, parseInt(seg.repeat, 10) || 1);
      const cycleDur = seg.duration > 0 ? seg.duration : 1;
      const cycle = Math.min(Math.floor((t - segmentStart) / cycleDur), repeatN - 1);
      return { seg, segIndex, segmentStart, repeatN, cycleDur, cycle };
    };

    let palette = null;
    let resolvePalette = null;
    const paletteReady = new Promise((r) => { resolvePalette = r; });
    const encoded = [];
    let batchSeq = 1;
    const waitBatch = (id, count) => new Promise((resolve) => {
      const got = pendingBatches.get(id);
      if (got && got.length === count) { pendingBatches.delete(id); resolve(got); return; }
      batchWaiters.set(id, resolve);
    });
    const ingest = async (raw) => {
      // first frame straightens + builds the shared palette on the main thread
      if (!palette) {
        palette = medianCut(straightenRgba(raw, width, height), width, height, 256);
        resolvePalette();
      } else {
        await paletteReady;
      }
      return pool.encode(raw, width, height, palette);
    };
    // batch version: submit every frame to the worker pool immediately so all
    // workers run in parallel (awaiting one by one serializes the pool)
    const ingestBatch = async (rawFrames) => {
      const jobs = rawFrames.map((raw) => {
        if (!palette) {
          palette = medianCut(straightenRgba(raw, width, height), width, height, 256);
          resolvePalette();
        }
        return pool.encode(raw, width, height, palette);
      });
      return Promise.all(jobs);
    };

    async function renderRange(send2, fromFrame, toFrame) {
      const params = [];
      for (let f = fromFrame; f < toFrame; f++) {
        const st = segStateAt(f / fps);
        params.push({ action: st.seg.action, view: st.seg.view || 'default', loop: st.seg.loop, delta: 1 / fps, timeScale: st.seg.timeScale || 1, restart: false });
      }
      const BATCH = 8;
      for (let b = 0; b < params.length; b += BATCH) {
        const batch = params.slice(b, b + BATCH);
        const id = batchSeq++;
        const res = await evalJs(send2, 'studio.renderFrames(' + JSON.stringify({ frames: batch, batch: id }) + ')');
        if (!res || !res.ok) throw new Error('renderFrames failed: ' + (res && res.error || 'unknown'));
        if (res.fallback) console.warn('  [warn] 动作不存在，已替换为 ' + res.action);
        const frames = await waitBatch(id, batch.length);
        const comps = await ingestBatch(frames);
        for (let i = 0; i < comps.length; i++) {
          const f = fromFrame + b + i;
          encoded[f] = comps[i];
          if (onFrame) onFrame(f + 1, frameCount, (segStateAt(f / fps).seg || {}).action);
        }
      }
    }

    const chunkCount = Math.max(1, Math.min(parseInt(process.env.ZDXR_RENDER_CHUNKS || '4', 10) || 4, frameCount === 1 ? 1 : Math.floor(frameCount / 30) || 1));
    const perChunk = Math.ceil(frameCount / chunkCount);
    const chunks2 = [];
    for (let c = 0; c < chunkCount; c++) {
      const from = c * perChunk;
      const to = Math.min(frameCount, (c + 1) * perChunk);
      if (from >= to) continue;
      chunks2.push({ from, to });
    }
    const runChunk = async ({ from, to }) => {
      const { sessionId } = await newPageSession(cdp, pageUrl);
      const send2 = (m, p) => cdp.send(m, p, sessionId);
      await evalJs(send2, 'studio.load()');
      if (from === 0) {
        // frame 0: exact t=0 pose (restart + delta 0), own batch
        const st0 = segStateAt(0);
        const id0 = batchSeq++;
        const res0 = await evalJs(send2, 'studio.renderFrames(' + JSON.stringify({ batch: id0, frames: [{ action: st0.seg.action, view: st0.seg.view || 'default', loop: st0.seg.loop, delta: 0, timeScale: st0.seg.timeScale || 1, restart: true }] }) + ')');
        if (!res0 || !res0.ok) throw new Error('frame0 failed: ' + (res0 && res0.error || 'unknown'));
        const f0 = (await waitBatch(id0, 1))[0];
        encoded[0] = await ingest(f0);
        if (onFrame) onFrame(1, frameCount, st0.seg.action);
        await renderRange(send2, 1, to);
      } else {
        // advance state to (from-1)/fps so the first stepped frame lands on from/fps
        const targetT = Math.max(0, (from - 1) / fps);
        const st = segStateAt(targetT);
        const segStartT = (() => { let acc = 0, i = 0; while (i < st.segIndex) { acc += segDuration(segments[i]); i++; } return acc; })();
        const offset = Math.max(0, targetT - segStartT);
        await evalJs(send2, 'studio.step(' + JSON.stringify({ action: st.seg.action, view: st.seg.view || 'default', loop: st.seg.loop, delta: offset, timeScale: st.seg.timeScale || 1, restart: true }) + ')');
        await renderRange(send2, from, to);
      }
    };
    await Promise.all(chunks2.map(runChunk));
    pool.close();

    // assemble in order
    const chunks = [buildGifHeader(width, height, palette)];
    for (let f = 0; f < frameCount; f++) chunks.push(buildGifFrame(encoded[f], width, height, delay));
    chunks.push(gifTrailer());
    const gif = Buffer.concat(chunks);
    fs.writeFileSync(outFile, gif);
    return { frames: frameCount, seconds: total, fps, outFile, bytes: gif.length };
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    await rmrfRetry(userDataDir);
  }
}
