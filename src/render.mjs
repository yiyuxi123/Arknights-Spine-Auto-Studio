// Headless renderer: Chrome (CDP) + render/index.html -> RGBA frames -> GIF.
// No Playwright / Puppeteer / FFmpeg required.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession } from './cdp.mjs';
import { encodeGif } from './gif.mjs';
import { decodePng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function renderTimelineToGif({
  rootDir,
  assets,
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
  const server = await startStaticServer(rootDir);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-studio-'));
  const chrome = launchChrome({ chromePath, userDataDir, width, height });
  const cdp = new CdpClient(await chrome.wsUrl());
  try {
    await cdp.open();
    const rel = (p) => '/' + String(p).replace(/\\/g, '/').replace(/^\/?/, '');
    const query = new URLSearchParams({
      skel: rel(assets.skel),
      atlas: rel(assets.atlas),
      png: rel(assets.png),
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

    const segments = timeline.timeline;
    const total = segments.reduce((sum, seg) => sum + seg.duration, 0);
    const frameCount = Math.max(1, Math.round(total * fps));
    const rgbaFrames = [];
    let segIndex = 0;
    let segmentStart = 0;

    for (let f = 0; f < frameCount; f++) {
      const t = f / fps;
      while (segIndex < segments.length - 1 && t >= segmentStart + segments[segIndex].duration) {
        segmentStart += segments[segIndex].duration;
        segIndex++;
      }
      const seg = segments[segIndex];
      const delta = 1 / fps; // 实时间，速率由 trackEntry.timeScale 应用
      const stepResult = await evalJs(
        send,
        `studio.step(${JSON.stringify({ action: seg.action, loop: seg.loop, delta, timeScale: seg.timeScale || 1 })})`,
      );
      if (stepResult && stepResult.fallback) {
        console.warn(`  [warn] 动作 "${seg.action}" 不存在，已替换为 "${stepResult.action}"`);
      }
      const dataUrl = await evalJs(send, 'studio.snapshot()');
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      const decoded = decodePng(png);
      if (decoded.width !== width || decoded.height !== height) {
        throw new Error(`frame size mismatch: ${decoded.width}x${decoded.height} != ${width}x${height}`);
      }
      rgbaFrames.push(decoded.rgba);
      if (onFrame) onFrame(f + 1, frameCount, seg.action);
    }

    const gif = encodeGif(rgbaFrames, width, height, { fps });
    fs.writeFileSync(outFile, gif);
    return { frames: frameCount, seconds: total, fps, outFile, bytes: gif.length };
  } finally {
    try { cdp.close(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}
