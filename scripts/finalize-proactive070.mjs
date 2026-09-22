import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root, run, python } from './tooling.mjs';

const product = JSON.parse(await readFile(path.join(root, 'config/product.json'), 'utf8'));
if (product.buildId !== '0.7.0-debug.001') throw new Error('Unexpected build');
const build = product.buildId, report = path.join(root, 'reports/proactive-redesign-2026-09-17');
const dir = path.join(root, 'dist/releases', product.version, build);
const fpk = path.join(dir, `qibox-${build}-all.fpk`);
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function files(folder, base = folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (['__pycache__', 'node_modules', '.git', '.cache'].includes(entry.name)) continue;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await files(file, base));
    else if (entry.isFile()) result.push(path.relative(base, file).replaceAll('\\', '/'));
  }
  return result.sort();
}
const parity = [];
for (const name of ['server', 'public', 'config']) {
  const original = path.join(root, name), stage = path.join(root, 'build/qibox-all/app', name);
  const expected = await files(original), actual = await files(stage);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Staged inventory differs: ' + name);
  for (const file of expected) {
    const hash = await sha(path.join(original, file));
    const stagedHash = await sha(path.join(stage, file));
    const productFile = name === 'config' && file === 'product.json';
    if (hash !== stagedHash) {
      if (!productFile || JSON.stringify(JSON.parse(await readFile(path.join(original, file), 'utf8'))) !== JSON.stringify(JSON.parse(await readFile(path.join(stage, file), 'utf8')))) throw new Error('Staged content differs: ' + name + '/' + file);
    }
    parity.push({ file: name + '/' + file, sha256: hash, stagedSha256: stagedHash, comparison: hash === stagedHash ? 'exact' : 'product-json-build-format-normalization' });
  }
}
await writeFile(path.join(report, 'source-stage-parity.json'), JSON.stringify({ build, files: parity }, null, 2));
const selection = [];
for (const name of ['server', 'web', 'scripts', 'test', 'config', 'packaging', 'docs', 'licenses']) {
  for (const file of await files(path.join(root, name))) selection.push(name + '/' + file);
}
selection.push('package.json', 'package-lock.json', 'README.md', 'NOTICE.md', '主动聊天-UI演示-v2.html');
for (const file of await files(report)) selection.push('reports/proactive-redesign-2026-09-17/' + file);
selection.sort();
const manifest = [];
for (const file of selection) manifest.push({ file, sha256: await sha(path.join(root, file)) });
await mkdir(dir, { recursive: true });
const mf = path.join(dir, 'SOURCE-MANIFEST.json'), zip = path.join(dir, `qibox-${build}-source.zip`);
await writeFile(mf, JSON.stringify({ build, files: manifest }, null, 2), { flag: 'wx' });
await run(python, ['-c', "import json,pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); manifest=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8')); z=zipfile.ZipFile(sys.argv[3],'x',zipfile.ZIP_DEFLATED); [z.write(root/f['file'],f['file']) for f in manifest['files']]; z.close()", root, mf, zip]);
const artifacts = [];
for (const file of [fpk, zip, mf]) artifacts.push({ file: path.basename(file), sha256: await sha(file) });
await writeFile(path.join(dir, 'SHA256SUMS.txt'), artifacts.map(a => `${a.sha256}  ${a.file}\n`).join(''), { flag: 'wx' });
console.log(JSON.stringify({ build, artifacts, parityFiles: parity.length, sourceFiles: manifest.length }));
