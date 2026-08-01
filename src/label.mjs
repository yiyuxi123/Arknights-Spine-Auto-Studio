// 动作语义标注：三层渐进（离线规则 → 千问视觉 → 用户微调）
// 字典文件: assets/<modelId>/actions.json
//  - 规则层: 对 Idle/Move/Attack/Sleep/Sit/Die 等规范命名直接打标（零成本）
//  - 视觉层: 无头渲染每个动作 4 张关键帧 → Qwen-VL 看图打标（一次性成本，结果入库永久复用）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStaticServer, launchChrome, CdpClient, evalJs, newPageSession, rmrfRetry } from './cdp.mjs';
import { encodePng } from './png.mjs';

const DEFAULT_VISION_MODEL = 'qwen-vl-max';
const DEFAULT_VISION_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// ---------------------------------------------------------------------------
// 规则层：根据动作名猜测含义（中文/英文关键词）
// ---------------------------------------------------------------------------
const RULES = [
  { re: /idle|stand|wait|待机|站立|default/i, label: '待机站立', tags: ['待机', '站立', '不动'] },
  { re: /move|run|walk|dash|sprint|跑步|移动|行走|前进|冲/i, label: '移动/跑步', tags: ['移动', '跑步', '前进'] },
  { re: /attack|hit|strike|fight|攻击|挥砍|击打/i, label: '攻击', tags: ['攻击', '战斗', '打击'] },
  { re: /die|death|down|defeat|倒下|死亡|阵亡|败北/i, label: '倒地/死亡', tags: ['倒地', '死亡', '倒下'] },
  { re: /sleep|zzz|睡/i, label: '睡觉', tags: ['睡觉', '躺着', '休息'] },
  { re: /sit|坐/i, label: '坐下', tags: ['坐下', '坐着'] },
  { re: /relax|rest|lie|休息|放松/i, label: '休息放松', tags: ['休息', '放松', '躺着'] },
  { re: /skill|spell|magic|cast|技能|施法|大招/i, label: '释放技能', tags: ['技能', '施法', '大招'] },
  { re: /stun|dizzy|faint|tired|exhaust|晕|眩晕|累|喘|瘫/i, label: '眩晕/疲惫', tags: ['眩晕', '疲惫', '累'] },
  { re: /interact|greet|wave|hi|hello|互动|打招呼|挥手/i, label: '互动/打招呼', tags: ['互动', '打招呼', '挥手'] },
  { re: /revive|resurrect|复活/i, label: '复活起身', tags: ['复活', '起身'] },
  { re: /victory|win|cheer|celebrate|胜利|欢呼/i, label: '胜利欢呼', tags: ['胜利', '欢呼', '庆祝'] },
  { re: /dance|舞/i, label: '跳舞', tags: ['跳舞', '舞蹈'] },
  { re: /start|appear|登场|出现|begin/i, label: '登场', tags: ['登场', '出现'] },
  { re: /end|leave|exit|退场|离开|结束/i, label: '退场/离开', tags: ['退场', '离开'] },
  { re: /build|construction|基建|建造/i, label: '基建动作', tags: ['基建', '建造'] },
  { re: /grow|sprout|成长/i, label: '成长变化', tags: ['成长', '变化'] },
  { re: /level|upgrade|升级/i, label: '升级', tags: ['升级', '提升'] },
  { re: /feed|eat|吃/i, label: '吃东西', tags: ['吃东西', '进食'] },
  { re: /tap|touch|摸/i, label: '触摸互动', tags: ['触摸', '互动'] },
];
export function guessLabel(name) {
  const n = String(name || '');
  for (const r of RULES) {
    if (r.re.test(n)) return { label: r.label, tags: r.tags.slice(), source: 'rule' };
  }
  return { label: '', tags: [], source: 'none' };
}

// ---------------------------------------------------------------------------
// 字典读写
// ---------------------------------------------------------------------------
export function loadDictionary(modelId, assetsDir) {
  try {
    const f = path.join(assetsDir, String(modelId || ''), 'actions.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* ignore */ }
  return null;
}
export function saveDictionary(modelId, assetsDir, dict) {
  const dir = path.join(assetsDir, String(modelId || ''));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'actions.json');
  fs.writeFileSync(f, JSON.stringify(dict, null, 2), 'utf8');
  return f;
}

// ---------------------------------------------------------------------------
// 渲染全部动作的关键帧（单次 Chrome 会话）
// ---------------------------------------------------------------------------
export async function renderAllKeyframes({ rootDir, assets, animations, outDir, width = 256, height = 256, count = 4, chromePath, onLog = () => {} }) {
  const server = await startStaticServer(rootDir);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-kf-'));
  const chrome = launchChrome({ chromePath, userDataDir, width, height });

  let cdp = null;
  try {
    cdp = new CdpClient(await chrome.wsUrl());
    await cdp.open();
    const base = String(rootDir).replace(/\\/g, '/').replace(/\/+$/, '');
    const rel = (p) => {
      let s = String(p).replace(/\\/g, '/');
      if (s.startsWith(base + '/')) s = s.slice(base.length + 1);
      return '/' + s.replace(/^\/+/, '');
    };
    const query = new URLSearchParams({
      skel: rel(assets.skel), atlas: rel(assets.atlas), png: rel(assets.png),
      w: String(width), h: String(height), bg: '00000000', mix: '0.15',
    });
    const { sessionId } = await newPageSession(cdp, server.origin + '/render/index.html?' + query);
    const send = (m, p) => cdp.send(m, p, sessionId);
    const load = await evalJs(send, 'studio.load()');
    if (!load || !load.ok) throw new Error('studio.load failed: ' + (load && load.error));
    fs.mkdirSync(outDir, { recursive: true });
    const result = {};
    for (const a of animations) {
      const total = a.duration > 0 ? a.duration : 1;
      const safe = String(a.name).replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'action';
      const files = [];
      let prevT = 0;
      for (let i = 0; i < count; i++) {
        const t = i === 0 ? 0.05 : Math.min((i / count) * total * 0.8 + 0.05, total * 0.95);
        await evalJs(send, 'studio.step(' + JSON.stringify({ action: a.name, loop: true, delta: Math.max(0.016, t - prevT) }) + ')');
        prevT = t;
        const dataUrl = String(await evalJs(send, 'studio.snapshot()'));
        const rgba = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        const file = path.join(outDir, safe + '-' + i + '.png');
        // snapshot 返回原始 straight-alpha RGBA，写文件前重新编码为 PNG
        fs.writeFileSync(file, encodePng(rgba, width, height));
        files.push(file);
      }
      result[a.name] = files;
      onLog('[keyframes] ' + a.name + ' -> ' + files.length + ' 帧');
    }
    return result;
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await chrome.close(); } catch {}
    try { await server.close(); } catch {}
    await rmrfRetry(userDataDir);
  }
}

// ---------------------------------------------------------------------------
// 视觉层：Qwen-VL 看图打标（OpenAI 兼容接口）
// ---------------------------------------------------------------------------
export async function visionLabelAction({ action, keyframes, apiKey, model = DEFAULT_VISION_MODEL, baseURL = DEFAULT_VISION_BASE, timeoutMs = 30000 }) {
  if (!apiKey) throw new Error('no vision api key');
  const parts = [
    { type: 'text', text: '这是游戏《明日方舟》角色动画「' + action + '」的 4 张关键帧截图（按播放顺序）。请判断这个小人在做什么动作，用 3~8 个中文词描述（例如：挥手打招呼、打哈欠伸懒腰、被击飞倒地、坐下吃东西）。只输出 JSON，不要其他文字：{"label":"简短中文标签","tags":["词1","词2","词3"]}' },
  ];
  for (const f of keyframes) {
    const b64 = fs.readFileSync(f).toString('base64');
    parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } });
  }
  const endpoint = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [{ role: 'user', content: parts }],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error('vision HTTP ' + resp.status + ': ' + detail.slice(0, 200));
    }
    const payload = await resp.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error('vision returned no content');
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed || !parsed.label) throw new Error('vision JSON 解析失败: ' + text.slice(0, 150));
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)).filter(Boolean).slice(0, 6) : [];
    return { label: String(parsed.label).slice(0, 40), tags, source: 'vision' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 总入口：先渲染关键帧，再逐动作打标；无视觉 Key 时仅规则层
// ---------------------------------------------------------------------------
export async function labelActions({
  rootDir,
  assets,
  animations,
  keyframesDir,
  visionKey = '',
  visionModel = DEFAULT_VISION_MODEL,
  visionBaseURL = DEFAULT_VISION_BASE,
  chromePath,
  concurrency = 2,
  onLog = () => {},
} = {}) {
  const anims = animations && animations.length ? animations : null;
  if (!anims) throw new Error('没有可标注的动作');
  // 无视觉 Key 时不需要关键帧（规则直接打标），省去 Chrome 渲染开销
  const frames = visionKey ? await renderAllKeyframes({ rootDir, assets, animations: anims, outDir: keyframesDir, chromePath, onLog }) : null;
  const dict = {};
  const jobs = anims.map(async (a) => {
    const guess = guessLabel(a.name);
    let entry = { raw_name: a.name, human_label: guess.label, tags: guess.tags, source: guess.source };
    if (visionKey && guess.source === 'none') {
      try {
        const v = await visionLabelAction({ action: a.name, keyframes: frames[a.name] || [], apiKey: visionKey, model: visionModel, baseURL: visionBaseURL });
        entry = { raw_name: a.name, human_label: v.label, tags: v.tags, source: 'vision' };
        onLog('[vision] ' + a.name + ' -> ' + v.label);
      } catch (err) {
        onLog('[vision] ' + a.name + ' 失败(' + err.message + ')，使用规则猜测');
      }
    }
    dict[a.name] = entry;
    return entry;
  });
  // 并发执行（限制并发数）
  const queue = jobs.slice();
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push((async () => { while (queue.length) await queue.shift(); })());
  }
  await Promise.all(workers);
  return { character: '', animations: dict, mode: visionKey ? 'vision' : 'rule', updatedAt: new Date().toISOString() };
}

export { DEFAULT_VISION_MODEL, DEFAULT_VISION_BASE };
