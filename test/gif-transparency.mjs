// GIF transparency + looping regression test.
//
// Verifies that encodeGif emits:
//   1. GCE packed byte 0x09 (disposal=2 "restore to background" + transparent
//      color flag) with transparent index 0 -- the standard layout used by
//      ffmpeg/Pillow for full-canvas transparent animations.
//   2. A NETSCAPE2.0 application extension (loop count 0) so browsers/GDI+
//      play the sequence repeatedly instead of freezing on the last frame.
//   3. LZW data that decodes to the expected pixel indices (verified with an
//      independent minimal GIF-LZW decoder).
import { encodeGif } from '../src/gif.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const W = 64, H = 64;
function makeFrame(color, bx, by) {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (x >= bx && x < bx + 16 && y >= by && y < by + 16) {
        rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = 255;
      } else {
        rgba[i + 3] = 0;
      }
    }
  }
  return rgba;
}

const frame1 = makeFrame([255, 0, 0], 4, 4);   // red block at (4,4)-(19,19)
const frame2 = makeFrame([0, 0, 255], 40, 40); // blue block at (40,40)-(55,55)
const gif = encodeGif([frame1, frame2], W, H, { fps: 10 });

// --- header / logical screen descriptor ---
check('gif: magic', gif.toString('ascii', 0, 6) === 'GIF89a');
check('gif: dimensions', gif.readUInt16LE(6) === W && gif.readUInt16LE(8) === H);
check('gif: GCT 256 entries', (gif[10] & 0x80) !== 0 && (gif[10] & 0x07) === 7);

// --- NETSCAPE2.0 loop extension right after the GCT ---
{
  const afterGct = 13 + 3 * 256;
  const ext = gif.slice(afterGct, afterGct + 19);
  const expected = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00]);
  check('gif: NETSCAPE2.0 loop block', ext.equals(expected), ext.toString('hex'));
}

// --- GCE structure for both frames ---
{
  const gces = [];
  for (let i = 13 + 3 * 256 + 19; i < gif.length - 4; i++) {
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) {
      gces.push({ packed: gif[i + 3], delay: gif[i + 4] | (gif[i + 5] << 8), tindex: gif[i + 6] });
    }
  }
  check('gif: two GCEs', gces.length === 2, String(gces.length));
  check('gif: GCE packed 0x09 (disposal=2 + transparent)', gces.every((g) => g.packed === 0x09), gces.map((g) => g.packed.toString(16)).join(','));
  check('gif: transparent index 0', gces.every((g) => g.tindex === 0));
  check('gif: delay 10cs (100ms @ fps 10)', gces.every((g) => g.delay === 10), String(gces[0]?.delay));
}

// --- independent LZW decode of both frames ---
function decodeFrames(buf) {
  const frames = [];
  let p = 13 + 3 * 256 + 19; // skip header + GCT + loop ext
  while (p < buf.length - 1) {
    if (buf[p] === 0x21 && buf[p + 1] === 0xf9) { p += 8; continue; }
    if (buf[p] === 0x2c) {
      p += 10;
      const minCodeSize = buf[p++];
      const blocks = [];
      while (buf[p] !== 0) {
        const len = buf[p++];
        for (let i = 0; i < len; i++) blocks.push(buf[p + i]);
        p += len;
      }
      p++;
      const clearCode = 1 << minCodeSize, endCode = clearCode + 1;
      let codeSize = minCodeSize + 1, nextCode = endCode + 1, prev = null;
      const dict = new Map();
      let bitPos = 0;
      const readCode = () => {
        let c = 0;
        for (let i = 0; i < codeSize; i++) {
          const byte = blocks[bitPos >> 3];
          c |= ((byte >> (bitPos & 7)) & 1) << i;
          bitPos++;
        }
        return c;
      };
      const out = [];
      while (true) {
        let code = readCode();
        if (code === endCode) break;
        if (code === clearCode) {
          dict.clear(); nextCode = endCode + 1; codeSize = minCodeSize + 1;
          code = readCode();
          if (code === endCode) break;
          prev = null;
        }
        let entry;
        if (code < clearCode) entry = [code];
        else if (dict.has(code)) entry = dict.get(code);
        else if (code === nextCode && prev !== null) entry = [...prev, prev[0]];
        else throw new Error('bad LZW code ' + code);
        out.push(...entry);
        if (prev !== null) {
          dict.set(nextCode, [...prev, entry[0]]);
          nextCode++;
          if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
        }
        prev = entry;
      }
      frames.push(out);
    } else if (buf[p] === 0x3b) break;
    else p++;
  }
  return frames;
}

{
  const frames = decodeFrames(gif);
  check('gif: two decoded frames', frames.length === 2, String(frames.length));
  const at = (out, x, y) => out[y * W + x];
  check('gif: frame1 red at (10,10)', frames[0] && at(frames[0], 10, 10) !== 0);
  check('gif: frame1 transparent at (44,44)', frames[0] && at(frames[0], 44, 44) === 0);
  check('gif: frame2 transparent at (10,10)', frames[1] && at(frames[1], 10, 10) === 0);
  check('gif: frame2 block at (44,44)', frames[1] && at(frames[1], 44, 44) !== 0);
  check('gif: full canvas coverage', frames.every((f) => f.length === W * H), frames.map((f) => f.length).join(','));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);