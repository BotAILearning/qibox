import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Instances } from '../server/instances.mjs';
import { temp, cleanup, runtimeFactory } from './fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';

// Only disposable instance files are touched. Runtime, WeChat and model are
// fixtures. No case contacts a service or starts a native process.
async function fixture(t) {
  const root = await temp(), provider = new AIModelFixture();
  const options = { dataRoot: root, appRoot: root, library: { installed: () => ({ version: 'fixture-only' }) }, aiProvider: provider,
    runtimeFactory: (...args) => ({ ...runtimeFactory(...args), aiBridge: new ChatFixture() }) };
  let users = new Instances(options); await users.init();
  const space = await users.get('1001'); await space.setConsent(true);
  const meta = await space.add('待删除合成实例'), kept = await space.add('另一合成实例'), item = space.get(meta.id);
  const marker = path.join(item.home, 'synthetic.txt'), otherMarker = path.join(space.get(kept.id).home, 'untouched.txt');
  await fs.writeFile(marker, 'synthetic data'); await fs.writeFile(otherMarker, 'other instance unchanged');
  const originalClose = item.ai.close;
  t.after(async () => { item.ai.close = originalClose; await users.close(); await cleanup(root); });
  return { root, provider, options, space, meta, kept, item, marker, otherMarker, originalClose,
    getUser(uid) { return users.get(uid); },
    async reopen() { await users.close(); users = new Instances(options); await users.init(); return users.get('1001'); } };
}
async function withBuiltin(name, replacement, action) {
  const original = fs[name]; fs[name] = (...args) => replacement(original, ...args); syncBuiltinESMExports();
  try { return await action(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const missing = error => error.code === 'ENOENT';
const fileFault = error => ['EPERM', 'EACCES', 'EISDIR', 'ENOTDIR', 'EEXIST'].includes(error.code);

test('failed keep-data deletion leaves its active AI and scheduler usable through ordinary start', async t => {
  const f = await fixture(t); await f.space.start(f.meta.id);
  let now = Date.now(); f.item.ai.now = () => now;
  await f.item.ai.configure(modelConfig); await f.item.ai.scan(); const contact = f.item.runtime.aiBridge.contacts[0].id;
  await f.item.ai.setReplyOptions({ contact, enabled: true, judgeReply: false }); await f.item.ai.settings({ enabled: true }); await f.item.ai.tick();
  const original = await fs.readFile(f.space.file), backup = f.space.file + '.original';
  await fs.rename(f.space.file, backup); await fs.mkdir(f.space.file);
  try { await assert.rejects(f.space.remove(f.meta.id), fileFault); }
  finally { await fs.rmdir(f.space.file); await fs.rename(backup, f.space.file); }
  assert.deepEqual(await fs.readFile(f.space.file), original); assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic data');
  assert(f.space.list().instances.some(row => row.id === f.meta.id));
  assert.equal(f.item.ai.closed, false, 'A rejected removal must not permanently destroy the still-active assistant');
  assert.equal(f.item.scheduler.timer._destroyed, false);
  await f.space.start(f.meta.id); await f.item.ai.settings({ enabled: true }); await f.item.ai.tick();
  const incoming = f.item.runtime.aiBridge.push(contact, 'other', '合成新问题'); incoming.timestamp = Math.floor(now / 1000);
  await f.item.ai.tick(); now += 20000; await f.item.ai.tick();
  assert.equal(f.item.runtime.status, 'running'); assert.equal(f.provider.calls.length, 1); assert.equal(f.item.runtime.aiBridge.sent.length, 1);
  assert.equal(f.space.get(f.kept.id).ai.closed, false); assert.equal(await fs.readFile(f.otherMarker, 'utf8'), 'other instance unchanged');
  const reloaded = await f.reopen(); assert.equal(reloaded.get(f.meta.id).ai.closed, false); assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic data');
});

test('a concurrent ordinary start cannot revive an instance while its removal catalog write is pending', async t => {
  const f = await fixture(t); await f.space.start(f.meta.id);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  await withBuiltin('rename', async (rename, from, to) => {
    if (to === f.space.file) { entered.resolve(); await release.promise; }
    return rename(from, to);
  }, async () => {
    const removing = f.space.remove(f.meta.id); await entered.promise;
    try { await assert.rejects(f.space.start(f.meta.id), error => error.status === 409 && error.code === 'INSTANCE_REMOVING'); }
    finally { release.resolve(); }
    await removing;
  });
  assert.equal(f.item.runtime.status, 'stopped'); assert.equal(f.space.list().instances.some(row => row.id === f.meta.id), false);
  assert.equal(f.space.list().retained.some(row => row.id === f.meta.id), true); assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic data');
});

for (const deleteData of [false, true]) test(`catalog-committed ${deleteData ? 'erase' : 'keep-data'} removal reports a later close failure without claiming rollback`, async t => {
  const f = await fixture(t); f.item.ai.close = async () => { throw Object.assign(Error('fixture close failed'), { code: 'EIO' }); };
  await assert.rejects(f.space.remove(f.meta.id, { deleteData, confirmName: `确认删除${f.meta.name}` }), error => error.code === 'INSTANCE_REMOVE_INCOMPLETE' && /已移除/.test(error.message));
  assert.equal((await json(f.space.file)).find(row => row.id === f.meta.id).removedAt != null, true);
  assert.equal(f.space.list().instances.some(row => row.id === f.meta.id), false); assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic data');
  assert.equal(f.space.get(f.kept.id).ai.closed, false);
  f.item.ai.close = f.originalClose;
  if (deleteData) {
    await assert.rejects(f.space.restore(f.meta.id), error => error.code === 'INSTANCE_DATA_DELETION_PENDING');
    await f.space.remove(f.meta.id, { deleteData: true, confirmName: `确认删除${f.meta.name}` }); await assert.rejects(fs.access(f.marker), missing);
  } else {
    await f.space.restore(f.meta.id); assert.equal(f.space.get(f.meta.id).ai.closed, false); assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic data');
  }
});

test('partial erase remains explicitly non-restorable across restart and a confirmed retry clears only that instance', async t => {
  const f = await fixture(t); let injected = false;
  await withBuiltin('rm', async (rm, file, options) => {
    if (file === f.item.dataRoot && !injected) { injected = true; await rm(f.marker); throw Object.assign(Error('fixture partial erase'), { code: 'EIO' }); }
    return rm(file, options);
  }, async () => { await assert.rejects(f.space.remove(f.meta.id, { deleteData: true, confirmName: `确认删除${f.meta.name}` }), error => error.code === 'INSTANCE_DATA_CLEANUP_INCOMPLETE'); });
  assert(injected); assert.equal((await json(f.space.file)).find(row => row.id === f.meta.id).dataDeletionStartedAt != null, true);
  await assert.rejects(f.space.restore(f.meta.id), error => error.code === 'INSTANCE_DATA_DELETION_PENDING');
  const space = await f.reopen(); await assert.rejects(space.restore(f.meta.id), error => error.code === 'INSTANCE_DATA_DELETION_PENDING');
  await space.remove(f.meta.id, { deleteData: true, confirmName: `确认删除${f.meta.name}` });
  assert.equal(space.list().retained.some(row => row.id === f.meta.id), false); assert.equal(await fs.readFile(f.otherMarker, 'utf8'), 'other instance unchanged');
});

test('erase followed by final catalog-write failure never offers missing data as a recoverable retained instance', async t => {
  const f = await fixture(t); let writes = 0;
  await withBuiltin('rename', async (rename, from, to) => {
    if (to === f.space.file && ++writes === 2) throw Object.assign(Error('fixture final catalog EIO'), { code: 'EIO' });
    return rename(from, to);
  }, async () => { await assert.rejects(f.space.remove(f.meta.id, { deleteData: true, confirmName: `确认删除${f.meta.name}` }), error => error.code === 'INSTANCE_DATA_CLEANUP_INCOMPLETE' && /已删除/.test(error.message)); });
  assert.equal(writes, 2); await assert.rejects(fs.access(f.marker), missing);
  const row = (await json(f.space.file)).find(row => row.id === f.meta.id); assert(row.removedAt && row.dataDeletionStartedAt);
  const space = await f.reopen(); await assert.rejects(space.restore(f.meta.id), error => error.code === 'INSTANCE_DATA_DELETION_PENDING');
  await assert.rejects(fs.access(f.item.home), missing, 'Failed restore must not recreate an empty original home');
  await space.remove(f.meta.id, { deleteData: true, confirmName: `确认删除${f.meta.name}` });
  assert.equal((await json(space.file)).some(row => row.id === f.meta.id), false); assert.equal(await fs.readFile(f.otherMarker, 'utf8'), 'other instance unchanged');
});

async function otherUser(f) {
  const space = await f.getUser('1002'); await space.setConsent(true); const meta = await space.add('其他用户合成实例');
  const file = path.join(space.get(meta.id).home, 'other-user.txt'); await fs.writeFile(file, 'other user unchanged'); return file;
}
test('bulk data clearing cannot erase or permanently close any instance before its first catalog intent commits', async t => {
  const f = await fixture(t), foreign = await otherUser(f); await f.space.start(f.meta.id);
  const original = await fs.readFile(f.space.file), backup = f.space.file + '.original';
  await fs.rename(f.space.file, backup); await fs.mkdir(f.space.file);
  try { await assert.rejects(f.space.clearData(), fileFault); }
  finally { await fs.rmdir(f.space.file); await fs.rename(backup, f.space.file); }
  assert.deepEqual(await fs.readFile(f.space.file), original); assert.equal(f.item.ai.closed, false); assert.equal(f.item.scheduler.timer._destroyed, false);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic data'); assert.equal(await fs.readFile(f.otherMarker, 'utf8'), 'other instance unchanged');
  const space = await f.reopen(); assert.equal(space.list().instances.length, 2); assert.equal(await fs.readFile(f.marker, 'utf8'), 'synthetic data');
  assert.equal(await fs.readFile(foreign, 'utf8'), 'other user unchanged');
});
test('bulk partial erase keeps a durable non-restorable target, leaves untouched entries intact and resumes only the same user scope', async t => {
  const f = await fixture(t), foreign = await otherUser(f); let injected = false;
  await withBuiltin('rm', async (rm, file, options) => {
    if (file === f.item.dataRoot && !injected) { injected = true; await rm(f.marker); throw Object.assign(Error('fixture bulk partial erase'), { code: 'EIO' }); }
    return rm(file, options);
  }, async () => { await assert.rejects(f.space.clearData(), error => error.code === 'INSTANCE_DATA_CLEANUP_INCOMPLETE'); });
  assert(injected); const catalog = await json(f.space.file), pending = catalog.find(row => row.id === f.meta.id);
  assert(pending.removedAt && pending.dataDeletionStartedAt); assert.equal(catalog.find(row => row.id === f.kept.id).removedAt, undefined);
  assert.equal(f.space.get(f.kept.id).ai.closed, false); assert.equal(await fs.readFile(f.otherMarker, 'utf8'), 'other instance unchanged');
  const space = await f.reopen(); await assert.rejects(space.restore(f.meta.id), error => error.code === 'INSTANCE_DATA_DELETION_PENDING');
  await space.clearData(); assert.equal(space.list().instances.length, 0); assert.equal(space.list().retained.length, 0);
  await assert.rejects(fs.access(f.marker), missing); await assert.rejects(fs.access(f.otherMarker), missing); assert.equal(await fs.readFile(foreign, 'utf8'), 'other user unchanged');
});
test('bulk final catalog failure records that erasure started and never recreates a missing home after restart', async t => {
  const f = await fixture(t), foreign = await otherUser(f); let writes = 0;
  await withBuiltin('rename', async (rename, from, to) => {
    if (to === f.space.file && ++writes === 2) throw Object.assign(Error('fixture bulk final catalog EIO'), { code: 'EIO' });
    return rename(from, to);
  }, async () => { await assert.rejects(f.space.clearData(), error => error.code === 'INSTANCE_DATA_CLEANUP_INCOMPLETE' && /已删除/.test(error.message)); });
  assert.equal(writes, 2); const catalog = await json(f.space.file); assert(catalog.find(row => row.id === f.meta.id).dataDeletionStartedAt);
  assert.equal(catalog.find(row => row.id === f.kept.id).removedAt, undefined); assert.equal(await fs.readFile(f.otherMarker, 'utf8'), 'other instance unchanged');
  const space = await f.reopen(); await assert.rejects(space.restore(f.meta.id), error => error.code === 'INSTANCE_DATA_DELETION_PENDING');
  await assert.rejects(fs.access(f.item.home), missing); await space.clearData(); assert.deepEqual(await json(space.file), []);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'other user unchanged');
});
