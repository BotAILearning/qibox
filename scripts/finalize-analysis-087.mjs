import { readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root } from './tooling.mjs';

const build = '0.8.7-debug.001';
const report = path.join(root, 'reports/analysis-report-20260922');
const dir = path.join(root, 'dist/releases/0.8.7', build);
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const product = JSON.parse(await readFile(path.join(root, 'config/product.json'), 'utf8'));
if (product.buildId !== build || product.version !== '0.8.7') throw new Error('Unexpected build');
async function files(folder, base = folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || /\.(?:bak|before)(?:$|[.\-_])/i.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Unexpected link: ' + entry.name);
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await files(file, base));
    else if (entry.isFile()) result.push(path.relative(base, file).replaceAll('\\', '/'));
  }
  return result.sort();
}
const parity = [];
for (const name of ['server', 'public', 'config']) {
  const source = path.join(root, name), stage = path.join(root, 'build/qibox-all/app', name);
  const expected = await files(source), actual = await files(stage);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Inventory mismatch: ' + name);
  for (const file of expected) {
    const sha256 = await hash(path.join(source, file)), stagedSha256 = await hash(path.join(stage, file));
    if (sha256 !== stagedSha256 && !(name === 'config' && file === 'product.json' &&
        JSON.stringify(JSON.parse(await readFile(path.join(source, file), 'utf8'))) === JSON.stringify(JSON.parse(await readFile(path.join(stage, file), 'utf8'))))) throw new Error('Content mismatch: ' + name + '/' + file);
    parity.push({ file: name + '/' + file, sha256, stagedSha256 });
  }
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if ([pkg.version, lock.version, lock.packages[''].version].some(v => v !== product.version)) throw new Error('Version mismatch');
await writeFile(path.join(report, 'source-stage-parity.json'), JSON.stringify({ build, passed: true, files: parity }, null, 2), { flag: 'wx' });
// Hash-only whitelist: never copy diagnostics, SSH settings, account data or chat text.
const selection = [];
for (const folder of ['server', 'web', 'config', 'packaging']) for (const file of await files(path.join(root, folder))) selection.push(folder + '/' + file);
selection.push('package.json', 'package-lock.json', 'scripts/build.mjs', 'scripts/pack-fpk.py', 'scripts/verify-fpk.py', 'scripts/finalize-analysis-087.mjs');
const manifest = [];
for (const file of selection.sort()) manifest.push({ file, sha256: await hash(path.join(root, file)) });
await writeFile(path.join(dir, 'SOURCE-MANIFEST.json'), JSON.stringify({ build, policy: 'Hash-only source whitelist; no diagnostics or account data included', files: manifest }, null, 2), { flag: 'wx' });
await copyFile(path.join(report, 'source-stage-parity.json'), path.join(dir, 'source-stage-parity.json'), 1);
const fpk = path.join(dir, `qibox-${build}-all.fpk`);
const result = { build, file: fpk, bytes: (await stat(fpk)).size, sha256: await hash(fpk), parityFiles: parity.length, sourceFiles: manifest.length };
await writeFile(path.join(report, 'package-result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
await writeFile(path.join(dir, 'SHA256SUMS.txt'), (await Promise.all([path.basename(fpk), 'SOURCE-MANIFEST.json', 'source-stage-parity.json'].map(async name => `${await hash(path.join(dir, name))}  ${name}\n`))).join(''), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
