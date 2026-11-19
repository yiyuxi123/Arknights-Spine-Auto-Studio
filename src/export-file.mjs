import fs from 'node:fs/promises';
import path from 'node:path';

// Build alongside the destination so rename takes place on the same volume.
// An interrupted encode never replaces an existing export at the final path.
export async function withExportFile(output, write) {
  const directory = await fs.mkdtemp(path.join(path.dirname(path.resolve(output)), '.spine-export-'));
  const temporary = path.join(directory, path.basename(output));
  try {
    const result = await write(temporary);
    await fs.rename(temporary, output);
    return result;
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(directory);
  }
}
