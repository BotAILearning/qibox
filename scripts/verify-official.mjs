import path from 'node:path';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { root, python, run } from './tooling.mjs';
import { download } from './download.mjs';
import { OFFICIAL_URL } from '../server/packages.mjs';
import { hashFile, within } from '../server/files.mjs';
const base = path.join(root, '.cache/official-test');
await mkdir(base, { recursive: true });
const file = path.join(base, 'wechat.deb'), destination = within(base, path.join(base, 'extracted'));
const report = { startedAt: new Date().toISOString(), url: OFFICIAL_URL, note: 'Official package extraction and byte-progress verification, reusing the cached installer when present. Does not execute Linux WeChat on Windows.' };
try {
  await download(OFFICIAL_URL, file);
  report.sha256 = await hashFile(file);
  await rm(destination, { recursive: true, force: true }); await mkdir(destination);
  await mkdir(path.join(root, 'reports'), { recursive: true });
  const details = path.join(root, 'reports/official-extraction.json');
  await run(python, [path.join(root, 'scripts/verify-official.py'), file, destination, details]);
  report.extraction = JSON.parse(await readFile(details, 'utf8'));
  const bytes = await readFile(path.join(destination, 'opt/wechat/wechat'));
  if (bytes.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error('Not an ELF executable');
  report.binarySha256 = await hashFile(path.join(destination, 'opt/wechat/wechat'));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
report.finishedAt = new Date().toISOString();
await mkdir(path.join(root, 'reports'), { recursive: true });
await writeFile(path.join(root, 'reports/official-package.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
