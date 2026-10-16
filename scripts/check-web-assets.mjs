import path from 'node:path';
import { readdir, readFile, access } from 'node:fs/promises';
import { root } from './tooling.mjs';
import { webChunkRoutes } from '../server/static-assets.mjs';

export async function checkWebAssets(directory) {
  let count = 0;
  const chunks = Object.values(await webChunkRoutes(directory)).map(([name]) => name);
  for (const name of ['app.js', 'auth-callback.js', ...chunks]) {
    const file = path.join(directory, name);
    const js = await readFile(file, 'utf8');
    for (const match of js.matchAll(/["'](\.\/[A-Za-z0-9_/-]+\.js)["']/g)) {
      const imported = path.relative(directory, path.resolve(path.dirname(file), match[1])).replaceAll('\\', '/');
      if (!chunks.includes(imported)) throw new Error(`${name} references an unregistered script ${imported}`);
      await access(path.join(directory, imported)); count++;
    }
  }
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.html')) continue;
    const html = await readFile(path.join(directory, name), 'utf8');
    for (const match of html.matchAll(/(?:src|href|data-desktop-style)=["']\.\/([^"']+)["']/g)) {
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
  for (const name of ['public']) console.log(`${name}: ${await checkWebAssets(path.join(root, name))} HTML asset references verified`);
}
