// FFmpeg support: locate/download a static build and encode RGBA frames to MP4.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL_FFMPEG = path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const DOWNLOAD_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64';

const COMMON_PATHS = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
];

export function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    process.env.FFMPEG_BIN,
    LOCAL_FFMPEG,
    ...COMMON_PATHS,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // PATH lookup
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  } catch {}
  return null;
}

export function ffmpegVersion(ffmpegPath) {
  const result = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) return null;
  const first = (result.stdout || '').split(/\r?\n/)[0];
  return first || null;
}

export async function downloadFfmpeg({ target = LOCAL_FFMPEG, onProgress } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) throw new Error(`ffmpeg download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const temp = target + '.part';
  const out = fs.createWriteStream(temp);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out.write(value);
    if (onProgress) onProgress(received, total);
  }
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });
  fs.renameSync(temp, target);
  return target;
}

export async function ensureFfmpeg({ forceDownload = false, onProgress } = {}) {
  if (!forceDownload) {
    const existing = findFfmpeg();
    if (existing) {
      const version = ffmpegVersion(existing);
      if (version) return { path: existing, version };
    }
  }
  const target = await downloadFfmpeg({ onProgress });
  const version = ffmpegVersion(target);
  if (!version) throw new Error('downloaded ffmpeg failed to run: ' + target);
  return { path: target, version };
}

// Composite RGBA frames over an opaque background and pipe raw RGB24 to
// ffmpeg/libx264. `background` is [r, g, b] 0-255.
export async function renderMp4({ frames, width, height, fps, outFile, background = [255, 255, 255], ffmpegPath }) {
  if (!frames || frames.length === 0) throw new Error('renderMp4: no frames');
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outFile,
  ];
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  const bgR = background[0], bgG = background[1], bgB = background[2];
  const rgb = Buffer.alloc(width * height * 3);
  for (let f = 0; f < frames.length; f++) {
    const rgba = frames[f];
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      const a = rgba[i + 3] / 255;
      const inv = 1 - a;
      rgb[j] = Math.round(rgba[i] * a + bgR * inv);
      rgb[j + 1] = Math.round(rgba[i + 1] * a + bgG * inv);
      rgb[j + 2] = Math.round(rgba[i + 2] * a + bgB * inv);
    }
    if (!proc.stdin.write(rgb)) await once(proc.stdin, 'drain');
  }
  proc.stdin.end();
  const code = await new Promise((resolve, reject) => {
    proc.on('close', resolve);
    proc.on('error', reject);
  });
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1200)}`);
  }
  return outFile;
}

/**
 * Streaming MP4 writer: create once, write() one RGBA frame at a time,
 * end() waits for ffmpeg and returns the output path. Only one frame buffer
 * stays in memory (safe for large canvases / long renders).
 */
export function createMp4Writer({ width, height, fps, outFile, background = [255, 255, 255], ffmpegPath }) {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outFile,
  ];
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  const bgR = background[0], bgG = background[1], bgB = background[2];
  const rgb = Buffer.alloc(width * height * 3);
  let ended = false;
  return {
    write(rgba) {
      if (ended) throw new Error('createMp4Writer: writer already ended');
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        const a = rgba[i + 3] / 255;
        const inv = 1 - a;
        rgb[j] = Math.round(rgba[i] * a + bgR * inv);
        rgb[j + 1] = Math.round(rgba[i + 1] * a + bgG * inv);
        rgb[j + 2] = Math.round(rgba[i + 2] * a + bgB * inv);
      }
      return new Promise((resolve) => {
        if (!proc.stdin.write(rgb)) proc.stdin.once('drain', resolve);
        else resolve();
      });
    },
    end() {
      if (ended) return Promise.resolve(outFile);
      ended = true;
      proc.stdin.end();
      return new Promise((resolve, reject) => {
        proc.on('close', (code) => {
          if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1200)}`));
          else resolve(outFile);
        });
        proc.on('error', reject);
      });
    },
    // kill the encoder and drop the partial file (used when the frame source
    // fails mid-render; otherwise ffmpeg would hang waiting on stdin forever)
    abort() {
      if (ended) return;
      ended = true;
      try { proc.stdin.destroy(); } catch {}
      try { proc.kill(); } catch {}
      try { fs.rmSync(outFile, { force: true }); } catch {}
    },
  };
}
