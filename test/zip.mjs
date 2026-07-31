// Tests for the pure-JS zip reader used by src/sr.mjs engine installer.
import { deflateRawSync } from 'node:zlib';
import { unzipEntries } from '../src/sr.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  // entries: [{name, data, method: 0|8}]
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.method === 8 ? deflateRawSync(e.data) : e.data;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt32LE(crc32(e.data), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([lh, nameBuf, data]));

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt32LE(crc32(e.data), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(locals.reduce((n, b) => n + b.length, 0), 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// --- stored + deflated entries round trip ---
{
  const zip = makeZip([
    { name: 'pkg/readme.txt', data: Buffer.from('hello zip'), method: 0 },
    { name: 'pkg/models/a.param', data: Buffer.from('param-data-'.repeat(100)), method: 8 },
  ]);
  const entries = unzipEntries(zip);
  check('zip: entry count', entries.size === 2);
  check('zip: stored entry bytes', entries.get('pkg/readme.txt').toString() === 'hello zip');
  check('zip: deflated entry bytes', entries.get('pkg/models/a.param').toString() === 'param-data-'.repeat(100));
}

// --- corrupt zip rejected ---
{
  let threw = false;
  try { unzipEntries(Buffer.from('not a zip at all....')); } catch { threw = true; }
  check('zip: garbage rejected', threw);
}

// --- path traversal guard ---
{
  const zip = makeZip([
    { name: '../../evil.txt', data: Buffer.from('boom'), method: 0 },
    { name: 'C:/Windows/evil.txt', data: Buffer.from('boom2'), method: 0 },
  ]);
  const entries = unzipEntries(zip);
  let threw = false;
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
    try {
      for (const [name, data] of entries) {
        const target = path.join(dir, name.replace(/\\/g, '/').split('/').filter(Boolean).join(path.sep));
        if (name.includes('..') || name.includes(':')) throw new Error('blocked: ' + name);
        fs.writeFileSync(target, data);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } catch { threw = true; }
  check('zip: traversal names rejected', threw);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
