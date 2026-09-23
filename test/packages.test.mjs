import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PackageLibrary, MAX_PACKAGE, OFFICIAL_URL } from '../server/packages.mjs';
import { temp, cleanup, fetcher, extractor, packageBytes, packageSha256, delay } from './fixtures.mjs';

test('concurrent install requests download once and reuse the installed program after restart', async () => {
  const dataRoot = await temp(); let downloads = 0;
  const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, fetcher: async (url, options) => { downloads++; assert.equal(url, OFFICIAL_URL); assert.equal(options.redirect, 'error'); await delay(20); return fetcher(); }, extract: extractor, trustedHashes: [packageSha256] });
  try {
    await library.init(); library.download(); library.download(); await library.working;
    assert.equal(downloads, 1); assert.equal(library.job.status, 'complete'); assert.equal(library.current.version, '4.1.13.9');
    library.download(); assert.equal(downloads, 1);
    const second = new PackageLibrary({ dataRoot, appRoot: dataRoot, fetcher, extract: extractor, trustedHashes: [packageSha256] }); await second.init();
    assert.equal(second.installed().sha256, library.installed().sha256);
    await access(path.join(second.installed().directory, 'installer.deb'));
  } finally { await library.close(); await cleanup(dataRoot); }
});
test('HTML downloads fail visibly without activation and can be retried', async () => {
  const dataRoot = await temp(); let good = false;
  const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, fetcher: () => good ? fetcher() : new Response('<html>error</html>'), extract: extractor, trustedHashes: [packageSha256] });
  try { await library.init(); library.download(); await library.working; assert.equal(library.job.status, 'error'); assert.equal(library.current, null); good = true; library.download(); await library.working; assert.equal(library.job.status, 'complete'); }
  finally { await library.close(); await cleanup(dataRoot); }
});
test('upload limits, truncated files and invalid application packages do not become installed', async () => {
  const dataRoot = await temp(); const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, extract: async () => { throw new Error('invalid package'); } });
  try {
    await library.init(); assert.throws(() => library.upload(Readable.from(packageBytes), MAX_PACKAGE + 1), /1 GB/);
    await library.upload(Readable.from(packageBytes), packageBytes.length + 1); assert.equal(library.current, null); assert.match(library.job.message, /不完整/);
    await library.upload(Readable.from(packageBytes), packageBytes.length); assert.equal(library.current, null); assert.equal(library.job.status, 'error');
  } finally { await library.close(); await cleanup(dataRoot); }
});
test('NAS imports use permission-checked handles and release handles on failures', async () => {
  const dataRoot = await temp(); let closed = false;
  const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, extract: extractor, trustedHashes: [createHash('sha256').update(packageBytes).digest('hex')] });
  const nas = { async openFile(uid, filename) { assert.equal(uid, '1001'); assert.equal(filename, '/vol1/user/WeChat.deb'); return { info: { size: packageBytes.length }, handle: { createReadStream: () => Readable.from(packageBytes), close: async () => { closed = true; } } }; } };
  try { await library.init(); library.importNas(nas, '1001', '/vol1/user/WeChat.deb'); await library.working; assert.equal(library.job.status, 'complete'); assert.equal(closed, true); }
  finally { await library.close(); await cleanup(dataRoot); }
});
test('restart removes only disposable interrupted install directories', async () => {
  const dataRoot = await temp();
  const root = path.join(dataRoot, 'applications/wechat/jobs'); const job = path.join(root, 'a'.repeat(36));
  try { await mkdir(job, { recursive: true }); await writeFile(path.join(job, 'partial'), 'data'); await mkdir(path.join(root, 'keep-me')); const library = new PackageLibrary({ dataRoot, appRoot: dataRoot }); await library.init(); await assert.rejects(access(job)); await access(path.join(root, 'keep-me')); }
  finally { await cleanup(dataRoot); }
});
test('unverified uploaded executables cannot become the shared application', async () => {
  const dataRoot = await temp(); let extracted = false;
  const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, extract: async () => { extracted = true; return { version: '4.1.13.9' }; } });
  try { await library.init(); await library.upload(Readable.from(packageBytes), packageBytes.length); assert.equal(library.current, null); assert.equal(extracted, true); assert.match(library.job.message, /与栖盒适配的版本结构差异较大/); }
  finally { await library.close(); await cleanup(dataRoot); }
});

test('uninstall excludes concurrent installers and leaves shared program intact if stopping fails', async () => {
  const dataRoot = await temp(); const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, fetcher, extract: extractor, trustedHashes: [packageSha256] });
  try {
    await library.init(); library.download(); await library.working;
    const program = path.join(library.installed().directory, 'opt/wechat/wechat');
    library.beforeUninstall = async () => { throw new Error('process still running'); };
    await assert.rejects(library.uninstall(), /卸载未完成/); await access(program); assert.ok(library.installed());
    let release; const stopped = new Promise(resolve => { release = resolve; });
    library.beforeUninstall = () => stopped;
    const operation = library.uninstall(); assert.equal(library.uninstalling, true);
    assert.throws(() => library.uninstall(), /请稍候/);
    assert.throws(() => library.upload(Readable.from(packageBytes), packageBytes.length), /已安装|请稍候/);
    library.download(); assert.equal(library.job.status, 'uninstalling');
    release(); await operation; assert.equal(library.installed(), null); await assert.rejects(access(program));
    const reboot = new PackageLibrary({ dataRoot, appRoot: dataRoot, fetcher, extract: extractor, trustedHashes: [packageSha256] }); await reboot.init(); assert.equal(reboot.installed(), null);
    reboot.download(); await reboot.working; await access(path.join(reboot.installed().directory, 'opt/wechat/wechat')); await reboot.close();
  } finally { await library.close(); await cleanup(dataRoot); }
});
