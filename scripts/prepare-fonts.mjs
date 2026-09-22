import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { root } from './tooling.mjs';
import { download } from './download.mjs';
import { hashFile } from '../server/files.mjs';

export async function prepareFonts() {
  const lock = JSON.parse(await readFile(path.join(root, 'config/fonts.json')));
  for (const asset of [...lock.fonts, ...lock.licenses]) {
    if (!/^(fonts\/[A-Za-z0-9-]+\.ttf|licenses\/fonts\/[A-Za-z0-9-]+\.txt)$/.test(asset.file)) throw new Error('Invalid font asset path');
    const destination = path.join(root, asset.file);
    await mkdir(path.dirname(destination), { recursive: true });
    await download(asset.url, destination, asset.sha256);
    if (await hashFile(destination) !== asset.sha256) throw new Error('Font asset checksum mismatch');
  }
  return lock;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'scripts/prepare-fonts.mjs')) {
  const lock = await prepareFonts(); console.log(`Verified ${lock.fonts.length} supplemental fonts and their licenses`);
}
