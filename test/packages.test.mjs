import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { PackageLibrary, MAX_PACKAGE, OFFICIAL_URL } from '../server/packages.mjs';
import { resourcePaths } from '../server/durable-download.mjs';
import { temp, cleanup, fetcher, extractor, packageBytes, packageSha256, delay } from './fixtures.mjs';

const testDownloadSource = { version: '4.1.13.9', url: OFFICIAL_URL, size: packageBytes.length, sha256: packageSha256 };
const library = options => new PackageLibrary({ downloadSource: testDownloadSource, ...options });

test('pause at a fully committed chunk cannot let the installer restart the downloader', async () => {
  const dataRoot = await temp(), payload = Buffer.alloc(3 * 1024 * 1024 + 11); Buffer.from('!<arch>\n').copy(payload);
  const sha256 = createHash('sha256').update(payload).digest('hex'); let requests = 0, pausePromise, pauseStarted = false, announced;
  const pauseRequested = new Promise(resolve => { announced = resolve; });
  const server = createServer((req, res) => {
    requests++;
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || ''), start = Number(match?.[1] || 0), end = Number(match?.[2] || payload.length - 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': end - start + 1 }); res.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = { version: 'fixture', url: `http://127.0.0.1:${server.address().port}/wechat.deb`, size: payload.length, sha256 };
  const instance = library({ dataRoot, appRoot: dataRoot, downloadSource: source, downloadAllowHttp: true, fetcher: (url, init) => fetch(url, init), extract: extractor, trustedHashes: [sha256] });
  const make = instance.makeDownloader.bind(instance);
  instance.makeDownloader = resource => {
    const downloader = make(resource), observe = downloader.onChange;
    downloader.onChange = async state => {
      await observe(state);
      if (!pauseStarted && downloader.meta.checkpoint === 1024 * 1024) {
        pauseStarted = true; pausePromise = instance.pauseDownload(); announced();
      }
    };
    return downloader;
  };
  try {
    await instance.init(); instance.download(); await pauseRequested; await pausePromise;
    // Await any accidentally restarted work: a correct pause has no such work.
    await instance.transfer?.working; await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, 'no new HTTP request is allowed until explicit Continue');
    assert.equal(instance.publicState().job.status, 'paused');
    assert.equal(instance.publicState().job.bytes, 1024 * 1024);
    instance.resumeDownload(); await instance.working;
    assert.equal(instance.job.status, 'complete');
  } finally { await instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanup(dataRoot); }
});

test('concurrent install requests download once and reuse the installed program after restart', async () => {
  const dataRoot = await temp(); let downloads = 0;
  const instance = library({ dataRoot, appRoot: dataRoot, fetcher: async (url, options) => { downloads++; assert.equal(url, OFFICIAL_URL); assert.equal(options.redirect, 'manual'); await delay(20); return fetcher(); }, extract: extractor, trustedHashes: [packageSha256] });
  try {
    await instance.init(); instance.download(); instance.download(); await instance.working;
    assert.equal(downloads, 1); assert.equal(instance.job.status, 'complete'); assert.equal(instance.current.version, '4.1.13.9');
    instance.download(); assert.equal(downloads, 1);
    const second = library({ dataRoot, appRoot: dataRoot, fetcher, extract: extractor, trustedHashes: [packageSha256] }); await second.init();
    assert.equal(second.installed().sha256, instance.installed().sha256);
    await access(path.join(second.installed().directory, 'installer.deb'));
  } finally { await instance.close(); await cleanup(dataRoot); }
});
test('HTML downloads fail visibly without activation and can be retried', async () => {
  const dataRoot = await temp(); let good = false;
  const instance = library({ dataRoot, appRoot: dataRoot, fetcher: () => good ? fetcher() : new Response('<html>error</html>'), extract: extractor, trustedHashes: [packageSha256] });
  try { await instance.init(); instance.download(); await instance.working; assert.equal(instance.job.status, 'error'); assert.equal(instance.current, null); good = true; instance.download(); await instance.working; assert.equal(instance.job.status, 'complete'); }
  finally { await instance.close(); await cleanup(dataRoot); }
});
test('a changed official payload fails its pinned hash before stopping or extracting', async () => {
  const dataRoot = await temp(), changed = Buffer.from(packageBytes); changed[changed.length - 1] ^= 0xff;
  let stopped = false, extracted = false;
  const instance = library({ dataRoot, appRoot: dataRoot, fetcher: () => new Response(changed, { headers: { 'content-length': String(changed.length) } }),
    extract: async () => { extracted = true; return { version: '4.1.13.9' }; }, trustedHashes: [packageSha256] });
  instance.beforeInstall = () => { stopped = true; };
  try {
    await instance.init(); instance.download(); await instance.working;
    assert.equal(instance.job.status, 'error'); assert.match(instance.job.message, /离线导入/);
    assert.equal(stopped, false); assert.equal(extracted, false); assert.equal(instance.installed(), null);
  } finally { await instance.close(); await cleanup(dataRoot); }
});
test('a paused fixed-hash download resumes through PackageLibrary after a user continue action', async () => {
  const dataRoot = await temp(), payload = Buffer.alloc(1024 * 1024 + 33); Buffer.from('!<arch>\n').copy(payload);
  const sha256 = createHash('sha256').update(payload).digest('hex'); let stalled; let secondRange = 0;
  const seen = new Promise(resolve => { stalled = resolve; });
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = Number(range?.[1] || 0), end = Number(range?.[2] || payload.length - 1);
    if (start > 0 && ++secondRange === 1) { stalled(); res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': end - start + 1 }); return; }
    res.writeHead(range ? 206 : 200, range ? { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': end - start + 1 } : { 'content-length': payload.length });
    res.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = { version: 'fixture', url: `http://127.0.0.1:${server.address().port}/wechat.deb`, size: payload.length, sha256 };
  const options = { dataRoot, appRoot: dataRoot, downloadSource: source, downloadAllowHttp: true,
    fetcher: (url, init) => fetch(url, init), trustedHashes: [sha256], extract: extractor };
  const instance = new PackageLibrary(options); let restarted;
  try {
    await instance.init(); instance.download(); await seen;
    assert.equal((await instance.pauseDownload()).job.status, 'paused');
    assert.equal(instance.publicState().job.bytes, 1024 * 1024);
    await instance.close(); restarted = new PackageLibrary(options); await restarted.init();
    assert.equal(restarted.publicState().job.status, 'paused');
    restarted.resumeDownload(); await restarted.working;
    assert.equal(restarted.job.status, 'complete'); assert.ok(restarted.installed());
  } finally { await instance.close(); await restarted?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanup(dataRoot); }
});
test('closing during a fixed-hash transfer restores download.json and resumes automatically on init', async () => {
  const dataRoot = await temp(), payload = Buffer.alloc(1024 * 1024 + 45); Buffer.from('!<arch>\n').copy(payload);
  const sha256 = createHash('sha256').update(payload).digest('hex'); let stalled; let laterRange = 0;
  const seen = new Promise(resolve => { stalled = resolve; });
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = Number(range?.[1] || 0), end = Number(range?.[2] || payload.length - 1);
    if (start > 0 && ++laterRange === 1) { stalled(); res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': end - start + 1 }); return; }
    res.writeHead(range ? 206 : 200, range ? { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': end - start + 1 } : { 'content-length': payload.length });
    res.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = { version: 'fixture', url: `http://127.0.0.1:${server.address().port}/wechat.deb`, size: payload.length, sha256 };
  const options = { dataRoot, appRoot: dataRoot, downloadSource: source, downloadAllowHttp: true, fetcher: (url, init) => fetch(url, init), trustedHashes: [sha256], extract: extractor };
  const first = new PackageLibrary(options);
  let reboot;
  try {
    await first.init(); first.download(); await seen; await first.close();
    reboot = new PackageLibrary(options); await reboot.init(); await reboot.working;
    assert.equal(reboot.job.status, 'complete'); assert.ok(reboot.installed());
  } finally {
    await first.close(); await reboot?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanup(dataRoot);
  }
});
test('deferred restore waits until installation preparation hook is registered', async () => {
  const dataRoot = await temp(); let beforeInstall = 0, extracted = 0;
  const source = testDownloadSource;
  const resource = { id: `wechat-x64-${source.version}`, version: source.version, url: source.url, size: source.size, sha256: source.sha256 };
  const downloadRoot = path.join(dataRoot, 'applications/wechat/downloads'); await mkdir(downloadRoot, { recursive: true });
  await writeFile(path.join(downloadRoot, resourcePaths(resource).cache), packageBytes);
  await writeFile(path.join(dataRoot, 'applications/wechat/download.json'), JSON.stringify({
    job: { id: 'persisted', source: 'download', message: '正在下载微信' }, mode: 'remote', resource, state: 'complete'
  }));
  const instance = library({ dataRoot, appRoot: dataRoot, deferResume: true, trustedHashes: [packageSha256], extract: async (...args) => { extracted++; return extractor(...args); } });
  try {
    await instance.init();
    assert.equal(extracted, 0); assert.equal(instance.job.status, 'downloading');
    assert.equal(instance.publicState().remainingDownloadSize, 0);
    instance.beforeInstall = () => { beforeInstall++; };
    await instance.resumePendingDownload(); await instance.working;
    assert.equal(beforeInstall, 1); assert.equal(extracted, 1); assert.equal(instance.job.status, 'complete', instance.lastError);
  } finally { await instance.close(); await cleanup(dataRoot); }
});
test('a completed installation suppresses stale persisted download restoration', async () => {
  const dataRoot = await temp(), root = path.join(dataRoot, 'applications/wechat'); let downloads = 0;
  const source = testDownloadSource, versionRoot = path.join(root, 'versions', packageSha256);
  await mkdir(path.join(versionRoot, 'opt/wechat'), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'current.json'), JSON.stringify({ version: source.version, sha256: packageSha256, arch: 'x64', installedAt: '2026-01-01' }));
  await writeFile(path.join(root, 'download.json'), JSON.stringify({ job: { id: 'stale', source: 'download', message: '正在下载微信' }, mode: 'remote', resource: { id: `wechat-x64-${source.version}`, ...source }, state: 'complete' }));
  const instance = library({ dataRoot, appRoot: dataRoot, fetcher: async () => { downloads++; return fetcher(); }, extract: extractor, trustedHashes: [packageSha256] });
  try {
    await instance.init();
    assert.equal(instance.job, null); assert.equal(instance.publicState().remainingDownloadSize, 0); assert.equal(downloads, 0);
    await assert.rejects(access(path.join(root, 'download.json')));
  } finally { await instance.close(); await cleanup(dataRoot); }
});
test('upload limits, truncated files and invalid application packages do not become installed', async () => {
  const dataRoot = await temp(); const instance = library({ dataRoot, appRoot: dataRoot, extract: async () => { throw new Error('invalid package'); } });
  try {
    await instance.init(); assert.throws(() => instance.upload(Readable.from(packageBytes), MAX_PACKAGE + 1), /1 GB/);
    await instance.upload(Readable.from(packageBytes), packageBytes.length + 1); assert.equal(instance.current, null); assert.match(instance.job.message, /不完整/);
    await instance.upload(Readable.from(packageBytes), packageBytes.length); assert.equal(instance.current, null); assert.equal(instance.job.status, 'error');
  } finally { await instance.close(); await cleanup(dataRoot); }
});
test('NAS imports use permission-checked handles and release handles on failures', async () => {
  const dataRoot = await temp(); let closed = false;
  const instance = library({ dataRoot, appRoot: dataRoot, extract: extractor, trustedHashes: [createHash('sha256').update(packageBytes).digest('hex')] });
  const nas = { async openFile(uid, filename) { assert.equal(uid, '1001'); assert.equal(filename, '/vol1/user/WeChat.deb'); return { info: { size: packageBytes.length }, handle: { createReadStream: () => Readable.from(packageBytes), close: async () => { closed = true; } } }; } };
  try { await instance.init(); instance.importNas(nas, '1001', '/vol1/user/WeChat.deb'); await instance.working; assert.equal(instance.job.status, 'complete'); assert.equal(closed, true); }
  finally { await instance.close(); await cleanup(dataRoot); }
});
test('restart removes only disposable interrupted install directories', async () => {
  const dataRoot = await temp();
  const root = path.join(dataRoot, 'applications/wechat/jobs'); const job = path.join(root, 'a'.repeat(36));
  try { await mkdir(job, { recursive: true }); await writeFile(path.join(job, 'partial'), 'data'); await mkdir(path.join(root, 'keep-me')); const instance = library({ dataRoot, appRoot: dataRoot }); await instance.init(); await assert.rejects(access(job)); await access(path.join(root, 'keep-me')); }
  finally { await cleanup(dataRoot); }
});
test('unverified uploaded executables cannot become the shared application', async () => {
  const dataRoot = await temp(); let extracted = false;
  const instance = library({ dataRoot, appRoot: dataRoot, extract: async () => { extracted = true; return { version: '4.1.13.9' }; } });
  try { await instance.init(); await instance.upload(Readable.from(packageBytes), packageBytes.length); assert.equal(instance.current, null); assert.equal(extracted, true); assert.match(instance.job.message, /与栖盒适配的版本结构差异较大/); }
  finally { await instance.close(); await cleanup(dataRoot); }
});

test('uninstall excludes concurrent installers and leaves shared program intact if stopping fails', async () => {
  const dataRoot = await temp(); const instance = library({ dataRoot, appRoot: dataRoot, fetcher, extract: extractor, trustedHashes: [packageSha256] });
  try {
    await instance.init(); instance.download(); await instance.working;
    const program = path.join(instance.installed().directory, 'opt/wechat/wechat');
    instance.beforeUninstall = async () => { throw new Error('process still running'); };
    await assert.rejects(instance.uninstall(), /卸载未完成/); await access(program); assert.ok(instance.installed());
    let release; const stopped = new Promise(resolve => { release = resolve; });
    instance.beforeUninstall = () => stopped;
    const operation = instance.uninstall(); assert.equal(instance.uninstalling, true);
    assert.throws(() => instance.uninstall(), /请稍候/);
    assert.throws(() => instance.upload(Readable.from(packageBytes), packageBytes.length), /已安装|请稍候/);
    instance.download(); assert.equal(instance.job.status, 'uninstalling');
    release(); await operation; assert.equal(instance.installed(), null); await assert.rejects(access(program));
    const reboot = library({ dataRoot, appRoot: dataRoot, fetcher, extract: extractor, trustedHashes: [packageSha256] }); await reboot.init(); assert.equal(reboot.installed(), null);
    reboot.download(); await reboot.working; await access(path.join(reboot.installed().directory, 'opt/wechat/wechat')); await reboot.close();
  } finally { await instance.close(); await cleanup(dataRoot); }
});
