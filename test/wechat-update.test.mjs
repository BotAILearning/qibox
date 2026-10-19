import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { WechatUpdate } from '../server/wechat-update.mjs';
import { DurableDownload } from '../server/durable-download.mjs';
import { temp, cleanup } from './fixtures.mjs';

const md5 = value => createHash('md5').update(value).digest('hex');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const updateBytes = Buffer.from('wechat-update-package');

async function context({ fetcher, version = '4.1.13.9', currentSha = 'old-current', validateProgram, extractVersion = '4.2.0.0', stubSave = true } = {}) {
  const dataRoot = await temp(), root = path.join(dataRoot, 'applications', 'wechat');
  await mkdir(root, { recursive: true });
  await mkdir(path.join(dataRoot, 'users', 'u1'), { recursive: true });
  await writeFile(path.join(dataRoot, 'users', 'u1', 'instances.json'), JSON.stringify([
    { id: 'one', name: '运行实例', appId: 'wechat' },
    { id: 'removed', name: '已删除', removedAt: Date.now() },
    { id: 'other', name: '其他应用', appId: 'other' },
  ]));
  let stops = 0;
  const users = { uids: ['u1'], spaces: new Map([['u1', { instances: new Map([['one', { runtime: { status: 'running' } }]]) }]]), async stopForUpdate() { stops++; } };
  const bytes = updateBytes, checksum = md5(bytes);
  const library = {
    root, appRoot: root, runtimeRoot: path.join(root, 'runtime'), sourceUrl: 'https://official.invalid/wechat.deb',
    arch: { node: 'x64', deb: 'amd64' }, current: { version, sha256: currentSha }, working: null, updating: false,
    extract: async (file, destination) => { await mkdir(path.join(destination, 'opt', 'wechat'), { recursive: true }); await writeFile(path.join(destination, 'opt', 'wechat', 'wechat'), 'new program'); return { version: extractVersion, arch: 'amd64' }; },
    saveStream: async (stream, destination, size) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); const value = Buffer.concat(chunks); assert.equal(value.length, size); await writeFile(destination, value); },
  };
  const calls = [];
  const sourceFetcher = fetcher || (async (url, options = {}) => { calls.push(options.method || 'GET'); if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(bytes.length), 'x-cos-meta-md5': checksum } }); return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }); });
  const updater = new WechatUpdate({ library, users, dataRoot, validateProgram: validateProgram || (async () => {}), fetcher: sourceFetcher });
  // These tests exercise transaction logic with an in-memory state boundary;
  // persistence/fsync is covered by the application integration tests.
  if (stubSave) updater.save = async () => {};
  return { dataRoot, library, users, updater, calls, get stops() { return stops; }, bytes, checksum };
}

test('init performs no network request and preview is the first official HEAD', async () => {
  const ctx = await context();
  try {
    await ctx.updater.init(); assert.deepEqual(ctx.calls, []);
    const preview = await ctx.updater.preview();
    assert.deepEqual(ctx.calls, ['HEAD']); assert.equal(preview.current.version, '4.1.13.9');
    assert.deepEqual(preview.affected, [{ name: '运行实例', running: true }]);
  } finally { await ctx.updater.close(); await cleanup(ctx.dataRoot); }
});

test('confirmation token binds current program and affected instance set', async () => {
  const ctx = await context();
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview();
    ctx.library.current = { ...ctx.library.current, sha256: 'changed' };
    await assert.rejects(ctx.updater.download(preview.token), /过期|受影响/);
    ctx.library.current.sha256 = 'old-current'; const second = await ctx.updater.preview();
    await writeFile(path.join(ctx.dataRoot, 'users', 'u1', 'instances.json'), JSON.stringify([{ id: 'new', name: '新实例' }]));
    await assert.rejects(ctx.updater.download(second.token), /过期|受影响/);
  } finally { await ctx.updater.close(); await cleanup(ctx.dataRoot); }
});

test('download and upload reservations reject concurrent update transactions', async () => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const ctx = await context({ fetcher: async (url, options = {}) => { if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(updateBytes.length), 'x-cos-meta-md5': md5(updateBytes) } }); await hold; return new Response(updateBytes, { status: 200, headers: { 'content-length': String(updateBytes.length) } }); } });
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview(); const first = ctx.updater.download(preview.token);
    await assert.rejects(ctx.updater.download(preview.token), /正在处理/); release(); await first; await ctx.updater.working;
    assert.equal(ctx.stops, 1);
  } finally { release?.(); await ctx.updater.close(); await cleanup(ctx.dataRoot); }
});

test('the first update reserves before a delayed instance scan; failure releases only its reservation', async () => {
  const ctx = await context(); let release;
  const hold = new Promise(resolve => { release = resolve; });
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview();
    const affected = ctx.updater.affected.bind(ctx.updater); let scans = 0;
    ctx.updater.affected = async () => { scans++; await hold; return affected(); };
    const first = ctx.updater.confirm(preview.token);
    await assert.rejects(ctx.updater.confirm(preview.token), /正在处理/);
    assert.equal(scans, 1); release(); await first;
    assert.equal(ctx.updater.reserved, true);
    assert.equal(ctx.library.updating, true);
  } finally { release?.(); ctx.updater.reserved = false; ctx.library.updating = false; await ctx.updater.close(); await cleanup(ctx.dataRoot); }
  const failed = await context();
  try {
    await failed.updater.init(); const preview = await failed.updater.preview();
    const affected = failed.updater.affected.bind(failed.updater);
    failed.updater.affected = async () => { throw new Error('隔离扫描失败'); };
    await assert.rejects(failed.updater.confirm(preview.token), /隔离扫描失败/);
    assert.equal(failed.updater.reserved, false); assert.equal(!!failed.library.updating, false);
    failed.updater.affected = affected;
    await failed.updater.confirm(preview.token);
    assert.equal(failed.updater.reserved, true);
  } finally { failed.updater.reserved = false; failed.library.updating = false; await failed.updater.close(); await cleanup(failed.dataRoot); }
});

test('self-test failure leaves old current and does not stop instances; newer uploaded version is accepted', async () => {
  const ctx = await context({ extractVersion: '4.2.1.0', validateProgram: async () => { throw new Error('隔离自检失败'); } });
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview();
    await ctx.updater.upload(preview.token, Readable.from(updateBytes), updateBytes.length); await ctx.updater.working;
    assert.equal(ctx.library.current.sha256, 'old-current'); assert.equal(ctx.stops, 0); assert.match(ctx.updater.state.error, /隔离自检失败/);
  } finally { await ctx.updater.close(); await cleanup(ctx.dataRoot); }
});

test('downgrade is rejected before stopping and same sha is a no-op', async () => {
  const downgrade = await context({ extractVersion: '4.0.0.0' });
  try {
    await downgrade.updater.init(); const preview = await downgrade.updater.preview(); await downgrade.updater.upload(preview.token, Readable.from(updateBytes), updateBytes.length); await downgrade.updater.working;
    assert.equal(downgrade.stops, 0); assert.match(downgrade.updater.state.error, /不能直接降级/);
  } finally { await downgrade.updater.close(); await cleanup(downgrade.dataRoot); }
  const same = await context({ currentSha: sha256(updateBytes), extractVersion: '4.1.13.9' });
  try {
    await same.updater.init(); const preview = await same.updater.preview(); await same.updater.upload(preview.token, Readable.from(updateBytes), updateBytes.length); await same.updater.working;
    assert.equal(same.stops, 0); assert.equal(same.library.current.sha256, sha256(updateBytes)); assert.match(same.updater.state.message, /相同/);
  } finally { await same.updater.close(); await cleanup(same.dataRoot); }
});

test('manual update holds are created only after validation and can be explicitly released', async () => {
  const ctx = await context();
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview(); await ctx.updater.upload(preview.token, Readable.from(updateBytes), updateBytes.length); await ctx.updater.working;
    assert.equal(ctx.updater.state.status, 'complete', ctx.updater.state.error || ctx.updater.state.message);
    assert.equal(ctx.library.updateHolds.size, 1); const key = [...ctx.library.updateHolds][0]; await ctx.library.releaseUpdateHold(key); assert.equal(ctx.library.updateHolds.size, 0);
  } finally { await ctx.updater.close(); await cleanup(ctx.dataRoot); }
});

test('MD5 download rebuild with autoResume false preserves checkpoint until explicit range resume', async () => {
  const root = await temp(), payload = Buffer.alloc(2 * 1024 * 1024, 7), checksum = md5(payload); let requests = 0, firstChunk;
  const resource = { id: 'manual-md5', version: 'official', url: 'https://official.invalid/update.deb', size: payload.length, md5: checksum };
  let pausePromise;
  const downloader = new DurableDownload({ directory: root, autoResume: false, fetcher: async (url, options = {}) => {
    requests++; const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.range || ''); const start = Number(range?.[1] || 0); const end = Number(range?.[2] || payload.length - 1);
    if (start === 0) return new Response(payload.subarray(0, end + 1), { status: 206, headers: { 'content-range': `bytes 0-${end}/${payload.length}`, 'content-length': String(end + 1) } });
    await new Promise((resolve, reject) => { options.signal?.addEventListener('abort', () => { firstChunk?.(); reject(new Error('aborted')); }, { once: true }); });
    return new Response(payload.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': String(end - start + 1) } });
  }, onChange: state => { if (state.bytes === 1024 * 1024 && !pausePromise) { firstChunk = () => {}; pausePromise = downloader.pause(); } } });
  try {
    await downloader.init(resource); downloader.start(); await pausePromise; await downloader.working;
    const checkpoint = downloader.snapshot().bytes; assert.equal(checkpoint, 1024 * 1024); const beforeRebuild = requests;
    await downloader.close();
    const resumed = new DurableDownload({ directory: root, autoResume: false, fetcher: async (url, options = {}) => {
      requests++; const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.range || ''); const start = Number(range?.[1] || 0), end = Number(range?.[2] || payload.length - 1);
      return new Response(payload.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': String(end - start + 1) } });
    } });
    await resumed.init(resource); assert.equal(requests, beforeRebuild, 'rebuild does not auto-resume'); resumed.start(); await resumed.working;
    assert.equal(resumed.snapshot().status, 'complete'); assert.equal(requests, beforeRebuild + 1); await resumed.close();
  } finally { await downloader.close(); await cleanup(root); }
});

test('real manager save persists holds and a rebuilt manager reloads them without starting instances', async () => {
  const first = await context({ stubSave: false });
  try {
    await first.updater.init(); const preview = await first.updater.preview();
    await first.updater.upload(preview.token, Readable.from(updateBytes), updateBytes.length); await first.updater.working;
    assert.equal(first.updater.state.status, 'complete', first.updater.state.error);
    assert.equal(first.library.updateHolds.size, 1);
    const second = new WechatUpdate({ library: first.library, users: first.users, dataRoot: first.dataRoot, validateProgram: async () => {}, fetcher: first.updater.fetcher });
    await second.init(); assert.equal(second.library.updateHolds.size, 1); assert.equal(first.users.instancesStarted || 0, 0);
    const hold = [...second.library.updateHolds][0]; await second.library.releaseUpdateHold(hold); assert.equal(second.library.updateHolds.size, 0);
  } finally { await first.updater.close(); await cleanup(first.dataRoot); }
});

test('pause immediately after download launch gates the first save and prevents GET or instance stop', async () => {
  const ctx = await context(); let releaseSave; let saveCount = 0, enterSave;
  const gate = new Promise(resolve => { releaseSave = resolve; }), entered = new Promise(resolve => { enterSave = resolve; });
  ctx.updater.save = async () => { saveCount++; if (saveCount === 2) { enterSave(); await gate; } };
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview(); const operation = ctx.updater.download(preview.token);
    await entered; const paused = ctx.updater.pause(); releaseSave(); await operation; await paused;
    assert.deepEqual(ctx.calls, ['HEAD']); assert.equal(ctx.stops, 0); assert.equal(ctx.library.updating, false);
  } finally { releaseSave?.(); await ctx.updater.close(); await cleanup(ctx.dataRoot); }
});

test('save ENOSPC and log handling settle the manager without unhandled rejection or update lock', async () => {
  const ctx = await context(); const failures = [];
  const unhandled = reason => failures.push(reason); process.on('unhandledRejection', unhandled);
  ctx.updater.save = async () => { throw Object.assign(new Error('磁盘空间不足'), { code: 'ENOSPC' }); };
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview(); const result = await ctx.updater.download(preview.token); await ctx.updater.working;
    assert.ok(result); assert.equal(ctx.library.updating, false); assert.equal(ctx.updater.working, null); assert.deepEqual(failures, []);
  } finally { process.off('unhandledRejection', unhandled); await ctx.updater.close().catch(() => {}); await cleanup(ctx.dataRoot); }
});

test('existing library update or uninstall lock rejects a second transaction before consuming token', async () => {
  const ctx = await context();
  try {
    await ctx.updater.init(); const preview = await ctx.updater.preview(); ctx.library.updating = true;
    await assert.rejects(ctx.updater.download(preview.token), /正在处理/);
    ctx.library.updating = false; ctx.library.uninstalling = true;
    const next = await ctx.updater.preview(); await assert.rejects(ctx.updater.upload(next.token, Readable.from(updateBytes), updateBytes.length), /正在处理|卸载/);
  } finally { ctx.library.updating = false; await ctx.updater.close(); await cleanup(ctx.dataRoot); }
});

