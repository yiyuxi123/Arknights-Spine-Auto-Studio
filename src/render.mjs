// Headless renderer: Chrome (CDP) + render/index.html -> RGBA frames -> GIF.
// No Playwright / Puppeteer / FFmpeg required.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession, rmrfRetry } from './cdp.mjs';
import { GifWorkerPool } from './gif-pool.mjs';
import { buildGifHeader, buildGifFrame, gifTrailer, medianCut, quantize, lzwEncode } from './gif.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared timeline renderer: segments the timeline into parallel chunks, each
// chunk gets its own page session (own renderer process), frames travel as
// raw premultiplied RGBA over a local POST channel (zero base64/JSON) and are
// onFrame receives raw premultiplied RGBA (bottom-left origin). GIF pipeline
// straightens inside its single worker call; PNG/MP4 pipelines straighten on
// their side. GIF / PNG-frame / MP4 pipelines all build on this.
// ---------------------------------------------------------------------------
export async function renderTimelineFrames({
  rootDir,
  assets,
  assetsList,
  timeline,
  outFile = null,
  width = 640,
  height = 640,
  fps = 30,
  background = '00000000',
  mix = 0.2,
  fit = 0.92,
  camMode = 'fixed',
  chromePath,
  onFrame = async () => {},
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
      for (let i = 0; i < count; i++) pieces.push(Buffer.from(body.subarray(i * size, (i + 1) * size))); // copy: independent transferable buffers
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
      fit: String(fit),
      camMode: String(camMode),
      // only fit to the actions actually used in this timeline, so a small
      // character is zoomed in and a large-amplitude move is not cropped
      actions: JSON.stringify([...new Set((timeline.timeline || []).map((s) => s.action).filter(Boolean))]),
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
    const pool = new GifWorkerPool(Math.max(2, Math.min(8, (os.cpus?.() || [1, 2, 3, 4]).length - 1)));

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

    let batchSeq = 1;
    const waitBatch = (id, count) => new Promise((resolve) => {
      const got = pendingBatches.get(id);
      if (got && got.length === count) { pendingBatches.delete(id); resolve(got); return; }
      batchWaiters.set(id, resolve);
    });

    // Parallel chunks finish in arbitrary order: buffer frames and hand them
    // to onFrame strictly by frame number so GIF/MP4/PNG stay in order.
    let nextFrame = 0;
    const pendingFrames = new Map();
    const deliver = async () => {
      while (pendingFrames.has(nextFrame)) {
        const raw = pendingFrames.get(nextFrame);
        pendingFrames.delete(nextFrame);
        const st = segStateAt(nextFrame / fps);
        await onFrame(raw, nextFrame + 1, frameCount, (st.seg || {}).action);
        nextFrame++;
      }
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
        for (let i = 0; i < frames.length; i++) {
          pendingFrames.set(fromFrame + b + i, frames[i]);
        }
        await deliver();
      }
    }

    // adaptive chunking: parallel pages pay a fixed load cost, so short
    // renders use fewer chunks (env ZDXR_RENDER_CHUNKS overrides)
    const envChunks = parseInt(process.env.ZDXR_RENDER_CHUNKS || '0', 10) || 0;
    const autoChunks = frameCount < 60 ? 1 : frameCount < 180 ? 2 : frameCount < 360 ? 3 : 4;
    const chunkCount = Math.max(1, Math.min(envChunks || autoChunks, frameCount === 1 ? 1 : Math.ceil(frameCount / 15)));
    const perChunk = Math.ceil(frameCount / chunkCount);
    const chunks2 = [];
    for (let c = 0; c < chunkCount; c++) {
      const from = c * perChunk;
      const to = Math.min(frameCount, (c + 1) * perChunk);
      if (from >= to) continue;
      chunks2.push({ from, to });
    }
    const runChunk = async ({ from, to }) => {
      const { sessionId: sid } = await newPageSession(cdp, pageUrl);
      const send2 = (m, p) => cdp.send(m, p, sid);
      await evalJs(send2, 'studio.load()');
      if (from === 0) {
        // frame 0: exact t=0 pose (restart + delta 0), own batch
        const st0 = segStateAt(0);
        const id0 = batchSeq++;
        const res0 = await evalJs(send2, 'studio.renderFrames(' + JSON.stringify({ batch: id0, frames: [{ action: st0.seg.action, view: st0.seg.view || 'default', loop: st0.seg.loop, delta: 0, timeScale: st0.seg.timeScale || 1, restart: true }] }) + ')');
        if (!res0 || !res0.ok) throw new Error('frame0 failed: ' + (res0 && res0.error || 'unknown'));
        const f0 = (await waitBatch(id0, 1))[0];
        pendingFrames.set(0, f0);
        await deliver();
        await renderRange(send2, 1, to);
      } else {
        // Replay every step from t=0 (no snapshots) so animation switches,
        // mix transitions and loop cycles build exactly like a single-chunk
        // run. A big-delta jump would skip the mix source track and shift
        // poses around chunk boundaries.
        const endFrame = Math.max(0, Math.floor(((from - 1) / fps) * fps + 1e-9));
        const advanceParams = [];
        for (let f = 0; f <= endFrame; f++) {
          const st = segStateAt(f / fps);
          advanceParams.push({ action: st.seg.action, view: st.seg.view || 'default', loop: st.seg.loop, delta: 1 / fps, timeScale: st.seg.timeScale || 1, restart: false });
        }
        await evalJs(send2, 'studio.stepMany(' + JSON.stringify({ frames: advanceParams }) + ')');
        await renderRange(send2, from, to);
      }
    };
    await Promise.all(chunks2.map(runChunk));
    await deliver();
    pool.close();
    return { frames: frameCount, seconds: total, fps };
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    await rmrfRetry(userDataDir);
  }
}

// ---------------------------------------------------------------------------
// GIF export built on renderTimelineFrames: shared palette from frame 1,
// every frame compressed on the worker pool, assembled in order.
// ---------------------------------------------------------------------------
export async function renderTimelineToGif(opts) {
  const { width = 640, height = 640, fps = 30 } = opts;
  const pool = new GifWorkerPool(Math.max(2, Math.min(8, (os.cpus?.() || [1, 2, 3, 4]).length - 1)));
  const delay = Math.max(1, Math.round(100 / fps));
  let palette = null;
  const userOnFrame = opts.onFrame;
  // Backpressured streaming GIF writer: at most MAX_INFLIGHT encodes are in
  // flight (bounded memory), finished frames are written to disk in order.
  const MAX_INFLIGHT = 256; // compressed frames are small (~0.25MB); a wide window keeps render/encode overlapped
  const inFlight = new Map(); // 1-based frame idx -> encode promise
  let nextToWrite = 1;
  let headerWritten = false;
  const writeStream = fs.createWriteStream(opts.outFile);
  const streamError = new Promise((resolve) => writeStream.on('error', resolve));
  const writeChunk = (buf) => new Promise((resolve) => {
    if (!writeStream.write(buf)) writeStream.once('drain', resolve);
    else resolve();
  });
  const flush = async () => {
    while (inFlight.has(nextToWrite)) {
      const compressed = await inFlight.get(nextToWrite);
      inFlight.delete(nextToWrite);
      if (!headerWritten) {
        await writeChunk(buildGifHeader(width, height, palette));
        headerWritten = true;
      }
      await writeChunk(buildGifFrame(compressed, width, height, delay));
      nextToWrite++;
    }
  };
  const result = await renderTimelineFrames({
    ...opts,
    onFrame: async (rgba, idx, total, action) => {
      // frames arrive in order; submit without awaiting so all workers stay
      // busy, but cap the in-flight window for bounded memory
      if (!palette) palette = medianCut(rgba, width, height, 256);
      inFlight.set(idx, pool.encode(rgba, width, height, palette));
      await flush();
      while (inFlight.size > MAX_INFLIGHT) await flush();
      if (userOnFrame) await userOnFrame(idx, total, action);
    },
  });
  await flush();
  await writeChunk(gifTrailer());
  await new Promise((resolve) => writeStream.end(resolve));
  pool.close();
  const err = await Promise.race([streamError, Promise.resolve(null)]);
  if (err) throw err;
  return { frames: result.frames, seconds: result.seconds, fps, outFile: opts.outFile, bytes: fs.statSync(opts.outFile).size };
}
