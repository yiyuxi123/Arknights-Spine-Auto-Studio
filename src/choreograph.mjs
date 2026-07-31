// LLM Choreographer: maps natural language + the character's real animation
// list onto a strict Timeline JSON.
//
// Two modes:
//   - LLM mode   : calls DeepSeek (OpenAI-compatible chat completions) with
//                  DEEPSEEK_API_KEY; no SDK needed, plain fetch.
//   - mock mode  : deterministic keyword matching, fully offline. Used when
//                  --mock is passed or no API key is configured.

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

// ---------------------------------------------------------------------------
// Keyword tables (Chinese + English) for mock mode.
// ---------------------------------------------------------------------------
const MOTION_KEYWORDS = [
  { keywords: ['睡觉', '睡眠', '睡', 'sleep', 'sleeping', 'dream'], defaultAction: 'Sleep', loop: true },
  { keywords: ['跑步', '奔跑', '跑', 'run', 'running', 'jog'], defaultAction: 'Run', loop: true },
  { keywords: ['走路', '行走', '走', 'walk', 'walking', 'move', '移动', '前进'], defaultAction: 'Move', loop: true },
  { keywords: ['站立', '站着', '待机', 'idle', 'stand', 'standing', '站'], defaultAction: 'Idle', loop: true },
  { keywords: ['坐下', '坐着', '坐', 'sit', 'sitting'], defaultAction: 'Sit', loop: true },
  { keywords: ['攻击', '砍', '打', '挥', 'attack', 'fighting', 'combat'], defaultAction: 'Attack', loop: false },
  { keywords: ['技能', '大招', '施法', 'skill', 'spell', 'magic', 'casting'], defaultAction: 'Skill', loop: false },
  { keywords: ['晕', '眩晕', '累垮', '累趴', '力竭', '喘', '瘫', 'stun', 'tired', 'exhaust', 'faint', 'dizzy'], defaultAction: 'Stun', loop: false },
  { keywords: ['倒下', '死亡', '阵亡', 'die', 'death', 'defeat'], defaultAction: 'Die', loop: false },
  { keywords: ['胜利', '欢呼', 'victory', 'win', 'cheer'], defaultAction: 'Victory', loop: false },
  { keywords: ['跳舞', '舞', 'dance'], defaultAction: 'Dance', loop: true },
  { keywords: ['挥手', '打招呼', 'hi', 'hello', 'wave', 'greet'], defaultAction: 'Hi', loop: false },
  { keywords: ['坐下休息', '休息', 'rest', 'relax'], defaultAction: 'Sit', loop: true },
];


// Semantic aliases used when the character lacks the exact clip (mock mode).
const ACTION_ALIASES = {
  Run: ['Move', 'Relax'],
  Attack: ['Interact'],
  Skill: ['Interact'],
  Dance: ['Move', 'Interact'],
  Hi: ['Interact'],
  Victory: ['Interact'],
  Die: ['Sleep', 'Relax'],
  Stun: ['Sleep', 'Relax', 'Sit'],
};

function splitPrompt(prompt) {
  const cleaned = String(prompt).replace(/[，、。；;\n]/g, '|').replace(/\s+/g, ' ');
  const parts = cleaned
    .split(/(?:然后|接着|随后|之后|再|最后|先)/)
    .flatMap((part) => part.split('|'))
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [String(prompt).trim()];
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function pickAnimation(animations, text, actionDescriptions) {
  const lower = text.toLowerCase();
  // 优先：动作字典（千问视觉/用户标注）中的语义标签命中
  if (actionDescriptions) {
    for (const animation of animations) {
      const desc = String(actionDescriptions[animation.name] || '').toLowerCase();
      if (!desc) continue;
      const words = desc.split(/[，,、/\s（()）]+/).filter((w) => w.length >= 2);
      if (words.some((w) => lower.includes(w))) {
        return { animation, loop: /跑|走|移|待机|睡|坐|休息/.test(lower), speedHint: /跑|run/.test(lower) ? 1.2 : 1.0 };
      }
    }
  }
  for (const motion of MOTION_KEYWORDS) {
    const matched = motion.keywords.some((keyword) => lower.includes(keyword));
    if (!matched) continue;
    const candidates = animations.filter((animation) =>
      animation.name.toLowerCase().includes(motion.defaultAction.toLowerCase()),
    );
    if (candidates.length > 0) {
      return { animation: candidates[0], loop: motion.loop, speedHint: /跑|run/.test(lower) ? 1.2 : 1.0 };
    }
    // keyword intent exists but the character lacks that exact clip:
    // prefer semantic aliases, then Levenshtein fallback
    const aliases = ACTION_ALIASES[motion.defaultAction] ?? [];
    for (const alias of aliases) {
      const hit = animations.find((a) => a.name.toLowerCase() === alias.toLowerCase());
      if (hit) return { animation: hit, loop: motion.loop, speedHint: 1.0 };
    }
    const scored = animations
      .map((animation) => ({
        animation,
        distance: levenshtein(motion.defaultAction.toLowerCase(), animation.name.toLowerCase()),
      }))
      .sort((a, b) => a.distance - b.distance);
    return { animation: scored[0].animation, loop: motion.loop, speedHint: 1.0 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mock choreographer: deterministic, offline.
// ---------------------------------------------------------------------------
export function mockChoreograph(prompt, animations, { fps = 30, actionDescriptions } = {}) {
  const parts = splitPrompt(prompt);
  const timeline = parts.map((part, index) => {
    const picked = pickAnimation(animations, part, actionDescriptions);
    const isLast = index === parts.length - 1;
    if (!picked) {
      const fallback = animations.find((a) => /idle/i.test(a.name)) ?? animations[0];
      return {
        action: fallback?.name ?? 'Idle',
        loop: true,
        duration: 2.0,
        timeScale: 1.0,
        description: `未匹配语义，回退到 ${fallback?.name ?? 'Idle'}（片段："${part}"）`,
      };
    }
    const duration = picked.loop ? 2.5 : 1.5;
    return {
      action: picked.animation.name,
      loop: picked.loop,
      duration,
      timeScale: picked.speedHint,
      description: `片段："${part}"`,
    };
  });
  return { character: 'unknown', fps, timeline };
}

// ---------------------------------------------------------------------------
// LLM choreographer (DeepSeek, OpenAI-compatible REST).
// ---------------------------------------------------------------------------
function buildSystemPrompt(character, animations, actionDescriptions) {
  const table = animations
    .map((animation) => {
      const desc = actionDescriptions && actionDescriptions[animation.name]
        ? ` —— 动作含义：${actionDescriptions[animation.name]}`
        : '';
      return `- ${animation.name}（duration ${animation.duration.toFixed(2)}s）${desc}`;
    })
    .join('\n');
  return [
    `你是明日方舟角色动画的“动作编排导演”。角色：${character}。`,
    `该角色可用的全部动画如下（只能从中选择，禁止编造动画名）；动画名后面的“动作含义”是视觉模型/用户标注的语义，请按语义而非名字选动作：`,
    table,
    ``,
    `把用户的自然语言指令切分为若干连续分镜，为每个分镜挑选最合适的动画。`,
    `动作拟合原则：没有完全对应的动画时，选语义最接近的（如“大喘气/累垮”可用 Stun 或 Exhaust 代替）。`,
    ``,
    `必须严格输出 JSON，不要输出任何其他文字，schema：`,
    `{`,
    `  "character": "${character}",`,
    `  "fps": 30,`,
    `  "timeline": [`,
    `    { "action": "动画名", "loop": true, "duration": 2.0, "timeScale": 1.0, "description": "分镜说明" }`,
    `  ]`,
    `}`,
    `约束：timeline 至少 1 个分镜；action 必须来自上面的列表；duration 为正数（单位秒）；loop 为布尔；timeScale 在 0.1~10 之间。`,
  ].join('\n');
}

export async function llmChoreograph(prompt, animations, { character = 'unknown', fps = 30, model = DEFAULT_MODEL, baseURL = DEFAULT_BASE_URL, apiKey, timeoutMs = 60000, actionDescriptions } = {}) {
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set; pass --mock to use the offline choreographer');
  }
  const endpoint = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(character, animations, actionDescriptions) },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`DeepSeek API HTTP ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const payload = await resp.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek API returned no message content');
    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.timeline)) {
      throw new Error(`DeepSeek returned invalid timeline JSON: ${content.slice(0, 300)}`);
    }
    return { character: parsed.character ?? character, fps: parsed.fps ?? fps, timeline: parsed.timeline };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Validation & normalization shared by both paths.
// ---------------------------------------------------------------------------
export function validateTimeline(timeline, animations, animationsByView) {
  if (!timeline || !Array.isArray(timeline.timeline) || timeline.timeline.length === 0) {
    throw new Error('Timeline must contain a non-empty "timeline" array');
  }
  const viewNames = animationsByView ? Object.keys(animationsByView) : [];
  const defaultView = viewNames[0] || null;
  const flatKnown = new Set((animations || []).map((a) => a.name));
  const flatFallback = animations?.[0]?.name ?? null;
  const segments = timeline.timeline.map((segment, index) => {
    const rawView = typeof segment.view === 'string' && segment.view ? segment.view : defaultView;
    const view = viewNames.includes(rawView) ? rawView : (defaultView || null);
    const pool = view && animationsByView ? (animationsByView[view] || []) : (animations || []);
    const known = new Set(pool.map((a) => a.name));
    const fallback = pool[0]?.name ?? flatFallback;
    const action = typeof segment.action === 'string' ? segment.action : null;
    let resolved = action && known.has(action) ? action : null;
    if (!resolved) {
      const fuzzy = action
        ? pool
            .map((animation) => ({
              name: animation.name,
              distance: levenshtein(action.toLowerCase(), animation.name.toLowerCase()),
            }))
            .sort((a, b) => a.distance - b.distance)[0]
        : null;
      resolved = fuzzy?.name ?? fallback;
      if (action && resolved !== action) {
        console.warn(`  [warn] segment ${index}: "${action}" 不存在（视图 ${view || 'default'}），已替换为 "${resolved}"`);
      }
    }
    const duration = Number(segment.duration);
    const loop = segment.loop === true;
    let timeScale = Number(segment.timeScale);
    if (!Number.isFinite(timeScale) || timeScale <= 0) timeScale = 1;
    timeScale = Math.min(10, Math.max(0.1, timeScale));
    let repeat = parseInt(segment.repeat, 10);
    if (!Number.isFinite(repeat) || repeat < 1) repeat = 1;
    repeat = Math.min(99, repeat);
    const out = {
      action: resolved,
      loop,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 2,
      timeScale,
      repeat,
      description: typeof segment.description === 'string' ? segment.description : '',
    };
    if (view) out.view = view;
    return out;
  });
  return { character: timeline.character ?? 'unknown', fps: normalizeFps(timeline.fps), timeline: segments };
}

export function normalizeFps(value) {
  const fps = Math.round(Number(value));
  return Number.isFinite(fps) ? Math.min(60, Math.max(1, fps)) : 30;
}

export function timelineTotal(validated) {
  return validated.timeline.reduce((sum, segment) => sum + segment.duration * (parseInt(segment.repeat, 10) || 1), 0);
}

export async function choreograph({ prompt, animations, character = 'unknown', fps = 30, mock = false, apiKey, model, baseURL, actionDescriptions }) {
  const useMock = mock || !apiKey;
  if (useMock) {
    if (!mock) console.warn('  [warn] DEEPSEEK_API_KEY 未设置，使用 mock 编导（--mock）');
    const raw = mockChoreograph(prompt, animations, { fps, actionDescriptions });
    return { ...validateTimeline({ ...raw, character }, animations), mode: 'mock' };
  }
  const raw = await llmChoreograph(prompt, animations, { character, fps, apiKey, model, baseURL, actionDescriptions });
  return { ...validateTimeline(raw, animations), mode: 'llm' };
}