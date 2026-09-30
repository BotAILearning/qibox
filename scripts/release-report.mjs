import path from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { root } from './tooling.mjs';
import { hashFile } from '../server/files.mjs';

const product = JSON.parse(await readFile(path.join(root, 'config/product.json')));
const directory = product.buildId ? path.join(root, 'dist/releases', product.version, product.buildId) : path.join(root, 'dist');
const file = `qibox-${product.buildId || product.version}-${product.platform}.fpk`, full = path.join(directory, file);
const sha256 = await hashFile(full), declared = (await readFile(full + '.sha256', 'utf8')).trim().split(/\s+/)[0];
if (declared !== sha256) throw new Error('Package hash differs from verified build output');
const report = { version: product.version, buildId: product.buildId, channel: product.channel, at: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
  artifacts: [{ file: path.relative(root, full).replaceAll('\\', '/'), bytes: (await stat(full)).size, sha256 }],
  platforms: { fnos: { package: 'universal FPK', architectures: ['x64', 'arm64'] } },
  checks: { verifiedBuildHash: true },
  acceptance: 'See the version-specific acceptance document for local, device, model and installation evidence. Package metadata alone does not prove device acceptance.' };
await mkdir(path.join(root, 'reports'), { recursive: true });
await writeFile(path.join(root, `reports/release-${product.buildId || product.version}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
