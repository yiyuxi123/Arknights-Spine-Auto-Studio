// Headless renderer: Chrome (CDP) + render/index.html -> RGBA frames -> GIF.
// No Playwright / Puppeteer / FFmpeg required.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withExportFile } from './export-file.mjs';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession, rmrfRetry } from './cdp.mjs';
import { GifWorkerPool } from './gif-pool.mjs';
import { buildGifHeader, buildGifFrame, gifTrailer, medianCut } from './gif.mjs';

const MiB = 1024 * 1024;
const MAX_BATCH_BYTES = 16 * MiB;
const MAX_GIF_RAW_BYTES = 128 * MiB;

function dimensionsInBytes(width, height) {
  const size = width * height * 4;
  if (![width, height, size].every(Number.isSafeInteger) || width < 1 || height < 1) {
    throw new Error('Invalid render dimensions');
  }
  return size;
}

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
  const frameBytes = dimensionsInBytes(width, height);
  const batchSize = Math.max(1, Math.min(8, Math.floor(MAX_BATCH_BYTES / frameBytes)));
  const expectedBatches = new Map();
  const server = await startStaticServer(rootDir, { onPost: async (pathname, req, res, url) => {
    const id = Number(url.searchParams.get('batch'));
    const batch = pathname === '/frame' && expectedBatches.get(id);
    if (!batch || batch.receiving || Number(url.searchParams.get('count')) !== batch.count) {
      req.resume();
      res.writeHead(400).end('Unexpected frame batch');
      return;
    }
    batch.receiving = true;
    const length = batch.count * frameBytes;
    const frames = Array.from({ length: batch.count }, () => Buffer.allocUnsafeSlow(frameBytes));
    let offset = 0;
    for await (const chunk of req) {
      if (offset + chunk.length > length) throw new Error('Oversized frame batch');
      for (let start = 0; start < chunk.length;) {
        const position = offset % frameBytes;
        const end = Math.min(start + frameBytes - position, chunk.length);
        chunk.copy(frames[Math.floor(offset / frameBytes)], position, start, end);
        offset += end - start;
        start = end;
      }
    }
    if (offset !== length) throw new Error('Incomplete frame batch');
    batch.frames = frames;
    res.writeHead(200).end('ok');
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

    const envChunks = parseInt(process.env.ZDXR_RENDER_CHUNKS || '0', 10) || 0;
    const autoChunks = width * height > 2_000_000 || frameCount < 60 ? 1
      : frameCount < 180 ? 2 : frameCount < 360 ? 3 : 4;
    const chunkCount = Math.max(1, Math.min(envChunks || autoChunks, 4, Math.ceil(frameCount / 15)));
    const perChunk = Math.ceil(frameCount / chunkCount);
    const stepAt = (frame) => {
      const { seg } = segStateAt(frame / fps);
      return {
        action: seg.action, view: seg.view || 'default', loop: seg.loop,
        delta: frame === 0 ? 0 : 1 / fps, timeScale: seg.timeScale || 1, restart: frame === 0,
      };
    };
    let batchSeq = 0;

    async function* renderChunk(from, to, sendPage = send) {
      let targetId;
      try {
        if (from > 0) {
          const page = await newPageSession(cdp, pageUrl);
          targetId = page.targetId;
          sendPage = (method, params) => cdp.send(method, params, page.sessionId);
          const loaded = await evalJs(sendPage, 'studio.load()');
          if (!loaded?.ok) throw new Error('studio.load failed: ' + loaded?.error);
          // Replay from the exact first pose, in bounded steps. No frame pixels
          // leave the page until it reaches the start of its own range.
          for (let first = 0; first < from; first += 128) {
            const frames = Array.from({ length: Math.min(128, from - first) }, (_, i) => stepAt(first + i));
            const replay = await evalJs(sendPage, 'studio.stepMany(' + JSON.stringify({ frames }) + ')');
            if (!replay?.ok) throw new Error('Frame replay failed: ' + replay?.error);
          }
        }
        for (let first = from; first < to; first += batchSize) {
          const count = Math.min(batchSize, to - first);
          const frames = Array.from({ length: count }, (_, i) => stepAt(first + i));
          const id = ++batchSeq;
          const batch = { count };
          expectedBatches.set(id, batch);
          try {
            const result = await evalJs(sendPage, 'studio.renderFrames(' + JSON.stringify({ frames, batch: id }) + ')');
            if (!result?.ok || !batch.frames) throw new Error('Frame batch failed: ' + (result?.error || 'no frame data'));
            if (result.fallback) console.warn('  [warn] 动作不存在，已替换为 ' + result.action);
          } finally {
            expectedBatches.delete(id);
          }
          yield { first, frames: batch.frames };
        }
      } finally {
        if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    }

    // A generator can have at most one request or one batch queued per page.
    // Only this loop writes frames, so a slow sink pauses all production
    // without letting later chunks block the next frame.
    const chunks = [];
    for (let from = 0; from < frameCount; from += perChunk) {
      const stream = renderChunk(from, Math.min(frameCount, from + perChunk));
      const firstBatch = stream.next();
      firstBatch.catch(() => {}); // held until this chunk reaches the writer
      chunks.push({ stream, firstBatch });
    }
    try {
      for (const { stream, firstBatch } of chunks) {
        for (let batch = await firstBatch; !batch.done; batch = await stream.next()) {
          const { first, frames } = batch.value;
          for (let i = 0; i < frames.length; i++) {
            const raw = frames[i];
            frames[i] = null;
            await onFrame(raw, first + i + 1, frameCount, stepAt(first + i).action);
          }
        }
      }
    } finally {
      cdp.close();
      await Promise.allSettled(chunks.map(({ stream }) => stream.return()));
    }
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
  const { width = 640, height = 640, fps = 30, outFile } = opts;
  const frameBytes = dimensionsInBytes(width, height);
  const window = Math.max(1, Math.min(16, Math.floor(MAX_GIF_RAW_BYTES / frameBytes)));
  const workerCount = Math.max(1, Math.min(window, 8, (os.cpus().length || 2) - 1));
  const delay = Math.max(1, Math.round(100 / fps));

  const result = await withExportFile(outFile, async (temporary) => {
    const file = await fs.promises.open(temporary, 'wx');
    const pool = new GifWorkerPool(workerCount);
    const pending = [];
    let palette;
    const writeNext = async () => {
      const { compressed, error } = await pending.shift();
      if (error) throw error;
      await file.writeFile(buildGifFrame(compressed, width, height, delay));
    };

    try {
      const rendered = await renderTimelineFrames({
        ...opts,
        onFrame: async (rgba, idx, total, action) => {
          if (!palette) {
            palette = medianCut(rgba, width, height, 256);
            await file.writeFile(buildGifHeader(width, height, palette));
          }
          pending.push(pool.encode(rgba, width, height, palette).then(
            compressed => ({ compressed }), error => ({ error }),
          ));
          if (pending.length >= window) await writeNext();
          if (opts.onFrame) await opts.onFrame(idx, total, action);
        },
      });
      while (pending.length) await writeNext();
      await file.writeFile(gifTrailer());
      return rendered;
    } finally {
      pool.close();
      await file.close();
    }
  });
  return { ...result, outFile, bytes: fs.statSync(outFile).size };
}
