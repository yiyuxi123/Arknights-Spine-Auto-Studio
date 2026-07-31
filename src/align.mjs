// Atlas <-> PNG size alignment.
//
// PRTS Wiki serves character textures downsampled to ~2/3 of the size declared
// in the .atlas (e.g. atlas "size: 548,548" but the PNG is 368x368). Spine
// normalizes region UVs against the ACTUAL texture size, so atlas region
// coordinates land in the wrong place and the character renders as a broken
// puzzle ("散架").
//
// alignAssetsInPlace() detects the mismatch and repairs it in place:
//   - PNG smaller than the atlas page -> Lanczos3 upscale PNG to the atlas size
//   - PNG larger  than the atlas page -> scale atlas coordinates up (keeps the
//     higher-resolution texture, never downsamples)
// After alignment, region coordinates and texture pixels match 1:1.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { resizeRgba, scaleAtlasText } from './upscale.mjs';

/** Read a PNG's pixel dimensions from its IHDR chunk. */
export function readPngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Parse the texture page size declared in the .atlas text. */
export function atlasPageSize(atlasText) {
  const m = String(atlasText).match(/^size:\s*(\d+)\s*,\s*(\d+)\s*$/m);
  if (!m) throw new Error('atlas 缺少 size: 声明');
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/** Page filenames referenced by an .atlas text (top-level lines ending in .png). */
export function atlasPages(atlasText) {
  return String(atlasText)
    .split(/\r?\n/)
    .filter((line) => /^[^\s:][^:\r\n]*\.png\s*$/i.test(line))
    .map((line) => line.trim());
}

/**
 * Detect whether the texture PNG matches the .atlas declared page size.
 * @returns {{ok: boolean, pages: number, png?: {width:number,height:number}, atlas?: {width:number,height:number}}}
 */
export function checkAlignment(atlasPath, pngPath) {
  const atlasText = fs.readFileSync(atlasPath, 'utf8');
  const pages = atlasPages(atlasText);
  if (pages.length !== 1) {
    return { ok: true, pages };
  }
  const atlas = atlasPageSize(atlasText);
  const png = readPngSize(fs.readFileSync(pngPath));
  return { ok: png.width === atlas.width && png.height === atlas.height, pages, png, atlas };
}

/**
 * Repair an atlas<->PNG size mismatch in place (idempotent no-op when matched).
 * @param {object} opts
 * @param {string} opts.atlasPath
 * @param {string} opts.pngPath
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {{aligned: boolean, action: 'png-upscale'|'atlas-scale'|'none', from: string, to: string}}
 */
export function alignAssetsInPlace({ atlasPath, pngPath, onLog = () => {} } = {}) {
  const atlasText = fs.readFileSync(atlasPath, 'utf8');
  const pages = atlasPages(atlasText);
  if (pages.length !== 1) {
    onLog(`[align] ${path.basename(atlasPath)} 含 ${pages.length} 张贴图页，跳过自动对齐`);
    return { aligned: false, action: 'none', from: '', to: '' };
  }
  const atlas = atlasPageSize(atlasText);
  const pngBytes = fs.readFileSync(pngPath);
  const png = readPngSize(pngBytes);
  if (png.width === atlas.width && png.height === atlas.height) {
    return { aligned: false, action: 'none', from: '', to: '' };
  }
  if (png.width < atlas.width || png.height < atlas.height) {
    const { width, height, rgba } = decodePng(pngBytes);
    const resized = resizeRgba(rgba, width, height, atlas.width, atlas.height);
    fs.writeFileSync(pngPath, encodePng(resized, atlas.width, atlas.height));
    onLog(`[align] PNG ${png.width}x${png.height} < atlas ${atlas.width}x${atlas.height}，已 Lanczos3 放大对齐：${pngPath}`);
    return { aligned: true, action: 'png-upscale', from: `${png.width}x${png.height}`, to: `${atlas.width}x${atlas.height}` };
  }
  // PNG larger than the atlas declaration: scale atlas coordinates up, keep the texture.
  const scale = Math.max(png.width / atlas.width, png.height / atlas.height);
  const scaled = scaleAtlasText(atlasText, scale);
  fs.writeFileSync(atlasPath, scaled.text);
  onLog(`[align] PNG ${png.width}x${png.height} > atlas ${atlas.width}x${atlas.height}，已按 x${scale.toFixed(3)} 放大 atlas 坐标：${atlasPath}`);
  return { aligned: true, action: 'atlas-scale', from: `${atlas.width}x${atlas.height}`, to: `${png.width}x${png.height}` };
}
