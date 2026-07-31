// Headless renderer: Chrome (CDP) + render/index.html -> RGBA frames -> GIF.
// No Playwright / Puppeteer / FFmpeg required.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession, rmrfRetry } from './cdp.mjs';
import { createGifEncoder } from './gif.mjs';
import { decodePng } from './png.mjs';

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
  const server = await startStaticServer(rootDir);
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

    const segments = timeline.timeline;
    const segDuration = (seg) => (seg.duration || 0) * Math.max(1, parseInt(seg.repeat, 10) || 1);
    const total = segments.reduce((sum, seg) => sum + segDuration(seg), 0);
    const frameCount = Math.max(1, Math.round(total * fps));
    const gifEncoder = createGifEncoder(width, height, { fps });
    let segIndex = 0;
    let segmentStart = 0;
    let lastCycle = -1;

    for (let f = 0; f < frameCount; f++) {
      const t = f / fps;
      while (segIndex < segments.length - 1 && t >= segmentStart + segDuration(segments[segIndex])) {
        segmentStart += segDuration(segments[segIndex]);
        segIndex++;
        lastCycle = -1;
      }
      const seg = segments[segIndex];
      const repeatN = Math.max(1, parseInt(seg.repeat, 10) || 1);
      const cycleDur = seg.duration > 0 ? seg.duration : 1;
      const cycle = Math.min(Math.floor((t - segmentStart) / cycleDur), repeatN - 1);
      const restart = cycle !== lastCycle;
      lastCycle = cycle;
      const delta = 1 / fps; // 实时间，速率由 trackEntry.timeScale 应用
      const stepResult = await evalJs(
        send,
        `studio.step(${JSON.stringify({ action: seg.action, view: seg.view || 'default', loop: seg.loop, delta, timeScale: seg.timeScale || 1, restart })})`,
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
      gifEncoder.write(decoded.rgba);
      decoded.rgba = null; // ???????????????
      if (onFrame) onFrame(f + 1, frameCount, seg.action);
    }

    const gif = gifEncoder.finish();
    fs.writeFileSync(outFile, gif);
    return { frames: frameCount, seconds: total, fps, outFile, bytes: gif.length };
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    await rmrfRetry(userDataDir);
  }
}
