// Render one representative frame per animation clip as PNG previews.
// Uses the same headless Chrome + render/index.html studio as the video path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession } from './cdp.mjs';

/**
 * Render one preview frame per animation of a Spine 3.8 model.
 * @param {object} opts
 * @param {string} opts.rootDir      repo root (static server base)
 * @param {{skel:string,atlas:string,png:string}} opts.assets absolute paths
 * @param {string} opts.outDir       directory for preview PNGs (created)
 * @param {number} [opts.width]      canvas width (default 256)
 * @param {number} [opts.height]     canvas height (default 256)
 * @param {string} [opts.background] RRGGBBAA (default transparent)
 * @param {string} [opts.chromePath]
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {Promise<Array<{name:string,duration:number,file:string}>>}
 */
export async function renderActionPreviews({
  rootDir,
  assets,
  outDir,
  width = 256,
  height = 256,
  background = '00000000',
  mix = 0.15,
  chromePath,
  onLog = () => {},
} = {}) {
  const server = await startStaticServer(rootDir);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-preview-'));
  const chrome = launchChrome({ chromePath, userDataDir, width, height });
  const cdp = new CdpClient(await chrome.wsUrl());
  try {
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
    const { sessionId } = await newPageSession(cdp, server.origin + '/render/index.html?' + query);
    const send = (m, p) => cdp.send(m, p, sessionId);
    const load = await evalJs(send, 'studio.load()');
    if (!load || !load.ok) throw new Error('studio.load failed: ' + (load && load.error));
    const animations = load.animations || [];
    if (!animations.length) throw new Error('该模型没有任何动画');
    fs.mkdirSync(outDir, { recursive: true });
    const items = [];
    for (const a of animations) {
      const t = a.duration > 0 ? Math.min(a.duration * 0.45, 3) : 0.12;
      await evalJs(send, 'studio.step(' + JSON.stringify({ action: a.name, loop: true, delta: t }) + ')');
      const dataUrl = await evalJs(send, 'studio.snapshot()');
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      const safe = String(a.name).replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'action';
      const file = path.join(outDir, safe + '.png');
      fs.writeFileSync(file, buf);
      items.push({ name: a.name, duration: a.duration, file });
      onLog('[preview] ' + a.name + ' ' + a.duration.toFixed(2) + 's -> ' + safe + '.png');
    }
    return items;
  } finally {
    try { cdp.close(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}
