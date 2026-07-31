// Pure-JS GIF89a encoder: median-cut palette + Floyd-Steinberg dithering +
// LZW compression. Fallback export path when no FFmpeg binary is available.

// ---------------------------------------------------------------------------
// Palette: median cut with alpha-aware weighting (alpha < 128 treated as
// transparent and mapped to index 0).
// ---------------------------------------------------------------------------
function medianCut(rgba, width, height, maxColors = 256) {
  // Only opaque pixels join the palette: index 0 is reserved for transparency,
  // so dark character pixels must never be quantized to it.
  const pixels = [];
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] < 128) continue;
    pixels.push({ r: rgba[i * 4], g: rgba[i * 4 + 1], b: rgba[i * 4 + 2], a: 255 });
  }

  const boxExtents = (box) => {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (let i = 0; i < box.length; i++) {
      const p = box[i];
      if (p.r < rMin) rMin = p.r;
      if (p.r > rMax) rMax = p.r;
      if (p.g < gMin) gMin = p.g;
      if (p.g > gMax) gMax = p.g;
      if (p.b < bMin) bMin = p.b;
      if (p.b > bMax) bMax = p.b;
    }
    return { rMin, rMax, gMin, gMax, bMin, bMax };
  };
  const boxes = [pixels];
  while (boxes.length < maxColors - 1) {
    let target = null;
    let targetRange = -1;
    for (const box of boxes) {
      if (box.length < 2) continue;
      const ext = boxExtents(box);
      const range = Math.max(ext.rMax - ext.rMin, ext.gMax - ext.gMin, ext.bMax - ext.bMin);
      if (range > targetRange) {
        targetRange = range;
        target = box;
      }
    }
    if (!target) break;
    const ext = boxExtents(target);
    const rRange = ext.rMax - ext.rMin;
    const gRange = ext.gMax - ext.gMin;
    const bRange = ext.bMax - ext.bMin;
    const channel = rRange >= gRange && rRange >= bRange ? 'r' : gRange >= bRange ? 'g' : 'b';
    target.sort((a, b) => a[channel] - b[channel]);
    const mid = target.length >> 1;
    boxes.splice(boxes.indexOf(target), 1, target.slice(0, mid), target.slice(mid));
  }

  const palette = [[0, 0, 0]]; // index 0 reserved for transparent black
  for (const box of boxes) {
    if (box.length === 0) continue;
    const sum = box.reduce((acc, p) => [acc[0] + p.r, acc[1] + p.g, acc[2] + p.b], [0, 0, 0]);
    palette.push([Math.round(sum[0] / box.length), Math.round(sum[1] / box.length), Math.round(sum[2] / box.length)]);
  }
  while (palette.length < 256) palette.push([0, 0, 0]);
  return palette;
}

function nearestIndex(palette, r, g, b) {
  let best = 1; // index 0 is the transparent slot; never pick it for opaque pixels
  let bestDistance = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const dr = palette[i][0] - r;
    const dg = palette[i][1] - g;
    const db = palette[i][2] - b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function quantize(rgba, width, height, palette) {
  const indices = new Uint8Array(width * height);
  const err = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = rgba[i * 4 + 3];
      if (a < 128) {
        indices[i] = 0;
        continue;
      }
      const src = i * 4;
      let r = rgba[src] + err[i * 3];
      let g = rgba[src + 1] + err[i * 3 + 1];
      let b = rgba[src + 2] + err[i * 3 + 2];
      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));
      const index = nearestIndex(palette, r, g, b);
      indices[i] = index;
      const dr = r - palette[index][0];
      const dg = g - palette[index][1];
      const db = b - palette[index][2];
      if (x + 1 < width) {
        err[i * 3 + 3] += dr * 7 / 16;
        err[i * 3 + 4] += dg * 7 / 16;
        err[i * 3 + 5] += db * 7 / 16;
      }
      if (y + 1 < height) {
        if (x > 0) {
          err[(i + width - 1) * 3] += dr * 3 / 16;
          err[(i + width - 1) * 3 + 1] += dg * 3 / 16;
          err[(i + width - 1) * 3 + 2] += db * 3 / 16;
        }
        err[(i + width) * 3] += dr * 5 / 16;
        err[(i + width) * 3 + 1] += dg * 5 / 16;
        err[(i + width) * 3 + 2] += db * 5 / 16;
        if (x + 1 < width) {
          err[(i + width + 1) * 3] += dr * 1 / 16;
          err[(i + width + 1) * 3 + 1] += dg * 1 / 16;
          err[(i + width + 1) * 3 + 2] += db * 1 / 16;
        }
      }
    }
  }
  return indices;
}

// ---------------------------------------------------------------------------
// LZW encoder (GIF flavor).
// ---------------------------------------------------------------------------
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const output = [];
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const dictionary = new Map();
  let previous = null;
  let previousKey = '';
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  const reset = () => {
    dictionary.clear();
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  emit(clearCode);
  for (let i = 0; i < indices.length; i++) {
    const symbol = indices[i];
    if (previous === null) {
      previous = symbol;
      previousKey = String(symbol);
      continue;
    }
    const key = `${previousKey},${symbol}`;
    if (dictionary.has(key)) {
      previous = dictionary.get(key);
      previousKey = key;
      continue;
    }
    emit(previous);
    dictionary.set(key, nextCode);
    if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    nextCode++;
    if (nextCode > 4095) {
      emit(clearCode);
      reset();
    }
    previous = symbol;
    previousKey = String(symbol);
  }
  if (previous !== null) emit(previous);
  emit(endCode);
  if (bitCount > 0) output.push(bitBuffer & 0xff);
  return output;
}

// ---------------------------------------------------------------------------
// Public API: encode an RGBA frame sequence into a GIF.
// ---------------------------------------------------------------------------
export { medianCut, quantize, lzwEncode };

/**
 * Streaming GIF89a encoder: create once, write() one RGBA frame at a time,
 * finish() returns the complete file buffer. Only the current frame stays in
 * memory (safe for 1280x1280@60fps long renders that would otherwise hold GBs).
 */
export function createGifEncoder(width, height, { fps = 15, maxColors = 256 } = {}) {
  const chunks = [];
  const push = (buf) => chunks.push(buf);
  let palette = null;
  let started = false;
  const delay = Math.max(1, Math.round(100 / fps));

  function start(firstFrame) {
    palette = medianCut(firstFrame, width, height, maxColors);
    push(Buffer.from('GIF89a'));
    const descriptor = Buffer.alloc(7);
    descriptor.writeUInt16LE(width, 0);
    descriptor.writeUInt16LE(height, 2);
    descriptor[4] = 0xf7; // global color table, 8 bits, 256 entries
    descriptor[5] = 0;
    descriptor[6] = 0;
    push(descriptor);
    for (const entry of palette) push(Buffer.from([entry[0], entry[1], entry[2]]));
    // NETSCAPE2.0 application extension: loop forever (count 0).
    // Without it, browsers/GDI+ play the sequence once and freeze on the last frame.
    push(Buffer.from([0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00]));
  }

  return {
    write(frame) {
      if (!frame) throw new Error('createGifEncoder.write: frame required');
      if (!started) { start(frame); started = true; }
      const indices = quantize(frame, width, height, palette);
      // packed: 0x09 = disposal=2 (restore to background) | transparent-color-flag.
      // disposal=2 + transparent index 0 is the standard choice for full-canvas
      // transparent animations (same as ffmpeg/Pillow output); verified in Chrome
      // 151 (ImageDecoder + <img> playback), GDI+ and ffmpeg.
      const gce = Buffer.from([0x21, 0xf9, 0x04, 0x09, delay & 0xff, delay >> 8, 0x00, 0x00]);
      push(gce);
      const image = Buffer.alloc(10);
      image[0] = 0x2c;
      image.writeUInt16LE(0, 1);
      image.writeUInt16LE(0, 3);
      image.writeUInt16LE(width, 5);
      image.writeUInt16LE(height, 7);
      image[9] = 0x00; // no local color table
      push(image);
      const minCodeSize = 8;
      push(Buffer.from([minCodeSize]));
      const compressed = lzwEncode(indices, minCodeSize);
      for (let i = 0; i < compressed.length; i += 255) {
        const block = compressed.slice(i, i + 255);
        push(Buffer.from([block.length, ...block]));
      }
      push(Buffer.from([0x00]));
    },
    finish() {
      if (!started) throw new Error('createGifEncoder.finish: no frames written');
      push(Buffer.from([0x3b]));
      return Buffer.concat(chunks);
    },
  };
}

export function encodeGif(frames, width, height, opts = {}) {
  if (!frames || frames.length === 0) throw new Error('encodeGif: no frames');
  const enc = createGifEncoder(width, height, opts);
  for (const f of frames) enc.write(f);
  return enc.finish();
}
