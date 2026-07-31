// Tests for atlas/PNG synchronized upscaling (src/upscale.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaleAtlasText, resizeRgba, upscalePng, prepareUpscaledAssets } from '../src/upscale.mjs';
import { decodePng, encodePng } from '../src/png.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

// --- 1. atlas text scaling ---
{
  const atlas = [
    'build_char_002_amiya.png',
    'size: 512,512',
    'format: RGBA8888',
    'filter: Linear,Linear',
    'repeat: none',
    'F_Belt',
    '  rotate: true',
    '  xy: 233, 446',
    '  size: 8, 39',
    '  orig: 8, 39',
    '  offset: 0, 0',
    '  index: -1',
    'F_Neon',
    '  rotate: false',
    '  xy: -4, 512',
    '  size: 12, 12',
    '  orig: 12, 12',
    '  offset: -2.5, 1.5',
    '  split: 1, 1, 1, 1',
    '  pad: 0, 0, 0, 0',
    '  index: -1',
  ].join('\n');
  const { text, pages } = scaleAtlasText(atlas, 2);
  const lines = text
    .split('\n')
    .map((l) => l.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]);
  const vals = (key) => lines.filter(([k]) => k === key).map(([, v]) => v);
  check('atlas: pages detected', pages.length === 1 && pages[0] === 'build_char_002_amiya.png');
  check('atlas: page size scaled', vals('size')[0] === '1024,1024', vals('size')[0]);
  check('atlas: region size scaled', vals('size')[1] === '16, 78', vals('size')[1]);
  check('atlas: xy scaled (incl. negative)', vals('xy')[0] === '466, 892' && vals('xy')[1] === '-8, 1024', vals('xy').join(' | '));
  check('atlas: offset scaled (incl. fractional)', vals('offset')[0] === '0, 0' && vals('offset')[1] === '-5, 3', vals('offset').join(' | '));
  check('atlas: split/pad scaled', vals('split')[0] === '2, 2, 2, 2' && vals('pad')[0] === '0, 0, 0, 0', `${vals('split').join('|')} ${vals('pad').join('|')}`);
  check('atlas: rotate untouched', text.includes('rotate: true'));
  check('atlas: index untouched', text.includes('index: -1'));
  check('atlas: region attr indentation kept (xy indented)', /^\s{2}xy:/m.test(text), 'indent lost would break Spine atlas parsing');
  check('atlas: page size line stays top-level', /^size: 1024,1024$/m.test(text));
  check('atlas: filter/repeat untouched', text.includes('filter: Linear,Linear') && text.includes('repeat: none'));
}

// --- 2. resizeRgba solid color + alpha edge (no dark fringe) ---
{
  const srcW = 4, srcH = 4;
  const rgba = new Uint8Array(srcW * srcH * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 200; rgba[i + 1] = 100; rgba[i + 2] = 50; rgba[i + 3] = 255;
  }
  const out = resizeRgba(rgba, srcW, srcH, srcW * 2, srcH * 2);
  check('resize: dimensions', out.length === srcW * 2 * srcH * 2 * 4);
  const mid = ((srcH * 2 / 2 | 0) * srcW * 2 + (srcW * 2 / 2 | 0)) * 4;
  check('resize: solid color preserved', out[mid] === 200 && out[mid + 1] === 100 && out[mid + 2] === 50 && out[mid + 3] === 255, `${out[mid]},${out[mid + 1]},${out[mid + 2]},${out[mid + 3]}`);

  // translucent edge: bright red pixel next to transparent -> RGB must not darken
  const e = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < e.length; i += 4) e[i + 3] = 0;
  e[0] = 255; e[1] = 0; e[2] = 0; e[3] = 255; // opaque red top-left
  const eOut = resizeRgba(e, 4, 4, 8, 8);
  let brightest = 0;
  for (let i = 0; i < eOut.length; i += 4) {
    if (eOut[i + 3] > 0 && eOut[i] > brightest) brightest = eOut[i];
  }
  check('resize: premultiplied edge (no dark fringe)', brightest >= 250, `brightest red=${brightest}`);
}

// --- 3. upscalePng round trip ---
{
  const w = 3, h = 2;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = 10 + x * 100; rgba[i + 1] = 20 + y * 100; rgba[i + 2] = 30; rgba[i + 3] = 255;
  }
  const big = upscalePng(encodePng(rgba, w, h), 2);
  const dec = decodePng(big);
  check('upscalePng: dimensions', dec.width === 6 && dec.height === 4, `${dec.width}x${dec.height}`);
  const center = (1 * 6 + 3) * 4;
  check('upscalePng: colors sane', dec.rgba[center] > 100 && dec.rgba[center] < 255 && dec.rgba[center + 3] === 255, `${dec.rgba[center]}`);
}

// --- 4. end-to-end: amiya assets synchronized upscale ---
{
  const src = path.join(root, 'assets', 'amiya');
  const outDir = path.join(root, 'out', 'test-hi-amiya');
  fs.rmSync(outDir, { recursive: true, force: true });
  const result = await prepareUpscaledAssets({
    atlasPath: path.join(src, 'amiya.atlas'),
    pngPath: path.join(src, 'amiya.png'),
    scale: 2,
    outDir,
  });
  const atlasText = fs.readFileSync(result.atlas, 'utf8');
  const firstSize = atlasText.match(/^size:\s*(\d+),\s*(\d+)/m);
  const png = decodePng(fs.readFileSync(result.png));
  const orig = decodePng(fs.readFileSync(path.join(src, 'amiya.png')));
  check('e2e: page size scaled x2', firstSize && firstSize[1] === String(orig.width * 2) && firstSize[2] === String(orig.height * 2), `${firstSize?.[1]}x${firstSize?.[2]}`);
  check('e2e: png scaled x2', png.width === orig.width * 2 && png.height === orig.height * 2, `${png.width}x${png.height}`);
  check('e2e: atlas page name rewritten', /^amiya\.png\s*$/m.test(atlasText) && !/build_char/.test(atlasText));
  const regionLine = atlasText.split('\n').find((l) => /^\s*xy:/.test(l));
  const xy = regionLine.match(/(\d+),\s*(\d+)/);
  const origXy = fs.readFileSync(path.join(src, 'amiya.atlas'), 'utf8').split('\n').find((l) => /^\s*xy:/.test(l)).match(/(\d+),\s*(\d+)/);
  check('e2e: first region xy scaled x2', xy[1] === String(parseInt(origXy[1], 10) * 2) && xy[2] === String(parseInt(origXy[2], 10) * 2), `${xy[1]},${xy[2]}`);
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
