// Tests for the pure-JS PNG encoder/decoder and GIF encoder.
// GIF is verified by decoding its LZW stream back and comparing indices.

import { encodePng, decodePng } from '../src/png.mjs';
import { encodeGif } from '../src/gif.mjs';

const WIDTH = 96;
const HEIGHT = 72;
const FRAMES = 12;

function makeFrame(frameIndex) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const dx = x - (WIDTH / 2 + Math.sin(frameIndex / 3) * 20);
      const dy = y - (HEIGHT / 2 + Math.cos(frameIndex / 4) * 15);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const circle = Math.max(0, 1 - dist / 18);
      rgba[i] = Math.min(255, Math.round(x * 255 / WIDTH + circle * 100));
      rgba[i + 1] = Math.min(255, Math.round(y * 255 / HEIGHT));
      rgba[i + 2] = Math.min(255, Math.round(circle * 255));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

let failures = 0;
let lastIndices = null;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

// --- PNG round trip ---
{
  const frame = makeFrame(0);
  const png = encodePng(frame, WIDTH, HEIGHT);
  check('png signature', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
  const decoded = decodePng(png);
  check('png size', decoded.width === WIDTH && decoded.height === HEIGHT, `${decoded.width}x${decoded.height}`);
  let identical = true;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] !== decoded.rgba[i]) { identical = false; break; }
  }
  check('png pixels identical', identical);
}

// --- GIF structure + LZW round trip ---
{
  const frames = [];
  for (let f = 0; f < FRAMES; f++) frames.push(makeFrame(f === 3 ? 1 : f)); // frames 1 and 3 identical for cross-check
  const gif = encodeGif(frames, WIDTH, HEIGHT, { fps: 15 });
  check('gif signature', gif.subarray(0, 6).toString('ascii') === 'GIF89a');
  check('gif trailer', gif[gif.length - 1] === 0x3b);
  const width = gif.readUInt16LE(6);
  const height = gif.readUInt16LE(8);
  check('gif size', width === WIDTH && height === HEIGHT, `${width}x${height}`);

  // Walk blocks and count image descriptors + verify LZW decodes to same indices.
  let pos = 13 + 256 * 3; // after global color table
  let images = 0;
  let decodeErrors = 0;
  while (pos < gif.length) {
    const marker = gif[pos];
    if (marker === 0x21) {
      const label = gif[pos + 1];
      if (label === 0xf9) {
        const blockSize = gif[pos + 2];
        pos += 3 + blockSize + 1;
      } else {
        pos += 2;
        while (gif[pos] !== 0) pos += gif[pos] + 1;
        pos += 1;
      }
      continue;
    }
    if (marker === 0x2c) {
      images++;
      const imgWidth = gif.readUInt16LE(pos + 5);
      const imgHeight = gif.readUInt16LE(pos + 7);
      if (imgWidth !== WIDTH || imgHeight !== HEIGHT) decodeErrors++;
      const minCodeSize = gif[pos + 10];
      let p = pos + 11;
      const data = [];
      while (gif[p] !== 0) {
        const blockSize = gif[p];
        for (let i = 1; i <= blockSize; i++) data.push(gif[p + i]);
        p += blockSize + 1;
      }
      pos = p + 1;
      // LZW decode
      const indices = lzwDecode(data, minCodeSize, WIDTH * HEIGHT);
      if (indices === null) { decodeErrors++; continue; }
      const frameIndex = images - 1;
      // Compare with the palette-mapped expectation indirectly: decode the
      // original frame's quantized indices via the same medianCut/quantize
      // functions is not exported, so verify decode produced consistent data:
      // indices length, and that two identical frames decode identically.
      if (indices.length !== WIDTH * HEIGHT) decodeErrors++;
      if (frameIndex === 1) lastIndices = indices;
      if (frameIndex === 3) {
        for (let i = 0; i < indices.length; i++) {
          if (indices[i] !== lastIndices[i]) { decodeErrors++; break; }
        }
      }
      continue;
    }
    if (marker === 0x3b) break;
    decodeErrors++;
    pos++;
  }
  check('gif frame count', images === FRAMES, `${images} images`);
  check('gif lzw decode ok', decodeErrors === 0, `${decodeErrors} errors`);
}


function lzwDecode(data, minCodeSize, expectedLength) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const dictionary = [];
  const init = () => {
    dictionary.length = 0;
    for (let i = 0; i <= endCode; i++) dictionary.push(i < 256 ? [i] : null);
  };
  init();
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let bitBuffer = 0;
  let bitCount = 0;
  let bitPos = 0;
  const readCode = () => {
    while (bitCount < codeSize) {
      if (bitPos >= data.length) return null;
      bitBuffer |= data[bitPos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };
  const out = [];
  let previous = null;
  for (;;) {
    const code = readCode();
    if (code === null) return null;
    if (code === clearCode) {
      init();
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      previous = null;
      continue;
    }
    if (code === endCode) break;
    let entry;
    if (code < dictionary.length && dictionary[code] !== null) {
      entry = dictionary[code];
    } else if (code === nextCode && previous !== null) {
      entry = previous.concat(previous[0]);
    } else {
      return null;
    }
    for (const value of entry) out.push(value);
    if (previous !== null && nextCode < 4096) {
      dictionary[nextCode++] = previous.concat(entry[0]);
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }
    previous = entry;
  }
  if (out.length !== expectedLength) return null;
  return out;
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);