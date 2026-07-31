'use strict';
// ============================================================================
// Arknights Spine Auto-Studio — 桌面 UI 逻辑（零依赖原生 JS）
// ============================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  models: [],
  current: null,          // 当前选中模型 {id, dir, animations, files, name}
  resolve: null,          // 解析结果 {charId, kind, name, skins}
  lastTimeline: null,     // {character, fps, timeline, mode}
  lastModelParams: null,  // 最近一次生成的模型参数（时间轴重渲染用）
  outputs: [],
  jobs: [],
};

const TPL = [
  '攻击，然后倒地',
  '先睡觉，然后起来跑步，最后累趴下',
  '站着挥手，然后坐下休息',
  '原地待机，缓缓抬手',
  '跑步冲刺，然后累瘫',
];

// ---------------------------------------------------------------------------
// API / SSE
// ---------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!json.ok && res.status >= 400) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const waiters = new Map(); // jobId -> {resolve, reject}
const jobLogs = new Map(); // jobId -> []  (UI 只保留当前任务的日志)

function connectSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => {
    $('#chip-srv').textContent = '服务 已连接';
    $('#chip-srv').className = 'chip ok';
  });
  es.addEventListener('status', (e) => {
    const { jobId, status } = JSON.parse(e.data);
    updateJobStatus(jobId, status);
    if (status === 'running') setBusy(true);
    if (status === 'done' || status === 'error') setBusy(false);
  });
  es.addEventListener('log', (e) => {
    const { jobId, line } = JSON.parse(e.data);
    if (!jobLogs.has(jobId)) jobLogs.set(jobId, []);
    jobLogs.get(jobId).push(line);
    if (jobLogs.get(jobId).length > 800) jobLogs.get(jobId).splice(0, jobLogs.get(jobId).length - 800);
    if (jobId === state.activeJob) appendLog(line);
    updateJobLogs(jobId);
  });
  es.addEventListener('done', (e) => {
    const { jobId, result } = JSON.parse(e.data);
    updateJobStatus(jobId, 'done');
    const w = waiters.get(jobId);
    if (w) { waiters.delete(jobId); w.resolve(result); }
    if (jobId === state.activeJob) onJobDone(result);
  });
  es.addEventListener('error', (e) => {
    const { jobId, message } = JSON.parse(e.data);
    updateJobStatus(jobId, 'error');
    const w = waiters.get(jobId);
    if (w) { waiters.delete(jobId); w.reject(new Error(message)); }
    if (jobId === state.activeJob) onJobError(message);
  });
  es.onerror = () => { $('#chip-srv').textContent = '服务 重连中…'; $('#chip-srv').className = 'chip bad'; };
}

function waitJob(jobId) {
  return new Promise((resolve, reject) => {
    waiters.set(jobId, { resolve, reject });
    setTimeout(() => {
      if (waiters.has(jobId)) {
        waiters.delete(jobId);
        // 兜底：轮询任务列表
        api('/api/jobs').then(({ jobs }) => {
          const j = jobs.find((x) => x.id === jobId);
          if (!j) return reject(new Error('任务不存在'));
          if (j.status === 'done') resolve(j.result);
          else if (j.status === 'error') reject(new Error(j.error || '任务失败'));
          else reject(new Error('等待任务超时'));
        }).catch(reject);
      }
    }, 120000);
  }).finally(() => setBusy(false)); // 无论成功/失败/超时都恢复按钮，防止卡死
}

// ---------------------------------------------------------------------------
// 全局任务锁（防止运行中误点重复提交）
// ---------------------------------------------------------------------------
const busyButtons = ['#btn-resolve', '#btn-fetch', '#btn-fetch-force', '#btn-run', '#btn-tl-render', '#btn-hi'];
function setBusy(flag) {
  for (const sel of busyButtons) {
    const el = document.querySelector(sel);
    if (el) el.disabled = flag;
  }
  const runBtn = $('#btn-run');
  if (runBtn) runBtn.textContent = flag ? '⏳ 任务进行中…' : '▶ 开始生成';
}

// ---------------------------------------------------------------------------
// 设置（DeepSeek API Key / 模型 / 地址）
// ---------------------------------------------------------------------------
function openSettings() {
  $('#settings-overlay').hidden = false;
  api('/api/config').then((cfg) => {
    $('#cfg-key').value = '';
    $('#cfg-key').placeholder = cfg.hasKey ? `已保存：${cfg.apiKeyMasked}（输入新 Key 可覆盖）` : 'sk-...（在 platform.deepseek.com 创建）';
    $('#cfg-model').value = cfg.model;
    $('#cfg-baseurl').value = cfg.baseURL;
    $('#cfg-current').textContent = cfg.hasKey ? `已配置（${cfg.apiKeyMasked}）` : '未配置（使用离线编排）';
    $('#cfg-file').textContent = cfg.configFile;
    $('#cfg-status').textContent = '';
  }).catch((err) => { $('#cfg-status').textContent = '加载失败: ' + err.message; });
}
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-settings-close').addEventListener('click', () => { $('#settings-overlay').hidden = true; });
$('#settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('#settings-overlay')) $('#settings-overlay').hidden = true;
});
$('#cfg-key-toggle').addEventListener('click', () => {
  const el = $('#cfg-key');
  el.type = el.type === 'password' ? 'text' : 'password';
  el.nextElementSibling.textContent = el.type === 'password' ? '显示' : '隐藏';
});
$('#btn-cfg-test').addEventListener('click', async () => {
  const st = $('#cfg-status');
  st.textContent = '测试中…';
  try {
    await api('/api/config', { apiKey: $('#cfg-key').value || undefined, model: $('#cfg-model').value, baseURL: $('#cfg-baseurl').value });
    const r = await api('/api/config/test', {});
    st.textContent = (r.ok ? '✅' : '✗') + (r.error || r.message || '未知结果');
  } catch (err) { st.textContent = '❌ ' + err.message; }
});
$('#btn-cfg-save').addEventListener('click', async () => {
  const st = $('#cfg-status');
  st.textContent = '保存中…';
  try {
    await api('/api/config', { apiKey: $('#cfg-key').value, model: $('#cfg-model').value, baseURL: $('#cfg-baseurl').value });
    st.textContent = '✅ 已保存（设置立即生效）';
    $('#cfg-current').textContent = $('#cfg-key').value.trim() ? '已配置（新 Key）' : '未配置（使用离线编排）';
    refreshState();
  } catch (err) { st.textContent = '❌ ' + err.message; }
});
$('#btn-cfg-clear').addEventListener('click', async () => {
  if (!confirm('确定清除已保存的 API Key 吗？')) return;
  const st = $('#cfg-status');
  st.textContent = '清除中…';
  try {
    await api('/api/config', { apiKey: '', model: $('#cfg-model').value, baseURL: $('#cfg-baseurl').value });
    st.textContent = '✅ 已清除';
    $('#cfg-key').value = '';
    $('#cfg-key').placeholder = 'sk-...';
    $('#cfg-current').textContent = '未配置（使用离线编排）';
    refreshState();
  } catch (err) { st.textContent = '❌ ' + err.message; }
});
$('#chip-key').addEventListener('click', openSettings);

// ---------------------------------------------------------------------------
// 状态栏 / 通用刷新
// ---------------------------------------------------------------------------
async function refreshState() {
  try {
    const s = await api('/api/state');
    state.models = s.models || [];
    state.outputs = s.outputs || [];
    renderModels();
    renderOutputs();
    const c = $('#chip-chrome');
    if (s.chrome) { c.textContent = `Chrome ✓`; c.className = 'chip ok'; }
    else { c.textContent = 'Chrome ✗'; c.className = 'chip bad'; }
    const f = $('#chip-ffmpeg');
    if (s.ffmpeg) { f.textContent = `FFmpeg ✓`; f.className = 'chip ok'; }
    else { f.textContent = 'FFmpeg 按需下载'; f.className = 'chip'; }
    const k = $('#chip-key');
    if (s.deepseekKey) { k.textContent = 'DeepSeek Key ✓'; k.className = 'chip ok'; }
    else { k.textContent = 'DeepSeek 离线模式'; k.className = 'chip'; }
  } catch (err) {
    $('#chip-srv').textContent = '服务 异常';
    $('#chip-srv').className = 'chip bad';
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Tab 切换
// ---------------------------------------------------------------------------
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'jobs') refreshJobs();
  });
});

// ---------------------------------------------------------------------------
// 模型资源：解析 / 拉取 / 列表
// ---------------------------------------------------------------------------
$('#btn-goto-models').addEventListener('click', () => { showTab('models'); $('#f-name').focus(); });
$('#btn-resolve').addEventListener('click', async () => {
  const name = $('#f-name').value.trim();
  const key = $('#f-key').value.trim();
  const enemy = document.querySelector('input[name=kind]:checked').value === 'enemy';
  const query = key || name;
  if (!query) return;
  const out = $('#resolve-out');
  out.textContent = '解析中…';
  out.className = 'muted';
  try {
    const { jobId } = await api('/api/resolve', { query, enemy, key: key || undefined });
    state.activeJob = jobId;
    const r = await waitJob(jobId);
    state.resolve = r;
    const tag = r.kind === 'enemy' ? '敌人' : '角色';
    out.innerHTML = `✅ ${tag}：<b>${escapeHtml(r.name)}</b>（${r.charId}） · ${r.skins.length} 套皮肤`;
    out.className = '';
    fillSkins(r.skins);
    $('#skin-row').hidden = false;
    if (r.skins.length === 1 && r.skins[0].skin === '默认') autoFillView(r.skins[0]);
  } catch (err) {
    out.textContent = `❌ ${err.message}`;
    out.className = 'muted';
  }
});

function autoFillView(skin) {
  const viewSel = $('#f-view');
  if (viewSel.options.length === 0 && skin.views.length) {
    skin.views.forEach((v) => viewSel.add(new Option(v.view, v.view)));
  }
}

function fillSkins(skins) {
  const skinSel = $('#f-skin');
  const viewSel = $('#f-view');
  skinSel.innerHTML = '';
  viewSel.innerHTML = '';
  for (const s of skins) skinSel.add(new Option(`${s.skin}（${s.views.length} 视图）`, s.skin));
  if (skins.length) fillViews(skins[0]);
}

function fillViews(skin) {
  const viewSel = $('#f-view');
  viewSel.innerHTML = '';
  const pri = ['战斗', '基建', '正面', '背面'];
  const sorted = [...skin.views].sort((a, b) => pri.indexOf(a.view) - pri.indexOf(b.view));
  for (const v of sorted) viewSel.add(new Option(v.view, v.view));
}

$('#f-skin').addEventListener('change', () => {
  const skin = (state.resolve?.skins || []).find((s) => s.skin === $('#f-skin').value);
  if (skin) fillViews(skin);
});

async function fetchModel(force) {
  const r = state.resolve;
  if (!r) return;
  const btn = $('#btn-fetch');
  btn.disabled = true;
  btn.textContent = force ? '强制重下中…' : '拉取中…';
  try {
    const { jobId } = await api('/api/fetch', {
      character: r.kind === 'char' ? r.charId : undefined,
      enemy: r.kind === 'enemy' ? r.charId : undefined,
      key: r.charId,
      skin: $('#f-skin').value,
      view: $('#f-view').value,
      force,
    });
    const result = await waitJob(jobId);
    await refreshState();
    const m = state.models.find((x) => x.id === result.charId);
    selectModel(m || { id: result.charId, name: result.characterName, dir: result.dir, animations: result.animations, files: result.files });
    showTab('generate');
  } catch (err) {
    alert(`拉取失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取三件套';
  }
}
$('#btn-fetch').addEventListener('click', () => fetchModel(false));
$('#btn-fetch-force').addEventListener('click', () => fetchModel(true));

function renderModels() {
  const box = $('#model-list');
  if (!state.models.length) {
    box.innerHTML = '<div class="empty-guide"><div>暂无本地模型，二选一即可开始：</div><ol>' +
      '<li><b>用内置示例</b>：阿米娅已自带（assets/amiya），直接切到「动画生成」使用。</li>' +
      '<li><b>从 PRTS 拉取</b>：在上方输入名称（如 阿米娅 / 霜星 / 弑君者）→「解析」→ 选皮肤/视图 →「拉取三件套」。</li>' +
      '</ol></div>';
    return;
  }
  box.innerHTML = '';
  for (const m of state.models) {
    const el = document.createElement('div');
    el.className = 'model-card' + (state.current?.id === m.id ? ' sel' : '');
    const tag = m.source === 'prts-enemy' ? '敌人' : m.source === 'prts' ? 'PRTS' : '本地';
    el.innerHTML = `
      <div class="name">${escapeHtml(m.name)}<span class="tag">${tag}</span></div>
      <div class="id">${escapeHtml(m.id)}</div>
      <div class="chips">${(m.animations || []).map((a) => `<span class="chip-anim">${escapeHtml(a.name)} ${a.duration.toFixed(2)}s</span>`).join('') || '<span class="muted">无动画信息</span>'}</div>`;
    el.addEventListener('click', () => selectModel(m));
    box.appendChild(el);
  }
}

function selectModel(m) {
  state.current = m;
  renderModels();
  $('#gen-model').innerHTML = `<b>${escapeHtml(m.name)}</b>（${escapeHtml(m.id)}） <button class="ghost" id="btn-use-files">查看三件套路径</button>`;
  const useBtn = document.getElementById('btn-use-files');
  if (useBtn) {
    useBtn.addEventListener('click', () => {
      const files = m.files || {};
      const missing = ['skel', 'atlas', 'png'].filter((k) => !files[k]);
      if (missing.length) alert('缺少文件: ' + missing.join(', ') + '\n请重新拉取该模型');
      else alert('当前模型三件套：\n' + files.skel + '\n' + files.atlas + '\n' + files.png);
    });
  }
  const step1 = document.querySelector('.steps .step');
  if (step1) step1.classList.add('done');
  const anims = $('#gen-anims');
  anims.innerHTML = (m.animations || []).map((a) => `<span class="chip-anim">${escapeHtml(a.name)} ${a.duration.toFixed(2)}s</span>`).join('') || '';
  localStorage.setItem('zd.current', JSON.stringify({ id: m.id, name: m.name }));
  const hiSel = $('#h-model');
  const exists = [...hiSel.options].some((o) => o.value === m.id);
  if (!exists) {
    hiSel.add(new Option(`${m.name}（${m.id}）`, m.id));
    hiSel.value = m.id;
  }
}

$('#btn-refresh').addEventListener('click', refreshState);
$('#btn-refresh-out').addEventListener('click', refreshState);

// ---------------------------------------------------------------------------
// 动画生成
// ---------------------------------------------------------------------------
const tplBox = $('#g-templates');
TPL.forEach((t) => {
  const chip = document.createElement('span');
  chip.className = 'chip-tpl';
  chip.textContent = t;
  chip.addEventListener('click', () => { $('#g-prompt').value = t; });
  tplBox.appendChild(chip);
});

function showTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}

function buildRunBody(extra = {}) {
  const m = state.current;
  if (!m) throw new Error('请先在「模型资源」选择一个模型');
  const body = {
    source: m.source === 'prts' || m.source === 'prts-enemy' ? 'prts' : 'prts',
    key: m.id,
    fps: $('#g-fps').value,
    size: $('#g-size').value,
    format: $('#g-format').value,
    mix: $('#g-mix').value,
    bg: $('#g-bg').value || '00000000',
    upscale: $('#g-upscale').value,
    sr: $('#g-sr').checked,
    srEngine: $('#g-sr-engine').value,
    outName: m.name,
  };
  return { ...body, ...extra };
}

$('#btn-run').addEventListener('click', async () => {
  const prompt = $('#g-prompt').value.trim();
  let body;
  try { body = buildRunBody({ prompt }); } catch (err) {
    $('#run-status').textContent = '❌ ' + err.message;
    $('#run-status').className = 'err-inline';
    showTab('models');
    return;
  }
  if (!body.prompt) {
    $('#run-status').textContent = '❌ 请先写下动作描述（如：先睡觉，然后起来跑步）';
    $('#run-status').className = 'err-inline';
    $('#g-prompt').focus();
    return;
  }
  state.lastModelParams = body;
  const steps = document.querySelectorAll('.steps .step');
  if (steps[1]) steps[1].classList.add('done');
  startJobUI();
  try {
    const { jobId } = await api('/api/run', body);
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    state.lastTimeline = await fetchTimeline(result.timelineFile);
    state.lastTimeline.mode = 'generated';
    renderTimeline();
  } catch (err) {
    onJobError(err.message);
  }
});

async function fetchTimeline(file) {
  const name = file.split(/[\\/]/).pop();
  const res = await fetch(`/outputs/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  return res.json();
}

let logLineSeq = 0;
function startJobUI() {
  logLineSeq = 0;
  $('#run-log').hidden = false;
  $('#run-log').innerHTML = '';
  $('#run-progress').hidden = false;
  $('#run-progress-bar').value = 0;
  $('#run-progress-text').textContent = '排队中…';
  $('#run-status').textContent = '';
  $('#run-status').className = '';
  $('#run-result').hidden = true;
  setBusy(true);
}

function appendLog(line) {
  const log = $('#run-log');
  const div = document.createElement('div');
  const t = new Date().toTimeString().slice(0, 8);
  const isErr = line.startsWith('[error]');
  div.innerHTML = `<span class="t">${t}</span>${escapeHtml(line)}`;
  if (isErr) div.className = 'err';
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  // 进度解析
  const m = line.match(/\[render\]\s+(\d+)\/(\d+)/);
  if (m) {
    const cur = parseInt(m[1], 10), total = parseInt(m[2], 10);
    $('#run-progress-bar').value = Math.round((cur / total) * 100);
    $('#run-progress-text').textContent = `渲染 ${cur}/${total} 帧`;
  } else if (line.includes('[hi-res]')) {
    $('#run-progress-text').textContent = '高清化处理中…';
  } else if (line.includes('[done]')) {
    $('#run-progress-text').textContent = '完成';
  }
}

function onJobDone(result) {
  setBusy(false);
  $('#btn-run').disabled = false;
  const steps = document.querySelectorAll('.steps .step');
  if (steps[1]) steps[1].classList.add('done');
  if (steps[2]) steps[2].classList.add('done');
  $('#run-progress-bar').value = 100;
  $('#run-status').textContent = '';
  $('#run-status').className = '';
  const box = $('#run-result');
  box.hidden = false;
  const media = (result.files || [])
    .map((f) => (f.kind === 'mp4' ? `<video src="${f.url}" controls></video>` : f.kind === 'gif' ? `<img src="${f.url}">` : f.kind === 'png' ? `<img src="${f.url}">` : ''))
    .join('');
  box.innerHTML = `<h3>✅ 生成完成</h3>${media}<div class="row" style="margin-top:10px"><button id="btn-open-out" class="ghost">打开输出目录</button><span class="muted" style="font-family:var(--mono);font-size:12px">${escapeHtml(result.outBase)}</span></div>`;
  const openBtn = box.querySelector('#btn-open-out');
  if (openBtn) openBtn.addEventListener('click', () => openFolder(result.outBase));
  refreshState();
  const tl = $('#run-progress-text');
  tl.textContent = '';
}

function onJobError(message) {
  setBusy(false);
  $('#btn-run').disabled = false;
  $('#run-status').textContent = `❌ ${message}`;
  $('#run-status').className = '';
}

// ---------------------------------------------------------------------------
// 时间轴
// ---------------------------------------------------------------------------
function renderTimeline() {
  const tl = state.lastTimeline;
  const empty = $('#tl-empty');
  const table = $('#tl-table');
  const actions = $('#tl-actions');
  if (!tl || !Array.isArray(tl.timeline) || !tl.timeline.length) {
    empty.hidden = false; table.hidden = true; actions.hidden = true;
    return;
  }
  empty.hidden = true; table.hidden = false; actions.hidden = false;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  const total = tl.timeline.reduce((s, x) => s + (parseFloat(x.duration) || 0), 0);
  tl.timeline.forEach((seg, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${escapeHtml(seg.action)}</b>${seg.description ? `<div class="muted">${escapeHtml(seg.description)}</div>` : ''}</td>
      <td><input type="number" min="0.1" step="0.1" value="${parseFloat(seg.duration) || 0}"></td>
      <td style="text-align:center"><input type="checkbox" ${seg.loop ? 'checked' : ''}></td>
      <td><input type="number" min="0.1" step="0.1" value="${parseFloat(seg.timeScale) || 1}"></td>
      <td><input type="text" value="${escapeHtml(seg.description || '')}"></td>`;
    tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
      seg.duration = parseFloat(tr.querySelector('input[type=number]').value) || seg.duration;
      seg.loop = tr.querySelector('input[type=checkbox]').checked;
      seg.timeScale = parseFloat(tr.querySelectorAll('input[type=number]')[1].value) || seg.timeScale;
      seg.description = tr.querySelector('input[type=text]').value;
      const tot = tl.timeline.reduce((s, x) => s + (parseFloat(x.duration) || 0), 0);
      $('#tl-info').textContent = `共 ${tl.timeline.length} 段 · ${tot.toFixed(2)}s · 模式 ${tl.mode || 'generated'}`;
    }));
    tbody.appendChild(tr);
  });
  $('#tl-info').textContent = `共 ${tl.timeline.length} 段 · ${total.toFixed(2)}s · 模式 ${tl.mode || 'generated'}`;
}

$('#btn-tl-render').addEventListener('click', async () => {
  const tl = state.lastTimeline;
  if (!tl) return;
  const m = state.current;
  if (!m) { $('#tl-info').textContent = '❌ 请先在「模型资源」选择模型'; showTab('models'); return; }
  const body = buildRunBody({ timeline: tl });
  startJobUI();
  try {
    const { jobId } = await api('/api/run', body);
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    const fresh = await fetchTimeline(result.timelineFile);
    if (fresh) { state.lastTimeline = { ...fresh, mode: 'edited' }; renderTimeline(); }
  } catch (err) {
    onJobError(err.message);
  }
});

$('#btn-tl-copy').addEventListener('click', async () => {
  if (!state.lastTimeline) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.lastTimeline, null, 2));
    $('#tl-info').textContent = '已复制 JSON ✓';
  } catch {
    alert(JSON.stringify(state.lastTimeline, null, 2));
  }
});

// ---------------------------------------------------------------------------
// 高清化：方案对比（4 图先行，用户选择后再执行整图高清化）
// ---------------------------------------------------------------------------
const HI_PLANS = [
  { key: 'orig', label: '原图 1x', desc: '不放大，保持原始，最省时间', bar: '#8c94a0', scale: '1', sr: false, engine: '', tag: '' },
  { key: 'lanczos', label: 'Lanczos 放大', desc: '快速锐化，文件小，无 AI 依赖', bar: '#4094ff', sr: false, engine: '', tag: '快速' },
  { key: 'realesrgan', label: 'Real-ESRGAN', desc: 'AI 细节增强，效果最稳', bar: '#00c882', sr: true, engine: 'realesrgan', tag: '推荐' },
  { key: 'waifu2x', label: 'Waifu2x', desc: 'AI 动漫风，线条干净', bar: '#b478ff', sr: true, engine: 'waifu2x', tag: '' },
];
let hiPlanKey = null;
let hiPlanScale = '2';

function renderHiPlans() {
  const box = $('#h-plans');
  if (!box) return;
  box.innerHTML = '';
  for (const plan of HI_PLANS) {
    const scale = plan.scale || $('#h-scale').value;
    const el = document.createElement('div');
    el.className = 'hi-plan' + (hiPlanKey === plan.key ? ' sel' : '');
    el.innerHTML = `<div class="bar" style="background:${plan.bar}"></div>
      <div class="name">${plan.label}${plan.tag ? '<span class="tag">' + plan.tag + '</span>' : ''}<span class="muted">${scale}x</span></div>
      <div class="desc">${plan.desc}</div>`;
    el.addEventListener('click', () => {
      hiPlanKey = plan.key;
      hiPlanScale = scale;
      renderHiPlans();
      $('#h-sr').checked = plan.sr;
      if (plan.engine) $('#h-sr-engine').value = plan.engine;
      $('#hi-plan-tag').textContent = '✅ 已选：' + plan.label + ' ' + scale + 'x，点「开始高清化」执行整图';
      // 联动「动画生成」参数，保证预览与成片一致
      $('#g-upscale').value = scale;
      $('#g-sr').checked = plan.sr;
      if (plan.engine) $('#g-sr-engine').value = plan.engine;
      $('#hi-info').textContent = '已同步到「动画生成」参数：放大 ' + scale + 'x' + (plan.sr ? ' + AI 超分（' + plan.engine + '）' : '');
    });
    box.appendChild(el);
  }
}
// 手动修改表单 → 视为放弃方案卡选择
$('#h-sr').addEventListener('change', () => { hiPlanKey = null; renderHiPlans(); $('#hi-plan-tag').textContent = ''; });
$('#h-sr-engine').addEventListener('change', () => { hiPlanKey = null; renderHiPlans(); $('#hi-plan-tag').textContent = ''; });
$('#h-scale').addEventListener('change', () => { renderHiPlans(); });

$('#btn-compare').addEventListener('click', async () => {
  const m = state.models.find((x) => x.id === $('#h-model').value);
  if (!m || !m.files.atlas || !m.files.png) {
    $('#cmp-info').textContent = '❌ 该模型缺少 atlas/png，请先拉取完整三件套';
    return;
  }
  const btn = $('#btn-compare');
  btn.disabled = true;
  hiPlanKey = null;
  renderHiPlans();
  $('#hi-plan-tag').textContent = '';
  $('#h-compare-wrap').hidden = true;
  $('#cmp-info').textContent = '⏳ 正在生成对比图（首次会自动下载 AI 引擎约 40MB，请耐心等待）…';
  try {
    const { jobId } = await api('/api/compare', {
      atlas: m.files.atlas, png: m.files.png,
      scale: $('#h-scale').value, outName: m.name,
      engines: ['realesrgan', 'waifu2x'],
    });
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    const img = $('#h-compare-img');
    img.onerror = () => { $('#cmp-info').textContent = '❌ 对比图加载失败，请重试'; };
    img.src = result.file.url;
    $('#h-compare-wrap').hidden = false;
    $('#cmp-info').textContent = '✅ 对比图已生成 · 点下方任一方案卡即可选中（灰=原图 蓝=Lanczos 绿=Real-ESRGAN 紫=Waifu2x）';
    renderHiPlans();
  } catch (err) {
    $('#cmp-info').textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// 高清化
// ---------------------------------------------------------------------------
$('#btn-hi').addEventListener('click', async () => {
  const m = state.models.find((x) => x.id === $('#h-model').value);
  if (!m || !m.files.atlas || !m.files.png) {
    $('#hi-info').textContent = '❌ 该模型缺少 atlas/png，请先拉取完整三件套';
    return;
  }
  $('#hi-info').textContent = '';
  $('#hi-log').hidden = false;
  $('#hi-log').innerHTML = '';
  $('#hi-result').hidden = true;
  $('#btn-hi').disabled = true;
  const showImg = (id, url) => { const img = $(id); img.src = url; };
  try {
    const { jobId } = await api('/api/upscale', {
      atlas: m.files.atlas, png: m.files.png,
      scale: $('#h-scale').value, sr: $('#h-sr').checked, srEngine: $('#h-sr-engine').value,
      outName: m.name,
    });
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    $('#hi-result').hidden = false;
    showImg('#hi-before', `/outputs/${encodeURIComponent(m.id)}.png`);
    const png = result.files.find((f) => f.kind === 'png');
    if (png) showImg('#hi-after', png.url);
    $('#hi-info').textContent = `输出：${result.outDir}`;
  } catch (err) {
    $('#hi-log').innerHTML += `<div class="err">${escapeHtml(err.message)}</div>`;
  } finally {
    $('#btn-hi').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// 任务与输出
// ---------------------------------------------------------------------------
function updateJobStatus(jobId, status) {
  const el = document.querySelector(`[data-job="${jobId}"] .st`);
  if (el) { el.textContent = status; el.className = 'st ' + status; }
}
function updateJobLogs(jobId) {
  const el = document.querySelector(`[data-job="${jobId}"] .logs`);
  if (el && jobLogs.has(jobId)) {
    el.textContent = jobLogs.get(jobId).slice(-12).join('\n');
  }
}
async function refreshJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    state.jobs = jobs;
    renderJobs();
  } catch { /* 忽略 */ }
}
function renderJobs() {
  const box = $('#job-list');
  if (!state.jobs.length) { box.innerHTML = '<div class="muted">暂无任务</div>'; return; }
  box.innerHTML = '';
  for (const j of state.jobs) {
    const el = document.createElement('div');
    el.className = 'job-item';
    el.dataset.job = j.id;
    const time = new Date(j.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
    const err = j.error ? `<div class="err" style="font-family:var(--mono);font-size:11px;margin-top:4px">${escapeHtml(String(j.error).slice(0, 300))}</div>` : '';
    el.innerHTML = `<div class="top"><span class="st ${j.status}">${j.status}</span><b>${escapeHtml(j.kind)}</b><span class="muted">${j.id} · ${time}</span></div>${err}<div class="logs"></div>`;
    box.prepend(el);
  }
}
function renderOutputs() {
  const box = $('#out-list');
  if (!state.outputs.length) { box.innerHTML = '<div class="muted">暂无输出</div>'; return; }
  box.innerHTML = '';
  for (const o of state.outputs) {
    if (o.name.endsWith('.timeline.json') || o.name.endsWith('.atlas')) continue;
    const kind = o.name.split('.').pop();
    const el = document.createElement('div');
    el.className = 'out-item';
    const media = kind === 'gif' || kind === 'png' ? `<img src="${o.url}" loading="lazy">` : kind === 'mp4' ? `<video src="${o.url}" controls preload="metadata"></video>` : '';
    const size = o.size > 1024 * 1024 ? `${(o.size / 1024 / 1024).toFixed(1)} MB` : `${(o.size / 1024).toFixed(0)} KB`;
    el.innerHTML = `${media}<div class="meta"><div class="nm">${escapeHtml(o.name)}</div><div>${size} · ${new Date(o.mtime).toLocaleString('zh-CN', { hour12: false })}</div></div>`;
    box.appendChild(el);
  }
}

function openFolder(filePath) {
  const dir = String(filePath || '').replace(/[\\/][^\\/]*$/, '');
  if (window.desktopAPI?.openPath) {
    window.desktopAPI.openPath(dir).then((r) => { if (!r.ok) alert('打开失败: ' + r.error); });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(dir)
      .then(() => alert('已复制输出目录路径（安装 Electron 后可一键打开）:\n' + dir))
      .catch(() => alert(dir));
  } else {
    alert(dir);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(async function init() {
  connectSse();
  await refreshState();
  // 恢复上次的提示词与参数
  try {
    const savedForm = JSON.parse(localStorage.getItem('zd.form') || 'null');
    if (savedForm) {
      if (savedForm.prompt) $('#g-prompt').value = savedForm.prompt;
      if (savedForm.fps) $('#g-fps').value = savedForm.fps;
      if (savedForm.size) $('#g-size').value = savedForm.size;
      if (savedForm.format) $('#g-format').value = savedForm.format;
      if (savedForm.mix) $('#g-mix').value = savedForm.mix;
      if (savedForm.bg) $('#g-bg').value = savedForm.bg;
      if (savedForm.upscale) $('#g-upscale').value = savedForm.upscale;
      if (savedForm.sr !== undefined) $('#g-sr').checked = !!savedForm.sr;
      if (savedForm.srEngine) $('#g-sr-engine').value = savedForm.srEngine;
    }
  } catch { /* 忽略 */ }
  // 表单变更自动记忆
  ['g-prompt', 'g-fps', 'g-size', 'g-format', 'g-mix', 'g-bg', 'g-upscale', 'g-sr', 'g-sr-engine'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      try {
        localStorage.setItem('zd.form', JSON.stringify({
          prompt: $('#g-prompt').value,
          fps: $('#g-fps').value,
          size: $('#g-size').value,
          format: $('#g-format').value,
          mix: $('#g-mix').value,
          bg: $('#g-bg').value,
          upscale: $('#g-upscale').value,
          sr: $('#g-sr').checked,
          srEngine: $('#g-sr-engine').value,
        }));
      } catch { /* 忽略 */ }
    });
  });
  // 恢复上次选择的模型
  try {
    const saved = JSON.parse(localStorage.getItem('zd.current') || 'null');
    if (saved) {
      const m = state.models.find((x) => x.id === saved.id);
      if (m) selectModel(m);
    }
  } catch { /* 忽略 */ }
  setInterval(refreshState, 30000);
})();