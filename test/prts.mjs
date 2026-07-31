// Unit tests for the PRTS fetcher (src/prts.mjs): pure parsing helpers,
// no network required.
import { parseCharIdFromHtml, parseSpineDataFromHtml, isEnemyKey, enemyMetaFromKey, normalizeCharKey, listAtlasPages, pickSkinView } from '../src/prts.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

// --- parseCharIdFromHtml ---
{
  check('parseCharIdFromHtml: basic', parseCharIdFromHtml('<div id="spine-root" data-id="char_002_amiya"></div>') === 'char_002_amiya');
  check('parseCharIdFromHtml: attribute order', parseCharIdFromHtml('<div class="x" data-id="char_102_texas" id="spine-root">') === 'char_102_texas');
  check('parseCharIdFromHtml: no root -> null', parseCharIdFromHtml('<html><body>nothing</body></html>') === null);
  check('parseCharIdFromHtml: empty -> null', parseCharIdFromHtml('') === null);
}

// --- normalizeCharKey ---
{
  check('normalizeCharKey: char id passthrough', normalizeCharKey('char_002_amiya') === 'char_002_amiya');
  check('normalizeCharKey: 3-digit ark-models style', normalizeCharKey('002_amiya') === 'char_002_amiya');
  check('normalizeCharKey: name stays', normalizeCharKey('阿米娅') === '阿米娅');
  check('normalizeCharKey: empty -> null', normalizeCharKey('') === null);
  check('normalizeCharKey: undefined -> null', normalizeCharKey(undefined) === null);
}

// --- listAtlasPages ---
{
  const atlas = `amiya.png
size: 512,512
format: RGBA8888
filter: Linear,Linear
repeat: none
Head
  rotate: false
  xy: 0, 0
  size: 100, 100
  orig: 100, 100
  offset: 0, 0
  index: -1
amiya2.png
size: 256,256
format: RGBA8888
filter: Linear,Linear
repeat: none
Tail
  rotate: false
  xy: 0, 0
  size: 50, 50
  orig: 50, 50
  offset: 0, 0
  index: -1
`;
  const pages = listAtlasPages(atlas);
  check('listAtlasPages: two pages', pages.length === 2 && pages[0] === 'amiya.png' && pages[1] === 'amiya2.png');
  check('listAtlasPages: dedupe', listAtlasPages(`a.png\n  xy: 0, 0\n  size: 1, 1\na.png\n`).length === 1);
  check('listAtlasPages: no png -> empty', listAtlasPages('size: 10,10\n').length === 0);
}

// --- pickSkinView ---
{
  const meta = {
    prefix: 'https://cdn.example/assets/char_002_amiya/',
    name: '阿米娅',
    skin: {
      默认: { 正面: { file: 'defaultskin/front/char_002_amiya' }, 基建: { file: 'defaultskin/build/build_char_002_amiya' } },
      报童: { 基建: { file: 'char_002_amiya_winter_1/build/build_char_002_amiya_winter_1' } },
    },
  };
  const def = pickSkinView(meta, {});
  check('pickSkinView: default skin+view', def.skin === '默认' && def.view === '基建' && def.file === 'defaultskin/build/build_char_002_amiya');
  const explicit = pickSkinView(meta, { skin: '报童', view: '基建' });
  check('pickSkinView: explicit', explicit.skin === '报童' && explicit.view === '基建' && explicit.file.includes('winter_1'));
  const partial = pickSkinView(meta, { skin: '报' });
  check('pickSkinView: partial match', partial.skin === '报童');
  let threw = false;
  try { pickSkinView(meta, { skin: '不存在的皮肤' }); } catch { threw = true; }
  check('pickSkinView: unknown skin throws', threw);
  let threw2 = false;
  try { pickSkinView({ skin: {} }, {}); } catch { threw2 = true; }
  check('pickSkinView: no skins throws', threw2);
}


// --- parseSpineDataFromHtml ---
{
  const json = '{"prefix":"https://torappu.prts.wiki/assets/enemy_spine/enemy_1505_frstar/","name":"\u971C\u661F","skin":{"\u9ED8\u8BA4":{"\u6218\u6597":{"file":"enemy_1505_frstar"}}}}';
  const html = '<span id="SPINEDATA" type="json" class="mw-json">' + json + '</span>';
  const got = parseSpineDataFromHtml(html);
  check('parseSpineDataFromHtml: enemy meta', !!got && got.prefix.endsWith('enemy_1505_frstar/') && got.skin['默认']['战斗'].file === 'enemy_1505_frstar');
  const esc = parseSpineDataFromHtml('<span id="SPINEDATA" type="json">{"prefix":"https://x.test/a?b=1&amp;c=2","name":"a","skin":{}}</span>');
  check('parseSpineDataFromHtml: html entity &amp;', !!esc && esc.prefix === 'https://x.test/a?b=1&c=2');
  const esc2 = parseSpineDataFromHtml('<span id="SPINEDATA" type="json">{&quot;prefix&quot;:&quot;https://x.test/&quot;,&quot;name&quot;:&quot;a&quot;,&quot;skin&quot;:{}}</span>');
  check('parseSpineDataFromHtml: full entity-escaped json', !!esc2 && esc2.prefix === 'https://x.test/');
  check('parseSpineDataFromHtml: bad json -> null', parseSpineDataFromHtml('<span id="SPINEDATA" type="json">not json</span>') === null);
  check('parseSpineDataFromHtml: no span -> null', parseSpineDataFromHtml('<html><body>x</body></html>') === null);
}

// --- isEnemyKey / enemyMetaFromKey ---
{
  check('isEnemyKey: enemy id', isEnemyKey('enemy_1505_frstar') === true);
  check('isEnemyKey: uppercase', isEnemyKey('ENEMY_1505_FRSTAR') === true);
  check('isEnemyKey: char id false', isEnemyKey('char_002_amiya') === false);
  check('isEnemyKey: empty false', isEnemyKey('') === false);
  const meta = enemyMetaFromKey('enemy_1505_frstar');
  check('enemyMetaFromKey: kind/prefix', !!meta && meta.kind === 'enemy' && meta.prefix.includes('/enemy_spine/enemy_1505_frstar/'));
  check('enemyMetaFromKey: skin structure', meta.skin['默认']['战斗'].file === 'enemy_1505_frstar');
  check('enemyMetaFromKey: char key -> null', enemyMetaFromKey('char_002_amiya') === null);
}

// --- pickSkinView: enemy 战斗 view ---
{
  const enemyMeta = {
    prefix: 'https://torappu.prts.wiki/assets/enemy_spine/enemy_1505_frstar/',
    name: '\u971C\u661F',
    kind: 'enemy',
    skin: { \u9ED8\u8BA4: { \u6218\u6597: { file: 'enemy_1505_frstar' } } },
  };
  const pick = pickSkinView(enemyMeta, {});
  check('pickSkinView: enemy battle priority', pick.skin === '\u9ED8\u8BA4' && pick.view === '\u6218\u6597' && pick.file === 'enemy_1505_frstar');
  const charMeta = {
    prefix: 'https://cdn.example/assets/char_002_amiya/',
    name: 'a',
    skin: { \u9ED8\u8BA4: { \u57FA\u5EFA: { file: 'b' } } },
  };
  const pick2 = pickSkinView(charMeta, {});
  check('pickSkinView: char build fallback', pick2.skin === '\u9ED8\u8BA4' && pick2.view === '\u57FA\u5EFA');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);