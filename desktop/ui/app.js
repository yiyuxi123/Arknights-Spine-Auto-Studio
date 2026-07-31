'use strict';
// ============================================================================
// Arknights Spine Auto-Studio — 桌面 UI 逻辑（零依赖原生 JS）
// 流程：① 拉取模型 → ② 高清化（可选）→ ③ 编排时间轴 → ④ 生成动画
// ============================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  models: [],
  current: null,          // 当前选中模型 {id, dir, animations, files, name, source}
  resolve: null,          // 解析结果 {charId, kind, name, skins}
  assetSet: null,         // 高清化资源 {modelId, skel, atlas, png, label}
  previews: null,         // 动作预览 [{name, duration, url, view}]
  fetchViews: null,       // 拉取时下载的视图列表 [{view, base, files, animations}]
  selection: [],          // 工作集：用户勾选的模型 id 列表
  assetSets: {},          // modelId -> 高清化资源 {skel, atlas, png, label}
  hiCompareId: null,      // 高清化对比目标模型 id
  pvDesc: {},             // 动作名 -> 用户描述
  queue: [],              // 时间轴 [{action, loop, duration, timeScale, description}]
  lastTimeline: null,
  lastModelParams: null,
  outputs: [],
  jobs: [],
  outDir: '',
  assetsDir: '',
  modelFilter: { kind: 'all', class: '', rarity: '', faction: '' },
  perf: { cpu: [], mem: [], gpu: [] },
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

function waitJob(jobId, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    waiters.set(jobId, { resolve, reject });
    // SSE 事件优先（快）；轮询作为兜底，长渲染（大画布/高帧率）不会误报超时
    const t0 = Date.now();
    const poll = async () => {
      try {
        const { jobs } = await api('/api/jobs');
        const j = jobs.find((x) => x.id === jobId);
        if (!j) { if (waiters.has(jobId)) { waiters.delete(jobId); return reject(new Error('任务不存在')); } return; }
        if (j.status === 'done') { if (waiters.has(jobId)) { waiters.delete(jobId); return resolve(j.result); } return; }
        if (j.status === 'error') { if (waiters.has(jobId)) { waiters.delete(jobId); return reject(new Error(j.error || '任务失败')); } return; }
      } catch { /* 网络瞬时错误，下一轮继续 */ }
      if (Date.now() - t0 > timeoutMs) {
        if (waiters.has(jobId)) { waiters.delete(jobId); return reject(new Error('等待任务超时（' + Math.round(timeoutMs / 60000) + ' 分钟）')); }
        return;
      }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }).finally(() => setBusy(false)); // 无论成功/失败/超时都恢复按钟，防止卡死
};

// ---------------------------------------------------------------------------
// 全局任务锁（防止运行中误点重复提交）
// ---------------------------------------------------------------------------
const busyButtons = ['#btn-resolve', '#btn-fetch', '#btn-fetch-force', '#btn-run', '#btn-preview', '#btn-label', '#btn-plan', '#btn-compare', '#btn-hi'];
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
// ---------------------------------------------------------------------------
// 性能监测
// ---------------------------------------------------------------------------
function drawPerfChart(canvas, data, { max = 100, color = '#5cb3ff', unit = '%' } = {}) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 560;
  const h = canvas.clientHeight || 130;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = 8;
  const n = data.length;
  if (!n) {
    ctx.fillStyle = 'rgba(148,170,210,0.5)';
    ctx.font = '12px sans-serif';
    ctx.fillText('等待采集数据…', pad, 18);
    return;
  }
  const step = (w - pad * 2) / 59;
  ctx.strokeStyle = 'rgba(148,170,210,0.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + ((h - pad * 2) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  }
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = pad + i * step;
    const y = h - pad - (Math.min(v, max) / max) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  const lastX = pad + (n - 1) * step;
  ctx.lineTo(lastX, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '44');
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.fill();
  const v = data[n - 1];
  ctx.fillStyle = color;
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText(v.toFixed(1) + unit, pad + 2, 16);
}

function renderPerf(s) {
  if (!s || !s.app) return;
  const setTxt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  setTxt('#perf-app-cpu', s.app.cpuPct.toFixed(1) + '%');
  setTxt('#perf-app-mem', s.app.memMB + ' MB');
  setTxt('#perf-app-procs', String(s.treeSize || 0));
  if (s.sys) {
    setTxt('#perf-sys-cpu', s.sys.cpuPct.toFixed(1) + '%');
    setTxt('#perf-sys-mem', s.sys.memPct.toFixed(1) + '% · ' + Math.round(s.sys.memUsedMB / 1024) + '/' + Math.round(s.sys.memTotalMB / 1024) + ' GB');
  }
  if (s.gpu) {
    setTxt('#perf-gpu-util', s.gpu.utilPct.toFixed(0) + '%');
    setTxt('#perf-gpu-mem', s.gpu.memUsedMB + ' / ' + s.gpu.memTotalMB + ' MB');
    setTxt('#perf-gpu-temp', s.gpu.tempC + '°C');
    setTxt('#perf-gpu-power', s.gpu.powerW.toFixed(0) + ' W');
    setTxt('#perf-gpu-name', s.gpu.name || '');
  }
  drawPerfChart($('#perf-cpu-chart'), state.perf.cpu, { max: Math.max(100, ...state.perf.cpu, 1) * 1.1, color: '#5cb3ff', unit: '%' });
  drawPerfChart($('#perf-mem-chart'), state.perf.mem, { max: Math.max(512, ...state.perf.mem, 1) * 1.15, color: '#4ade9a', unit: 'MB' });
  drawPerfChart($('#perf-gpu-chart'), state.perf.gpu, { max: Math.max(100, ...state.perf.gpu, 1) * 1.1, color: '#f472b6', unit: '%' });
  const box = $('#perf-procs');
  if (box) {
    const rows = (s.procs || []).map((p) =>
      '<div class="perf-proc"><span class="mono">' + escapeHtml(p.name) + ' <i>' + p.pid + '</i></span><span>' + p.cpuPct.toFixed(1) + '%</span><span>' + p.memMB + ' MB</span></div>').join('');
    box.innerHTML = '<div class="perf-proc head"><span>进程</span><span>CPU</span><span>内存</span></div>' + rows +
      (s.treeSize ? '<div class="perf-proc muted"><span>合计 ' + s.treeSize + ' 个进程（含渲染 Chrome）</span></div>' : '');
  }
}

async function refreshPerf() {
  try {
    const r = await api('/api/perf');
    const s = r && r.sample;
    const chip = $('#chip-perf');
    if (!s || !s.app) {
      if (chip) chip.textContent = '性能 采集中…';
      return;
    }
    if (chip) chip.textContent = '⚡ CPU ' + s.app.cpuPct.toFixed(0) + '% · ' + s.app.memMB + 'MB';
    state.perf.cpu.push(s.app.cpuPct);
    state.perf.mem.push(s.app.memMB);
    if (s.gpu) state.perf.gpu.push(s.gpu.utilPct);
    if (state.perf.cpu.length > 60) { state.perf.cpu.shift(); state.perf.mem.shift(); state.perf.gpu.shift(); }
    if (!$('#perf-overlay').hidden) renderPerf(s);
  } catch { /* 忽略 */ }
}

$('#chip-perf')?.addEventListener('click', () => {
  $('#perf-overlay').hidden = false;
  refreshPerf();
});
$('#btn-perf-close')?.addEventListener('click', () => { $('#perf-overlay').hidden = true; });
$('#perf-overlay')?.addEventListener('click', (e) => { if (e.target === $('#perf-overlay')) $('#perf-overlay').hidden = true; });

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
    $('#cfg-vkey').value = '';
    $('#cfg-vkey').placeholder = cfg.hasVisionKey ? `已保存：${cfg.visionKeyMasked}（输入新 Key 可覆盖）` : 'sk-...（在 bailian.console.aliyun.com 创建）';
    $('#cfg-vmodel').value = cfg.visionModel;
    $('#cfg-vbaseurl').value = cfg.visionBaseURL;
    $('#cfg-vcurrent').textContent = cfg.hasVisionKey ? `已配置（${cfg.visionKeyMasked}）` : '未配置（使用离线规则标注）';
    $('#cfg-vstatus').textContent = '';
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
  } catch (err) { st.textContent = '✗' + err.message; }
});
$('#btn-cfg-save').addEventListener('click', async () => {
  const st = $('#cfg-status');
  st.textContent = '保存中…';
  try {
    await api('/api/config', { apiKey: $('#cfg-key').value, model: $('#cfg-model').value, baseURL: $('#cfg-baseurl').value });
    st.textContent = '✅ 已保存（设置立即生效）';
    $('#cfg-current').textContent = $('#cfg-key').value.trim() ? '已配置（新 Key）' : '未配置（使用离线编排）';
    refreshState();
  } catch (err) { st.textContent = '✗' + err.message; }
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
  } catch (err) { st.textContent = '✗' + err.message; }
});
$('#chip-key').addEventListener('click', openSettings);
$('#chip-vision').addEventListener('click', openSettings);
$('#cfg-vkey-toggle').addEventListener('click', () => {
  const el = $('#cfg-vkey');
  el.type = el.type === 'password' ? 'text' : 'password';
  el.nextElementSibling.textContent = el.type === 'password' ? '显示' : '隐藏';
});
$('#btn-cfg-vtest').addEventListener('click', async () => {
  const st = $('#cfg-vstatus');
  st.textContent = '测试中…';
  try {
    await api('/api/config', { visionKey: $('#cfg-vkey').value || undefined, visionModel: $('#cfg-vmodel').value, visionBaseURL: $('#cfg-vbaseurl').value });
    const r = await api('/api/vision/test', {});
    st.textContent = (r.ok ? '✅ ' : '✗ ') + (r.error || r.message || '未知结果');
  } catch (err) { st.textContent = '✗' + err.message; }
});
$('#btn-cfg-vsave').addEventListener('click', async () => {
  const st = $('#cfg-vstatus');
  st.textContent = '保存中…';
  try {
    await api('/api/config', { visionKey: $('#cfg-vkey').value, visionModel: $('#cfg-vmodel').value, visionBaseURL: $('#cfg-vbaseurl').value });
    st.textContent = '✅ 已保存（设置立即生效）';
    refreshState();
  } catch (err) { st.textContent = '✗' + err.message; }
});
$('#btn-cfg-vclear').addEventListener('click', async () => {
  if (!confirm('确定清除已保存的千问视觉 Key 吗？')) return;
  const st = $('#cfg-vstatus');
  try {
    await api('/api/config', { visionKey: '', visionModel: $('#cfg-vmodel').value, visionBaseURL: $('#cfg-vbaseurl').value });
    st.textContent = '✅ 已清除';
    $('#cfg-vkey').value = '';
    $('#cfg-vkey').placeholder = 'sk-...';
    refreshState();
  } catch (err) { st.textContent = '✗' + err.message; }
});

// ---------------------------------------------------------------------------
// 状态栏 / 通用刷新
// ---------------------------------------------------------------------------
async function refreshState() {
  try {
    const s = await api('/api/state');
    state.models = s.models || [];
    state.outputs = s.outputs || [];
    state.outDir = s.outDir || '';
    state.assetsDir = s.assetsDir || '';
    renderModels();
    renderDirFilters();
    renderHiWorkList();
    updateModelCount();
    renderOutputs();
    const c = $('#chip-chrome');
    if (s.chrome) { c.textContent = 'Chrome ✓'; c.className = 'chip ok'; }
    else { c.textContent = 'Chrome ✗'; c.className = 'chip bad'; }
    const f = $('#chip-ffmpeg');
    if (s.ffmpeg) { f.textContent = 'FFmpeg ✓'; f.className = 'chip ok'; }
    else { f.textContent = 'FFmpeg 按需下载'; f.className = 'chip'; }
    const k = $('#chip-key');
    if (s.deepseekKey) { k.textContent = 'DeepSeek Key ✓'; k.className = 'chip ok'; }
    else { k.textContent = 'DeepSeek 离线模式'; k.className = 'chip'; }
    state.vision = { key: !!s.visionKey, model: s.visionModel || 'qwen-vl-max', baseURL: s.visionBaseURL || '' };
    const v = $('#chip-vision');
    if (state.vision.key) { v.textContent = '千问视觉 ✓'; v.className = 'chip ok'; }
    else { v.textContent = '千问视觉 未配置'; v.className = 'chip'; }
  } catch (err) {
    $('#chip-srv').textContent = '服务 异常';
    $('#chip-srv').className = 'chip bad';
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Tab 切换 + 全局流程条
// ---------------------------------------------------------------------------
function showTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  const flowMap = { models: 1, hi: 2, timeline: 3, generate: 4, jobs: 4 };
  const cur = flowMap[name] || 1;
  $$('#flow-bar .flow-step').forEach((el) => {
    const n = parseInt(el.dataset.flow === 'jobs' ? '4' : (flowMap[el.dataset.flow] || 1), 10);
    el.classList.toggle('active', n === cur);
    el.classList.toggle('done', n < cur);
  });
}
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    showTab(btn.dataset.tab);
    if (btn.dataset.tab === 'jobs') refreshJobs();
  });
});
$$('#flow-bar .flow-step').forEach((el) => {
  el.addEventListener('click', () => {
    const tab = el.dataset.flow;
    showTab(tab);
    if (tab === 'jobs') refreshJobs();
  });
});

// ---------------------------------------------------------------------------
// 资源状态（高清化后的三件套 / 原图）
// ---------------------------------------------------------------------------
function currentAssets() {
  const m = state.current;
  if (!m) return null;
  const set = state.assetSets && state.assetSets[m.id] ? state.assetSets[m.id] : (state.assetSet && state.assetSet.modelId === m.id ? state.assetSet : null);
  if (set) {
    return { skel: set.skel, atlas: set.atlas, png: set.png, label: set.label, isHi: true };
  }
  return { skel: m.files?.skel, atlas: m.files?.atlas, png: m.files?.png, label: '原图', isHi: false };
}
function setAssetSet(modelId, set) {
  if (!modelId) return;
  if (set) state.assetSets = { ...(state.assetSets || {}), [modelId]: set };
  else {
    const next = { ...(state.assetSets || {}) };
    delete next[modelId];
    state.assetSets = next;
  }
  if (state.current && state.current.id === modelId) {
    state.assetSet = set ? { modelId, ...set } : null;
  }
  // 资源变化 → 预览与旧时间轴可能不匹配，提示重新生成
  state.previews = null;
  $('#pv-grid').innerHTML = '';
  $('#pv-info').textContent = Object.keys(state.assetSets || {}).length ? '资源已切换，请重新生成动作预览' : '';
  updateAssetViews();
}
function updateAssetViews() {
  const assets = currentAssets();
  const label = assets ? assets.label : '原图';
  const txt = (el, s) => { const e = $(el); if (e) e.textContent = s; };
  txt('#gen-res', '资源：' + label + (state.current ? ' · ' + state.current.name : ''));
  txt('#tl-res', '生成资源：' + label + '（动作预览固定用原始资源，更快）');
  txt('#hi-res-state', '资源：' + label);
  txt('#hi-use-info', '');
  const useBtn = $('#btn-hi-use');
  if (useBtn) useBtn.hidden = true;
  // 超分控件：已用 ② 高清资源时自动禁用（避免重复高清化）
  const hi = !!assets.isHi;
  for (const id of ['#g-upscale', '#g-sr', '#g-sr-engine']) {
    const el = $(id);
    if (!el) continue;
    el.disabled = hi;
    const lab = el.closest('label');
    if (lab) lab.classList.toggle('dim', hi);
  }
  const hint = $('#gen-upscale-hint');
  if (hint) {
    hint.textContent = hi
      ? '当前使用 ② 高清化资源（' + label + '），生成时不会再次放大；如需其他倍率请回到 ② 高清化重新选择。'
      : '当前使用原图：若开启上方「放大 / AI 超分」，将在生成前自动放大再渲染（会更耗时）。';
  }
  updateGenTlState();
}
function updateGenTlState() {
  const q = state.queue;
  const el = $('#gen-tl-state');
  if (!el) return;
  if (q && q.length) {
    const total = q.reduce((s, x) => s + (parseFloat(x.duration) || 0) * (parseInt(x.repeat, 10) || 1), 0);
    el.innerHTML = '时间轴：<b>' + q.length + ' 段 · ' + total.toFixed(2) + 's</b>（可回到「编排时间轴」继续修改）';
  } else {
    el.innerHTML = '时间轴：未编排 · <button class="ghost" id="btn-goto-tl" type="button">去「编排时间轴」</button>';
    const b = $('#btn-goto-tl');
    if (b) b.addEventListener('click', () => showTab('timeline'));
  }
}

// ---------------------------------------------------------------------------
// 模型资源：解析 / 拉取 / 列表
// ---------------------------------------------------------------------------
$('#btn-goto-models').addEventListener('click', () => { showTab('models'); $('#f-name').focus(); });
$('#btn-goto-tl-fast').addEventListener('click', () => showTab('timeline'));
$('#btn-hi-goto-models').addEventListener('click', () => showTab('models'));
$('#btn-tl-goto-models').addEventListener('click', () => showTab('models'));
$('#btn-goto-tl').addEventListener('click', () => showTab('timeline'));
$('#btn-hi-goto-tl').addEventListener('click', () => showTab('timeline'));
$('#btn-goto-hi').addEventListener('click', () => showTab('hi'));

$('#btn-resolve').addEventListener('click', async () => {
  const query = $('#f-name').value.trim() || $('#f-key').value.trim();
  if (!query) { $('#resolve-out').textContent = '❌ 请输入名称或模型 ID'; return; }
  const btn = $('#btn-resolve');
  btn.disabled = true;
  $('#resolve-out').textContent = '⏳ 解析中…';
  try {
    const { jobId } = await api('/api/resolve', { query, enemy: document.querySelector('input[name=kind]:checked').value === 'enemy' });
    const result = await waitJob(jobId);
    state.resolve = result;
    $('#resolve-out').innerHTML = '✅ ' + (result.kind === 'enemy' ? '敌人' : '角色') + '：<b>' + escapeHtml(result.name) + '</b>（' + escapeHtml(result.charId) + '） · ' + result.skins.length + ' 套皮肤';
    $('#skin-row').hidden = !result.skins.length;
    fillSkins(result.skins);
    $('#fetch-done').hidden = true;
  } catch (err) {
    $('#resolve-out').textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

function autoFillView(skin) {
  const views = Object.keys(skin.views || {});
  if (!views.length) return;
  const prefer = ['基建', 'battle', '正面', 'front', 'build'];
  const hit = prefer.find((p) => views.includes(p)) || views[0];
  $('#f-view').value = hit;
}

function fillSkins(skins) {
  const sel = $('#f-skin');
  sel.innerHTML = '';
  for (const s of skins) {
    sel.add(new Option(s.skin, s.skin));
  }
  autoFillView(skins[0] || { views: {} });
  fillViews(sel.value);
}

function fillViews(skinName) {
  const s = (state.resolve?.skins || []).find((x) => x.skin === skinName);
  const sel = $('#f-view');
  sel.innerHTML = '';
  for (const v of s?.views || []) sel.add(new Option(v.view, v.view));
  if (!sel.options.length) sel.add(new Option('默认', ''));
}

$('#f-skin').addEventListener('change', () => fillViews($('#f-skin').value));

async function fetchModel(force) {
  const r = state.resolve;
  if (!r) return;
  const btn = $('#btn-fetch');
  btn.disabled = true;
  btn.textContent = force ? '强制重下中…' : '拉取中…';
  try {
    const allViews = $('#f-allviews') ? $('#f-allviews').checked : false;
    const { jobId } = await api('/api/fetch', {
      character: r.kind === 'char' ? r.charId : undefined,
      enemy: r.kind === 'enemy' ? r.charId : undefined,
      key: r.charId,
      skin: $('#f-skin').value,
      view: $('#f-view').value,
      allViews,
      force,
    });
    const result = await waitJob(jobId);
    await refreshState();
    state.fetchViews = Array.isArray(result.views) ? result.views : null;
    const skelBase = String(result.files?.skel || '').split(/[\\/]/).pop().replace(/\.skel$/, '');
    const m = state.models.find((x) => x.id === result.charId + '|' + skelBase) || state.models.find((x) => x.groupId === result.charId);
    selectModel(m || { id: result.charId + '|' + skelBase, groupId: result.charId, name: result.characterName, displayName: result.characterName, skinLabel: result.skin || '默认', viewLabel: result.view || '', base: skelBase, kind: result.kind, source: result.kind === 'enemy' ? 'prts-enemy' : 'prts', dir: result.dir, animations: result.animations, files: result.files });
    $('#fetch-done').hidden = false;
    $('#resolve-out').textContent = '✅ ' + (result.allViews ? '已下载 ' + (state.fetchViews?.length || 0) + ' 个视图（战斗 / 基建 / 正面 / 背面），可在预览与时间轴中拼贴动作' : '三件套就绪：' + (result.files?.skel || ''));
  } catch (err) {
    alert('拉取失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取三件套';
  }
}
$('#btn-fetch').addEventListener('click', () => fetchModel(false));
$('#btn-fetch-force').addEventListener('click', () => fetchModel(true));

function modelKindTag(m) {
  if (m.kind === 'enemy') return '敌人';
  if (m.kind === 'build') return '基建';
  return m.source === 'prts' ? 'PRTS' : '本地';
}
function modelEntryLabel(m) {
  let label = m.skinLabel || '';
  if (m.viewLabel) label = label ? label + ' / ' + m.viewLabel : m.viewLabel;
  return label || '默认';
}
function animStat(m) {
  const list = m.animations || [];
  const total = list.reduce((s, a) => s + (parseFloat(a.duration) || 0), 0);
  return list.length ? list.length + ' 个动作 · ' + total.toFixed(1) + 's' : '无动画信息';
}
function rarityStars(r) {
  const raw = parseInt(r, 10) || 0;
  if (raw < 1 || raw > 5) return '';
  const n = raw + 1;
  return '<span class="stars" title="' + n + '星">' + '★'.repeat(n) + '☆'.repeat(6 - n) + '</span>';
}
// art 路径转 /assets/ URL
function artUrl(m, key) {
  const file = m.art && m.art[key];
  if (!file || !m.groupId) return '';
  return '/assets/' + encodeURIComponent(m.groupId) + '/art/' + encodeURIComponent(file);
}
function modelAvatar(m) {
  return artUrl(m, 'avatar') ||
    (m.art && m.art.elite && m.art.elite.length ? artUrl(m, 'elite' + m.art.elite.length) : '') ||
    artUrl(m, 'portrait');
}
// 分组过滤（类型/职业/稀有度/阵营/搜索）
function groupModels(filter) {
  const groups = new Map();
  const f = state.modelFilter || {};
  const kw = String(filter || '').trim().toLowerCase();
  for (const m of state.models) {
    if (f.kind && f.kind !== 'all') {
      const mk = m.kind === 'enemy' ? 'enemy' : m.kind === 'build' ? 'build' : 'char';
      if (mk !== f.kind) continue;
    }
    if (f.class && m.class !== f.class) continue;
    if (f.rarity && String(m.rarity || '') !== f.rarity) continue;
    if (f.faction && m.faction !== f.faction) continue;
    const hay = [m.name, m.displayName, m.groupId, m.id, m.skinLabel, m.viewLabel, m.base, m.kind, m.class, m.branch, m.faction, m.enemyLevel].join(' ').toLowerCase();
    if (kw && !hay.includes(kw)) continue;
    if (!groups.has(m.groupId)) groups.set(m.groupId, []);
    groups.get(m.groupId).push(m);
  }
  return groups;
}
function kindOf(m) {
  return m.kind === 'enemy' ? 'enemy' : m.kind === 'build' ? 'build' : 'char';
}
function viewNameOf(m) {
  return m.viewLabel || m.base || m.id;
}
// 工作集：用户勾选的模型；未勾选时回退到当前模型同皮肤视图
function workingModels() {
  if (state.selection && state.selection.length) {
    return state.selection.map((id) => state.models.find((x) => x.id === id)).filter(Boolean);
  }
  const m = state.current;
  if (!m) return [];
  const skin = m.skinLabel || '默认';
  return state.models.filter((x) => x.groupId === m.groupId && (x.skinLabel || '默认') === skin);
}
function workingViews() {
  const seen = new Set();
  const out = [];
  for (const m of workingModels()) {
    if (!m.files || !m.files.skel || !m.files.atlas || !m.files.png) continue;
    let name = viewNameOf(m);
    if (seen.has(name)) name = name + ' · ' + m.base;
    seen.add(name);
    out.push({ view: name, files: m.files, animations: m.animations || [] });
  }
  return out;
}
function workingCount() {
  return workingModels().length;
}
function renderDirFilters() {
  const kinds = [
    { key: 'all', label: '全部' },
    { key: 'char', label: '干员' },
    { key: 'enemy', label: '敌人' },
    { key: 'build', label: '基建' },
  ];
  const box = $('#dir-kind');
  if (box) {
    box.innerHTML = '';
    for (const k of kinds) {
      const n = state.models.filter((m) => kindOf(m) === k.key || k.key === 'all').length;
      const chip = document.createElement('span');
      chip.className = 'filter-chip' + (state.modelFilter.kind === k.key ? ' sel' : '');
      chip.textContent = k.label + ' ' + n;
      chip.addEventListener('click', () => { state.modelFilter.kind = k.key; renderModels(); renderDirFilters(); });
      box.appendChild(chip);
    }
  }
  const opts = (sel, items, allLabel) => {
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">' + allLabel + '</option>';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.key;
      o.textContent = it.label;
      sel.appendChild(o);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  };
  const cls = new Map();
  const fac = new Map();
  const rar = new Map();
  for (const m of state.models) {
    if (m.class) cls.set(m.class, (cls.get(m.class) || 0) + 1);
    if (m.faction) fac.set(m.faction, (fac.get(m.faction) || 0) + 1);
    if (m.rarity) rar.set(String(m.rarity), (rar.get(String(m.rarity)) || 0) + 1);
  }
  opts($('#f-class'), [...cls.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, label: k + ' (' + n + ')' })), '职业全部');
  opts($('#f-rarity'), [...rar.entries()].sort((a, b) => b[0] - a[0]).map(([k, n]) => ({ key: k, label: (parseInt(k, 10) > 0 ? '★'.repeat(parseInt(k, 10) + 1) : '无') + ' (' + n + ')' })), '稀有度全部');
  opts($('#f-faction'), [...fac.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, label: k + ' (' + n + ')' })), '阵营全部');
}
function bindFilterSelects() {
  for (const [id, key] of [['#f-class', 'class'], ['#f-rarity', 'rarity'], ['#f-faction', 'faction']]) {
    const el = $(id);
    if (!el) continue;
    el.onchange = () => { state.modelFilter[key] = el.value; renderModels(); };
  }
}
function renderModels() {
  const box = $('#model-list');
  if (!state.models.length) {
    box.innerHTML = '<div class="empty-guide"><div>暂无本地模型，二选一即可开始：</div><ol>' +
      '<li><b>用内置示例</b>：阿米娅已自带（assets/amiya），点下方列表后从第 ② 步继续。</li>' +
      '<li><b>从 PRTS 拉取</b>：在上方输入名称（如 阿米娅 / 霜星 / 弑君者）→「解析」→ 选皮肤/视图 →「拉取三件套」。</li>' +
      '</ol></div>';
    return;
  }
  const groups = groupModels($('#model-search')?.value);
  box.innerHTML = '';
  if (!groups.size) {
    box.innerHTML = '<div class="muted">没有匹配的模型，调整筛选条件或换个关键词试试。</div>';
    return;
  }
  // 第一层：类别（干员/敌人/其他）；第二层：职业；第三层：角色卡片（皮肤/视图）
  const kindOrder = ['char', 'enemy', 'build'];
  const kindLabel = { char: '干员', enemy: '敌人', build: '基建' };
  for (const kind of kindOrder) {
    const kindGroups = [...groups.entries()].filter(([, es]) => kindOf(es[0]) === kind);
    if (!kindGroups.length) continue;
    const sec = document.createElement('div');
    sec.className = 'dir-section';
    sec.innerHTML = '<div class="dir-sec-title"><b>' + kindLabel[kind] + '</b><span class="muted">' + kindGroups.length + ' 位</span></div>';
    // 职业分组
    const classGroups = new Map();
    for (const [gid, es] of kindGroups) {
      const c = es[0].class || (kind === 'enemy' ? es[0].enemyLevel || '敌人' : '未分类');
      if (!classGroups.has(c)) classGroups.set(c, []);
      classGroups.get(c).push([gid, es]);
    }
    const classOrder = [...classGroups.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [cls, cgs] of classOrder) {
      const csec = document.createElement('div');
      csec.className = 'dir-subsec';
      csec.innerHTML = '<div class="dir-sub-title"><span class="cls-dot"></span><b>' + escapeHtml(cls) + '</b><span class="muted">' + cgs.length + '人</span></div>';
      const grid = document.createElement('div');
      grid.className = 'model-grid';
      for (const [gid, entries] of cgs) {
        const first = entries[0];
        const card = document.createElement('div');
        card.className = 'model-card';
        const selEntry = entries.find((e) => state.current?.id === e.id);
        if (selEntry) card.classList.add('sel');
        const avatar = modelAvatar(first);
        const head = document.createElement('div');
        head.className = 'mh';
        head.innerHTML =
          (avatar ? '<img class="m-avatar" src="' + avatar + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
          '<div class="mh-main"><div class="name">' + escapeHtml(first.name) +
          (first.kind === 'enemy' ? '<span class="tag enemy">' + escapeHtml(first.enemyLevel || '敌人') + '</span>' : '<span class="tag">' + escapeHtml(first.class || modelKindTag(first)) + '</span>') +
          rarityStars(first.rarity) + '</div>' +
          '<div class="id">' + escapeHtml(gid) + ' · ' + entries.length + ' 个皮肤/视图</div>' +
          (first.branch || first.faction || first.position ? '<div class="meta">' +
            (first.branch ? '<span class="chip-sm">' + escapeHtml(first.branch) + '</span>' : '') +
            (first.faction ? '<span class="chip-sm fac">' + escapeHtml(first.faction) + '</span>' : '') +
            (first.position ? '<span class="chip-sm">' + escapeHtml(first.position) + '</span>' : '') +
            '</div>' : '') +
          '</div>';
        card.appendChild(head);
        // 皮肤 → 视图 两级目录
        const skinOrder = [];
        const bySkin = new Map();
        for (const e of entries) {
          const sk = e.skinLabel || '默认';
          if (!bySkin.has(sk)) { bySkin.set(sk, []); skinOrder.push(sk); }
          bySkin.get(sk).push(e);
        }
        const skins = document.createElement('div');
        skins.className = 'm-skins';
        for (const sk of skinOrder) {
          const sec2 = document.createElement('div');
          sec2.className = 'm-skin' + (selEntry && selEntry.skinLabel === sk ? ' open' : '');
          const skinFile = first.art && first.art.skins && first.art.skins[sk];
          sec2.innerHTML = '<div class="m-skin-name">' +
            (skinFile ? '<img class="skin-thumb" src="/assets/' + encodeURIComponent(first.groupId) + '/art/' + encodeURIComponent(skinFile) + '" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
            escapeHtml(sk) + '<span class="muted">' + bySkin.get(sk).length + ' 个视图</span></div>';
          const rows = document.createElement('div');
          rows.className = 'm-views';
          for (const e of bySkin.get(sk)) {
            const row = document.createElement('div');
            const inSel = (state.selection || []).includes(e.id);
            row.className = 'm-view' + (state.current?.id === e.id ? ' sel' : '') + (inSel ? ' selw' : '');
            row.innerHTML = '<label class="m-sel" title="勾选加入工作集（可多套拼贴）"><input type="checkbox" class="sel-chk" ' + (inSel ? 'checked' : '') + '></label>' +
              '<div class="m-view-main"><b>' + escapeHtml(modelEntryLabel(e)) + '</b><span class="muted">' + escapeHtml(e.base) + '</span></div>' +
              '<div class="m-view-stat">' + escapeHtml(animStat(e)) + (e.viewLabel ? '<span class="tag mini">' + escapeHtml(e.viewLabel) + '</span>' : '') + '</div>';
            row.title = '点击行 = 单选；勾选 = 加入工作集';
            row.querySelector('.sel-chk').addEventListener('click', (ev) => { ev.stopPropagation(); });
            row.querySelector('.sel-chk').addEventListener('change', (ev) => {
              if (ev.target.checked) {
                if (!(state.selection || []).includes(e.id)) { state.selection = [...(state.selection || []), e.id]; }
                selectModel(e);
              } else {
                state.selection = (state.selection || []).filter((id) => id !== e.id);
                renderModels();
                updateWorkSetUI();
              }
            });
            row.addEventListener('click', (ev) => { ev.stopPropagation(); selectModel(e); });
            rows.appendChild(row);
          }
          sec2.appendChild(rows);
          skins.appendChild(sec2);
        }
        card.appendChild(skins);
        grid.appendChild(card);
      }
      csec.appendChild(grid);
      sec.appendChild(csec);
    }
    box.appendChild(sec);
  }
}


function updateWorkSetUI() {
  const bar = $('#work-set-bar');
  const list = $('#work-set-list');
  const sel = state.selection || [];
  if (bar) {
    bar.hidden = !sel.length;
    if (list) {
      const names = sel.map((id) => {
        const m = state.models.find((x) => x.id === id);
        return m ? (m.name || '') + ' · ' + (m.viewLabel || m.base || '') : id;
      });
      list.textContent = names.join(' / ');
    }
  }
  const btn = $('#btn-hi');
  const n = workingCount();
  if (btn) btn.textContent = n > 1 ? '开始高清化（工作集 ' + n + ' 套）' : '开始高清化';
  renderHiWorkList();
}
function selectModel(m) {
  if (!m) return;
  // 单选：点击行时清空工作集勾选（checkbox 独立控制）
  if (!state.selection?.includes(m.id)) state.selection = [];
  if (state.current?.id !== m.id) {
    // 切换模型：清空高清化资源、预览与时间轴，避免串模型
    const hadPrev = !!state.previews;
    state.assetSet = null;
    state.previews = null;
    state.pvDesc = {};
    state.queue = [];
    state.lastTimeline = null;
    $('#pv-grid').innerHTML = '';
    $('#pv-info').textContent = hadPrev ? '已切换模型，动作预览已重置，请重新生成' : '';
    $('#tl-queue-bar').innerHTML = '';
    $('#tl-queue').innerHTML = '';
    $('#tl-queue-info').textContent = '';
    $('#fetch-done').hidden = true;
  }
  state.current = m;
  renderModels();
  renderHiWorkList();
  updateWorkSetUI();
  const fullName = m.name + ' · ' + modelEntryLabel(m);
  const label = currentAssets()?.label || '原图';
  const wsN = workingCount();
  const wsTag = wsN > 1 ? '<span class="tag mini" style="margin-left:6px">工作集 ' + wsN + ' 套视图</span>' : '';
  $('#gen-model').innerHTML = '<b>' + escapeHtml(fullName) + '</b>（' + escapeHtml(m.groupId || m.id) + '）' + wsTag;
  $('#gen-res').textContent = '资源：' + label;
  $('#tl-model').innerHTML = '<b>' + escapeHtml(fullName) + '</b>（' + escapeHtml(m.groupId || m.id) + '）' + wsTag;
  $('#tl-res').textContent = '生成资源：' + label + '（动作预览固定用原始资源，更快）';
  $('#hi-model-state').innerHTML = '<b>' + escapeHtml(fullName) + '</b>（' + escapeHtml(m.groupId || m.id) + '）';
  $('#hi-res-state').textContent = '资源：' + label;
  const anims = $('#gen-anims');
  anims.innerHTML = (m.animations || []).map((a) => '<span class="chip-anim">' + escapeHtml(a.name) + ' ' + a.duration.toFixed(2) + 's</span>').join('') || '';
  localStorage.setItem('zd.current', JSON.stringify({ id: m.id, name: m.name, groupId: m.groupId }));
  updateAssetViews();
  updateGenTlState();
}

// 高清化页的模型选择器：按角色分组（角色 → 皮肤/视图）
function updateModelCount() {
  const el = $('#model-count');
  if (!el) return;
  const n = groupModels($('#model-search')?.value).size;
  el.textContent = n ? '共 ' + n + ' 个角色' : '';
}
$('#model-search')?.addEventListener('input', () => { renderModels(); updateModelCount(); });
$('#btn-work-clear')?.addEventListener('click', () => {
  state.selection = [];
  renderModels();
  updateWorkSetUI();
});

function hiCompareTarget() {
  if (state.hiCompareId) {
    const m = state.models.find((x) => x.id === state.hiCompareId);
    if (m) return m;
  }
  return workingModels()[0] || state.current;
}
function renderHiWorkList() {
  const box = $('#hi-worklist');
  if (!box) return;
  const ws = workingModels();
  if (!ws.length) {
    box.innerHTML = '<div class="muted" style="padding:8px 2px">尚未选择模型，请先回到「① 拉取模型」勾选工作集（可多套）</div>';
    return;
  }
  const rows = ws.map((m) => {
    const set = state.assetSets && state.assetSets[m.id];
    const sel = state.hiCompareId ? state.hiCompareId === m.id : m.id === (ws[0]?.id || '');
    return '<div class="hi-wl-row' + (sel ? ' sel' : '') + '" data-id="' + escapeHtml(m.id) + '">' +
      '<b>' + escapeHtml(m.name) + '</b>' +
      '<span class="muted">' + escapeHtml(m.viewLabel || m.base || '') + '</span>' +
      '<span class="tag' + (set ? ' ok' : '') + '">' + (set ? escapeHtml(set.label || '已高清化') : '原图') + '</span>' +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="hi-wl-head"><b>📌 工作集（' + ws.length + ' 套）</b><span class="muted">点击行设为对比目标</span></div>' + rows;
  box.querySelectorAll('.hi-wl-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.hiCompareId = row.dataset.id;
      renderHiWorkList();
      $('#cmp-info').textContent = '对比目标：' + escapeHtml((state.models.find((x) => x.id === state.hiCompareId) || {}).name || '');
    });
  });
}

$('#btn-enrich')?.addEventListener('click', async () => {
  const btn = $('#btn-enrich');
  const info = $('#enrich-info');
  if (!btn || !info) return;
  btn.disabled = true;
  info.textContent = '⏳ 正在批量补全资料与美术（需访问 PRTS，请稍候）…';
  try {
    const r = await api('/api/enrich', {});
    const result = await waitJob(r.jobId);
    info.textContent = '✅ ' + (result.message || '补全完成') + '（' + (result.done || 0) + '/' + (result.total || 0) + ' 个目录）';
    await refreshState();
  } catch (err) {
    info.textContent = '❌ 补全失败：' + (err && err.message ? err.message : err);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-refresh').addEventListener('click', refreshState);
$('#btn-refresh-out').addEventListener('click', refreshState);

// ---------------------------------------------------------------------------
// ③ 编排时间轴：动作预览
// ---------------------------------------------------------------------------
$('#btn-preview').addEventListener('click', async () => {
  const m = state.current;
  if (!m) { $('#pv-info').textContent = '❌ 请先选择模型'; showTab('models'); return; }
  // 预览固定使用原始三件套（assets/），速度快；高清化资源仅用于最终生成
  const assets = { skel: m.files?.skel, atlas: m.files?.atlas, png: m.files?.png };
  if (!assets || !assets.skel || !assets.atlas || !assets.png) {
    $('#pv-info').textContent = '❌ 模型三件套不完整，请先拉取模型';
    return;
  }
  const btn = $('#btn-preview');
  btn.disabled = true;
  const mode = document.querySelector('input[name=pv-mode]:checked')?.value || 'anim';
  $('#pv-info').textContent = '⏳ 正在' + (mode === 'anim' ? '渲染完整动画预览' : '截取单帧快照') + '（' + (m.animations || []).length + ' 个动作，使用原始资源）…';
  try {
    const mv = workingViews();
    const pvBody = mv.length > 1
      ? { views: mv.map((v) => ({ view: v.view, skel: v.files.skel, atlas: v.files.atlas, png: v.files.png })), outName: m.name, mode, modelId: m.id }
      : { skel: assets.skel, atlas: assets.atlas, png: assets.png, view: mv[0]?.view || '', outName: m.name, mode, modelId: m.id };
    const { jobId } = await api('/api/previews', pvBody);
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    state.previews = result.files;
    // 本地动作字典（若有）预填标注
    if (result.labels && typeof result.labels === 'object') {
      for (const [name, info] of Object.entries(result.labels)) {
        if (!info || typeof info !== 'object') continue;
        if (!state.pvDesc[name] && info.human_label) {
          state.pvDesc[name] = String(info.human_label) + (Array.isArray(info.tags) && info.tags.length ? '（' + info.tags.join('/') + '）' : '');
        }
      }
    }
    $('#pv-info').textContent = '✅ 预览就绪：共 ' + result.files.length + ' 个动作 · 卡片上可填「动作含义」并点「＋」加入时间轴';
    renderPvGrid();
  } catch (err) {
    $('#pv-info').textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#btn-label').addEventListener('click', async () => {
  const m = state.current;
  if (!m) { $('#pv-info').textContent = '❌ 请先选择模型'; showTab('models'); return; }
  const assets = { skel: m.files?.skel, atlas: m.files?.atlas, png: m.files?.png };
  if (!assets || !assets.skel || !assets.atlas || !assets.png) {
    $('#pv-info').textContent = '❌ 模型三件套不完整，请先拉取模型';
    return;
  }
  const btn = $('#btn-label');
  btn.disabled = true;
  $('#pv-info').textContent = '⏳ 正在识别动作含义（渲染关键帧 + ' + (state.vision?.key ? '千问视觉看图打标' : '离线规则猜测') + '）…';
  try {
        const mode = document.querySelector('input[name=pv-mode]:checked')?.value || 'anim';
    const { jobId } = await api('/api/label', { skel: assets.skel, atlas: assets.atlas, png: assets.png, outName: m.name, modelId: m.id, characterName: m.name, mode });
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    if (result.files && result.files.length) state.previews = result.files;
    const labels = result.labels || {};
    for (const [name, info] of Object.entries(labels)) {
      if (!info || typeof info !== 'object') continue;
      const tagText = Array.isArray(info.tags) && info.tags.length ? '（' + info.tags.join('/') + '）' : '';
      state.pvDesc[name] = String(info.human_label || '') + tagText;
    }
    $('#pv-info').textContent = '✅ 标注完成（' + (result.mode === 'vision' ? '千问视觉 + 离线规则' : '离线规则') + '），可继续在卡片上微调；已保存到本地动作字典' + (result.dictFile ? '：' + result.dictFile : '') + '。以后 DeepSeek 编排就能看懂这些动作了';
    renderPvGrid();
  } catch (err) {
    $('#pv-info').textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

function renderPvGrid() {
  const box = $('#pv-grid');
  const files = state.previews || [];
  if (!files.length) { box.innerHTML = '<div class="muted">还没有预览，点上方「生成动作预览」。</div>'; return; }
  box.innerHTML = '';
  const inQueue = new Map();
  for (const s of state.queue) {
    const k = s.action + '\u0000' + (s.view || '');
    inQueue.set(k, (inQueue.get(k) || 0) + 1);
  }
  const groups = new Map();
  for (const p of files) {
    const v = p.view || '';
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(p);
  }
  for (const [view, list] of groups) {
    // 每个分类独立包裹：标题独占一行，卡片放进自己的 Grid，避免混排错位
    const wrap = document.createElement('div');
    wrap.className = 'pv-group';
    if (groups.size > 1) {
      const head = document.createElement('div');
      head.className = 'pv-group-head';
      head.innerHTML = '<b>' + escapeHtml(view || 'default') + '</b><span class="muted">' + list.length + ' 个动作</span>';
      wrap.appendChild(head);
    }
    const grid = document.createElement('div');
    grid.className = 'pv-grid';
    for (const p of list) {
      const card = document.createElement('div');
      const cnt = inQueue.get(p.name + '\u0000' + (p.view || '')) || 0;
      card.className = 'pv-card' + (cnt > 0 ? ' used' : '');
      const desc = state.pvDesc[p.name] || '';
      const isGif = p.kind === 'gif';
      card.innerHTML =
        '<div class="pv-img">' + (isGif
          ? '<img src="' + p.url + '" alt="' + escapeHtml(p.name) + '" title="完整动画预览（循环播放）">'
          : '<img src="' + p.url + '" loading="lazy" alt="' + escapeHtml(p.name) + '" title="单帧快照">') +
        '</div>' +
        '<div class="pv-name"><b>' + escapeHtml(p.name) + '</b><span class="muted">' + (p.duration > 0 ? p.duration.toFixed(2) + 's' : '瞬发') + (isGif ? ' · GIF' : '') + '</span></div>' +
        (desc ? '<div class="pv-tags" title="' + escapeHtml(desc) + '">' + escapeHtml(desc) + '</div>' : '') +
        '<input class="pv-desc" type="text" placeholder="这个动作代表什么？（可选，可点 🤖 AI 自动标注）" value="' + escapeHtml(desc) + '">' +
        '<button class="primary pv-add" type="button">' + (cnt > 0 ? '＋ 再加入（已在 ×' + cnt + '）' : '＋ 加入时间轴') + '</button>';
      const descInput = card.querySelector('.pv-desc');
      descInput.addEventListener('input', () => {
        state.pvDesc[p.name] = descInput.value;
        state.queue.forEach((s) => { if (s.action === p.name) s.description = descInput.value; });
        renderQueue();
      });
      card.querySelector('.pv-add').addEventListener('click', () => {
        queueAdd(p.name, p.duration, descInput.value, p.view || '');
        card.classList.add('used');
      });
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    box.appendChild(wrap);
  }
}
function queueAdd(action, duration, description, view) {
  const d2 = duration && duration > 0 ? Math.min(Math.max(duration, 0.5), 10) : 2;
  state.queue.push({ action, view: view || '', loop: d2 >= 2, duration: d2, timeScale: 1, repeat: 1, description: description || '' });
  renderQueue();
  if (typeof renderPvGrid === 'function') renderPvGrid();
}
function queueRemove(i) {
  state.queue.splice(i, 1);
  renderQueue();
  if (typeof renderPvGrid === 'function') renderPvGrid();
}
function queueDup(i) {
  const seg = state.queue[i];
  if (!seg) return;
  state.queue.splice(i + 1, 0, { ...seg });
  renderQueue();
  if (typeof renderPvGrid === 'function') renderPvGrid();
}
function queueMove(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.queue.length) return;
  const [seg] = state.queue.splice(i, 1);
  state.queue.splice(j, 0, seg);
  renderQueue();
  if (typeof renderPvGrid === 'function') renderPvGrid();
}

function renderQueue() {
  const bar = $('#tl-queue-bar');
  const box = $('#tl-queue');
  const q = state.queue;
  const info = $('#tl-queue-info');
  if (!q.length) {
    bar.innerHTML = '<div class="muted" style="padding:10px">空时间轴：勾选下方动作「＋加入」或写自然语言生成。</div>';
    box.innerHTML = '';
    info.textContent = '';
    updateGenTlState();
    return;
  }
  const total = q.reduce((s, x) => s + (parseFloat(x.duration) || 0) * (parseInt(x.repeat, 10) || 1), 0);
  const colors = ['#4094ff', '#00c882', '#b478ff', '#ff9f43', '#ff5c7a', '#2ec4b6', '#ffd166', '#8c94a0', '#6c5ce7', '#00b894'];
  bar.innerHTML = '';
  q.forEach((seg, i) => {
    const w = Math.max(6, Math.round((parseFloat(seg.duration) || 0) * (parseInt(seg.repeat, 10) || 1) / total * 100));
    const blk = document.createElement('div');
    blk.className = 'tl-seg';
    blk.style.background = colors[i % colors.length];
    blk.style.width = w + '%';
    blk.innerHTML = '<b>' + escapeHtml(seg.action) + '</b><span>' + (parseFloat(seg.duration) || 0).toFixed(1) + 's' + ((parseInt(seg.repeat, 10) || 1) > 1 ? ' ×' + (parseInt(seg.repeat, 10) || 1) : '') + (seg.loop ? ' ⟳' : '') + '</span>';
    blk.title = (seg.description || seg.action) + ' · ' + (parseFloat(seg.duration) || 0).toFixed(1) + 's' + ((parseInt(seg.repeat, 10) || 1) > 1 ? ' ×' + (parseInt(seg.repeat, 10) || 1) : '') + ' 次' + (seg.loop ? ' 循环' : '');
    bar.appendChild(blk);
  });
  box.innerHTML = '';
  const tlViews = workingViews();
  q.forEach((seg, i) => {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.innerHTML = `
      <span class="tl-idx">${i + 1}</span>
      <b class="tl-act">${escapeHtml(seg.action)}</b>
      <label>时长 <input type="number" min="0.1" step="0.1" value="${parseFloat(seg.duration) || 0}" class="tl-dur"></label>
      <label class="checkbox">循环 <input type="checkbox" ${seg.loop ? 'checked' : ''} class="tl-loop"></label>
      <label>倍速 <input type="number" min="0.1" step="0.1" value="${parseFloat(seg.timeScale) || 1}" class="tl-scale"></label>
      <label>次数 <input type="number" min="1" max="99" step="1" value="${parseInt(seg.repeat) || 1}" class="tl-repeat"></label>
      ${tlViews.length > 1 ? '<label>视图 <select class="tl-view">' + tlViews.map((v) => '<option value="' + escapeHtml(v.view || 'default') + '"' + ((seg.view || '') === (v.view || '') ? ' selected' : '') + '>' + escapeHtml(v.view || 'default') + '</option>').join('') + '</select></label>' : ''}
      <input type="text" class="grow tl-desc" placeholder="含义（可选）" value="${escapeHtml(seg.description || '')}">
      <span class="tl-ops">
        <button class="ghost" data-op="up" title="上移">↑</button>
        <button class="ghost" data-op="down" title="下移">↓</button>
        <button class="ghost" data-op="dup" title="复制此段">⧉</button>
        <button class="ghost danger" data-op="del" title="删除">✕</button>
      </span>`;
    const sync = () => {
      seg.duration = Math.max(0.1, parseFloat(row.querySelector('.tl-dur').value) || seg.duration);
      seg.loop = row.querySelector('.tl-loop').checked;
      seg.timeScale = Math.max(0.1, parseFloat(row.querySelector('.tl-scale').value) || seg.timeScale);
      seg.repeat = Math.max(1, Math.round(parseFloat(row.querySelector('.tl-repeat').value)) || 1);
      const vs = row.querySelector('.tl-view');
      if (vs) seg.view = vs.value;
      seg.description = row.querySelector('.tl-desc').value;
      if (seg.description && state.pvDesc[seg.action] !== seg.description) state.pvDesc[seg.action] = seg.description;
      renderQueue();
    };
    row.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', sync));
    row.querySelectorAll('[data-op]').forEach((btn) => btn.addEventListener('click', () => {
      const op = btn.dataset.op;
      if (op === 'up') queueMove(i, -1);
      else if (op === 'down') queueMove(i, 1);
      else if (op === 'dup') queueDup(i);
      else queueRemove(i);
    }));
    box.appendChild(row);
  });
  info.textContent = '共 ' + q.length + ' 段 · ' + total.toFixed(2) + 's · 下一步点「去生成动画」';
  updateGenTlState();
}

// 自然语言 → 时间轴
$('#btn-plan').addEventListener('click', async () => {
  const prompt = $('#tl-prompt').value.trim();
  if (!prompt) { $('#plan-info').textContent = '❌ 请先写下动作描述'; return; }
  const m = state.current;
  if (!m) { $('#plan-info').textContent = '❌ 请先选择模型'; showTab('models'); return; }
  const assets = currentAssets();
  const body = {
    prompt,
    fps: $('#g-fps').value,
    character: m.name,
    key: m.id,
    skel: assets?.skel, atlas: assets?.atlas, png: assets?.png,
  };
  const btn = $('#btn-plan');
  btn.disabled = true;
  $('#plan-info').textContent = '⏳ AI 正在编排…';
  try {
    const { jobId } = await api('/api/plan', body);
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    state.queue = (result.timeline || []).map((s) => ({ ...s }));
    $('#plan-info').textContent = '✅ 已生成 ' + state.queue.length + ' 段（模式：' + (result.mode || 'llm') + '），可在下方微调后去生成';
    renderQueue();
    renderPvGrid();
  } catch (err) {
    $('#plan-info').textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#btn-queue-clear').addEventListener('click', () => {
  state.queue = [];
  renderQueue();
  $('#plan-info').textContent = '';
});

$('#btn-tl-generate').addEventListener('click', () => {
  const m = state.current;
  if (!m) { $('#tl-queue-info').textContent = '❌ 请先选择模型'; showTab('models'); return; }
  if (!state.queue.length) { $('#tl-queue-info').textContent = '❌ 时间轴还是空的：点预览卡「＋加入」或写描述生成'; return; }
  state.lastTimeline = { character: m.name, fps: parseInt($('#g-fps').value, 10) || 30, timeline: state.queue.map((s) => ({ ...s })), mode: 'edited' };
  updateGenTlState();
  showTab('generate');
});

// ---------------------------------------------------------------------------
// ④ 动画生成
// ---------------------------------------------------------------------------
function buildRunBody(extra = {}) {
  const m = state.current;
  if (!m) throw new Error('请先在「① 拉取模型」选择一个模型');
  const assets = currentAssets();
  if (!assets || !assets.skel || !assets.atlas || !assets.png) {
    throw new Error('模型三件套不完整：请先拉取模型（或重新选择本地模型）');
  }
  const body = {
    key: m.groupId || m.id,
    skel: assets.skel,
    atlas: assets.atlas,
    png: assets.png,
    fps: $('#g-fps').value,
    size: $('#g-size').value,
    format: $('#g-format').value,
    mix: $('#g-mix').value,
    bg: $('#g-bg').value || '00000000',
    outName: m.name + '-' + modelEntryLabel(m).replace(/[\\/]+/g, '_'),
  };
  if (assets?.isHi) {
    // 已高清化：直接使用高清资源，不再重复放大
    body.upscale = '1';
    body.sr = false;
  } else {
    body.upscale = $('#g-upscale').value;
    body.sr = $('#g-sr').checked;
    body.srEngine = $('#g-sr-engine').value;
  }
  return { ...body, ...extra };
}


$('#btn-run').addEventListener('click', async () => {
  let body;
  try { body = buildRunBody({}); } catch (err) {
    $('#run-status').textContent = '❌ ' + err.message;
    $('#run-status').className = 'err-inline';
    showTab('models');
    return;
  }
  if (!state.queue || !state.queue.length) {
    $('#run-status').textContent = '❌ 请先到「③ 编排时间轴」排好时间轴（可写自然语言生成，也可手动勾选）';
    $('#run-status').className = 'err-inline';
    showTab('timeline');
    return;
  }
  // 直接快照当前队列（实时时间轴），保证成片与编排页完全一致
  state.lastTimeline = {
    character: state.current?.name || 'result',
    fps: parseInt($('#g-fps').value, 10) || 30,
    timeline: state.queue.map((s) => ({ action: s.action, view: s.view || '', loop: !!s.loop, duration: Number(s.duration) || 2, timeScale: Number(s.timeScale) || 1, repeat: Math.max(1, Math.round(Number(s.repeat)) || 1), description: s.description || '' })),
    mode: 'edited',
  };
  body.timeline = state.lastTimeline;
  const mvAll = workingViews();
  if (mvAll.length > 1) {
    body.assetsList = mvAll.map((v) => {
      const hi = Object.values(state.assetSets || {}).find((s) => s.skel === v.files.skel);
      const use = hi || v.files;
      return { name: v.view || 'default', skel: use.skel, atlas: use.atlas, png: use.png };
    });
  }
  state.lastModelParams = body;
  startJobUI();
  try {
    const { jobId } = await api('/api/run', body);
    state.activeJob = jobId;
    await waitJob(jobId);
    refreshState();
  } catch (err) {
    onJobError(err.message);
  }
});

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
  div.innerHTML = '<span class="t">' + t + '</span>' + escapeHtml(line);
  if (isErr) div.className = 'err';
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  const m = line.match(/\[render\]\s+(\d+)\/(\d+)/);
  if (m) {
    const cur = parseInt(m[1], 10), total = parseInt(m[2], 10);
    $('#run-progress-bar').value = Math.round((cur / total) * 100);
    $('#run-progress-text').textContent = '渲染 ' + cur + '/' + total + ' 帧';
  } else if (line.includes('[hi-res]')) {
    $('#run-progress-text').textContent = '高清化处理中…';
  } else if (line.includes('[done]')) {
    $('#run-progress-text').textContent = '完成';
  }
}

function onJobDone(result) {
  if (!result || !result.outBase || !Array.isArray(result.files)) return; // 仅生成任务展示结果卡
  setBusy(false);
  $('#run-status').textContent = '';
  $('#run-status').className = '';
  $('#run-progress-bar').value = 100;
  const box = $('#run-result');
  box.hidden = false;
  const media = (result.files || [])
    .map((f) => (f.kind === 'mp4' ? '<video src="' + f.url + '" controls></video>' : f.kind === 'gif' ? '<img src="' + f.url + '">' : f.kind === 'png' ? '<div class="muted">📁 PNG 帧序列目录：帧文件已保存，点下方「在文件夹中显示」查看</div>' : ''))
    .join('');
  box.innerHTML = '<h3>✅ 生成完成</h3>' + media +
    '<div class="row wrap" style="margin-top:10px">' +
    '<button id="btn-open-out" class="ghost">在文件夹中显示</button>' +
    '<button id="btn-lb-view" class="ghost">放大预览</button>' +
    '<span class="muted" style="font-family:var(--mono);font-size:12px">' + escapeHtml(result.outBase) + '</span></div>';
  const openBtn = box.querySelector('#btn-open-out');
  if (openBtn) openBtn.addEventListener('click', () => openFolder(result.files && result.files.length ? result.files[0].path || result.files[0].url : result.outBase));
  const lbBtn = box.querySelector('#btn-lb-view');
  if (lbBtn && result.files && result.files.length) {
    lbBtn.addEventListener('click', () => openLightbox('生成结果', media));
  }
  refreshState();
  $('#run-progress-text').textContent = '';
}

function onJobError(message) {
  setBusy(false);
  $('#run-status').textContent = '❌ ' + message;
  $('#run-status').className = 'err-inline';
}

// ---------------------------------------------------------------------------
// ② 高清化：方案对比（4 图先行，用户选择后再执行整图高清化）
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
    el.innerHTML = '<div class="bar" style="background:' + plan.bar + '"></div>' +
      '<div class="name">' + plan.label + (plan.tag ? '<span class="tag">' + plan.tag + '</span>' : '') + '<span class="muted">' + scale + 'x</span></div>' +
      '<div class="desc">' + plan.desc + '</div>';
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
$('#h-sr').addEventListener('change', () => { hiPlanKey = null; renderHiPlans(); $('#hi-plan-tag').textContent = ''; });
$('#h-sr-engine').addEventListener('change', () => { hiPlanKey = null; renderHiPlans(); $('#hi-plan-tag').textContent = ''; });
$('#h-scale').addEventListener('change', () => { renderHiPlans(); });

$('#btn-compare').addEventListener('click', async () => {
  const m = hiCompareTarget();
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

$('#btn-hi').addEventListener('click', async () => {
  const targets = workingModels();
  if (!targets.length) {
    $('#hi-info').textContent = '❌ 请先在模型库选择模型（可勾选多套形成工作集）';
    return;
  }
  const bad = targets.find((m) => !m.files || !m.files.atlas || !m.files.png);
  if (bad) {
    $('#hi-info').textContent = '❌ ' + bad.name + ' 缺少 atlas/png，请先拉取完整三件套';
    return;
  }
  $('#hi-info').textContent = '';
  $('#hi-log').hidden = false;
  $('#hi-log').innerHTML = '';
  $('#hi-result').hidden = true;
  $('#btn-hi').disabled = true;
  const showImg = (id, url) => { const img = $(id); if (img) img.src = url; };
  const scale = $('#h-scale').value;
  const srOn = $('#h-sr').checked;
  const srEngine = $('#h-sr-engine').value;
  const label = '高清化' + scale + 'x' + (srOn ? ' + AI(' + srEngine + ')' : '');
  let done = 0, failed = 0;
  try {
    for (const m of targets) {
      $('#hi-info').textContent = '⚠️ 高清化 ' + (done + failed + 1) + '/' + targets.length + '：' + m.name + ' · ' + (m.viewLabel || m.base || '');
      const { jobId } = await api('/api/upscale', {
        atlas: m.files.atlas, png: m.files.png,
        scale, sr: srOn, srEngine,
        outName: m.name,
      });
      state.activeJob = jobId;
      const result = await waitJob(jobId);
      const png = result.files.find((f) => f.kind === 'png');
      const atlas = result.files.find((f) => f.kind === 'atlas');
      if (png && atlas) {
        setAssetSet(m.id, { skel: m.files.skel, atlas: atlas.path, png: png.path, label });
        $('#hi-log').innerHTML += '<div class="ok">✅ ' + escapeHtml(m.name + ' · ' + (m.viewLabel || m.base || '')) + ' 高清化完成</div>';
        done++;
        if (done === targets.length) {
          $('#hi-result').hidden = false;
          showImg('#hi-before', assetUrl(targets[0].files.png));
          showImg('#hi-after', png.url);
        }
      } else {
        $('#hi-log').innerHTML += '<div class="err">❌ ' + escapeHtml(m.name || '') + ' 高清化产物缺少文件</div>';
        failed++;
      }
    }
    $('#hi-info').textContent = '完成：' + done + ' 套成功' + (failed ? '，' + failed + ' 套失败' : '') + '，已自动采用到工作集';
    $('#hi-use-info').textContent = '✅ 已自动采用 ' + done + ' 套高清资源：动作预览固定用原图（快），最终生成使用高清资源；如需切回原图可点上方「跳过高清化」';
    const useBtn = $('#btn-hi-use');
    if (useBtn) useBtn.hidden = true;
  } catch (err) {
    $('#hi-log').innerHTML += '<div class="err">' + escapeHtml(err.message) + '</div>';
  } finally {
    $('#btn-hi').disabled = false;
    updateWorkSetUI();
  }
});

$('#btn-hi-skip').addEventListener('click', () => {
  const targets = workingModels();
  for (const m of targets) setAssetSet(m.id, null);
  $('#hi-use-info').textContent = '已使用原图资源';
});

// ---------------------------------------------------------------------------
// 任务与输出
// ---------------------------------------------------------------------------
function updateJobStatus(jobId, status) {
  const el = document.querySelector('.job-item[data-job="' + jobId + '"]');
  if (!el) return;
  const st = el.querySelector('.st');
  if (st) { st.textContent = status; st.className = 'st ' + status; }
}
function updateJobLogs(jobId) {
  const el = document.querySelector('.job-item[data-job="' + jobId + '"]');
  if (!el) return;
  const logs = jobLogs.get(jobId) || [];
  const box = el.querySelector('.logs');
  if (box && logs.length) box.innerHTML = logs.slice(-6).map((l) => '<div>' + escapeHtml(l) + '</div>').join('');
}
async function refreshJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    state.jobs = jobs || [];
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
    const err = j.error ? '<div class="err" style="font-family:var(--mono);font-size:11px;margin-top:4px">' + escapeHtml(String(j.error).slice(0, 300)) + '</div>' : '';
    el.innerHTML = '<div class="top"><span class="st ' + j.status + '">' + j.status + '</span><b>' + escapeHtml(j.kind) + '</b><span class="muted">' + j.id + ' · ' + time + '</span></div>' + err + '<div class="logs"></div>';
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
    const media = kind === 'gif' || kind === 'png' ? '<img src="' + o.url + '" loading="lazy">' : kind === 'mp4' ? '<video src="' + o.url + '" controls preload="metadata"></video>' : '';
    const size = o.size > 1024 * 1024 ? (o.size / 1024 / 1024).toFixed(1) + ' MB' : (o.size / 1024).toFixed(0) + ' KB';
    const isMedia = kind === 'gif' || kind === 'png' || kind === 'mp4';
    el.innerHTML = media +
      '<div class="meta"><div class="nm">' + escapeHtml(o.name) + '</div>' +
      '<div>' + size + ' · ' + new Date(o.mtime).toLocaleString('zh-CN', { hour12: false }) + '</div>' +
      '<div class="row wrap" style="margin-top:6px">' +
      (isMedia ? '<button class="ghost sm" data-act="view">放大</button>' : '') +
      '<button class="ghost sm" data-act="folder">打开文件夹</button>' +
      (o.name.endsWith('.json') ? '<button class="ghost sm" data-act="json">查看内容</button>' : '') +
      '</div></div>';
    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'view') openLightbox(o.name, media);
        else if (act === 'folder') openFolder(o.url || o.dir);
        else if (act === 'json') {
          fetch(o.url).then((r) => r.text()).then((txt) => openLightbox(o.name, '<pre class="lb-json">' + escapeHtml(txt) + '</pre>')).catch(() => alert('读取失败'));
        }
      });
    });
    if (isMedia) {
      el.addEventListener('click', () => openLightbox(o.name, media));
    }
    box.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// 灯箱 / 打开文件夹
// ---------------------------------------------------------------------------
function openLightbox(title, html) {
  $('#lb-title').textContent = title;
  $('#lb-body').innerHTML = html;
  $('#lightbox').hidden = false;
}
$('#btn-lb-close').addEventListener('click', () => { $('#lightbox').hidden = true; });
$('#lightbox').addEventListener('click', (e) => {
  if (e.target === $('#lightbox')) $('#lightbox').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#lightbox').hidden) $('#lightbox').hidden = true;
});

// 将 assets 下绝对路径转为可访问的 /assets/ URL（用于展示原始贴图）
// 将 assets 下绝对路径转为可访问的 /assets/ URL（用于展示原始贴图）
function assetUrl(abs) {
  if (!abs || !state.assetsDir) return '';
  let base = String(state.assetsDir).split('\\').join('/');
  while (base.endsWith('/')) base = base.slice(0, -1);
  let rel = String(abs).split('\\').join('/').split('?')[0];
  if (!rel.startsWith(base + '/')) return '';
  const segs = rel.slice(base.length + 1).split('/').map((s) => encodeURIComponent(s));
  return '/assets/' + segs.join('/');
}


function openFolder(target) {
  let abs = String(target || '');
  if (!abs) { alert('没有可打开的路径'); return; }
  const isAbs = /^[a-zA-Z]:[\\/]/.test(abs) || abs.startsWith('\\\\');
  if (!isAbs) {
    const rel = abs.startsWith('/outputs/') ? decodeURIComponent(abs.slice(9)).replace(/\//g, '\\') : abs.replace(/\//g, '\\');
    abs = (state.outDir || '') + '\\' + rel;
  }
  if (window.desktopAPI?.openPath) {
    window.desktopAPI.openPath(abs).then((r) => { if (!r.ok) alert('打开失败: ' + r.error + '\n路径: ' + abs); });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(abs)
      .then(() => alert('已复制路径（安装 Electron 后可一键打开）：\n' + abs))
      .catch(() => alert(abs));
  } else {
    alert(abs);
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
  renderDirFilters();
  bindFilterSelects();
  // 恢复上次的提示词与参数
  try {
    const savedForm = JSON.parse(localStorage.getItem('zd.form') || 'null');
    if (savedForm) {
      if (savedForm.prompt) $('#tl-prompt').value = savedForm.prompt;
      if (savedForm.prompt) $('#g-prompt') && ($('#g-prompt').value = savedForm.prompt);
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
  ['tl-prompt', 'g-prompt', 'g-fps', 'g-size', 'g-format', 'g-mix', 'g-bg', 'g-upscale', 'g-sr', 'g-sr-engine'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      try {
        localStorage.setItem('zd.form', JSON.stringify({
          prompt: $('#tl-prompt').value,
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
  renderPvGrid();
  renderHiPlans();
  setInterval(refreshState, 30000);
  setInterval(refreshPerf, 2000);
})();
