// PRTS (https://prts.wiki) 干员三件套 (.skel/.atlas/.png) 抓取器。
//
// 原理（逆向自 PRTS 的 SpineViewer widget）:
//   1. 干员页面 <div id="spine-root" data-id="char_002_amiya"> 给出角色模型 ID
//   2. 模型元数据: https://torappu.prts.wiki/assets/char_spine/<id>/meta.json
//      -> { prefix, name, skin: { <皮肤>: { 正面/基建/背面: { file } } } }
//   3. 三件套 URL = prefix + file + .skel / .atlas / <atlas 内引用的 .png 页>
//
// 用法:
//   node src/prts.mjs --character 阿米娅 --out assets/amiya-prts
//   node src/prts.mjs --key char_002_amiya --skin 报童 --view 正面
//   node src/prts.mjs --character 阿米娅 --list-skins

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const WIKI = 'https://prts.wiki';
const TORAPPU = 'https://torappu.prts.wiki';
const VIEW_PRIORITY = ['战斗', '基建', '正面', '背面'];

const EXTS = ['.skel', '.atlas'];

export async function fetchBytes(url, { timeoutMs = 60000, onLog } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 角色 ID 解析 ----------

export function parseCharIdFromHtml(html) {
  // <div id="spine-root" data-id="char_002_amiya" ...>
  const match = html.match(/<div\b[^>]*\bid="spine-root"[^>]*\bdata-id="([^"]+)"/i) || html.match(/<div\b[^>]*\bdata-id="([^"]+)"[^>]*\bid="spine-root"/i);
  return match ? match[1] : null;
}

export function parseSpineDataFromHtml(html) {
  // PRTS 敌人页（及部分角色页）把模型元数据内嵌在
  // <span id="SPINEDATA" type="json" class="...">{prefix,name,skin}</span> 中。
  const match = String(html).match(/<span\b[^>]*\bid="SPINEDATA"[^>]*>([\s\S]*?)<\/span>/i);
  if (!match) return null;
  const text = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.prefix === 'string' && parsed.skin) {
      return parsed;
    }
  } catch {
    /* 不是 JSON 就不是 SPINEDATA */
  }
  return null;
}

export function isEnemyKey(key) {
  return /^enemy_\d+_/i.test(String(key ?? '').trim());
}

export function enemyMetaFromKey(key) {
  // 敌人没有独立 meta.json；SPINEDATA 结构固定为
  // { prefix, name, skin: { 默认: { 战斗: { file } } } }，
  // 这里按 key 直接构造等价元数据，免去抓页面。
  const id = String(key ?? '').trim();
  if (!isEnemyKey(id)) return null;
  return {
    prefix: `${TORAPPU}/assets/enemy_spine/${id}/`,
    name: id,
    kind: 'enemy',
    skin: { 默认: { 战斗: { file: id } } },
  };
}
/**
 * 反查敌人中文名：通过 PRTS 搜索翻径，找到 prefix 包含该 ID 的 SPINEDATA 页面并取 name 字段。
 */
let _enemyIndexCache = null;

/**
 * 敌人翻转索引：通过「模板:敌人信息/common2」的嵌入页列表枚举全部敌人页，
 * 批量获取各页面 <敌人名>/spine 子页，解析 SPINEDATA 建立
 * spineId -> { name, pageTitle } 映射。结果在进程内缓存，可选写入本地文件复用。
 */
export async function enemyIndex({ force = false, cacheFile = null, onLog = () => {} } = {}) {
  if (_enemyIndexCache && !force) return _enemyIndexCache;
  if (!force && cacheFile) {
    try {
      const j = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (j && typeof j === 'object' && Object.keys(j).length > 3) { _enemyIndexCache = j; return j; }
    } catch { /* 无缓存文件 */ }
  }
  const titles = [];
  let cont = null;
  for (;;) {
    let u = WIKI + '/api.php?action=query&list=embeddedin&eititle=' + encodeURIComponent('模板:敌人信息/common2') + '&eilimit=500&format=json';
    if (cont) u += '&eicontinue=' + encodeURIComponent(cont);
    const j = JSON.parse((await fetchBytes(u)).toString('utf8'));
    for (const x of (j?.query?.embeddedin || [])) titles.push(x.title);
    cont = j?.continue?.eicontinue || null;
    if (!cont) break;
  }
  const map = {};
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50).map((t) => t + '/spine');
    const u = WIKI + '/api.php?action=query&titles=' + encodeURIComponent(chunk.join('|')) + '&prop=revisions&rvprop=content&rvslots=main&format=json';
    let j = null;
    try { j = JSON.parse((await fetchBytes(u)).toString('utf8')); } catch { continue; }
    for (const pg of Object.values(j?.query?.pages || {})) {
      const rev = pg?.revisions?.[0]?.slots?.main?.['*'];
      if (!rev || typeof rev !== 'string') continue;
      const pm = rev.match(/"prefix"\s*:\s*"([^"]*enemy_spine\/([^\/"]+)[\/"]?)/);
      if (!pm) continue;
      const id = pm[2];
      const nm = rev.match(/"name"\s*:\s*"([^"]*)"/);
      map[id] = { name: nm ? nm[1] : pg.title.replace(/\/spine$/, ''), pageTitle: pg.title.replace(/\/spine$/, '') };
    }
  }
  _enemyIndexCache = map;
  if (cacheFile) { try { await writeFile(cacheFile, JSON.stringify(map)); } catch { /* 忽略 */ } }
  onLog('[prts] 敌人翻转索引已建立：' + Object.keys(map).length + ' 个');
  return map;
}

/** 反查敌人中文名：用翻转索引找 spineId 对应的页面名与 SPINEDATA name 。 */
export async function enemyNameFromId(enemyId, { onLog = () => {} } = {}) {
  const id = String(enemyId ?? '').trim();
  if (!isEnemyKey(id)) return null;
  try {
    const idx = await enemyIndex({ onLog });
    const hit = idx[id];
    if (hit) return { name: hit.name, pageTitle: hit.pageTitle };
  } catch (e) {
    if (onLog) onLog('[prts] 敌人名反查失败 ' + e.message);
  }
  return null;
}

export function normalizeCharKey(key) {
  const text = String(key ?? '').trim();
  if (!text) return null;
  if (/^char_\d+_/i.test(text)) return text;
  // Ark-Models 风格 key（如 002_amiya）-> char_002_amiya
  if (/^\d{3}_/.test(text)) return 'char_' + text;
  return text;
}

export async function resolveModelRef({ character, key, enemy, onLog } = {}) {
  const direct = normalizeCharKey(key);
  if (direct && isEnemyKey(direct)) {
    if (onLog) onLog(`[prts] 敌人模型 key: ${direct}（按 SPINEDATA 结构直接构造）`);
    return { charId: direct, meta: enemyMetaFromKey(direct), kind: 'enemy' };
  }
  if (direct && /^char_\d+_/i.test(direct)) {
    const meta = await fetchMeta(direct, { onLog });
    return { charId: direct, meta, kind: 'char' };
  }

  const query = String(enemy ?? character ?? key ?? '').trim();
  if (!query) throw new Error('需要 --character <干员名> / --enemy <敌人名> 或 --key <模型ID>');

  const pageUrl = `${WIKI}/w/${encodeURIComponent(query)}`;
  if (onLog) onLog(`[prts] 抓取页面 ${pageUrl}`);
  const html = (await fetchBytes(pageUrl)).toString('utf8');

  // 干员/敌方领袖（如 弑君者 char_1502_crosly）：spine-root data-id -> meta.json
  const charId = parseCharIdFromHtml(html);
  if (charId) {
    if (onLog) onLog(`[prts] 干员模型 ID: ${charId}`);
    const meta = await fetchMeta(charId, { onLog });
    return { charId, meta, kind: 'char' };
  }
  // 普通敌人（如 霜星 enemy_1505_frstar）：SPINEDATA 内嵌元数据
  const spinedata = parseSpineDataFromHtml(html);
  if (spinedata) {
    const enemyId = String(spinedata.prefix ?? '').replace(/\/+$/, '').split('/').pop() || query;
    if (onLog) onLog(`[prts] 敌人模型（SPINEDATA）: ${enemyId}`);
    return { charId: enemyId, meta: spinedata, kind: 'enemy' };
  }

  // 页面可能是重定向/消歧义页：用 MediaWiki 搜索找到精确标题后再试一次
  if (onLog) onLog('[prts] 页面没有模型挂载点，尝试 MediaWiki 搜索...');
  const api = `${WIKI}/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=10&format=json`;
  const res = JSON.parse((await fetchBytes(api)).toString('utf8'));
  const hits = (res?.query?.search ?? []).map((s) => s.title);
  for (const title of hits) {
    const html2 = (await fetchBytes(`${WIKI}/w/${encodeURIComponent(title)}`)).toString('utf8');
    const hitCharId = parseCharIdFromHtml(html2);
    if (hitCharId) {
      if (onLog) onLog(`[prts] 通过搜索命中干员页面「${title}」`);
      const meta = await fetchMeta(hitCharId, { onLog });
      return { charId: hitCharId, meta, kind: 'char' };
    }
    const hitSpine = parseSpineDataFromHtml(html2);
    if (hitSpine) {
      if (onLog) onLog(`[prts] 通过搜索命中敌人页面「${title}」`);
      const enemyId = String(hitSpine.prefix ?? '').replace(/\/+$/, '').split('/').pop() || title;
      return { charId: enemyId, meta: hitSpine, kind: 'enemy' };
    }
  }
  throw new Error(
    `无法在 PRTS 找到「${query}」的模型（页面无 #spine-root / SPINEDATA）。` +
      `可尝试: --key char_002_amiya 或 --key enemy_1505_frstar 直接指定模型 ID。`,
  );
}

export async function resolveCharId({ character, key, onLog } = {}) {
  const ref = await resolveModelRef({ character, key, onLog });
  return ref.charId;
}

// ---------- meta.json 与皮肤选择 ----------

export async function fetchMeta(charId, { onLog } = {}) {
  const url = `${TORAPPU}/assets/char_spine/${charId}/meta.json`;
  if (onLog) onLog(`[prts] 抓取模型元数据 ${url}`);
  const text = (await fetchBytes(url)).toString('utf8');
  const meta = JSON.parse(text);
  if (!meta || typeof meta !== 'object' || !meta.skin || typeof meta.skin !== 'object') {
    throw new Error(`meta.json 结构异常（缺少 skin 字段）: ${charId}`);
  }
  return meta;
}

export function pickSkinView(meta, { skin, view } = {}) {
  const skins = Object.keys(meta.skin ?? {});
  if (skins.length === 0) throw new Error(`角色 ${meta.name ?? meta.prefix} 没有可用皮肤`);

  let skinKey = null;
  const want = String(skin ?? '').trim();
  if (want) {
    const exact = skins.find((s) => s === want);
    const partial = skins.find((s) => s.includes(want) || want.includes(s));
    skinKey = exact ?? partial ?? null;
    if (!skinKey) throw new Error(`皮肤「${want}」不存在。可用: ${skins.join(' / ')}`);
  } else {
    skinKey = skins.includes('默认') ? '默认' : skins[0];
  }

  const views = meta.skin[skinKey] ?? {};
  const viewNames = Object.keys(views);
  const wantView = String(view ?? '').trim();
  let viewKey = null;
  if (wantView) {
    viewKey = viewNames.find((v) => v === wantView) ?? null;
    if (!viewKey) throw new Error(`皮肤「${skinKey}」没有视图「${wantView}」。可用: ${viewNames.join(' / ')}`);
  } else {
    viewKey = VIEW_PRIORITY.find((v) => viewNames.includes(v)) ?? viewNames[0];
  }
  return { skin: skinKey, view: viewKey, file: views[viewKey]?.file ?? null };
}

// ---------- atlas 多页 PNG ----------

export function listAtlasPages(atlasText) {
  const pages = [];
  for (const line of String(atlasText).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/\.png$/i.test(trimmed) && !/^\s/.test(line)) pages.push(trimmed);
  }
  return [...new Set(pages)];
}

// ---------- 三件套下载 ----------

async function existsFile(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}


const DONE_MSG = '[prts] \u5b8c\u6210\uff1a';

const SKIN_NOT_EXIST = '\u4e0d\u5b58\u5728\u3002\u53ef\u7528: ';
const NO_VIEWS = '\u6ca1\u6709\u53ef\u7528\u89c6\u56fe';
const VIEW_NO_FILE = '\u7f3a\u5c11 file \u5b57\u6bb5\uff0c\u8df3\u8fc7';
const VIEW_FAIL = '\u89c6\u56fe\u300c';
const VIEW_FAIL2 = '\u300d\u4e0b\u8f7d\u5931\u8d25\uff1a';
const ALL_FAIL = '\u5168\u90e8\u89c6\u56fe\u4e0b\u8f7d\u5931\u8d25';

const SKIP_MSG = '[prts] \u5df2\u6709 ';
const DOWN_MSG = '[prts] \u4e0b\u8f7d ';
const OK_MSG = '[prts] OK ';
const KB_MSG = ' KB';
const ATLAS_ERR = 'atlas \u672a\u53d1\u73b0\u8d34\u56fe\u9875: ';
const ALIGN_MSG = '[prts] \u81ea\u52a8\u5bf9\u9f50\u8d34\u56fe\uff1a';
const ALIGN_SKIP = '[align] \u8df3\u8fc7\u5bf9\u9f50\uff1a';
const SPINE_ERR = 'PRTS \u6a21\u578b ';
const SPINE_ERR2 = ' \u662f Spine ';
const SPINE_ERR3 = ' \u683c\u5f0f\uff0c\u5f53\u524d\u64ad\u653e\u5668\u4ec5\u652f\u6301 3.8.x\u3002';
const META_FAIL = '[prts] \u4fdd\u5b58 meta.json \u5931\u8d25\uff1a';
const ENRICH_MSG = '[prts] \u8d44\u6599\u5df2\u8865\u5168\uff1a';
const ENRICH_SKIP = '[prts] \u8d44\u6599\u8865\u5168\u8df3\u8fc7\uff1a';
const ART_SKIP = '[prts] \u7f8e\u672f\u4e0b\u8f7d\u8df3\u8fc7\uff1a';

const VIEW_TAG = { '\u6b63\u9762': 'front', '\u80cc\u9762': 'back', '\u57fa\u5efa': 'build', '\u6218\u6597': 'battle', '\u9ed8\u8ba4': 'default' };

async function downloadView({ charId, meta, kind, skinKey, viewKey, file, targetDir, prefix, force, onLog, usedBases, tag = '' }) {
  const rawBase = basename(file);
  let base = rawBase;
  let renamed = false;
  if (usedBases && usedBases.has(rawBase) && tag) {
    base = rawBase + tag;
    renamed = true;
  }
  if (usedBases) usedBases.add(rawBase);
  const files = { skel: join(targetDir, base + '.skel'), atlas: join(targetDir, base + '.atlas') };
  for (const ext of EXTS) {
    const url = `${prefix}${file}${ext}`;
    const target = files[ext.slice(1)];
    if (!force && (await existsFile(target))) {
      if (onLog) onLog(SKIP_MSG + basename(target) + '\uff08--force \u53ef\u5f3a\u5236\u91cd\u4e0b\uff09');
      continue;
    }
    if (onLog) onLog(DOWN_MSG + url);
    const bytes = await fetchBytes(url);
    await writeFile(target, bytes);
    if (onLog) onLog(OK_MSG + basename(target) + '  ' + (bytes.length / 1024).toFixed(0) + KB_MSG);
  }
  const rawAtlasText = (await readFile(files.atlas, 'utf8')).toString();
  const origPages = listAtlasPages(rawAtlasText);
  if (origPages.length === 0) throw new Error(ATLAS_ERR + files.atlas);
  let atlasText = rawAtlasText;
  if (renamed) {
    atlasText = rawAtlasText.replace(/^([A-Za-z0-9_\-.\/]+\.png)\s*$/gm, (m0, pname) => {
      const nm = pname.split('/').pop();
      return pname.replace(nm, nm.replace(/\.png$/i, tag + '.png'));
    });
    await writeFile(files.atlas, atlasText);
  }
  const pages = listAtlasPages(atlasText);
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const localName = page;
    const urlPage = origPages[pi] ?? page;
    const target = join(targetDir, localName);
    if (!force && (await existsFile(target))) { if (onLog) onLog(SKIP_MSG + localName + '\uff0c\u8df3\u8fc7'); continue; }
    const url = `${prefix}${file.replace(/[^/]*$/, '')}${urlPage}`;
    if (onLog) onLog(DOWN_MSG + url);
    const bytes = await fetchBytes(url);
    await writeFile(target, bytes);
    if (onLog) onLog(OK_MSG + localName + '  ' + (bytes.length / 1024).toFixed(0) + KB_MSG);
  }
  try {
    const { alignAssetsInPlace } = await import('./align.mjs');
    const pngPath = join(targetDir, pages[0]);
    const align = alignAssetsInPlace({ atlasPath: files.atlas, pngPath, onLog });
    if (align.aligned && onLog) onLog(ALIGN_MSG + align.action + ' ' + align.from + ' -> ' + align.to);
  } catch (alignErr) { if (onLog) onLog(ALIGN_SKIP + alignErr.message); }
  const { parseSkeleton } = await import('./skel.mjs');
  const skelBytes = new Uint8Array(await readFile(files.skel));
  const version = parseSkeleton(skelBytes).version ?? '';
  if (!version.startsWith('3.8')) {
    throw new Error(SPINE_ERR + charId + SPINE_ERR2 + version + SPINE_ERR3);
  }
  return {
    base, view: viewKey, skin: skinKey,
    skel: files.skel, atlas: files.atlas, png: join(targetDir, pages[0]),
    version, animations: parseSkeleton(skelBytes).animations?.map((a) => ({ name: a.name, duration: a.duration })) ?? [],
  };
}

async function writeMetaAndEnrich({ charId, meta, kind, targetDir, onLog = console.log }) {
  try {
    await writeFile(join(targetDir, 'meta.json'), JSON.stringify({ charId, name: meta.name ?? charId, kind, prefix: meta.prefix, skin: meta.skin, fetchedAt: new Date().toISOString() }, null, 2));
  } catch (metaErr) { if (onLog) onLog(META_FAIL + metaErr.message); }
  try {
    const { enrichCharMeta, enrichEnemyMeta } = await import('./info.mjs');
    const extra = kind === 'char' ? await enrichCharMeta(charId) : (meta.name && meta.name !== charId ? await enrichEnemyMeta(meta.name) : null);
    if (extra && extra.info && Object.keys(extra.info).length) {
      const info = extra.info;
      const merged = { charId, name: meta.name ?? charId, kind, prefix: meta.prefix, skin: meta.skin, fetchedAt: new Date().toISOString() };
      merged.info = info; merged.pageTitle = extra.pageTitle;
      merged.class = info['\u804c\u4e1a'] || '';
      merged.rarity = parseInt(info['\u7a00\u6709\u5ea6'], 10) || 0;
      merged.branch = info['\u5206\u652f'] || info['\u5b50\u804c\u4e1a'] || '';
      merged.faction = info['\u6240\u5c5e\u56fd\u5bb6'] || info['\u6240\u5c5e\u7ec4\u7ec7'] || '';
      merged.position = info['\u4f4d\u7f6e'] || '';
      merged.tags = info['\u6807\u7b7e'] || '';
      merged.trait = info['\u7279\u6027'] || '';
      merged.enemyLevel = info['\u5730\u4f4d\u7ea7\u522b'] || '';
      merged.enemyType = info['\u4f24\u5bb3\u7c7b\u578b'] || '';
      merged.enemyAttack = info['\u653b\u51fb\u65b9\u5f0f'] || '';
      merged.enemyMove = info['\u884c\u52a8\u65b9\u5f0f'] || '';
      merged.description = info['\u63cf\u8ff0'] || '';
      merged.stats = extra.stats || null;
      try {
        const { enrichArt } = await import('./info.mjs');
        const art = await enrichArt({ charId, name: merged.name, pageTitle: extra.pageTitle, kind, meta: merged, dirPath: targetDir, onLog });
        if (art) merged.art = art;
      } catch (artErr) {
        if (onLog) onLog(ART_SKIP + artErr.message);
      }
      await writeFile(join(targetDir, 'meta.json'), JSON.stringify(merged, null, 2));
      if (onLog) onLog(ENRICH_MSG + extra.pageTitle);
    }
  } catch (enrichErr) {
    if (onLog) onLog(ENRICH_SKIP + enrichErr.message);
  }
}

export async function fetchCharacterFromPrts({ character, key, enemy, skin, view, outDir = join(root, 'assets'), force = false, onLog = console.log } = {}) {
  const { charId, meta, kind } = await resolveModelRef({ character, key, enemy, onLog });
  const chosen = pickSkinView(meta, { skin, view });
  if (!chosen.file) throw new Error('\u76ae\u80a4\u300c' + chosen.skin + '\u300d\u89c6\u56fe\u300c' + chosen.view + '\u300d\u7f3a\u5c11 file \u5b57\u6bb5');
  const targetDir = resolve(outDir, charId);
  await mkdir(targetDir, { recursive: true });
  const prefix = meta.prefix;
  const v = await downloadView({ charId, meta, kind, skinKey: chosen.skin, viewKey: chosen.view, file: chosen.file, targetDir, prefix, force, onLog, usedBases: new Set() });
  const result = {
    skel: v.skel, atlas: v.atlas, png: v.png, dir: targetDir,
    characterName: meta.name ?? charId, charId, kind, skin: chosen.skin, view: chosen.view,
    version: v.version, animations: v.animations,
  };
  await writeMetaAndEnrich({ charId, meta, kind, targetDir, onLog });
  if (onLog) onLog(DONE_MSG + result.characterName + '\uff08' + charId + ' / ' + chosen.skin + ' / ' + chosen.view + '\uff0cSpine ' + v.version + '\uff09');
  return result;
}

export async function fetchAllViewsFromPrts({ character, key, enemy, skin, outDir = join(root, 'assets'), force = false, onLog = console.log } = {}) {
  const { charId, meta, kind } = await resolveModelRef({ character, key, enemy, onLog });
  const skins = Object.keys(meta.skin ?? {});
  if (skins.length === 0) throw new Error('\u89d2\u8272 ' + (meta.name ?? meta.prefix) + ' \u6ca1\u6709\u53ef\u7528\u76ae\u80a4');
  let skinKey = String(skin ?? '').trim();
  if (skinKey) {
    const exact = skins.find((s) => s === skinKey);
    const partial = skins.find((s) => s.includes(skinKey) || skinKey.includes(s));
    skinKey = exact ?? partial ?? null;
    if (!skinKey) throw new Error('\u76ae\u80a4\u300c' + skin + '\u300d' + SKIN_NOT_EXIST + skins.join(' / '));
  } else {
    skinKey = skins.includes('\u9ed8\u8ba4') ? '\u9ed8\u8ba4' : skins[0];
  }
  const views = meta.skin[skinKey] ?? {};
  const viewNames = Object.keys(views);
  if (!viewNames.length) throw new Error('\u76ae\u80a4\u300c' + skinKey + '\u300d' + NO_VIEWS);
  const targetDir = resolve(outDir, charId);
  await mkdir(targetDir, { recursive: true });
  const prefix = meta.prefix;
  const all = [];
  const usedBases = new Set();
  for (const viewKey of viewNames) {
    const file = views[viewKey]?.file ?? null;
    if (!file) { if (onLog) onLog('[prts] \u89c6\u56fe\u300c' + viewKey + '\u300d' + VIEW_NO_FILE); continue; }
    try {
      const tag = '_' + (VIEW_TAG[viewKey] || 'v') + '_' + String(viewNames.indexOf(viewKey));
      const v = await downloadView({ charId, meta, kind, skinKey, viewKey, file, targetDir, prefix, force, onLog, usedBases, tag });
      all.push(v);
    } catch (e) { if (onLog) onLog('[prts] ' + VIEW_FAIL + viewKey + VIEW_FAIL2 + e.message); }
  }
  if (!all.length) throw new Error('\u76ae\u80a4\u300c' + skinKey + '\u300d' + ALL_FAIL);
  await writeMetaAndEnrich({ charId, meta, kind, targetDir, onLog });
  if (onLog) onLog(DONE_MSG + (meta.name ?? charId) + '\uff08' + charId + ' / ' + skinKey + ' / \u5168\u90e8\u89c6\u56fe\uff0c' + all.length + ' \u4e2a\uff09');
  return {
    charId, characterName: meta.name ?? charId, kind, skin: skinKey, dir: targetDir,
    version: all[0].version,
    views: all,
  };
}

export async function listSkinsFromPrts({ character, key, enemy, onLog = console.log } = {}) {
  const { charId, meta, kind } = await resolveModelRef({ character, key, enemy, onLog });
  const lines = [`${kind === 'enemy' ? '敌人' : '角色'}: ${meta.name ?? charId}  (${charId})`];
  for (const [skinName, views] of Object.entries(meta.skin ?? {})) {
    const viewDesc = Object.entries(views ?? {})
      .map(([v, f]) => `${v}=${basename(f?.file ?? '')}`)
      .join('  ');
    lines.push(`  ${skinName}   ${viewDesc}`);
  }
  onLog(lines.join('\n'));
  return meta;
}

// ---------- CLI ----------

export async function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes(name);
  const character = flag('--character');
  const key = flag('--key');
  const enemy = flag('--enemy');

  const skin = flag('--skin');
  const view = flag('--view');
  const outDir = flag('--out') || join(root, 'assets');
  const force = has('--force');

  if (has('--list-skins')) {
    await listSkinsFromPrts({ character, key, enemy });
    return;
  }
  const result = await fetchCharacterFromPrts({ character, key, enemy, skin, view, outDir, force });
  console.log(`[done] ${result.characterName}（${result.kind === 'enemy' ? '敌人' : '干员'} ${result.charId} / ${result.skin} / ${result.view}）→ ${result.dir}`);
  console.log(`  skel  ${result.skel}`);
  console.log(`  atlas ${result.atlas}`);
  console.log(`  png   ${result.png}`);
  console.log(`  动画  ${result.animations.map((a) => `${a.name}(${a.duration.toFixed(2)}s)`).join('  ')}`);
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    console.error(`\n[error] ${error.message}`);
    process.exit(1);
  });
}