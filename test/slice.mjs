// Slice pipeline unit tests:
//   1. atlas parsing (pages / regions / rotate)
//   2. shelf packing (fit, no overlap)
//   3. scale-1 slice identity: opaque-pixel conservation through
//      crop -> de-rotate -> pad -> (identity) -> crop-back -> repack
//   4. generated atlas text round-trips through the parser
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAtlasRegions, packShelf, slicePage, buildAtlasText } from '../src/slice.mjs';
import { decodePng } from '../src/png.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const atlasText = fs.readFileSync(path.join(root, 'assets', 'amiya', 'amiya.atlas'), 'utf8');
const pngBuf = fs.readFileSync(path.join(root, 'assets', 'amiya', 'amiya.png'));
const { width, height, rgba } = decodePng(pngBuf);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
};

// 1) parse
const { pages, regions } = parseAtlasRegions(atlasText);
check('parse: 1 page 512x512', pages.length === 1 && pages[0].size[0] === 512 && pages[0].size[1] === 512, JSON.stringify(pages.map(p => p.size)));
check('parse: 46 regions', regions.length === 46, String(regions.length));
check('parse: rotated regions have nonzero size', regions.filter(r => r.rotate).every(r => r.size[0] > 0 && r.size[1] > 0));
check('parse: no 9-slice regions', regions.every(r => !r.split && !r.pad));

// 2) pack
const items = [{ name: 'a', w: 10, h: 20 }, { name: 'b', w: 30, h: 10 }, { name: 'c', w: 15, h: 15 }, { name: 'd', w: 8, h: 40 }];
const packed = packShelf(items, { gap: 2, maxW: 64 });
const overlap = (() => {
  for (let i = 0; i < packed.slots.length; i++) {
    for (let j = i + 1; j < packed.slots.length; j++) {
      const a = packed.slots[i], b = packed.slots[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  }
  return false;
})();
check('pack: all placed', packed.slots.length === items.length);
check('pack: no overlap', !overlap);
check('pack: within bounds', packed.slots.every(s => s.x + s.w <= packed.width && s.y + s.h <= packed.height));

// 3) scale-1 identity: opaque pixel conservation
// Count opaque pixels covered by region rects only. The page may carry
// unused pixels outside every region (amiya's sheet has 64 such specks),
// which slice mode legitimately drops; region content must be conserved.
const opaqueIn = (() => {
  let n = 0;
  for (const r of regions) {
    const [x, y] = r.xy;
    const [w, h] = r.size;
    const cw = r.rotate ? h : w, ch = r.rotate ? w : h;
    for (let yy = 0; yy < ch; yy++) {
      const row = (y + yy) * width + x;
      for (let xx = 0; xx < cw; xx++) if (rgba[(row + xx) * 4 + 3] > 0) n++;
    }
  }
  return n;
})();
const identity = (r, w, h, tw, th) => {
  if (w !== tw || h !== th) throw new Error('identity upscale mismatch');
  return Buffer.from(r);
};
const { png, slots } = await slicePage({
  rgba, pageW: width, pageH: height, regions, scale: 1, upscalePiece: identity, pad: 4, gap: 2,
});
const outDecoded = decodePng(png);
const opaqueOut = (() => { let n = 0; for (let i = 3; i < outDecoded.rgba.length; i += 4) if (outDecoded.rgba[i] > 0) n++; return n; })();
check('slice: all regions placed', slots.length === regions.length, slots.length + '/' + regions.length);
check('slice: opaque pixels conserved (scale=1)', Math.abs(opaqueIn - opaqueOut) <= 4, opaqueIn + ' -> ' + opaqueOut);
check('slice: output sheet not empty', outDecoded.width > 0 && outDecoded.height > 0, outDecoded.width + 'x' + outDecoded.height);

// 4) generated atlas round-trip
const gen = buildAtlasText({ pageName: 'out.png', width: outDecoded.width, height: outDecoded.height, format: 'RGBA8888', filter: 'Linear,Linear', repeat: 'none', slots });
const reparsed = parseAtlasRegions(gen);
check('atlas round-trip: 1 page', reparsed.pages.length === 1);
check('atlas round-trip: same region count', reparsed.regions.length === slots.length, reparsed.regions.length + ' vs ' + slots.length);
check('atlas round-trip: no rotate flags', reparsed.regions.every(r => !r.rotate));
check('atlas round-trip: coords in bounds', reparsed.regions.every(r => r.xy[0] + r.size[0] <= outDecoded.width && r.xy[1] + r.size[1] <= outDecoded.height));

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
