// PRTS Asset Fetcher: resolves a character name/key and downloads
// .png / .atlas / .skel from the Ark-Models mirrors.
//
// Primary mirror : https://raw.githubusercontent.com/lozye/Ark-Models/master
// Backup mirror  : https://raw.githubusercontent.com/isHarryh/Ark-Models/master
//
// Usage:
//   node src/download.mjs --character 阿米娅
//   node src/download.mjs --key 002_amiya
//   node src/download.mjs --character Amiya --refresh-manifest

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_URL = 'https://raw.githubusercontent.com/lozye/Ark-Models/master/models_data.json';
const MIRRORS = [
  'https://raw.githubusercontent.com/lozye/Ark-Models/master',
  'https://raw.githubusercontent.com/isHarryh/Ark-Models/master',
];
const MANIFEST_CACHE = join(root, 'assets', 'models_data.json');

const EXTS = ['.atlas', '.skel', '.png'];

async function fetchBytes(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function normalizeManifest(raw) {
  // Accept the current Ark-Models format ({ data: {...}, storageDirectory: {...} }),
  // an object keyed by character id, or an array of entries.
  const entries = [];
  const source = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  if (Array.isArray(source)) {
    for (const entry of source) entries.push(entry);
  } else if (source && typeof source === 'object') {
    const storage = raw && raw.storageDirectory && typeof raw.storageDirectory === 'object' ? raw.storageDirectory : {};
    for (const [key, value] of Object.entries(source)) {
      if (!value || typeof value !== 'object') continue;
      const type = value.type;
      entries.push({ ...value, key, storageDir: storage[type] || 'models' });
    }
  }
  return entries.filter((entry) => entry && typeof entry === 'object');
}

function namesOf(entry) {
  const raw = entry.name ?? entry.names ?? entry.characterName ?? entry.displayName;
  const names = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string' && raw.length > 0
      ? [raw]
      : [];
  if (typeof entry.appellation === 'string' && entry.appellation.length > 0) {
    names.push(entry.appellation);
  }
  return names;
}

function assetIdOf(entry) {
  return (
    entry.assetId ??
    entry.asset_id ??
    entry.fileBase ??
    entry.id ??
    (typeof entry.key === 'string' ? entry.key : null)
  );
}

function checksumOf(entry, ext) {
  const checksum = entry.checksum;
  if (!checksum) return null;
  const clean = (value) => {
    const text = String(value).replace(/^(sha256|md5):/i, '');
    // 32 hex chars = md5, 64 hex chars = sha256 (current Ark-Models manifest uses md5)
    return { hex: text.toLowerCase(), algorithm: /^[0-9a-f]{64}$/.test(text) ? 'sha256' : 'md5' };
  };
  if (typeof checksum === 'string') return clean(checksum);
  if (checksum && typeof checksum === 'object') {
    const value = checksum[ext.slice(1)] ?? checksum[ext] ?? checksum.default;
    if (typeof value === 'string') return clean(value);
  }
  return null;
}

export async function loadManifest({ refresh = false } = {}) {
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(MANIFEST_CACHE, 'utf8'));
      return normalizeManifest(cached);
    } catch {
      // fall through to network fetch
    }
  }
  const bytes = await fetchBytes(MANIFEST_URL);
  await mkdir(dirname(MANIFEST_CACHE), { recursive: true });
  await writeFile(MANIFEST_CACHE, bytes);
  return normalizeManifest(JSON.parse(bytes.toString('utf8')));
}

export function findCharacter(manifest, { character, key }) {
  const query = String(character ?? key ?? '').trim().toLowerCase();
  if (!query) throw new Error('Provide --character <name> or --key <character key>');

  const byKey = manifest.find((entry) => String(entry.key ?? '').toLowerCase() === query);
  if (byKey) return byKey;

  const matches = manifest.filter((entry) => {
    const names = namesOf(entry).map((name) => name.toLowerCase());
    return names.includes(query) || names.some((name) => name.includes(query));
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Prefer the default skin when a name matches several entries
    // (skin entries have keys like "103_angel_sale#8").
    const defaults = matches.filter((entry) => !String(entry.key ?? '').includes('#'));
    if (defaults.length === 1) return defaults[0];
    throw new Error(
      `Multiple characters match "${character}": ${matches
        .map((entry) => `${entry.key} (${namesOf(entry).join('/')})`)
        .join(', ')}. Use --key to disambiguate.`,
    );
  }
  throw new Error(
    `Character "${character}" not found in the manifest. ` +
      `Try a Chinese name (阿米娅), an English name (Amiya), or a key (002_amiya).`,
  );
}

export async function downloadCharacter(entry, { outDir = join(root, 'assets'), mirror = 0 } = {}) {
  const key = entry.key;
  const assetId = assetIdOf(entry);
  if (!key || !assetId) {
    throw new Error(`Manifest entry missing key/assetId: ${JSON.stringify(entry)}`);
  }
  const targetDir = resolve(outDir, key);
  await mkdir(targetDir, { recursive: true });

  const downloaded = [];
  let lastError = null;
  for (const ext of EXTS) {
    const fileName = `${assetId}${ext}`;
    const targetFile = join(targetDir, fileName);
    const expectedChecksum = checksumOf(entry, ext);
    let saved = false;

    for (let m = 0; m < MIRRORS.length; m++) {
      const base = MIRRORS[(mirror + m) % MIRRORS.length];
      const storageDir = entry.storageDir || 'models';
      const url = `${base}/${storageDir}/${key}/${fileName}`;
      try {
        const bytes = await fetchBytes(url);
        if (expectedChecksum) {
          const actual = createHash(expectedChecksum.algorithm).update(bytes).digest('hex');
          if (actual !== expectedChecksum.hex) {
            throw new Error(`checksum mismatch for ${fileName} (${expectedChecksum.algorithm} got ${actual.slice(0, 12)}…)`);
          }
        }
        await writeFile(targetFile, bytes);
        console.log(`OK   ${fileName}  ${(bytes.length / 1024).toFixed(0)} KB  -> ${targetFile}`);
        downloaded.push(targetFile);
        saved = true;
        break;
      } catch (error) {
        lastError = error;
        if (error.name === 'AbortError') throw error;
      }
    }
    if (!saved) throw new Error(`Failed to download ${fileName}: ${lastError?.message}`);
  }
  return downloaded;
}

export async function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  const character = flag('--character');
  const key = flag('--key');
  const refresh = argv.includes('--refresh-manifest');
  const mirrorIndex = flag('--mirror') === 'isharryh' ? 1 : 0;

  const manifest = await loadManifest({ refresh });
  const entry = findCharacter(manifest, { character, key });
  console.log(`Character: ${namesOf(entry).join(' / ')}  (key: ${entry.key})`);
  const files = await downloadCharacter(entry, { mirror: mirrorIndex });
  console.log(`\nDone. Assets in ${dirname(files[0])}`);
  console.log(`Next: node src/pipeline.mjs inspect --assets ${dirname(files[0])}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`download failed: ${error.message}`);
    process.exit(1);
  });
}