import path from 'node:path';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { root } from './tooling.mjs';
import { hashFile } from '../server/files.mjs';

const product = JSON.parse(await readFile(path.join(root, 'config/product.json')));
const directory = product.buildId ? path.join(root, 'dist/releases', product.version, product.buildId) : path.join(root, 'dist');
const build = product.buildId || product.version;
const files = await readdir(directory), artifacts = [];
for (const platform of ['all', 'x86', 'arm']) {
  const file = `qibox-${build}-${platform}.fpk`, full = path.join(directory, file);
  if (!files.includes(file)) continue;
  const sha256 = await hashFile(full), declared = (await readFile(full + '.sha256', 'utf8')).trim().split(/\s+/)[0];
  if (declared !== sha256) throw new Error('Package hash differs from verified build output');
  artifacts.push({ file: path.relative(root, full).replaceAll('\\', '/'), bytes: (await stat(full)).size, sha256,
    platform, architectures: platform === 'all' ? ['x64','arm64'] : platform === 'x86' ? ['x64'] : ['arm64'] });
}
if (!artifacts.some(item => item.platform === product.platform)) throw new Error('Declared package platform is missing');
const report = { version: product.version, buildId: product.buildId, channel: product.channel, at: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
  artifacts,
  platforms: { fnos: { package: 'FPK', architectures: [...new Set(artifacts.flatMap(item => item.architectures))] } },
  checks: { verifiedBuildHash: true },
  acceptance: 'See the version-specific acceptance document for local, device, model and installation evidence. Package metadata alone does not prove device acceptance.' };
await mkdir(path.join(root, 'reports'), { recursive: true });
await writeFile(path.join(root, `reports/release-${product.buildId || product.version}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
