// Tests for the 4-panel comparison generator (scripts/make-compare.mjs).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../src/png.mjs';
import { main as compareMain } from '../scripts/make-compare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zdxr-cmp-'));
const atlas = path.join(root, 'assets/amiya/amiya.atlas');
const png = path.join(root, 'assets/amiya/amiya.png');

try {
  // 1. 无引擎 2 面板 + 区域不存在时自动选择
  const out1 = path.join(tmp, 'cmp1.png');
  const code1 = await compareMain(['--atlas', atlas, '--png', png, '--scale', '4', '--out', out1, '--region', 'NoSuchRegion', '--no-labels', '--engines', '']);
  check('compare exit 0 (auto region)', code1 === 0);
  const img1 = decodePng(fs.readFileSync(out1));
  check('2 panels @4x', img1.width === 2 * 512 && img1.height === 512, `${img1.width}x${img1.height}`);
  const g1 = (10 * img1.width + 256) * 4;
  check('panel1 gray bar', img1.rgba[g1] === 140 && img1.rgba[g1 + 1] === 148 && img1.rgba[g1 + 2] === 160);
  const b1 = (10 * img1.width + 256 + 512) * 4;
  check('panel2 blue bar', img1.rgba[b1] === 64 && img1.rgba[b1 + 1] === 148 && img1.rgba[b1 + 2] === 255);

  // 2. 指定存在的区域 + 2x
  const out2 = path.join(tmp, 'cmp2.png');
  const code2 = await compareMain(['--atlas', atlas, '--png', png, '--scale', '2', '--region', 'F_Face', '--out', out2, '--no-labels', '--engines', '']);
  check('compare exit 0 (explicit region)', code2 === 0);
  const img2 = decodePng(fs.readFileSync(out2));
  check('2 panels @2x', img2.width === 2 * 256 && img2.height === 256, `${img2.width}x${img2.height}`);

  // 3. 源文件不存在 → 返回 2
  const code3 = await compareMain(['--atlas', path.join(tmp, 'nope.atlas'), '--png', png, '--out', path.join(tmp, 'x.png'), '--no-labels']);
  check('missing file -> code 2', code3 === 2);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);