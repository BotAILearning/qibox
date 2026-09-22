import path from 'node:path';
import { readdir, readFile, access } from 'node:fs/promises';
import { root } from './tooling.mjs';

export async function checkWebAssets(directory) {
  let count = 0;
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.html')) continue;
    const html = await readFile(path.join(directory, name), 'utf8');
    for (const match of html.matchAll(/(?:src|href)=["']\.\/([^"']+)["']/g)) {
      const resource = match[1].split(/[?#]/)[0]; if (!resource) continue;
      const file = path.resolve(directory, resource);
      if (!file.startsWith(path.resolve(directory) + path.sep)) throw new Error('Asset reference escaped public directory');
      try { await access(file); } catch { throw new Error(`${name} references missing asset ${resource}`); }
      count++;
    }
  }
  return count;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, 'scripts/check-web-assets.mjs')) {
  for (const name of ['public', 'public-ugos']) console.log(`${name}: ${await checkWebAssets(path.join(root, name))} HTML asset references verified`);
}
