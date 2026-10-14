// Real WebGL regression: one, two and three views; fixed and dynamic cameras.
// Optional --assets=<JSON> supplies distinct real views (default: built-in Amiya).
// --expect-bug verifies the pre-fix failure. --out-dir=<path> retains evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startStaticServer, launchChrome, CdpClient, newPageSession, evalJs, rmrfRetry } from '../src/cdp.mjs';
import { encodePng, decodePng } from '../src/png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (key) => process.argv.find(a => a.startsWith(key + '='))?.slice(key.length + 1);
const out = option('--out-dir');
const expectBug = process.argv.includes('--expect-bug');
const assetsFile = option('--assets');
const renderer = option('--renderer') || 'render/index.html';
const views = assetsFile ? JSON.parse(fs.readFileSync(assetsFile, 'utf8')) : ['base', 'front', 'back'].map(name => ({
  name, skel: '/assets/amiya/amiya.skel', atlas: '/assets/amiya/amiya.atlas', png: '/assets/amiya/amiya.png',
}));
assert.equal(views.length, 3);
const width = Number(option('--size') || 640), height = width;
const server = await startStaticServer(root);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'issue1-regression-'));
const chrome = launchChrome({ userDataDir: profile, width, height });
let cdp;
const results = [];
const fallbackHashes = [];
try {
  cdp = new CdpClient(await chrome.wsUrl());
  await cdp.open();
  const version = await cdp.send('Browser.getVersion');
  for (const count of [1, 2, 3]) {
    for (const camMode of ['fixed', 'dynamic']) {
      // Empty action whitelist deliberately exercises per-view union fallback.
      const query = new URLSearchParams({ views: JSON.stringify(views.slice(0, count)), w: String(width), h: String(height), bg: '00000000', camMode, actions: '[]' });
      const page = await newPageSession(cdp, `${server.origin}/${renderer}?${query}`);
      const send = (method, params) => cdp.send(method, params, page.sessionId);
      const load = await evalJs(send, '(async () => { const r = await studio.load(); return { ...r, boundsFinite: r.ok && Object.values(r.bounds).every(Number.isFinite), boundsNaN: r.ok ? Object.keys(r.bounds).filter(k => Number.isNaN(r.bounds[k])) : [] }; })()');
      assert.equal(load.ok, true, load.error);
      const boundsFinite = load.boundsFinite;
      const frames = [];
      for (let viewIndex = 0; viewIndex < count; viewIndex++) {
        const action = load.views[viewIndex].animations[0].name;
        for (const stepIndex of [0, 1]) {
          const params = { action, view: views[viewIndex].name, delta: stepIndex ? 1 / 60 : 0, loop: true, restart: stepIndex === 0 };
          const snapshot = await evalJs(send, 'studio.stepAndSnapshot(' + JSON.stringify(params) + ')');
          assert.equal(snapshot.ok, true);
          const rgba = Buffer.from(snapshot.dataUrl.split(',')[1], 'base64');
          assert.equal(rgba.length, width * height * 4);
          let visible = 0;
          for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) visible++;
          const hash = crypto.createHash('sha256').update(rgba).digest('hex');
          frames.push({ view: views[viewIndex].name, step: stepIndex, visiblePixels: visible, totalPixels: width * height, rgbaSha256: hash });
          if (camMode === 'dynamic' && viewIndex === 0 && stepIndex === 0) fallbackHashes.push(hash);
          if (out && stepIndex === 0) {
            fs.mkdirSync(out, { recursive: true });
            const filename = path.join(out, `${count}-${camMode}-${views[viewIndex].name}.png`);
            const png = encodePng(rgba, width, height);
            fs.writeFileSync(filename, png);
            assert.deepEqual(Buffer.from(decodePng(fs.readFileSync(filename)).rgba), rgba);
          }
        }
      }
      results.push({ count, camMode, bounds: load.bounds, boundsFinite, boundsNaN: load.boundsNaN, frames });
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
    }
  }
  const report = { expectedBug: expectBug, renderer, environment: { node: process.version, platform: process.platform, browser: version, softwareRendering: process.env.ZDXR_SWIFTSHADER === '1' }, size: width, assets: assetsFile || 'built-in Amiya reused under distinct view names', results, dynamicFallbackFirstFrameIdentical: new Set(fallbackHashes).size === 1 };
  if (out) fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const result of results) {
    const failing = expectBug && result.count > 1;
    assert.equal(result.boundsFinite, !failing, 'merged bounds must match expected condition');
    for (const frame of result.frames) {
      if (failing && (result.camMode === 'fixed' || frame.view === views[0].name)) assert.equal(frame.visiblePixels, 0, 'pre-fix aggregate and first-view fallback must be blank');
      else assert.ok(frame.visiblePixels > 0, 'character must be visible');
    }
  }
  if (!expectBug) assert.equal(report.dynamicFallbackFirstFrameIdentical, true, 'merging must not mutate first view bounds used by dynamic fallback');
  console.log(JSON.stringify({ status: 'PASS', expectedBug: expectBug, cases: results.map(r => ({ views: r.count, camera: r.camMode, boundsFinite: r.boundsFinite, visiblePixels: r.frames.map(f => f.visiblePixels) })), dynamicFallbackFirstFrameIdentical: report.dynamicFallbackFirstFrameIdentical }));
} finally {
  cdp?.close();
  await chrome.close();
  await server.close();
  await rmrfRetry(profile);
}
