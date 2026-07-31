// Verify atlas<->PNG alignment fix: render the same character from
// (a) the repaired assets and (b) a reconstructed "broken" control
// (PNG downscaled back to 2/3), then compare fragmentation stats.
// Broken renders produce many small disconnected color fragments; a fixed
// render produces one dominant connected body.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession } from '../src/cdp.mjs';
import { decodePng, encodePng } from '../src/png.mjs';
import { resizeRgba } from '../src/upscale.mjs';
import { readPngSize } from '../src/align.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 320, H = 320, FPS = 10;

async function renderFrames(assets, timeline) {
  const server = await startStaticServer(root);
  const userDataDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'align-ver-'));
  const chrome = launchChrome({ userDataDir, width: W, height: H });
  const cdp = new CdpClient(await chrome.wsUrl());
  try {
    await cdp.open();
    const rel = (p) => '/' + String(p).replace(/\\/g, '/').replace(/^\/?/, '');
    const query = new URLSearchParams({ skel: rel(assets.skel), atlas: rel(assets.atlas), png: rel(assets.png), w: String(W), h: String(H), bg: '00000000', mix: '0.2' });
    const { sessionId } = await newPageSession(cdp, server.origin + '/render/index.html?' + query);
    const send = (m, p) => cdp.send(m, p, sessionId);
    const load = await evalJs(send, 'studio.load()');
    if (!load || !load.ok) throw new Error('studio.load failed: ' + (load && load.error));
    const frames = [];
    for (let f = 0; f < 2; f++) {
      const seg = timeline.timeline[0];
      await evalJs(send, 'studio.step(' + JSON.stringify({ action: seg.action, loop: seg.loop, delta: 1 / FPS * (seg.timeScale || 1) }) + ')');
      const dataUrl = await evalJs(send, 'studio.snapshot()');
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      frames.push(decodePng(png).rgba);
    }
    return frames;
  } finally {
    try { cdp.close(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

function stats(rgba) {
  const opaque = new Uint8Array(W * H);
  let total = 0;
  for (let i = 0; i < W * H; i++) {
    if (rgba[i * 4 + 3] > 8) { opaque[i] = 1; total++; }
  }
  // 4-connectivity flood fill
  const compSize = [];
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!opaque[i] || seen[i]) continue;
    let sp = 0, size = 0;
    stack[sp++] = i;
    seen[i] = 1;
    while (sp > 0) {
      const cur = stack[--sp];
      size++;
      const x = cur % W, y = (cur / W) | 0;
      const nb = [];
      if (x > 0) nb.push(cur - 1);
      if (x < W - 1) nb.push(cur + 1);
      if (y > 0) nb.push(cur - W);
      if (y < H - 1) nb.push(cur + W);
      for (const n of nb) {
        if (opaque[n] && !seen[n]) { seen[n] = 1; stack[sp++] = n; }
      }
    }
    compSize.push(size);
  }
  compSize.sort((a, b) => b - a);
  const largest = compSize[0] || 0;
  return { opaque: total, fill: total / (W * H), components: compSize.length, largestShare: total ? largest / total : 0, top5: compSize.slice(0, 5) };
}

// build broken control: downscale repaired PNG back to 2/3
const src = path.join(root, 'assets', 'char_201_moeshd', 'char_201_moeshd');
const brokenDir = path.join(root, 'out', 'align-test-broken');
fs.mkdirSync(brokenDir, { recursive: true });
for (const ext of ['.skel', '.atlas']) fs.copyFileSync(src + ext, path.join(brokenDir, 'char_201_moeshd' + ext));
const pngBuf = fs.readFileSync(src + '.png');
const { width: pw, height: ph, rgba } = decodePng(pngBuf);
const bw = Math.round(pw * 2 / 3), bh = Math.round(ph * 2 / 3);
fs.writeFileSync(path.join(brokenDir, 'char_201_moeshd.png'), encodePng(resizeRgba(rgba, pw, ph, bw, bh), bw, bh));
console.log('control png:', bw + 'x' + bh, '(atlas still declares', readPngSize(fs.readFileSync(src + '.png')).width + 'x' + readPngSize(fs.readFileSync(src + '.png')).height + ')');

const timeline = JSON.parse(fs.readFileSync(path.join(root, 'out', 'align-test.timeline.json'), 'utf8'));
const fixedAssets = { skel: 'assets/char_201_moeshd/char_201_moeshd.skel', atlas: 'assets/char_201_moeshd/char_201_moeshd.atlas', png: 'assets/char_201_moeshd/char_201_moeshd.png' };
const brokenAssets = { skel: 'out/align-test-broken/char_201_moeshd.skel', atlas: 'out/align-test-broken/char_201_moeshd.atlas', png: 'out/align-test-broken/char_201_moeshd.png' };

console.log('rendering FIXED ...');
const fixedFrames = await renderFrames(fixedAssets, timeline);
console.log('rendering BROKEN control ...');
const brokenFrames = await renderFrames(brokenAssets, timeline);

const fixed = stats(fixedFrames[1]);
const broken = stats(brokenFrames[1]);
console.log('FIXED  :', JSON.stringify(fixed));
console.log('BROKEN :', JSON.stringify(broken));
// save frames for manual inspection
fs.writeFileSync(path.join(root, 'out', 'align-verify-fixed.png'), encodePng(fixedFrames[1], W, H));
fs.writeFileSync(path.join(root, 'out', 'align-verify-broken.png'), encodePng(brokenFrames[1], W, H));
const pass = fixed.largestShare > 0.95 && fixed.components <= 3 && broken.components > fixed.components + 5;
console.log('VERDICT:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
