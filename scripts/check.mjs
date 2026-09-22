import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, run } from './tooling.mjs';
const product = JSON.parse(await readFile(path.join(root, 'config/product.json')));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
if (pkg.name !== product.appname || pkg.version !== product.version) throw new Error('Product/package mismatch');
for (const dir of ['server', 'web', 'scripts', 'test']) for (const name of await readdir(path.join(root, dir))) {
  if (!name.endsWith('.mjs')) continue;
  const file = path.join(root, dir, name), text = await readFile(file, 'utf8');
  if (dir !== 'scripts' && /qibackup|QIBACKUP|栖微信|接收设置/.test(text)) throw new Error(`Old application coupling in ${file}`);
  await run(process.execPath, ['--check', file]);
}
console.log('Syntax, independent application identifiers and version checks passed.');
