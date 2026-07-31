import fs from 'node:fs';

const code = fs.readFileSync('vendor/spine-core.js', 'utf8');
const needle = '\t\treturn BinaryInput;\n\t}());\n\tvar LinkedMesh';
const patched = code.replace(needle, '\t\treturn BinaryInput;\n\t}());\n\tspine.BinaryInput = BinaryInput;\n\tvar LinkedMesh');
const spine = new Function(patched + '\n;return spine;')();

const offLog = [];
for (const m of ['readByte','readShort','readInt32','readInt','readStringRef','readString','readFloat','readBoolean']) {
  const orig = spine.BinaryInput.prototype[m];
  spine.BinaryInput.prototype[m] = function (...args) {
    const v = orig.apply(this, args);
    offLog.push({ pos: this.index, m, v: typeof v === 'number' ? v : String(v ?? '').slice(0, 24) });
    return v;
  };
}

const { parseSkeleton, BinaryReader } = await import('../src/skel.mjs');
const myLog = [];
for (const m of ['readByte','readUByte','readBoolean','readInt','readInt32','readShort','readFloat','readString','readStringRef']) {
  const orig = BinaryReader.prototype[m];
  BinaryReader.prototype[m] = function (...args) {
    const v = orig.apply(this, args);
    myLog.push({ pos: this.pos, m, v: typeof v === 'number' ? v : String(v ?? '').slice(0, 24) });
    return v;
  };
}

const bytes = new Uint8Array(fs.readFileSync('assets/amiya/amiya.skel'));
const atlasText = fs.readFileSync('assets/amiya/amiya.atlas', 'utf8');
const dummyTex = (path) => ({ width: 1024, height: 1024, setFilters(){}, setWrap(){}, setWraps(){}, getImage(){ return { width: 1024, height: 1024 }; }, dispose(){} });
const atlas = new spine.TextureAtlas(atlasText, dummyTex);
const loader = new spine.AtlasAttachmentLoader(atlas);
const sb = new spine.SkeletonBinary(loader);
const offData = sb.readSkeletonData(bytes);
const mine = parseSkeleton(bytes);

const collapse = (log) => {
  const seq = [];
  for (const e of log) if (seq[seq.length - 1] !== e.pos) seq.push(e.pos);
  return seq;
};
const offSeq = collapse(offLog);
const mySeq = collapse(myLog);
console.log('official reads:', offLog.length, 'collapsed:', offSeq.length);
console.log('mine     reads:', myLog.length, 'collapsed:', mySeq.length);

let div = -1;
const n = Math.min(offSeq.length, mySeq.length);
for (let i = 0; i < n; i++) {
  if (offSeq[i] !== mySeq[i]) { div = i; break; }
}
if (div < 0 && offSeq.length === mySeq.length) {
  console.log('POSITIONS MATCH PERFECTLY');
} else {
  const d = div < 0 ? Math.min(offSeq.length, mySeq.length) : div;
  const offPos = offSeq[div] ?? offSeq[offSeq.length - 1];
  const myPos = mySeq[div] ?? mySeq[mySeq.length - 1];
  console.log('DIVERGENCE at collapsed entry', d, 'official pos', offPos, 'mine pos', myPos);
  console.log('official prev 14:', offSeq.slice(Math.max(0, d - 14), d + 2));
  console.log('mine     prev 14:', mySeq.slice(Math.max(0, d - 14), d + 2));
  const near = offLog.filter((e) => e.pos >= Math.max(0, offPos - 16) && e.pos <= offPos + 8);
  console.log('official reads near divergence:');
  for (const e of near.slice(-16)) console.log('  ', e.pos, e.m, JSON.stringify(e.v));
  const nearMy = myLog.filter((e) => e.pos >= Math.max(0, myPos - 16) && e.pos <= myPos + 8);
  console.log('mine reads near divergence:');
  for (const e of nearMy.slice(-16)) console.log('  ', e.pos, e.m, JSON.stringify(e.v));
  const hex = (pos) => Array.from(bytes.slice(Math.max(0, pos - 8), pos + 24)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log('bytes around official pos', offPos, ':', hex(offPos));
  console.log('bytes around mine     pos', myPos, ':', hex(myPos));
}

console.log('\nofficial animations:', offData.animations.map((a) => `${a.name}=${a.duration.toFixed(3)}`).join(', '));
console.log('mine     animations:', mine.animations.map((a) => `${a.name}=${a.duration.toFixed(3)}`).join(', '));
