// Run with Node >= 22 and Chrome/Edge.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkeleton } from '../src/skel.mjs';
import { renderTimelineFrames, renderTimelineToGif } from '../src/render.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const skel = 'assets/amiya/amiya.skel';
const actions = parseSkeleton(new Uint8Array(await fs.readFile(path.join(rootDir, skel))))
  .animations.filter(animation => animation.duration > 0);
const assetsList = ['front', 'back'].map(name => ({ name, skel, atlas: 'assets/amiya/amiya.atlas', png: 'assets/amiya/amiya.png' }));
const timeline = { timeline: [
  { view: 'front', action: actions[0].name, duration: 1.27, loop: true },
  { view: 'front', action: actions[1].name, duration: 2.15, loop: true },
  { view: 'back', action: actions[0].name, duration: 2.58, loop: true },
] };
const options = { rootDir, assetsList, timeline, width: 160, height: 160, fps: 20 };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'spine-export-test-'));
const configuredChunks = process.env.ZDXR_RENDER_CHUNKS;
try {
  const renderHashes = async (chunks) => {
    process.env.ZDXR_RENDER_CHUNKS = String(chunks);
    const hashes = [];
    const result = await renderTimelineFrames({ ...options, onFrame: async (raw, index) => {
      if (chunks > 1) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(index, hashes.length + 1);
      hashes.push(crypto.createHash('sha256').update(raw).digest('hex'));
    } });
    assert.equal(result.frames, 120);
    assert.equal(hashes.length, 120);
    return hashes;
  };
  assert.deepEqual(await renderHashes(4), await renderHashes(1), 'parallel frame order and replay must match sequential');

  process.env.ZDXR_RENDER_CHUNKS = '4';
  const outFile = path.join(temporary, 'test.gif');
  await fs.writeFile(outFile, 'old-export');
  await assert.rejects(renderTimelineToGif({ ...options, outFile, onFrame: async index => {
    if (index === 37) throw new Error('frame sink failed');
  } }), /frame sink failed/);
  assert.equal(await fs.readFile(outFile, 'utf8'), 'old-export');
  assert.deepEqual(await fs.readdir(temporary), ['test.gif']);
  const output = await renderTimelineToGif({ ...options, outFile });
  assert.equal(output.frames, 120);
  const gif = await fs.readFile(outFile);
  assert.equal(gif.subarray(0, 6).toString(), 'GIF89a');
  assert.equal(gif.at(-1), 0x3b);
  console.log('PASS: ordered parallel rendering, matched replay, complete GIF and previous output preserved on failure');
} finally {
  if (configuredChunks === undefined) delete process.env.ZDXR_RENDER_CHUNKS;
  else process.env.ZDXR_RENDER_CHUNKS = configuredChunks;
  await fs.rm(temporary, { recursive: true, force: true });
}
