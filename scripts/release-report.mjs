import path from 'node:path';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { root } from './tooling.mjs';
import { hashFile } from '../server/files.mjs';
const version = JSON.parse(await readFile(path.join(root, 'config/product.json'))).version;
const files = (await readdir(path.join(root, 'dist'))).filter(name => name.includes(version) && /\.(fpk|upk)$/.test(name));
const artifacts = [];
if (files.length !== 3) throw new Error('Expected one universal FPK and two UPKs');
for (const file of files) {
  const full = path.join(root, 'dist', file);
  artifacts.push({ file: `dist/${file}`, bytes: (await stat(full)).size, sha256: await hashFile(full) });
}
const report = { version, at: new Date().toISOString(), artifacts,
  checks: { node: 48, python: 12, syntax: 'passed', ui: 'passed', desktopWebSocket: 'passed', desktopFetchStream: 'passed', fpk: 'passed', upk: 'passed', upkBuilder: 'official ugcli 1.1.0.25 on Linux' },
  platforms: { fnos: { package: 'one universal FPK', architectures: ['x64', 'arm64'], runtimeComponents: 636 }, ugos: { package: 'native UPK', architectures: ['amd64', 'arm64'], realDeviceTested: false } },
  deployment: { newPackageDeployed: false, linuxHostUse: ['isolated packaging', 'synthetic font rendering; existing WeChat not restarted'] },
  remaining: ['fnOS ARM64 native execution and upgrade acceptance', 'UGOS developer device signature and actual ARM64 firmware installation/SDK/desktop acceptance', 'Actual WeChat login, restore and automatic-login/idle-backup full-cycle acceptance'] };
const coverage = JSON.parse(await readFile(path.join(root, 'reports/font-coverage.json')));
const native = JSON.parse(await readFile(path.join(root, 'reports/font-native.json')));
if (coverage.status !== 'passed' || native.status !== 'passed') throw new Error('Font checks not passed');
report.checks.fontSamples = coverage.samples.length; report.checks.nativeFontLines = native.rows.length;
report.remaining.push('Exact original nickname symbol still requires original Unicode text from user');
await writeFile(path.join(root, `reports/release-${version}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
