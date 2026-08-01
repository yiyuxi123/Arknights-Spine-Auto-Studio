// GIF frame worker: quantize + LZW compress one RGBA frame off the main
// thread. Runs in a worker_threads pool driven by render.mjs.
import { parentPort } from 'node:worker_threads';
import { quantize, lzwEncode, straightenRgba } from './gif.mjs';

parentPort.on('message', (msg) => {
  const id = msg && msg.id;
  try {
    if (msg.op === 'straighten') {
      const { rgba, width, height } = msg;
      const out = straightenRgba(Buffer.from(rgba), width, height);
      const copy = new Uint8Array(out);
      parentPort.postMessage({ id, straight: copy }, [copy.buffer]);
      return;
    }
    const { rgba, width, height, palette, straight } = msg;
    const src = straight === false ? Buffer.from(rgba) : straightenRgba(Buffer.from(rgba), width, height);
    const indices = quantize(src, width, height, palette);
    const compressed = lzwEncode(indices, 8);
    // ensure a standalone buffer (lzwEncode may return a pooled view)
    const copy = new Uint8Array(compressed);
    parentPort.postMessage({ id, compressed: copy }, [copy.buffer]);
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.stack || e) });
  }
});
