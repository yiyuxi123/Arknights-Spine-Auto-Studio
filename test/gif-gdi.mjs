// Cross-validation: encode a GIF with the pure-JS encoder, decode it with
// GDI+ (System.Drawing) and compare sampled pixels against the expected
// palette colors. This validates the LZW bitstream against a real decoder.

import { writeFileSync, readFileSync } from 'node:fs';
import { encodeGif, medianCut, quantize } from '../src/gif.mjs';

const WIDTH = 220;
const HEIGHT = 180;
const FRAMES = 3;
const SAMPLES = 240;

function makeFrame(frameIndex) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      // smooth gradient + per-pixel noise => thousands of LZW strings,
      // forcing code-size transitions and table clears.
      const noise = ((x * 7 + y * 13 + frameIndex * 29) % 37) - 18;
      rgba[i] = Math.max(0, Math.min(255, Math.round(x * 255 / WIDTH) + noise));
      rgba[i + 1] = Math.max(0, Math.min(255, Math.round(y * 255 / HEIGHT) + noise));
      rgba[i + 2] = Math.max(0, Math.min(255, Math.round((x + y) * 255 / (WIDTH + HEIGHT)) + noise));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const frames = [];
for (let f = 0; f < FRAMES; f++) frames.push(makeFrame(f));
const gif = encodeGif(frames, WIDTH, HEIGHT, { fps: 12 });
writeFileSync('test/out.gif', gif);

const palette = medianCut(frames[0], WIDTH, HEIGHT, 256);
const expected = { width: WIDTH, height: HEIGHT, frameCount: FRAMES, samples: [] };
for (let f = 0; f < FRAMES; f++) {
  const indices = quantize(frames[f], WIDTH, HEIGHT, palette);
  for (let s = 0; s < SAMPLES; s++) {
    const x = (s * 37 + f * 11) % WIDTH;
    const y = (s * 53 + f * 7) % HEIGHT;
    const index = indices[y * WIDTH + x];
    expected.samples.push({ frame: f, x, y, r: palette[index][0], g: palette[index][1], b: palette[index][2] });
  }
}
writeFileSync('test/gif-expected.json', JSON.stringify(expected));
console.log(`encoded ${FRAMES} frames -> test/out.gif (${gif.length} bytes), expected samples: ${expected.samples.length}`);