import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const targets = [
  {
    url: 'https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/3.8/spine-ts/build/spine-player.js',
    file: join(root, 'vendor', 'spine-3.8', 'spine-player.js'),
  },
  {
    url: 'https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/3.8/spine-ts/build/spine-core.js',
    file: join(root, 'vendor', 'spine-3.8', 'spine-core.js'),
  },
  {
    url: 'https://raw.githubusercontent.com/lozye/Ark-Models/master/models_data.json',
    file: join(root, 'assets', 'models_data.json'),
  },
];

for (const target of targets) {
  const resp = await fetch(target.url);
  if (!resp.ok) {
    throw new Error(`Failed to download ${target.url}: HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await mkdir(dirname(target.file), { recursive: true });
  await writeFile(target.file, buf);
  console.log(`OK  ${target.url} -> ${target.file} (${buf.length} bytes)`);
}