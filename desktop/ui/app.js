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
  previews: null,         // 动作预览 [{name, duration, url}]
  pvDesc: {},             // 动作名 -> 用户描述
  queue: [],              // 时间轴 [{action, loop, duration, timeScale, description}]
  lastTimeline: null,
  lastModelParams: null,
  outputs: [],
  jobs: [],
  outDir: '',
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
        api('/api/jobs').then(({ jobs }) => {
          const j = jobs.find((x) => x.id === jobId);
          if (!j) return reject(new Error('任务不存在'));
          if (j.status === 'done') resolve(j.result);
          else if (j.status === 'error') reject(new Error(j.error || '任务失败'));
          else reject(new Error('等待任务超时'));
        }).catch(reject);
      }
    }, 180000);
  }).finally(() => setBusy(false)); // 无论成功/失败/超时都恢复按钮，防止卡死
}

// ---------------------------------------------------------------------------
// 全局任务锁（防止运行中误点重复提交）
// ---------------------------------------------------------------------------
const busyButtons = ['#btn-resolve', '#btn-fetch', '#btn-fetch-force', '#btn-run', '#btn-preview', '#btn-plan', '#btn-compare', '#btn-hi'];
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
    renderModels();
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
  if (state.assetSet && state.assetSet.modelId === m.id) {
    return { skel: state.assetSet.skel, atlas: state.assetSet.atlas, png: state.assetSet.png, label: state.assetSet.label, isHi: true };
  }
  return { skel: m.files?.skel, atlas: m.files?.atlas, png: m.files?.png, label: '原图', isHi: false };
}
function setAssetSet(modelId, set) {
  state.assetSet = set ? { modelId, ...set } : null;
  // 资源变化 → 预览与旧时间轴可能不匹配，提示重新生成
  state.previews = null;
  $('#pv-grid').innerHTML = '';
  $('#pv-info').textContent = state.assetSet ? '资源已切换，请重新生成动作预览' : '';
  updateAssetViews();
}
function updateAssetViews() {
  const assets = currentAssets();
  const label = assets ? assets.label : '原图';
  const txt = (el, s) => { const e = $(el); if (e) e.textContent = s; };
  txt('#gen-res', '资源：' + label + (state.current ? ' · ' + state.current.name : ''));
  txt('#tl-res', '资源：' + label + '（预览与生成都将使用这套资源）');
  txt('#hi-res-state', '资源：' + label);
  txt('#hi-use-info', '');
  const useBtn = $('#btn-hi-use');
  if (useBtn) useBtn.hidden = true;
  updateGenTlState();
}
function updateGenTlState() {
  const q = state.queue;
  const el = $('#gen-tl-state');
  if (!el) return;
  if (q && q.length) {
    const total = q.reduce((s, x) => s + (parseFloat(x.duration) || 0), 0);
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
    $('#fetch-done').hidden = false;
    $('#resolve-out').textContent = '✅ 三件套就绪：' + (result.files?.skel || '');
  } catch (err) {
    alert('拉取失败：' + err.message);
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
      '<li><b>用内置示例</b>：阿米娅已自带（assets/amiya），点下方列表后从第 ② 步继续。</li>' +
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
      <div class="chips">${(m.animations || []).map((a) => '<span class="chip-anim">' + escapeHtml(a.name) + ' ' + a.duration.toFixed(2) + 's</span>').join('') || '<span class="muted">无动画信息</span>'}</div>`;
    el.addEventListener('click', () => selectModel(m));
    box.appendChild(el);
  }
}

function selectModel(m) {
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
  const label = state.assetSet?.label || '原图';
  $('#gen-model').innerHTML = '<b>' + escapeHtml(m.name) + '</b>（' + escapeHtml(m.id) + '）';
  $('#gen-res').textContent = '资源：' + label;
  $('#tl-model').innerHTML = '<b>' + escapeHtml(m.name) + '</b>（' + escapeHtml(m.id) + '）';
  $('#tl-res').textContent = '资源：' + label + '（预览与生成都将使用这套资源）';
  $('#hi-model-state').innerHTML = '<b>' + escapeHtml(m.name) + '</b>（' + escapeHtml(m.id) + '）';
  $('#hi-res-state').textContent = '资源：' + label;
  const anims = $('#gen-anims');
  anims.innerHTML = (m.animations || []).map((a) => '<span class="chip-anim">' + escapeHtml(a.name) + ' ' + a.duration.toFixed(2) + 's</span>').join('') || '';
  localStorage.setItem('zd.current', JSON.stringify({ id: m.id, name: m.name }));
  const hiSel = $('#h-model');
  const exists = [...hiSel.options].some((o) => o.value === m.id);
  if (!exists) {
    hiSel.add(new Option(m.name + '（' + m.id + '）', m.id));
    hiSel.value = m.id;
  }
  updateGenTlState();
}

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
    const { jobId } = await api('/api/previews', { skel: assets.skel, atlas: assets.atlas, png: assets.png, outName: m.name, mode, modelId: m.id });
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
    const { jobId } = await api('/api/label', { skel: assets.skel, atlas: assets.atlas, png: assets.png, outName: m.name, modelId: m.id, characterName: m.name });
    state.activeJob = jobId;
    const result = await waitJob(jobId);
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
  const inQueue = new Set(state.queue.map((s) => s.action));
  for (const p of files) {
    const card = document.createElement('div');
    card.className = 'pv-card' + (inQueue.has(p.name) ? ' used' : '');
    const desc = state.pvDesc[p.name] || '';
    const isGif = p.kind === 'gif';
    card.innerHTML =
      '<div class="pv-img">' + (isGif
        ? '<img src="' + p.url + '" alt="' + escapeHtml(p.name) + '" title="完整动画预览（循环播放）">'
        : '<img src="' + p.url + '" loading="lazy" alt="' + escapeHtml(p.name) + '" title="单帧快照">') +
      '</div>' +
      '<div class="pv-name"><b>' + escapeHtml(p.name) + '</b><span class="muted">' + (p.duration > 0 ? p.duration.toFixed(2) + 's' : '瞬发') + (isGif ? ' · GIF' : '') + '</span></div>' +
      (desc ? '<div class="pv-tags">' + escapeHtml(desc) + '</div>' : '') +
      '<input class="pv-desc" type="text" placeholder="这个动作代表什么？（可选，可点 🤖 AI 自动标注）" value="' + escapeHtml(desc) + '">' +
      '<button class="primary pv-add" type="button">＋ 加入时间轴</button>';
    const descInput = card.querySelector('.pv-desc');
    descInput.addEventListener('input', () => {
      state.pvDesc[p.name] = descInput.value;
      const seg = state.queue.find((s) => s.action === p.name);
      if (seg) { seg.description = descInput.value; renderQueue(); }
    });
    card.querySelector('.pv-add').addEventListener('click', () => {
      queueAdd(p.name, p.duration, descInput.value);
      card.classList.add('used');
    });
    box.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// ③ 编排时间轴：队列 + PR 式可视化
// ---------------------------------------------------------------------------
function queueAdd(action, duration, description) {
  const existing = state.queue.find((s) => s.action === action);
  if (existing) { queueRemove(state.queue.indexOf(existing)); return; }
  const d = duration && duration > 0 ? Math.min(Math.max(duration, 0.5), 10) : 2;
  state.queue.push({ action, loop: d >= 2, duration: d, timeScale: 1, description: description || '' });
  renderQueue();
}
function queueRemove(i) {
  state.queue.splice(i, 1);
  renderQueue();
}
function queueMove(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.queue.length) return;
  const [seg] = state.queue.splice(i, 1);
  state.queue.splice(j, 0, seg);
  renderQueue();
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
  const total = q.reduce((s, x) => s + (parseFloat(x.duration) || 0), 0);
  const colors = ['#4094ff', '#00c882', '#b478ff', '#ff9f43', '#ff5c7a', '#2ec4b6', '#ffd166', '#8c94a0', '#6c5ce7', '#00b894'];
  bar.innerHTML = '';
  q.forEach((seg, i) => {
    const w = Math.max(6, Math.round((parseFloat(seg.duration) || 0) / total * 100));
    const blk = document.createElement('div');
    blk.className = 'tl-seg';
    blk.style.background = colors[i % colors.length];
    blk.style.width = w + '%';
    blk.innerHTML = '<b>' + escapeHtml(seg.action) + '</b><span>' + (parseFloat(seg.duration) || 0).toFixed(1) + 's' + (seg.loop ? ' ⟳' : '') + '</span>';
    blk.title = (seg.description || seg.action) + ' · ' + (parseFloat(seg.duration) || 0).toFixed(1) + 's';
    bar.appendChild(blk);
  });
  box.innerHTML = '';
  q.forEach((seg, i) => {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.innerHTML = `
      <span class="tl-idx">${i + 1}</span>
      <b class="tl-act">${escapeHtml(seg.action)}</b>
      <label>时长 <input type="number" min="0.1" step="0.1" value="${parseFloat(seg.duration) || 0}" class="tl-dur"></label>
      <label class="checkbox">循环 <input type="checkbox" ${seg.loop ? 'checked' : ''} class="tl-loop"></label>
      <label>倍速 <input type="number" min="0.1" step="0.1" value="${parseFloat(seg.timeScale) || 1}" class="tl-scale"></label>
      <input type="text" class="grow tl-desc" placeholder="含义（可选）" value="${escapeHtml(seg.description || '')}">
      <span class="tl-ops">
        <button class="ghost" data-op="up" title="上移">↑</button>
        <button class="ghost" data-op="down" title="下移">↓</button>
        <button class="ghost danger" data-op="del" title="删除">✕</button>
      </span>`;
    const sync = () => {
      seg.duration = Math.max(0.1, parseFloat(row.querySelector('.tl-dur').value) || seg.duration);
      seg.loop = row.querySelector('.tl-loop').checked;
      seg.timeScale = Math.max(0.1, parseFloat(row.querySelector('.tl-scale').value) || seg.timeScale);
      seg.description = row.querySelector('.tl-desc').value;
      if (seg.description && state.pvDesc[seg.action] !== seg.description) state.pvDesc[seg.action] = seg.description;
      renderQueue();
    };
    row.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', sync));
    row.querySelectorAll('[data-op]').forEach((btn) => btn.addEventListener('click', () => {
      const op = btn.dataset.op;
      if (op === 'up') queueMove(i, -1);
      else if (op === 'down') queueMove(i, 1);
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
  const body = {
    key: m.id,
    fps: $('#g-fps').value,
    size: $('#g-size').value,
    format: $('#g-format').value,
    mix: $('#g-mix').value,
    bg: $('#g-bg').value || '00000000',
    outName: m.name,
  };
  if (assets?.isHi && assets.skel && assets.atlas && assets.png) {
    // 已高清化：直接使用高清资源，不再重复放大
    body.skel = assets.skel;
    body.atlas = assets.atlas;
    body.png = assets.png;
    body.upscale = '1';
    body.sr = false;
  } else {
    body.source = 'prts';
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
  if (!state.lastTimeline || !state.lastTimeline.timeline || !state.lastTimeline.timeline.length) {
    $('#run-status').textContent = '❌ 请先到「③ 编排时间轴」排好时间轴（可写自然语言生成，也可手动勾选）';
    $('#run-status').className = 'err-inline';
    showTab('timeline');
    return;
  }
  body.timeline = state.lastTimeline;
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
    .map((f) => (f.kind === 'mp4' ? '<video src="' + f.url + '" controls></video>' : f.kind === 'gif' || f.kind === 'png' ? '<img src="' + f.url + '">' : ''))
    .join('');
  box.innerHTML = '<h3>✅ 生成完成</h3>' + media +
    '<div class="row wrap" style="margin-top:10px">' +
    '<button id="btn-open-out" class="ghost">打开输出目录</button>' +
    '<button id="btn-lb-view" class="ghost">放大预览</button>' +
    '<span class="muted" style="font-family:var(--mono);font-size:12px">' + escapeHtml(result.outBase) + '</span></div>';
  const openBtn = box.querySelector('#btn-open-out');
  if (openBtn) openBtn.addEventListener('click', () => openFolder(result.outBase));
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
  $('#run-status').className = '';
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
  const showImg = (id, url) => { const img = $(id); if (img) img.src = url; };
  try {
    const { jobId } = await api('/api/upscale', {
      atlas: m.files.atlas, png: m.files.png,
      scale: $('#h-scale').value, sr: $('#h-sr').checked, srEngine: $('#h-sr-engine').value,
      outName: m.name,
    });
    state.activeJob = jobId;
    const result = await waitJob(jobId);
    $('#hi-result').hidden = false;
    showImg('#hi-before', '/outputs/' + encodeURIComponent(m.id) + '.png');
    const png = result.files.find((f) => f.kind === 'png');
    const atlas = result.files.find((f) => f.kind === 'atlas');
    if (png) showImg('#hi-after', png.url);
    $('#hi-info').textContent = '输出：' + result.outDir;
    const useBtn = $('#btn-hi-use');
    useBtn.hidden = false;
    useBtn.onclick = () => {
      if (!png || !atlas) { $('#hi-use-info').textContent = '❌ 高清化产物缺少文件'; return; }
      setAssetSet(m.id, { skel: m.files.skel, atlas: atlas.path, png: png.path, label: '高清化 x' + $('#h-scale').value + ($('#h-sr').checked ? ' + AI(' + $('#h-sr-engine').value + ')' : '') });
      $('#hi-use-info').textContent = '✅ 已采用，后续预览 / 生成将使用这套高清资源';
    };
  } catch (err) {
    $('#hi-log').innerHTML += '<div class="err">' + escapeHtml(err.message) + '</div>';
  } finally {
    $('#btn-hi').disabled = false;
  }
});

$('#btn-hi-skip').addEventListener('click', () => {
  if (state.current) setAssetSet(state.current.id, null);
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
        else if (act === 'folder') openFolder(o.dir || o.url);
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
})();
