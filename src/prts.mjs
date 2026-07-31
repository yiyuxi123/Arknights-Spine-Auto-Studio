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

export async function fetchCharacterFromPrts({ character, key, enemy, skin, view, outDir = join(root, 'assets'), force = false, onLog = console.log } = {}) {
  const { charId, meta, kind } = await resolveModelRef({ character, key, enemy, onLog });
  const chosen = pickSkinView(meta, { skin, view });
  if (!chosen.file) throw new Error(`皮肤「${chosen.skin}」视图「${chosen.view}」缺少 file 字段`);

  const targetDir = resolve(outDir, charId);
  await mkdir(targetDir, { recursive: true });
  const prefix = meta.prefix;
  const base = basename(chosen.file); // e.g. build_char_002_amiya
  const urls = {
    skel: `${prefix}${chosen.file}.skel`,
    atlas: `${prefix}${chosen.file}.atlas`,
  };
  const files = { skel: join(targetDir, base + '.skel'), atlas: join(targetDir, base + '.atlas') };

  // 下载 skel + atlas
  for (const kind of EXTS) {
    const ext = kind; // '.skel' | '.atlas'
    const url = urls[ext.slice(1)];
    const target = files[ext.slice(1)];
    if (!force && (await existsFile(target))) {
      if (onLog) onLog(`[prts] 已有 ${basename(target)}，跳过（--force 可强制重下）`);
      continue;
    }
    if (onLog) onLog(`[prts] 下载 ${url}`);
    const bytes = await fetchBytes(url);
    await writeFile(target, bytes);
    if (onLog) onLog(`[prts] OK ${basename(target)}  ${(bytes.length / 1024).toFixed(0)} KB`);
  }

  // 解析 atlas 得到所有贴图页并下载
  const atlasText = (await readFile(files.atlas, 'utf8')).toString();
  const pages = listAtlasPages(atlasText);
  if (pages.length === 0) throw new Error(`atlas 未发现贴图页: ${files.atlas}`);
  for (const page of pages) {
    const target = join(targetDir, page);
    if (!force && (await existsFile(target))) {
      if (onLog) onLog(`[prts] 已有 ${page}，跳过`);
      continue;
    }
    const url = `${prefix}${chosen.file.replace(/[^/]*$/, '')}${page}`;
    if (onLog) onLog(`[prts] 下载 ${url}`);
    const bytes = await fetchBytes(url);
    await writeFile(target, bytes);
    if (onLog) onLog(`[prts] OK ${page}  ${(bytes.length / 1024).toFixed(0)} KB`);
  }

  // 校验 skel 版本兼容（Spine 3.8 播放器）
    // 对齐 atlas 声明尺寸与实际 PNG 尺寸（PRTS 常把贴图降采样到 2/3，不修复会渲染散架）
  try {
    const { alignAssetsInPlace } = await import('./align.mjs');
    const pngPath = join(targetDir, pages[0]);
    const align = alignAssetsInPlace({ atlasPath: files.atlas, pngPath, onLog });
    if (align.aligned) {
      if (onLog) onLog(`[prts] 自动对齐贴图：${align.action} ${align.from} -> ${align.to}`);
    }
  } catch (alignErr) {
    if (onLog) onLog(`[align] 跳过对齐：${alignErr.message}`);
  }

const { parseSkeleton } = await import('./skel.mjs');
  const skelBytes = new Uint8Array(await readFile(files.skel));
  const version = parseSkeleton(skelBytes).version ?? '';
  if (!version.startsWith('3.8')) {
    throw new Error(
      `PRTS 模型 ${charId} 是 Spine ${version} 格式，当前播放器仅支持 3.8.x。` +
        `可尝试下载 spine38 版本资源或升级播放器。`,
    );
  }

  const result = {
    skel: files.skel,
    atlas: files.atlas,
    png: join(targetDir, pages[0]),
    dir: targetDir,
    characterName: meta.name ?? charId,
    charId,
    kind,
    skin: chosen.skin,
    view: chosen.view,
    version,
    animations: parseSkeleton(skelBytes).animations?.map((a) => ({ name: a.name, duration: a.duration })) ?? [],
  };
  if (onLog) onLog(`[prts] 完成：${result.characterName}（${charId} / ${chosen.skin} / ${chosen.view}，Spine ${version}）`);
  return result;
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