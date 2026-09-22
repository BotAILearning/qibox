import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { root } from './tooling.mjs';
import { download, arMember } from './download.mjs';
import { hashFile } from '../server/files.mjs';
const arm = process.argv.includes('--arch=arm64');
const lock = JSON.parse(await readFile(path.join(root, 'config', arm ? 'runtime-lock-arm64.json' : 'runtime-lock.json'), 'utf8'));
if (lock.wechat || lock.packages.some(x => /wechat/i.test(x.name))) throw new Error('Only open-source runtime components are prepared during build');
const payload = path.join(root, arm ? '.cache/runtime-arm64' : '.cache/runtime'); await mkdir(payload, { recursive: true });
let complete = 0;
for (const entry of lock.packages) {
  if (!/^[a-zA-Z0-9_.+-]+$/.test(entry.file)) throw new Error('Invalid component name');
  const destination = path.join(payload, entry.file);
  let cached = false; try { cached = await hashFile(destination) === entry.sha256; } catch {}
  if (!cached) {
    const source = new URL(entry.url);
    if (source.protocol !== 'https:' || !['deb.debian.org', 'security.debian.org'].includes(source.hostname)) throw new Error('Unexpected component source');
    const deb = await download(entry.url, path.join(root, '.cache/debs', path.basename(source.pathname)), entry.debSha256);
    const member = arMember(deb, 'data.tar');
    if (createHash('sha256').update(member.data).digest('hex') !== entry.sha256) throw new Error(`Component payload mismatch: ${entry.name}`);
    await writeFile(destination, member.data);
  }
  complete++; if (complete % 40 === 0 || complete === lock.packages.length) console.log(`Runtime components verified: ${complete}/${lock.packages.length}`);
}
