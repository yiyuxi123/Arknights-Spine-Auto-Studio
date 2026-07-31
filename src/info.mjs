// PRTS info enrichment: fetch operator/enemy profile pages (SMW + wikitext)
// and enrich local meta.json with class/rarity/faction/stats etc.
//   char  - SMW ask (charId -> page title) + CharinfoV2 full fields
//   enemy - page wikitext "敌人信息/common2" + level-0 stats
import { fetchBytes, isEnemyKey } from './prts.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const WIKI = 'https://prts.wiki';

export async function fetchWikitext(title) {
  const url = WIKI + '/api.php?action=parse&page=' + encodeURIComponent(String(title)) + '&format=json&prop=wikitext&redirects=1';
  const j = JSON.parse((await fetchBytes(url)).toString('utf8'));
  if (j.error || !j.parse) return { ok: false, title: String(title), error: (j.error && j.error.info) || 'parse failed' };
  return { ok: true, title: j.parse.title, wikitext: j.parse.wikitext?.['*'] || '' };
}

/** 清理模板语法：color/链接/小模板/注释/<br> */
export function cleanWikiText(text) {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{color\|[^}]*\|([\s\S]*?)\}\}/g, '$1')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\{\{([^{}]*)\}\}/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[\t ]+$/gm, '')
    .trim();
}

/** 提取第一个指定模板内的所有 |key=value 字段 */
export function parsePipeFields(wikitext, template) {
  const text = String(wikitext);
  const idx = text.indexOf('{{' + template);
  if (idx < 0) return null;
  const start = text.indexOf('\n', idx) + 1;
  const end = text.indexOf('\n}}', start);
  const body = end > 0 ? text.slice(start, end) : text.slice(start, start + 30000);
  const fields = {};
  for (const raw of body.split('\n')) {
    const line = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
    const m = line.match(/^\|([^=]+?)\s*=\s*([\s\S]*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = cleanWikiText(m[2]);
    if (key && !(key in fields)) fields[key] = val;
  }
  return fields;
}

/** SMW：干员id → 页面标题 + 基本属性 */
export async function smwFindChar(charId) {
  const q = '[[' + '\u5e72\u5458id::' + charId + ']]|?\u5e72\u5458\u540d|?\u804c\u4e1a|?\u7a00\u6709\u5ea6|?\u4f4d\u7f6e|?\u6807\u7b7e|?\u5b50\u804c\u4e1a';
  const url = WIKI + '/api.php?action=ask&query=' + encodeURIComponent(q) + '&format=json';
  const j = JSON.parse((await fetchBytes(url)).toString('utf8'));
  const results = (j.query && j.query.results) || {};
  const titles = Object.keys(results);
  if (!titles.length) return null;
  const title = titles[0];
  const po = results[title]?.printouts || {};
  return {
    pageTitle: title,
    name: po['\u5e72\u5458\u540d']?.[0] || title,
    props: {
      '\u804c\u4e1a': po['\u804c\u4e1a']?.[0] || '',
      '\u7a00\u6709\u5ea6': po['\u7a00\u6709\u5ea6']?.[0] || '',
      '\u4f4d\u7f6e': po['\u4f4d\u7f6e']?.[0] || '',
      '\u6807\u7b7e': po['\u6807\u7b7e']?.[0] || '',
      '\u5b50\u804c\u4e1a': po['\u5b50\u804c\u4e1a']?.[0] || '',
    },
  };
}

/** 干员：SMW 定位页面 + CharinfoV2 全字段 */
export async function enrichCharMeta(charId) {
  const found = await smwFindChar(charId);
  if (!found) return null;
  const page = await fetchWikitext(found.pageTitle);
  if (!page.ok) return null;
  const info = parsePipeFields(page.wikitext, 'CharinfoV2') || {};
  // SMW 补充 wikitext 缺失字段
  for (const [k, v] of Object.entries(found.props)) {
    if (v && !info[k]) info[k] = v;
  }
  if (!info['\u5e72\u5458\u540d']) info['\u5e72\u5458\u540d'] = found.name;
  return { pageTitle: page.title, info };
}

/** 敌人：页面 《敌人信息/common2》 + 级别0 数值 */
export async function enrichEnemyMeta(name) {
  const page = await fetchWikitext(name);
  if (!page.ok) return null;
  const info = parsePipeFields(page.wikitext, '\u654c\u4eba\u4fe1\u606f/common2') || {};
  const lv = parsePipeFields(page.wikitext, '\u654c\u4eba\u4fe1\u606f/levelcontent');
  const statKeys = ['\u6700\u5927\u751f\u547d\u503c', '\u653b\u51fb\u529b', '\u9632\u5fa1\u529b', '\u6cd5\u672f\u6297\u6027', '\u79fb\u52a8\u901f\u5ea6', '\u653b\u51fb\u95f4\u9694', '\u91cd\u91cf\u7b49\u7ea7', '\u653b\u51fb\u8303\u56f4\u534a\u5f84', '\u6570\u91cf', '\u751f\u547d\u6062\u590d\u901f\u5ea6', 'sp\u6062\u590d\u901f\u5ea6', '\u635f\u4f24\u62b5\u6297', '\u5143\u7d20\u6297\u6027', '\u57fa\u7840\u5632\u8bbd\u7b49\u7ea7', '\u7729\u6655\u6297\u6027', '\u6c89\u9ed8\u6297\u6027', '\u6c89\u7761\u6297\u6027', '\u51bb\u7ed3\u6297\u6027', '\u6d6e\u7a7a\u6297\u6027', '\u6218\u6150\u6297\u6027', '\u6050\u60e7\u6297\u6027', '\u9ebb\u75f9\u6297\u6027', '\u8bf1\u5bfc\u6297\u6027', '\u6280\u80fd0', '\u6280\u80fd0\u6548\u679c', '\u6280\u80fd0\u521d\u59cb', '\u6280\u80fd0\u6d88\u8017', '\u6280\u80fd1', '\u6280\u80fd1\u6548\u679c', '\u6280\u80fd1\u521d\u59cb', '\u6280\u80fd1\u6d88\u8017'];
  const stats = {};
  if (lv) for (const k of statKeys) if (lv[k] !== undefined) stats[k] = lv[k];
  return { pageTitle: page.title, info, stats };
}

/** 对本地模型库全量补全资料（并写回各目录 meta.json） */
export async function enrichAllLocal(assetsDir, { onLog = () => {} } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const results = [];
  let dirs = [];
  try { dirs = fs.readdirSync(assetsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch (e) { return results; }
  for (const dir of dirs) {
    const dirPath = path.join(assetsDir, dir);
    const metaFile = path.join(dirPath, 'meta.json');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { meta = null; }
    let charId = dir;
    if (/^\d{3}_/.test(dir)) charId = 'char_' + dir;
    if (dir === 'amiya') charId = 'char_002_amiya';
    const enemy = isEnemyKey(charId);
    if (!meta && !enemy) {
      try {
        const { fetchMeta } = await import('./prts.mjs');
        const tor = await fetchMeta(charId);
        meta = { charId, name: tor.name || charId, kind: 'char', prefix: tor.prefix, skin: tor.skin };
      } catch (e) {
        onLog('[enrich] ' + dir + ': 拉取 meta 失败 ' + e.message);
      }
    }
    if (!meta && enemy) {
      // 敌人目录无 meta.json：按 SPINEDATA 结构构造，并尝试反查中文名
      try {
        const { enemyMetaFromKey, enemyNameFromId } = await import('./prts.mjs');
        meta = enemyMetaFromKey(charId);
        const found = await enemyNameFromId(charId, { onLog });
        if (found) { meta.name = found.name; meta.pageTitle = found.pageTitle; }
        else { meta.name = charId; }
        meta.kind = 'enemy';
      } catch (e) {
        onLog('[enrich] ' + dir + ': 敌人 meta 构造失败 ' + e.message);
      }
    }
    if (!meta) { results.push({ dir, ok: false, reason: 'no-meta' }); continue; }
    let extra = null;
    try {
      if (enemy || meta.kind === 'enemy') {
        extra = meta.name && meta.name !== charId ? await enrichEnemyMeta(meta.name) : null;
      } else {
        extra = await enrichCharMeta(charId);
      }
    } catch (e) {
      onLog('[enrich] ' + dir + ': ' + e.message);
    }
    meta.updatedAt = new Date().toISOString();
    if (!extra || !extra.info || !Object.keys(extra.info).length) {
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      results.push({ dir, ok: false, reason: 'no-info' });
      continue;
    }
    meta.info = extra.info;
    meta.pageTitle = extra.pageTitle;
    meta.class = extra.info['\u804c\u4e1a'] || '';
    meta.rarity = parseInt(extra.info['\u7a00\u6709\u5ea6'], 10) || 0;
    meta.branch = extra.info['\u5206\u652f'] || extra.info['\u5b50\u804c\u4e1a'] || '';
    meta.faction = extra.info['\u6240\u5c5e\u56fd\u5bb6'] || extra.info['\u6240\u5c5e\u7ec4\u7ec7'] || '';
    meta.position = extra.info['\u4f4d\u7f6e'] || '';
    meta.tags = extra.info['\u6807\u7b7e'] || '';
    meta.trait = extra.info['\u7279\u6027'] || '';
    meta.enemyLevel = extra.info['\u5730\u4f4d\u7ea7\u522b'] || '';
    meta.enemyType = extra.info['\u4f24\u5bb3\u7c7b\u578b'] || '';
    meta.enemyAttack = extra.info['\u653b\u51fb\u65b9\u5f0f'] || '';
    meta.enemyMove = extra.info['\u884c\u52a8\u65b9\u5f0f'] || '';
    meta.description = extra.info['\u63cf\u8ff0'] || '';
    meta.stats = extra.stats || null;
    meta.enrichedAt = new Date().toISOString();
    // 美术资源（头像/精英立绘/皮肤立绘/职业图标）
    try {
      const art = await enrichArt({ charId, name: meta.name || charId, pageTitle: meta.pageTitle, kind: meta.kind || (enemy ? 'enemy' : 'char'), meta, dirPath });
      if (art) meta.art = art;
    } catch (artErr) {
      onLog('[enrich] ' + dir + ': 美术下载跳过 ' + artErr.message);
    }
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    results.push({ dir, ok: true, name: meta.name || charId, class: meta.class, rarity: meta.rarity, faction: meta.faction, enemyLevel: meta.enemyLevel, pageTitle: meta.pageTitle });
    onLog('[enrich] ' + dir + ': ' + (meta.name || charId) + ' ✓');
  }
  return results;
}

// ===========================================================================
// 美术资源：头像 / 精英立绘 / 皮肤立绘 / 职业图标
// ===========================================================================

/** MediaWiki imageinfo：文件标题 → 直连 URL（未知文件返回 null） */
export async function imageInfo(title) {
  const url = WIKI + '/api.php?action=query&titles=' + encodeURIComponent('File:' + title) + '&prop=imageinfo&iiprop=url|size&format=json';
  const j = JSON.parse((await fetchBytes(url)).toString('utf8'));
  const p0 = Object.values((j.query && j.query.pages) || {})[0];
  if (!p0 || p0.missing || !p0.imageinfo || !p0.imageinfo[0]) return null;
  const ii = p0.imageinfo[0];
  return { url: String(ii.url || '').replace(/^\/\//, 'https://'), width: ii.width || 0, height: ii.height || 0, name: String(p0.title || '').replace(/^\u6587\u4ef6:/, '') };
}

async function saveArt(artDir, file, url, onLog) {
  if (!url) return null;
  try {
    const buf = await fetchBytes(url);
    fs.writeFileSync(artDir + '/' + file, buf);
    return file;
  } catch (e) {
    if (onLog) onLog('[art] ' + file + ' 下载失败: ' + e.message);
    return null;
  }
}

/** 爬取干员/敌人美术并存入 <dir>/art/；返回 meta.art 字典（相对文件名） */
export async function enrichArt({ charId, name, pageTitle, kind, meta = {}, dirPath, onLog = () => {} } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const artDir = path.join(dirPath, 'art');
  try { fs.mkdirSync(artDir, { recursive: true }); } catch { return null; }
  const art = { avatar: null, elite: [], classIcon: null, branchIcon: null, skins: {}, portrait: null };
  const enemy = isEnemyKey(charId) || kind === 'enemy';
  if (!enemy) {
    if (name) {
      const av = await imageInfo('\u5934\u50cf ' + name + '.png');
      if (av) art.avatar = await saveArt(artDir, 'avatar.png', av.url, onLog);
    }
    for (const n of [1, 2, 3]) {
      const ii = await imageInfo('Avg ' + charId + ' ' + n + '.png');
      if (ii) art.elite.push(await saveArt(artDir, 'elite' + n + '.png', ii.url, onLog));
    }
    const br = String(meta.branch || meta.info?.['\u5206\u652f'] || meta.info?.['\u5b50\u804c\u4e1a'] || '').trim();
    if (br) {
      const bi = await imageInfo('\u804c\u4e1a\u5206\u652f\u56fe\u6807_' + br + '.png');
      if (bi) art.branchIcon = await saveArt(artDir, 'branch.png', bi.url, onLog);
    }
    // 皮肤立绘：每个皮肤的「正面」文件名 → Avg <base> 1.png
    const seen = new Set();
    for (const [sname, views] of Object.entries(meta.skin || {})) {
      if (!views || typeof views !== 'object') continue;
      const file = String(views['\u6b63\u9762']?.file || views['front']?.file || '');
      if (!file) continue;
      const base = String(file).split('/').pop();
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const si = await imageInfo('Avg ' + base + ' 1.png');
      if (si) {
        const f = 'skin_' + base.replace(/[^\w\-]/g, '_') + '.png';
        const saved = await saveArt(artDir, f, si.url, onLog);
        if (saved) art.skins[sname] = saved;
      }
    }
    art.portrait = art.elite.length ? art.elite[art.elite.length - 1] : art.avatar;
  } else {
    // 敌人：页面第一张图（立绘/缩略图）
    if (pageTitle) {
      const page = await fetchWikitext(pageTitle);
      if (page.ok) {
        const m = page.wikitext.match(/\[\[\u6587\u4ef6:([^\]|]+?)\.(png|jpg|jpeg|webp)[^\]]*?\]\]/i);
        if (m) {
          const ii = await imageInfo(m[1] + '.' + m[2].toLowerCase());
          if (ii) art.portrait = await saveArt(artDir, 'portrait.png', ii.url, onLog);
        }
      }
    }
    if (!art.portrait) {
      // 退而求其次：按 SPINE id 推测（enemy_1505_frstar -> Avg char 1505 frstar 1.png）
      const guess = 'Avg char ' + String(charId).replace(/^enemy_/i, '').replace(/_/g, ' ') + ' 1.png';
      const gi = await imageInfo(guess);
      if (gi) art.portrait = await saveArt(artDir, 'portrait.png', gi.url, onLog);
    }
    if (!art.portrait) art.portrait = art.avatar;
  }
  return art;
}