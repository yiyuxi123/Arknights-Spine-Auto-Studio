// Shared GIF frame worker pool: quantize + LZW compression run on
// worker_threads so the main thread only orchestrates screenshots.
// Used by render.mjs and preview.mjs. Falls back to inline synchronous
// encoding if a worker fails.
import { Worker } from 'node:worker_threads';
import { quantize, lzwEncode, straightenRgba } from './gif.mjs';

export class GifWorkerPool {
  constructor(size) {
    this.size = Math.max(1, size);
    this.workers = [];
    this.idle = [];
    this.waiting = [];
  }
  _ensure() {
    if (this.workers.length) return;
    const workerUrl = new URL('./gif-worker.mjs', import.meta.url);
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(workerUrl);
      w._busy = null;
      w.on('message', (msg) => {
        const task = w._busy;
        w._busy = null;
        if (task) {
          if (msg.error) task.reject(new Error('gif worker: ' + msg.error));
          else task.resolve(msg.compressed !== undefined ? msg.compressed : msg.straight);
        }
        this._next(w);
      });
      w.on('error', (e) => {
        const task = w._busy;
        w._busy = null;
        if (task) task.reject(e);
        const idx = this.workers.indexOf(w);
        if (idx >= 0) this.workers.splice(idx, 1);
        try { w.terminate(); } catch {}
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }
  _next(w) {
    if (!this.waiting.length) { this.idle.push(w); return; }
    const task = this.waiting.shift();
    this._run(w, task);
  }
  _run(w, task) {
    w._busy = task;
    try {
      w.postMessage({ id: task.id, op: task.op, rgba: task.rgba, width: task.width, height: task.height, palette: task.palette, straight: !!task.straight }, [task.rgba.buffer]);
    } catch (e) {
      w._busy = null;
      task.reject(e);
      this._next(w);
    }
  }
  async encode(frame, width, height, palette, { straight = true } = {}) {
    this._ensure();
    if (!this.workers.length) {
      const src = straight ? straightenRgba(frame, width, height) : frame;
      return lzwEncode(quantize(src, width, height, palette), 8);
    }
    return new Promise((resolve, reject) => {
      const task = { id: 0, resolve, reject, rgba: frame, width, height, palette, straight };
      const w = this.idle.pop();
      if (w) this._run(w, task);
      else this.waiting.push(task);
    });
  }
  // straighten (flip + un-premultiply) a raw WebGL frame on a worker
  straightenOnly(frame, width, height) {
    this._ensure();
    if (!this.workers.length) return Promise.resolve(straightenRgba(frame, width, height));
    return new Promise((resolve, reject) => {
      const task = { id: 0, resolve, reject, rgba: frame, width, height, straight: true, op: 'straighten' };
      const w = this.idle.pop();
      if (w) this._run(w, task);
      else this.waiting.push(task);
    });
  }
  close() {
    for (const w of this.workers) { try { w.terminate(); } catch {} }
    this.workers = [];
    this.idle = [];
    this.waiting = [];
  }
}
