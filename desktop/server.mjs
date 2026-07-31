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
import { resolveModelRef, fetchCharacterFromPrts, fetchAllViewsFromPrts, enemyIndex } from '../src/prts.mjs';
import { alignAssetsInPlace } from '../src/align.mjs';
import { PerfMonitor } from '../src/perf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const uiDir = path.join(here, 'ui');
const assetsDir = path.join(root, 'assets');
const outDir = path.join(root, 'out');
const PORT = parseInt(process.env.ZDXR_PORT || '4879', 10);
const HOST = '127.0.0.1';

fs.mkdirSync(outDir, { recursive: true });

// 敌人名缓存：启动时异步预热翻转索引，本地缓存文件加速
const ENEMY_INDEX_FILE = path.join(assetsDir, 'enemy-index.json');
let enemyNameCache = {};
enemyIndex({ cacheFile: ENEMY_INDEX_FILE }).then((m) => { enemyNameCache = m; }).catch(() => {});

// 性能监测：每 2s 采样进程树 CPU/内存
const perfMonitor = new PerfMonitor({ intervalMs: 2000 });
perfMonitor.start();

// ---------- 配置（config.json：DeepSeek API Key / 模型 / 地址） ----------
const CONFIG_FILE = path.join(root, 'config.json');

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* 首次运行无配置文件 */ }
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || file.deepseekApiKey || '',
    model: process.env.DEEPSEEK_MODEL || file.deepseekModel || 'deepseek-v4-flash',
    baseURL: process.env.DEEPSEEK_BASE_URL || file.deepseekBaseURL || 'https://api.deepseek.com',
    visionKey: process.env.DASHSCOPE_API_KEY || file.visionApiKey || '',
    visionModel: process.env.DASHSCOPE_VISION_MODEL || file.visionModel || 'qwen-vl-max',
    visionBaseURL: process.env.DASHSCOPE_BASE_URL || file.visionBaseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
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
  if (!process.env.DASHSCOPE_API_KEY && cfg.file.visionApiKey) process.env.DASHSCOPE_API_KEY = cfg.file.visionApiKey;
  if (cfg.visionModel) process.env.DASHSCOPE_VISION_MODEL = cfg.visionModel;
  if (cfg.visionBaseURL) process.env.DASHSCOPE_BASE_URL = cfg.visionBaseURL;
  return cfg;
}

function saveConfig({ apiKey, model, baseURL, visionKey, visionModel, visionBaseURL } = {}) {
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
  if (visionKey !== undefined) {
    if (String(visionKey).trim()) {
      next.visionApiKey = String(visionKey).trim();
      process.env.DASHSCOPE_API_KEY = String(visionKey).trim();
    } else {
      delete next.visionApiKey;
      delete process.env.DASHSCOPE_API_KEY;
    }
  }
  if (visionModel !== undefined) {
    next.visionModel = String(visionModel).trim() || 'qwen-vl-max';
    process.env.DASHSCOPE_VISION_MODEL = next.visionModel;
  }
  if (visionBaseURL !== undefined) {
    next.visionBaseURL = String(visionBaseURL).trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    process.env.DASHSCOPE_BASE_URL = next.visionBaseURL;
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
    if (d.name.startsWith('.')) return [];
    if (depth === 0 && d.name === 'hi') return []; // 高清化资源独立目录，不进输出记录
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return listFiles(p, depth + 1);
    if (!d.isFile()) return [];
    const st = fs.statSync(p);
    const rel = path.relative(outDir, p);
    const url = '/outputs/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/');
    return [{ name: rel, size: st.size, mtime: st.mtimeMs, url, dir: path.dirname(p) }];
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

// 常见皮肤后缀 → 中文标签（无 meta.json 时的兜底显示）
const SKIN_HINTS = {
  kfc_1: 'KFC 联动', kfc_2: 'KFC 联动', kfc_3: 'KFC 联动',
  witch_2: '万圣节', witch_3: '万圣节',
  boc_1: '泳装', boc_2: '泳装', boc_3: '泳装', boc_4: '夏日泳装',
  chr_1: '新春', chr_2: '新春',
  doll_1: '手办', iteration_1: '基建一期', iteration_2: '基建二期', iteration_3: '基建三期', mini: '迷你', ico: '图标', evg: '庆典',
};

function cachedModels() {
  if (!fs.existsSync(assetsDir)) return [];
  const groups = [];
  for (const d of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = path.join(assetsDir, d.name);
    // 读 PRTS 元数据（角色名 + 皮肤/视图清单）
    let meta = null;
    try {
      const mf = path.join(dir, 'meta.json');
      if (fs.existsSync(mf)) meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch { meta = null; }
    // 扫描目录内全部 .skel 三件套（同一角色可有多个皮肤/视图）
    let skelFiles = [];
    try { skelFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.skel')); } catch { continue; }
    const entries = [];
    for (const sf of skelFiles.sort()) {
      const base = sf.slice(0, -'.skel'.length);
      const skelPath = path.join(dir, sf);
      const atlas = path.join(dir, base + '.atlas');
      if (!fs.existsSync(atlas)) continue;
      // PNG：同名文件，否则取 atlas 声明的第一页
      let png = path.join(dir, base + '.png');
      if (!fs.existsSync(png)) {
        try {
          const first = fs.readFileSync(atlas, 'utf8').toString().split(/\r?\n/).map((l) => l.trim()).find((l) => /\.png$/i.test(l));
          if (first) png = path.join(dir, first);
        } catch { /* ignore */ }
      }
      if (!fs.existsSync(png)) continue;
      let animations = [];
      try { animations = parseSkeleton(new Uint8Array(fs.readFileSync(skelPath))).animations.map((a) => ({ name: a.name, duration: a.duration })); } catch { animations = []; }
      // 皮肤/视图标签：meta.json 反查 → 后缀映射兜底
      let skinLabel = base === d.name ? '默认' : base;
      let viewLabel = '';
      if (meta && meta.skin && typeof meta.skin === 'object') {
        for (const [sname, views] of Object.entries(meta.skin)) {
          for (const [vname, f] of Object.entries(views || {})) {
            if (String(f?.file || '') === base) { skinLabel = sname; viewLabel = vname; }
          }
        }
      }
      if (skinLabel === base) {
        const prefix = 'build_' + d.name;
        let suffix = '';
        if (base === d.name) suffix = '';
        else if (base.startsWith(prefix)) suffix = base.slice(prefix.length).replace(/^_/, '');
        else if (base.startsWith(d.name + '_')) suffix = base.slice(d.name.length + 1);
        else suffix = base.replace(/^build_/, '').replace(/^char_[^_]+_/, '');
        skinLabel = SKIN_HINTS[suffix] || (suffix ? '皮肤 ' + suffix : '默认');
      }
      entries.push({ base, skinLabel, viewLabel, files: { skel: skelPath, atlas, png }, animations });
    }
    if (!entries.length) continue;
    // 组信息：类型优先看三件套前缀（兼容 103_angel 这类旧目录）
    const firstBase = entries[0].base;
    let kind = 'local';
    if (/^enemy_\d+_/i.test(d.name) || /^enemy_/i.test(firstBase)) kind = 'enemy';
    else if (/^char_/i.test(d.name) || /^char_/i.test(firstBase)) kind = 'char';
    else if (/^build_/i.test(firstBase) || /^build_/i.test(d.name)) kind = 'build';
    const name = meta?.name || (kind === 'enemy' ? (enemyNameCache[d.name]?.name || d.name.replace(/^enemy_/, '')) : d.name.replace(/^(char_|enemy_|build_)/, '')) || d.name;
    const info = meta && meta.info && typeof meta.info === 'object' ? meta.info : {};
    const gmeta = {
      class: meta?.class || info['\u804c\u4e1a'] || '',
      rarity: parseInt(meta?.rarity ?? info['\u7a00\u6709\u5ea6'], 10) || 0,
      branch: meta?.branch || info['\u5206\u652f'] || info['\u5b50\u804c\u4e1a'] || '',
      faction: meta?.faction || info['\u6240\u5c5e\u56fd\u5bb6'] || info['\u6240\u5c5e\u7ec4\u7ec7'] || '',
      position: meta?.position || info['\u4f4d\u7f6e'] || '',
      tags: meta?.tags || info['\u6807\u7b7e'] || '',
      trait: meta?.trait || info['\u7279\u6027'] || '',
      enemyLevel: meta?.enemyLevel || info['\u5730\u4f4d\u7ea7\u522b'] || '',
      enemyType: meta?.enemyType || info['\u4f24\u5bb3\u7c7b\u578b'] || '',
      enemyAttack: meta?.enemyAttack || info['\u653b\u51fb\u65b9\u5f0f'] || '',
      enemyMove: meta?.enemyMove || info['\u884c\u52a8\u65b9\u5f0f'] || '',
      description: meta?.description || info['\u63cf\u8ff0'] || '',
      stats: meta?.stats || null,
      art: meta?.art || null,
      info,
    };
    groups.push({ id: d.name, name, kind, dir, meta, ...gmeta, entries });
  }
  const order = { char: 0, enemy: 1, build: 2, local: 3 };
  groups.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  // 摊平为「模型条目」列表：每个皮肤/视图一个可选条目
  const flat = [];
  for (const g of groups) {
    for (const e of g.entries) {
      flat.push({
        id: g.id + '|' + e.base,
        groupId: g.id,
        name: e.skinLabel !== '默认' && g.entries.length > 1 ? g.name + ' · ' + e.skinLabel : g.name,
        displayName: g.name,
        skinLabel: e.skinLabel,
        viewLabel: e.viewLabel,
        base: e.base,
        kind: g.kind,
        source: g.kind === 'local' ? 'local' : g.kind === 'enemy' ? 'prts-enemy' : 'prts',
        dir: g.dir,
        animations: e.animations,
        files: e.files,
        class: g.class, rarity: g.rarity, branch: g.branch, faction: g.faction,
        position: g.position, tags: g.tags, trait: g.trait, enemyLevel: g.enemyLevel,
        enemyType: g.enemyType, enemyAttack: g.enemyAttack, enemyMove: g.enemyMove,
        description: g.description, stats: g.stats, art: g.art, info: g.info,
        groupCount: g.entries.length,
      });
    }
  }
  return flat;
}

// 兼容新旧模型 id：新格式「组ID|文件名」（组=角色目录，文件=具体皮肤/视图三件套），
// 旧格式为角色目录名（charId）。找不到时返回 null。
function modelFromKey(key) {
  if (!key) return null;
  const k = String(key);
  const models = cachedModels();
  let m = models.find((x) => x.id === k);
  if (!m && k.includes('|')) {
    const [gid, base] = k.split('|');
    m = models.find((x) => x.groupId === gid && x.base === base) || models.find((x) => x.groupId === gid);
  }
  if (!m) m = models.find((x) => x.groupId === k);
  return m || null;
}


// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/api/perf') {
    sendJson(res, 200, { ok: true, sample: perfMonitor.cached });
    return;
  }
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
      visionKey: !!loadConfig().visionKey,
      visionModel: loadConfig().visionModel,
      visionBaseURL: loadConfig().visionBaseURL,
      node: process.version,
      outDir,
      assetsDir,
      models: cachedModels(),
      outputs: listFiles(outDir).slice(0, 40),
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/config') {
    const cfg = loadConfig();
    sendJson(res, 200, {
      ok: true, hasKey: !!cfg.apiKey, apiKeyMasked: maskKey(cfg.apiKey), model: cfg.model, baseURL: cfg.baseURL,
      hasVisionKey: !!cfg.visionKey, visionKeyMasked: maskKey(cfg.visionKey), visionModel: cfg.visionModel, visionBaseURL: cfg.visionBaseURL,
      configFile: CONFIG_FILE,
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await readBody(req);
    try {
      saveConfig({ apiKey: body.apiKey, model: body.model, baseURL: body.baseURL, visionKey: body.visionKey, visionModel: body.visionModel, visionBaseURL: body.visionBaseURL });
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
  if (req.method === 'POST' && pathname === '/api/plan') {
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return sendJson(res, 400, { ok: false, error: '请先写下动作描述' });
    const jobId = enqueue('plan', async () => {
      let skel = String(body.skel || '');
      let atlas = String(body.atlas || '');
      let png = String(body.png || '');
      if (!skel || !atlas || !png) {
        const key = String(body.key || '');
        const model = modelFromKey(key);
        if (!model || !model.files || !model.files.skel) throw new Error('未找到模型 ' + key + '，请先拉取三件套');
        skel = model.files.skel; atlas = model.files.atlas; png = model.files.png;
      }
      const planModel = modelFromKey(String(body.key || ''));
      const planModelId = (planModel && planModel.groupId) || String(body.character || body.key || '');
      const animations = parseSkeleton(new Uint8Array(fs.readFileSync(skel))).animations.map((a) => ({ name: a.name, duration: a.duration }));
      const cfg = applyConfig();
      const { choreograph } = await import('../src/choreograph.mjs');
      // 读取本地动作字典（千问视觉/用户标注的语义），让 LLM 能看懂特殊动作名
      let actionDescriptions;
      try {
        const { loadDictionary } = await import('../src/label.mjs');
        const dict = loadDictionary(planModelId, assetsDir);
        if (dict && dict.animations) {
          actionDescriptions = {};
          for (const [name, info] of Object.entries(dict.animations)) {
            if (!info || typeof info !== 'object') continue;
            const parts = [String(info.human_label || '')];
            if (Array.isArray(info.tags) && info.tags.length) parts.push('标签:' + info.tags.join('/'));
            actionDescriptions[name] = parts.filter(Boolean).join('，');
          }
        }
      } catch { /* 无字典时忽略 */ }
      const plan = await choreograph({
        prompt,
        animations,
        character: String(body.character || body.key || '角色'),
        fps: parseInt(body.fps || '30', 10) || 30,
        mock: !cfg.apiKey,
        apiKey: cfg.apiKey || undefined,
        model: cfg.model,
        baseURL: cfg.baseURL,
        actionDescriptions,
      });
      return { character: plan.character, fps: plan.fps, timeline: plan.timeline, mode: plan.mode };
    });
    sendJson(res, 202, { ok: true, jobId });
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
      const result = body.allViews
        ? await fetchAllViewsFromPrts({
            character: body.character,
            enemy: body.enemy,
            key: body.key,
            skin: body.skin,
            outDir: assetsDir,
            force: !!body.force,
            onLog: (m) => console.log(m),
          })
        : await fetchCharacterFromPrts({
            character: body.character,
            enemy: body.enemy,
            key: body.key,
            skin: body.skin,
            view: body.view,
            outDir: assetsDir,
            force: !!body.force,
            onLog: (m) => console.log(m),
          });
      const views = (result.views || [result]).map((v) => {
        let animations = [];
        try { animations = parseSkeleton(new Uint8Array(fs.readFileSync(v.skel))).animations.map((a) => ({ name: a.name, duration: a.duration })); } catch { animations = []; }
        return {
          view: v.view || result.view,
          base: String(v.skel || '').replace(/\.skel$/i, '').split(/[\\/]/).pop(),
          animations,
          files: { skel: v.skel, atlas: v.atlas, png: v.png },
        };
      });
      return {
        charId: result.charId,
        characterName: result.characterName,
        kind: result.kind,
        skin: result.skin,
        view: result.view,
        allViews: !!body.allViews,
        dir: result.dir,
        views,
        animations: views[0]?.animations || [],
        files: views[0]?.files || { skel: result.skel, atlas: result.atlas, png: result.png },
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
    // 若未显式传三件套，尝试按 key 从本地模型库补齐（避免把新 id 直接传给 CLI 重新下载）
    let rskel = String(body.skel || '');
    let ratlas = String(body.atlas || '');
    let rpng = String(body.png || '');
    if (!rskel || !ratlas || !rpng) {
      const m = modelFromKey(String(body.key || ''));
      if (m && m.files) { rskel = m.files.skel || rskel; ratlas = m.files.atlas || ratlas; rpng = m.files.png || rpng; }
    }
    if (rskel && ratlas && rpng) {
      // 本地三件套就绪：直接使用，不再触发 PRTS 重新下载
      body.skel = rskel; body.atlas = ratlas; body.png = rpng;
      body.source = 'local';
    }

    const stem = safeName(body.outName || (body.enemy || body.character || body.key || 'result'));
    const outFile = `${stem}-${Date.now()}`;
    const outBase = path.join(outDir, outFile);
    const argv = ['run'];
    if (body.prompt) argv.push('--prompt', String(body.prompt));
    if (String(body.source || 'prts') === 'prts' && !body.skel && !body.atlas && !body.png) {
      // 无本地三件套时才走 PRTS 重新拉取（key 必须是角色目录名）
      argv.push('--source', 'prts');
      if (body.character) argv.push('--character', String(body.character));
      if (body.enemy) argv.push('--enemy', String(body.enemy));
      if (body.key) argv.push('--key', String(body.key).split('|')[0]);
      if (body.skin) argv.push('--skin', String(body.skin));
      if (body.view) argv.push('--view', String(body.view));
    }
    if (body.skel) argv.push('--skel', String(body.skel));
    if (body.atlas) argv.push('--atlas', String(body.atlas));
    if (body.png) argv.push('--png', String(body.png));
    if (body.timeline) {
      const t = typeof body.timeline === 'string' ? JSON.parse(body.timeline) : body.timeline;
      const tlFile = `${outBase}.timeline.json`;
      fs.writeFileSync(tlFile, JSON.stringify(t, null, 2));
      argv.push('--timeline', tlFile);
    }
    if (body.assetsList && Array.isArray(body.assetsList) && body.assetsList.length) {
      const listFile = `${outBase}.assets-list.json`;
      fs.writeFileSync(listFile, JSON.stringify(body.assetsList.map((a) => ({ name: String(a.name || 'default'), skel: String(a.skel || ''), atlas: String(a.atlas || ''), png: String(a.png || '') })), null, 2));
      argv.push('--assets-list', listFile);
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
  if (req.method === 'POST' && pathname === '/api/previews') {
    const body = await readBody(req);
    const views = Array.isArray(body.views) && body.views.length
      ? body.views.map((v) => ({ view: String(v.view || ''), skel: String(v.skel || ''), atlas: String(v.atlas || ''), png: String(v.png || '') }))
      : [{ view: String(body.view || ''), skel: String(body.skel || ''), atlas: String(body.atlas || ''), png: String(body.png || '') }];
    for (const v of views) {
      if (!v.skel || !v.atlas || !v.png || !fs.existsSync(v.skel) || !fs.existsSync(v.atlas) || !fs.existsSync(v.png)) {
        return sendJson(res, 400, { ok: false, error: '模型三件套不完整，请先拉取模型' });
      }
    }
    const jobId = enqueue('preview', async () => {
      const { renderActionPreviews } = await import('../src/preview.mjs');
      const tag = safeName(body.outName || 'model') + '-' + Date.now();
      const pvDir = path.join(outDir, '.previews', tag);
      const itemsAll = [];
      for (const v of views) {
        const vDir = path.join(pvDir, safeName(v.view || 'default'));
        const items = await renderActionPreviews({
          rootDir: root,
          assets: { skel: v.skel, atlas: v.atlas, png: v.png },
          outDir: vDir,
          mode: body.mode === 'frame' ? 'frame' : 'anim',
          chromePath: chromeCandidates(),
          onLog: (m) => console.log(m),
        });
        for (const it of items) itemsAll.push({ ...it, view: v.view || '' });
      }
      // 读取本地动作字典（若有），供 UI 预填标注
      let labels = {};
      if (body.modelId) {
        try {
        const dictFile = path.join(assetsDir, (modelFromKey(String(body.modelId || '') ) || {}).groupId || String(body.modelId || ''), 'actions.json');
          if (fs.existsSync(dictFile)) {
            const dict = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
            labels = (dict.animations && typeof dict.animations === 'object') ? dict.animations : {};
          }
        } catch { /* 字典损坏时忽略 */ }
      }
      return {
        tag,
        outDir: pvDir,
        labels,
        files: itemsAll.map((it) => ({
          name: it.name,
          duration: it.duration,
          kind: it.kind,
          view: it.view || '',
          url: '/outputs/.previews/' + tag + '/' + safeName(it.view || 'default') + '/' + encodeURIComponent(path.basename(it.file)),
        })),
      };
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
    const hiOut = path.join(outDir, 'hi', outTag); // 高清化资源独立目录，assets/ 原图永不覆盖
    argv.push('--out', hiOut);
    const jobId = enqueue('upscale', async () => {
      await main(argv);
      const atlas = path.join(hiOut, path.basename(String(body.atlas)));
      const png = path.join(hiOut, path.basename(String(body.png)));
      const files = [atlas, png].filter((p) => fs.existsSync(p)).map((p) => ({ path: p, url: `/outputs/hi/${outTag}/${encodeURIComponent(path.basename(p))}`, kind: path.extname(p).slice(1) }));
      return { outDir: hiOut, files };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }
  // ---- 补全本地模型资料 + 美术（PRTS） ----
  if (req.method === 'POST' && pathname === '/api/enrich') {
    const jobId = enqueue('enrich', async () => {
      const { enrichAllLocal } = await import('../src/info.mjs');
      const results = await enrichAllLocal(assetsDir, { onLog: (m) => console.log(m) });
      // 刷新敌人翻转索引缓存，使新 meta 名称立即生效
      try {
        const idx = await enemyIndex({ force: true, cacheFile: ENEMY_INDEX_FILE });
        enemyNameCache = idx;
      } catch { /* 网络异常不影响主流程 */ }
      return { results, done: results.filter((r) => r.ok).length, total: results.length };
    });
    sendJson(res, 202, { ok: true, jobId });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/vision/test') {
    const body = await readBody(req);
    const cfg = loadConfig();
    const key = String(body.visionKey !== undefined ? body.visionKey : cfg.visionKey).trim();
    if (!key) return sendJson(res, 200, { ok: false, error: '尚未配置千问视觉 Key（可在设置中填写，或使用离线规则标注）' });
    const model = String(body.visionModel || cfg.visionModel || 'qwen-vl-max').trim();
    const baseURL = String(body.visionBaseURL || cfg.visionBaseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').trim();
    try {
      // 1x1 透明 PNG，验证 Key + 模型可用性（费用可忽略）
      const tiny = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGOQs6n4TwlmGDVg1IBRA4aLAQBT0dEQa3qWQAAAAABJRU5ErkJggg=='; // 16x16（Qwen-VL 要求宽高 > 10）
      const resp = await fetch(baseURL.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: '回复OK' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + tiny } }] }],
        }),
      });
      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 300);
        return sendError(res, new Error(`千问视觉校验失败 HTTP ${resp.status}: ${detail}`));
      }
      sendJson(res, 200, { ok: true, message: '千问视觉连接成功（模型 ' + model + '）' });
    } catch (err) {
      sendError(res, new Error('千问视觉连接失败: ' + err.message));
    }
    return;
  }
  // ---- 视觉动作标注：离线规则 + 千问视觉 ----
  if (req.method === 'POST' && pathname === '/api/label') {
    const body = await readBody(req);
    const skel = String(body.skel || '');
    const atlas = String(body.atlas || '');
    const png = String(body.png || '');
    if (!skel || !atlas || !png || !fs.existsSync(skel) || !fs.existsSync(atlas) || !fs.existsSync(png)) {
      return sendJson(res, 400, { ok: false, error: '模型三件套不完整，请先拉取模型' });
    }
    const modelId = (modelFromKey(String(body.modelId || '')) || {}).groupId || String(body.modelId || '');
    const jobId = enqueue('label', async () => {
      const cfg = applyConfig();
      const { labelActions, saveDictionary } = await import('../src/label.mjs');
      const animations = parseSkeleton(new Uint8Array(fs.readFileSync(skel))).animations.map((a) => ({ name: a.name, duration: a.duration }));
      const kfDir = path.join(outDir, '.previews', safeName(body.outName || modelId || 'model') + '-kf-' + Date.now());
      const dict = await labelActions({
        rootDir: root,
        assets: { skel, atlas, png },
        animations,
        keyframesDir: kfDir,
        visionKey: cfg.visionKey,
        visionModel: cfg.visionModel,
        visionBaseURL: cfg.visionBaseURL,
        chromePath: chromeCandidates(),
        onLog: (m) => console.log(m),
      });
      dict.character = String(body.characterName || body.outName || modelId || '角色');
      let dictFile = null;
      if (modelId) dictFile = saveDictionary(modelId, assetsDir, dict);
      return { labels: dict.animations, dictFile, mode: dict.mode };
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
  if (label === 'assets' && rel.startsWith('assets/')) rel = rel.slice(7);
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
    if (url.pathname.startsWith('/assets/')) {
      serveStatic(res, url, assetsDir, 'assets');
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