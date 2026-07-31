// ============================================================================
// Arknights Spine Auto-Studio — 桌面端本地服务（零依赖 Node ESM）
//   本地 HTTP + SSE：驱动 src/pipeline.mjs 的 fetch / run / upscale / inspect，
//   并把进度实时推送给桌面 UI。
//   仅绑定 127.0.0.1，供本机桌面窗口使用。
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { main } from '../src/pipeline.mjs';
import { parseSkeleton } from '../src/skel.mjs';
import { resolveModelRef, fetchCharacterFromPrts } from '../src/prts.mjs';
import { alignAssetsInPlace } from '../src/align.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const uiDir = path.join(here, 'ui');
const assetsDir = path.join(root, 'assets');
const outDir = path.join(root, 'out');
const PORT = parseInt(process.env.ZDXR_PORT || '4879', 10);
const HOST = '127.0.0.1';

fs.mkdirSync(outDir, { recursive: true });

// ---------- 配置（config.json：DeepSeek API Key / 模型 / 地址） ----------
const CONFIG_FILE = path.join(root, 'config.json');

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* 首次运行无配置文件 */ }
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || file.deepseekApiKey || '',
    model: process.env.DEEPSEEK_MODEL || file.deepseekModel || 'deepseek-v4-flash',
    baseURL: process.env.DEEPSEEK_BASE_URL || file.deepseekBaseURL || 'https://api.deepseek.com',
    file,
  };
}

let envKeyInjected = false; // 记录 API Key 是否由本程序注入（用于清除时同步删除）

function applyConfig() {
  const cfg = loadConfig();
  if (!process.env.DEEPSEEK_API_KEY && cfg.file.deepseekApiKey) {
    process.env.DEEPSEEK_API_KEY = cfg.file.deepseekApiKey;
    envKeyInjected = true;
  }
  if (cfg.model) process.env.DEEPSEEK_MODEL = cfg.model;
  if (cfg.baseURL) process.env.DEEPSEEK_BASE_URL = cfg.baseURL;
  return cfg;
}

function saveConfig({ apiKey, model, baseURL } = {}) {
  const cfg = loadConfig();
  const next = { ...cfg.file };
  if (apiKey !== undefined) {
    if (String(apiKey).trim()) {
      next.deepseekApiKey = String(apiKey).trim();
      process.env.DEEPSEEK_API_KEY = String(apiKey).trim(); // 立即生效
      envKeyInjected = true;
    } else {
      delete next.deepseekApiKey;
      if (envKeyInjected) delete process.env.DEEPSEEK_API_KEY; // 仅清除本程序注入的值
      envKeyInjected = false;
    }
  }
  if (model !== undefined) {
    next.deepseekModel = String(model).trim() || 'deepseek-v4-flash';
    process.env.DEEPSEEK_MODEL = next.deepseekModel;
  }
  if (baseURL !== undefined) {
    next.deepseekBaseURL = String(baseURL).trim() || 'https://api.deepseek.com';
    process.env.DEEPSEEK_BASE_URL = next.deepseekBaseURL;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return key.slice(0, 3) + '***' + key.slice(-4);
}

// ---------------------------------------------------------------------------
// SSE 广播
// ---------------------------------------------------------------------------
const sseClients = new Set();
function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ---------------------------------------------------------------------------
// 任务队列（串行，避免并发渲染冲突）
// ---------------------------------------------------------------------------
let queue = Promise.resolve();
let jobSeq = 0;
const jobs = new Map();

function enqueue(kind, fn) {
  const id = `job-${++jobSeq}`;
  const job = { id, kind, status: 'queued', createdAt: Date.now(), logs: [], result: null, error: null };
  jobs.set(id, job);
  queue = queue
    .then(async () => {
      job.status = 'running';
      broadcast('status', { jobId: id, status: 'running' });
      const origLog = console.log;
      const origErr = console.error;
      const emit = (line) => {
        job.logs.push(line);
        broadcast('log', { jobId: id, line });
      };
      console.log = (...a) => {
        const line = a.map((v) => (typeof v === 'string' ? v : util.inspect(v, { depth: 3, colors: false }))).join(' ');
        emit(line);
        origLog(...a);
      };
      console.error = (...a) => {
        const line = a.map((v) => (typeof v === 'string' ? v : util.inspect(v, { depth: 3, colors: false }))).join(' ');
        emit(line);
        origErr(...a);
      };
      try {
        const result = await fn();
        job.status = 'done';
        job.result = result;
        broadcast('done', { jobId: id, result });
        return result;
      } catch (err) {
        job.status = 'error';
        job.error = String(err?.stack || err);
        emit(`[error] ${err?.stack || err}`);
        broadcast('error', { jobId: id, message: String(err?.message || err) });
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
    })
    .catch(() => {});
  return id;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.skel': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, err) {
  sendJson(res, 500, { ok: false, error: String(err?.message || err) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function runChild(nodeArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, { cwd: root, windowsHide: true });
    let errText = '';
    child.stdout.on('data', (d) => {
      for (const line of String(d).split(/[\r\n]+/)) if (line.trim()) console.log(line);
    });
    child.stderr.on('data', (d) => { errText += String(d); console.error(String(d).trimEnd()); });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const tail = errText.split(/[\r\n]+/).filter(Boolean).slice(-4).join(' | ');
        reject(new Error(tail || '子进程退出码 ' + code));
      }
    });
  });
}

function safeName(name) {
  return String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'result';
}

function listFiles(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 2) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return listFiles(p, depth + 1);
    if (!d.isFile()) return [];
    const st = fs.statSync(p);
    const rel = path.relative(outDir, p);
    const url = '/outputs/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/');
    return [{ name: rel, size: st.size, mtime: st.mtimeMs, url }];
  }).sort((a, b) => b.mtime - a.mtime);
}

function chromeCandidates() {
  const list = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
  ].filter(Boolean);
  return list.find((p) => fs.existsSync(p)) || null;
}

function cachedModels() {
  if (!fs.existsSync(assetsDir)) return [];
  return fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(assetsDir, d.name);
      const skel = path.join(dir, `${d.name}.skel`);
      if (!fs.existsSync(skel)) return null;
      let animations = [];
      try { animations = parseSkeleton(new Uint8Array(fs.readFileSync(skel))).animations.map((a) => ({ name: a.name, duration: a.duration })); } catch { animations = []; }
      let source = 'local';
      if (/^enemy_\d+_/i.test(d.name)) source = 'prts-enemy';
      else if (/^(char_|build_)/i.test(d.name)) source = 'prts';
      const label = d.name.replace(/^(char_|enemy_|build_)/, '');
      return {
        id: d.name,
        name: label,
        dir,
        source,
        animations,
        files: {
          skel: path.join(dir, `${d.name}.skel`),
          atlas: fs.existsSync(path.join(dir, `${d.name}.atlas`)) ? path.join(dir, `${d.name}.atlas`) : null,
          png: fs.existsSync(path.join(dir, `${d.name}.png`)) ? path.join(dir, `${d.name}.png`) : null,
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/api/state') {
    const ffmpeg = path.join(root, 'vendor/ffmpeg/ffmpeg.exe');
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      chrome: chromeCandidates(),
      ffmpeg: fs.existsSync(ffmpeg) ? ffmpeg : null,
      deepseekKey: !!loadConfig().apiKey,
      deepseekModel: loadConfig().model,
      deepseekBaseURL: loadConfig().baseURL,
      deepseekKeyMasked: maskKey(loadConfig().apiKey),
      node: process.version,
      models: cachedModels(),
      outputs: listFiles(outDir).slice(0, 40),
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/config') {
    const cfg = loadConfig();
    sendJson(res, 200, { ok: true, hasKey: !!cfg.apiKey, apiKeyMasked: maskKey(cfg.apiKey), model: cfg.model, baseURL: cfg.baseURL, configFile: CONFIG_FILE });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await readBody(req);
    try {
      saveConfig({ apiKey: body.apiKey, model: body.model, baseURL: body.baseURL });
      sendJson(res, 200, { ok: true, message: '已保存' });
    } catch (err) { sendError(res, err); }
    return;
  }
  if ((req.method === 'POST' || req.method === 'GET') && pathname === '/api/config/test') {
    const cfg = loadConfig();
    if (!cfg.apiKey) return sendJson(res, 200, { ok: false, error: '尚未配置 API Key，请先在设置中填入 Key（或使用离线编排）' });
    try {
      const resp = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 300);
        return sendError(res, new Error(`DeepSeek 校验失败 HTTP ${resp.status}: ${detail}`));
      }
      sendJson(res, 200, { ok: true, message: '连接成功，API Key 有效' });
    } catch (err) {
      sendError(res, new Error('连接失败: ' + err.message));
    }
    return;
  }
  if (req.method === 'GET' && pathname === '/api/jobs') {
    const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((j) => ({
      id: j.id, kind: j.kind, status: j.status, createdAt: j.createdAt,
      logs: j.logs.slice(-200), result: j.result, error: j.error,
    }));
    sendJson(res, 200, { ok: true, jobs: list });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/outputs') {
    sendJson(res, 200, { ok: true, outputs: listFiles(outDir) });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('event: hello\ndata: {"ok":true}\n\n');
    sseClients.add(res);
    const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
    req.on('close', () => {
      clearInterval(timer);
      sseClients.delete(res);
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/resolve') {
    const body = await readBody(req);
    const query = String(body.query ?? '').trim();
    const enemy = !!body.enemy;
    if (!query) return sendError(res, new Error('请输入名称或模型 ID'));
    const jobId = enqueue('resolve', async () => {
      const ref = await resolveModelRef({ enemy: enemy ? query : undefined, character: enemy ? undefined : query, key: /^(char_|enemy_)/i.test(query) ? query : undefined, onLog: (m) => console.log(m) });
      const skins = Object.entries(ref.meta?.skin ?? {}).map(([skin, views]) => ({
        skin,
        views: Object.entries(views ?? {}).map(([view, v]) => ({ view, file: v?.file ?? '' })),
      }));
      return { charId: ref.charId, kind: ref.kind, name: ref.meta?.name ?? ref.charId, prefix: ref.meta?.prefix ?? '', skins };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/fetch') {
    const body = await readBody(req);
    const jobId = enqueue('fetch', async () => {
      const result = await fetchCharacterFromPrts({
        character: body.character,
        enemy: body.enemy,
        key: body.key,
        skin: body.skin,
        view: body.view,
        outDir: assetsDir,
        force: !!body.force,
        onLog: (m) => console.log(m),
      });
      let animations = [];
      try { animations = parseSkeleton(new Uint8Array(fs.readFileSync(result.skel))).animations.map((a) => ({ name: a.name, duration: a.duration })); } catch { animations = []; }
      return {
        charId: result.charId,
        characterName: result.characterName,
        kind: result.kind,
        skin: result.skin,
        view: result.view,
        dir: result.dir,
        animations,
        files: { skel: result.skel, atlas: result.atlas, png: result.png },
      };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/inspect') {
    const body = await readBody(req);
    const jobId = enqueue('inspect', async () => {
      const p = path.resolve(String(body.skel ?? ''));
      if (!fs.existsSync(p)) throw new Error(`skel 不存在: ${p}`);
      const animations = parseSkeleton(new Uint8Array(fs.readFileSync(p))).animations.map((a) => ({ name: a.name, duration: a.duration }));
      return { skel: p, animations };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/run') {
    const body = await readBody(req);
    const fmt = String(body.format || 'gif').toLowerCase();
    if (!['gif', 'png', 'mp4', 'all'].includes(fmt)) return sendError(res, new Error(`format 仅支持 gif/png/mp4/all，收到: ${fmt}`));
    if (body.mix !== undefined && body.mix !== '') {
      const mixNum = parseFloat(body.mix);
      if (Number.isNaN(mixNum) || mixNum < 0 || mixNum > 3) return sendError(res, new Error('过渡时长应在 0~3 秒之间'));
    }
    const bgText = String(body.bg || '00000000');
    if (!/^[0-9a-fA-F]{6,8}$/.test(bgText)) return sendError(res, new Error('背景色格式应为 RRGGBB 或 RRGGBBAA（如 00000000）'));
    const upNum = parseInt(body.upscale || '1', 10);
    if (!(upNum >= 1 && upNum <= 8)) return sendError(res, new Error('放大倍数应在 1~8 之间'));
    const stem = safeName(body.outName || (body.enemy || body.character || body.key || 'result'));
    const outFile = `${stem}-${Date.now()}`;
    const outBase = path.join(outDir, outFile);
    const argv = ['run'];
    if (body.prompt) argv.push('--prompt', String(body.prompt));
    argv.push('--source', String(body.source || 'prts'));
    if (body.character) argv.push('--character', String(body.character));
    if (body.enemy) argv.push('--enemy', String(body.enemy));
    if (body.key) argv.push('--key', String(body.key));
    if (body.skin) argv.push('--skin', String(body.skin));
    if (body.view) argv.push('--view', String(body.view));
    if (body.timeline) {
      const t = typeof body.timeline === 'string' ? JSON.parse(body.timeline) : body.timeline;
      const tlFile = `${outBase}.timeline.json`;
      fs.writeFileSync(tlFile, JSON.stringify(t, null, 2));
      argv.push('--timeline', tlFile);
    }
    if (body.fps) argv.push('--fps', String(body.fps));
    if (body.size) argv.push('--size', String(body.size));
    if (body.format) argv.push('--format', String(body.format));
    if (body.mix !== undefined && body.mix !== '') argv.push('--mix', String(body.mix));
    if (body.bg) argv.push('--bg', String(body.bg));
    if (body.upscale && parseInt(body.upscale, 10) > 1) argv.push('--upscale', String(body.upscale));
    if (body.sr) argv.push('--sr');
    if (body.srEngine) argv.push('--sr-engine', String(body.srEngine));
    argv.push('--out', `${outBase}.gif`);
    const jobId = enqueue('run', async () => {
      await main(argv);
      const ext = String(body.format || 'gif').toLowerCase();
      const wanted = ext === 'all' ? ['.gif', '.mp4', '.png'] : [ext === 'png' ? '.png' : ext === 'mp4' ? '.mp4' : '.gif'];
      const files = wanted
        .map((e) => {
          const p = `${outBase}${e}`;
          return fs.existsSync(p) ? { path: p, url: `/outputs/${encodeURIComponent(path.basename(p))}`, kind: e.slice(1) } : null;
        })
        .filter(Boolean);
      return { outBase, files, timelineFile: `${outBase}.timeline.json`, logs: [] };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/compare') {
    const body = await readBody(req);
    const atlas = String(body.atlas || '');
    const png = String(body.png || '');
    if (!atlas || !png || !fs.existsSync(atlas) || !fs.existsSync(png)) {
      return sendJson(res, 400, { ok: false, error: '模型文件不存在，请先在「模型资源」拉取三件套' });
    }
    const scale = parseInt(body.scale, 10);
    const scaleOk = scale === 2 || scale === 4 ? scale : 2;
    const engines = Array.isArray(body.engines) ? body.engines.filter((e) => typeof e === 'string' && e).slice(0, 2) : ['realesrgan', 'waifu2x'];
    const outTag = 'compare-' + safeName(body.outName || 'model') + '-' + Date.now();
    const outFile = path.join(outDir, outTag + '.png');
    const argv = ['--atlas', atlas, '--png', png, '--scale', String(scaleOk), '--out', outFile];
    if (engines.length) argv.push('--engines', engines.join(','));
    const script = path.join(root, 'scripts', 'make-compare.mjs');
    const jobId = enqueue('compare', async () => {
      await runChild([script, ...argv]);
      const labeled = outFile.slice(0, -'.png'.length) + '-labeled.png';
      const final = fs.existsSync(labeled) ? labeled : outFile;
      return {
        outDir,
        file: { path: final, url: '/outputs/' + encodeURIComponent(path.basename(final)), kind: 'png' },
        panels: 2 + engines.length,
        engines,
      };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/upscale') {
    const body = await readBody(req);
    const atlas = String(body.atlas || '');
    const png = String(body.png || '');
    if (!atlas || !png || !fs.existsSync(atlas) || !fs.existsSync(png)) {
      return sendJson(res, 400, { ok: false, error: '模型文件不存在，请先拉取三件套' });
    }
    const argv = ['upscale', '--atlas', atlas, '--png', png, '--scale', String(body.scale || '2')];
    if (body.sr) argv.push('--sr');
    if (body.srEngine) argv.push('--sr-engine', String(body.srEngine));
    const outTag = `${safeName(body.outName || 'hi')}-${Date.now()}`;
    const hiOut = path.join(outDir, outTag);
    argv.push('--out', hiOut);
    const jobId = enqueue('upscale', async () => {
      await main(argv);
      const atlas = path.join(hiOut, path.basename(String(body.atlas)));
      const png = path.join(hiOut, path.basename(String(body.png)));
      const files = [atlas, png].filter((p) => fs.existsSync(p)).map((p) => ({ path: p, url: `/outputs/${outTag}/${encodeURIComponent(path.basename(p))}`, kind: path.extname(p).slice(1) }));
      return { outDir: hiOut, files };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }
  sendJson(res, 404, { ok: false, error: `未知接口: ${pathname}` });
}

// ---------------------------------------------------------------------------
// 静态文件（ui/ 与 outputs/）
// ---------------------------------------------------------------------------
function serveStatic(res, url, baseDir, label) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (label === 'ui') {
    if (rel === '' || rel === 'ui') rel = 'index.html';
    else if (rel.startsWith('ui/')) rel = rel.slice(3) || 'index.html';
  }
  if (label === 'outputs' && rel.startsWith('outputs/')) rel = rel.slice(8);
  const file = path.resolve(baseDir, rel);
  if (!file.startsWith(path.resolve(baseDir) + path.sep) && file !== path.resolve(baseDir)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': label === 'outputs' ? 'no-store' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
      serveStatic(res, url, uiDir, 'ui');
      return;
    }
    if (url.pathname.startsWith('/outputs/')) {
      serveStatic(res, url, outDir, 'outputs');
      return;
    }
    res.writeHead(302, { Location: '/ui/' });
    res.end();
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[desktop] 端口 ${PORT} 已被占用（可能已有实例在运行），直接使用现有服务。`);
    process.exit(0);
  }
  throw err;
});

function repairAllAssets() {
  let dirs = [];
  try { dirs = fs.readdirSync(assetsDir).filter((d) => { try { return fs.statSync(path.join(assetsDir, d)).isDirectory(); } catch { return false; } }); } catch { return; }
  for (const dir of dirs) {
    const base = path.join(assetsDir, dir);
    let files = [];
    try { files = fs.readdirSync(base); } catch { continue; }
    const atlasName = files.find((f) => f.endsWith('.atlas'));
    const png =
      (atlasName && files.find((f) => f.endsWith('.png') && path.basename(f, '.png') === path.basename(atlasName, '.atlas'))) ||
      files.find((f) => f.endsWith('.png'));
    if (!atlasName || !png) continue;
    try {
      alignAssetsInPlace({ atlasPath: path.join(base, atlasName), pngPath: path.join(base, png), onLog: (m) => console.log(m) });
    } catch (err) {
      console.log('[align] 跳过 ' + dir + ': ' + err.message);
    }
  }
}

server.listen(PORT, HOST, () => {
  repairAllAssets();
  console.log(`[desktop] Arknights Spine Auto-Studio 桌面服务已启动: http://${HOST}:${PORT}/ui/`);
  console.log(`[desktop] 输出目录: ${outDir}`);
});