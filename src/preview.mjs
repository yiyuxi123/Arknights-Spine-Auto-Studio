// Render action previews: one PNG keyframe (fast) or a short looping GIF (直观).
// GIF mode captures frames in headless Chrome and encodes with the pure-JS GIF encoder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession, rmrfRetry } from './cdp.mjs';
import { GifWorkerPool } from './gif-pool.mjs';
import { buildGifHeader, buildGifFrame, gifTrailer, medianCut } from './gif.mjs';
import { encodePng } from './png.mjs';

/**
 * Render previews for every animation clip of a Spine 3.8 model.
 * @param {object} opts
 * @param {string} opts.rootDir      repo root (static server base)
 * @param {{skel:string,atlas:string,png:string}} opts.assets absolute paths
 * @param {string} opts.outDir       directory for preview files (created)
 * @param {'frame'|'anim'} [opts.mode] frame=单帧快照(快)；anim=完整循环动画 GIF(直观)
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.previewFps] GIF 模式帧率（默认 12）
 * @param {number} [opts.maxFrames] GIF 模式每动作最大帧数（默认 48）
 * @param {string} [opts.chromePath]
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {Promise<Array<{name:string,duration:number,kind:string,file:string}>>}
 */
export async function renderActionPreviews({
  rootDir,
  assets,
  outDir,
  mode = 'anim',
  width = 256,
  height = 256,
  previewFps = 12,
  maxFrames = 48,
  background = '00000000',
  mix = 0.15,
  chromePath,
  onLog = () => {},
} = {}) {
  const server = await startStaticServer(rootDir);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-preview-'));
  const chrome = launchChrome({ chromePath, userDataDir, width, height });

  let cdp = null;
  try {
    cdp = new CdpClient(await chrome.wsUrl());
    await cdp.open();
    const base = String(rootDir).replace(/\\/g, '/').replace(/\/+$/, '');
    const rel = (p) => {
      let s = String(p).replace(/\\/g, '/');
      if (s.startsWith(base + '/')) s = s.slice(base.length + 1);
      return '/' + s.replace(/^\/+/, '');
    };
    const query = new URLSearchParams({
      skel: rel(assets.skel),
      atlas: rel(assets.atlas),
      png: rel(assets.png),
      w: String(width),
      h: String(height),
      bg: background,
      mix: String(mix),
    });
    const pageUrl = server.origin + '/render/index.html?' + query;
    const first = await newPageSession(cdp, pageUrl);
    const sendFirst = (m, p) => cdp.send(m, p, first.sessionId);
    const load = await evalJs(sendFirst, 'studio.load()');
    if (!load || !load.ok) throw new Error('studio.load failed: ' + (load && load.error));
    const animations = load.animations || [];
    if (!animations.length) throw new Error('该模型没有任何动画');
    fs.mkdirSync(outDir, { recursive: true });
    // Parallel previews: up to 4 pages render different actions at once, GIF
    // encoding runs on the shared worker pool.
    const pool = new GifWorkerPool(Math.max(2, Math.min(8, (os.cpus?.() || [1, 2, 3, 4]).length - 1)));
    const delay = Math.max(1, Math.round(100 / previewFps));
    const items = [];
    let cursor = 0;
    const renderOne = async () => {
      while (cursor < animations.length) {
        const a = animations[cursor++];
        const safe = String(a.name).replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'action';
        const { sessionId } = await newPageSession(cdp, pageUrl);
        const send = (m, p) => cdp.send(m, p, sessionId);
        await evalJs(send, 'studio.load()');
        const step = (t) => evalJs(send, 'studio.step(' + JSON.stringify({ action: a.name, loop: true, delta: t }) + ')');
        if (mode === 'frame') {
          const t = a.duration > 0 ? Math.min(a.duration * 0.45, 3) : 0.12;
          await step(t);
          const dataUrl = String(await evalJs(send, 'studio.snapshot()'));
          const rgba = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
          const file = path.join(outDir, safe + '.png');
          fs.writeFileSync(file, encodePng(rgba, width, height));
          items.push({ name: a.name, duration: a.duration, kind: 'png', file });
          onLog('[preview] ' + a.name + ' ' + a.duration.toFixed(2) + 's -> ' + safe + '.png');
        } else {
          const frames = a.duration > 0 ? Math.max(8, Math.min(Math.round(a.duration * previewFps), maxFrames)) : 8;
          const rgbaFrames = [];
          for (let f = 0; f < frames; f++) {
            await step(1 / previewFps);
            const dataUrl = String(await evalJs(send, 'studio.snapshot()'));
            rgbaFrames.push(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
          }
          const palette = medianCut(rgbaFrames[0], width, height, 256);
          const chunks = [buildGifHeader(width, height, palette)];
          const comps = await Promise.all(rgbaFrames.map((rgba) => pool.encode(rgba, width, height, palette, { straight: false })));
          for (const c of comps) chunks.push(buildGifFrame(c, width, height, delay));
          chunks.push(gifTrailer());
          const gif = Buffer.concat(chunks);
          const file = path.join(outDir, safe + '.gif');
          fs.writeFileSync(file, gif);
          items.push({ name: a.name, duration: a.duration, kind: 'gif', file });
          onLog('[preview] ' + a.name + ' ' + a.duration.toFixed(2) + 's ' + frames + '帧 -> ' + safe + '.gif');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, animations.length)) }, renderOne));
    pool.close();
    return items;
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    await rmrfRetry(userDataDir);
  }
}

// 取回某动作的代表帧 PNG 路径（供视觉标注拼图用，复用同一渲染管线）
export async function renderKeyframes({
  rootDir,
  assets,
  outDir,
  action,
  duration,
  width = 256,
  height = 256,
  count = 4,
  chromePath,
  onLog = () => {},
} = {}) {
  const server = await startStaticServer(rootDir);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-kf-'));
  const chrome = launchChrome({ chromePath, userDataDir, width, height });

  let cdp = null;
  try {
    cdp = new CdpClient(await chrome.wsUrl());
    await cdp.open();
    const base = String(rootDir).replace(/\\/g, '/').replace(/\/+$/, '');
    const rel = (p) => {
      let s = String(p).replace(/\\/g, '/');
      if (s.startsWith(base + '/')) s = s.slice(base.length + 1);
      return '/' + s.replace(/^\/+/, '');
    };
    const query = new URLSearchParams({
      skel: rel(assets.skel),
      atlas: rel(assets.atlas),
      png: rel(assets.png),
      w: String(width),
      h: String(height),
      bg: '00000000',
      mix: '0.15',
    });
    const { sessionId } = await newPageSession(cdp, server.origin + '/render/index.html?' + query);
    const send = (m, p) => cdp.send(m, p, sessionId);
    const load = await evalJs(send, 'studio.load()');
    if (!load || !load.ok) throw new Error('studio.load failed: ' + (load && load.error));
    fs.mkdirSync(outDir, { recursive: true });
    const total = duration > 0 ? duration : 1;
    const files = [];
    let prevT = 0;
    for (let i = 0; i < count; i++) {
      const t = i === 0 ? 0.05 : Math.min((i / count) * total * 0.8 + 0.05, total * 0.95);
      await evalJs(send, 'studio.step(' + JSON.stringify({ action, loop: true, delta: Math.max(0.016, t - prevT) }) + ')');
      prevT = t;
      const dataUrl = String(await evalJs(send, 'studio.snapshot()'));
      const rgba = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      const file = path.join(outDir, 'kf' + i + '.png');
      fs.writeFileSync(file, encodePng(rgba, width, height));
      files.push(file);
    }
    onLog('[keyframes] ' + action + ' -> ' + files.length + ' 帧');
    return files;
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    await rmrfRetry(userDataDir);
  }
}
