import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { Instances } from '../server/instances.mjs';
import { temp, cleanup, runtimeFactory } from './fixtures.mjs';
test('two users and two instances isolate data, rename, startup and keep/delete/restore', async () => {
  const dataRoot = await temp(), library = { installed: () => ({ version: '4.1.13.9', directory: '/test-only' }) };
  const users = new Instances({ dataRoot, appRoot: dataRoot, library, runtimeFactory });
  try {
    await users.init(); const one = await users.get('1001'), two = await users.get('1002');
    await assert.rejects(one.add('微信'), /同意/); await one.setConsent(true); await two.setConsent(true);
    const a = await one.add('工作微信'), b = await one.add('个人微信'), c = await two.add('另一个用户');
    assert.equal(a.appId, 'wechat');
    await assert.rejects(one.add('其他应用', 'unknown'), /暂未上架/);
    assert.notEqual(one.get(a.id).home, one.get(b.id).home); assert.notEqual(one.get(a.id).home, two.get(c.id).home);
    assert.throws(() => two.get(a.id), /不存在/); await assert.rejects(two.rename(a.id, '越权'), /不存在/);
    await Promise.all([one.start(a.id), one.start(a.id), two.start(c.id)]); assert.equal(one.get(a.id).runtime.starts, 1); assert.equal(two.get(c.id).runtime.starts, 1);
    await one.rename(a.id, '办公账号'); assert.equal(one.list().instances[0].name, '办公账号');
    const file = path.join(one.get(a.id).home, 'test-data'); await writeFile(file, 'private');
    await one.remove(a.id); assert.equal(one.list().retained.length, 1); assert.equal(await readFile(file, 'utf8'), 'private');
    assert.equal(one.list().retained[0].appId, 'wechat');
    await assert.rejects(two.restore(a.id), /未找到/); await one.restore(a.id); assert.equal(one.get(a.id).scheduler.settings.mode, 'manual');
    assert.equal(await readFile(file, 'utf8'), 'private');
    await assert.rejects(one.remove(a.id, { deleteData: true, confirmName: 'wrong' }), /输入/);
    await assert.rejects(one.remove(a.id, { deleteData: true, confirmName: '办公账号' }), /确认删除办公账号/);
    await one.remove(a.id, { deleteData: true, confirmName: '确认删除办公账号' }); await assert.rejects(access(file));
    assert.equal(two.get(c.id).runtime.status, 'running');
    await one.setConsent(false); assert.equal(two.get(c.id).runtime.status, 'running');
  } finally { await users.close(); await cleanup(dataRoot); }
});
test('catalog survives process restart; installation is shared without migrating external data', async () => {
  const dataRoot = await temp(), library = { installed: () => ({ version: '4.1.13.9' }) };
  let users = new Instances({ dataRoot, appRoot: dataRoot, library, runtimeFactory });
  try { await users.init(); const one = await users.get('1001'); await one.setConsent(true); const meta = await one.add('微信'); await users.close(); users = new Instances({ dataRoot, appRoot: dataRoot, library, runtimeFactory }); await users.init(); assert.equal((await users.get('1001')).list().instances[0].id, meta.id); assert.equal((await users.get('1002')).list().instances.length, 0); }
  finally { await users.close(); await cleanup(dataRoot); }
});

test('legacy active and retained entries acquire the WeChat app type without changing their homes', async () => {
  const dataRoot = await temp(), library = { installed: () => ({ version: '4.1.13.9' }) };
  const options = { dataRoot, appRoot: dataRoot, library, runtimeFactory };
  let users = new Instances(options);
  try {
    await users.init(); let space = await users.get('1001'); await space.setConsent(true);
    const a = await space.add('旧微信'), b = await space.add('旧保留微信');
    const home = space.get(b.id).home, file = path.join(home, 'retained-sentinel'); await writeFile(file, 'original');
    await space.remove(b.id); const catalog = space.file;
    await users.close();
    await writeFile(catalog, JSON.stringify(JSON.parse(await readFile(catalog)).map(({ appId, ...meta }) => meta)));
    users = new Instances(options); await users.init(); space = await users.get('1001');
    assert.equal(space.list().instances.find(x => x.id === a.id).appId, 'wechat');
    assert.equal(space.list().retained[0].appId, 'wechat');
    await space.restore(b.id); assert.equal(space.get(b.id).home, home);
    assert.equal(await readFile(file, 'utf8'), 'original');
    assert.ok(JSON.parse(await readFile(catalog)).every(x => x.appId === 'wechat'));
  } finally { await users.close(); await cleanup(dataRoot); }
});

test('retained data reopens the exact original home after restart, while a new instance stays separate', async () => {
  const dataRoot = await temp(); let installed = true;
  const library = { installed: () => installed ? { version: '4.1.13.9' } : null };
  const options = { dataRoot, appRoot: dataRoot, library, runtimeFactory };
  let users = new Instances(options);
  try {
    await users.init(); let space = await users.get('1001'); await space.setConsent(true);
    const original = await space.add('微信'); const home = space.get(original.id).home;
    const database = path.join(home, 'chat-data'), login = path.join(home, 'login-data');
    await writeFile(database, Buffer.from([0, 1, 2, 255, 128])); await writeFile(login, 'retained-login-fixture');
    await space.remove(original.id, { deleteData: false }); await users.close();
    users = new Instances(options); await users.init(); space = await users.get('1001');
    assert.equal(space.list().retained[0].id, original.id);
    await assert.rejects(space.add('微信'), /名称已存在/);
    const fresh = await space.add('新微信'); assert.notEqual(space.get(fresh.id).home, home);
    await assert.rejects(access(path.join(space.get(fresh.id).home, 'chat-data')));
    installed = false; await assert.rejects(space.restore(original.id), /先安装微信/); installed = true;
    await space.restore(original.id); await space.start(original.id);
    const restored = space.get(original.id);
    assert.equal(restored.home, home); assert.equal((await restored.runtime.options.store.active()).home, home);
    assert.deepEqual(await readFile(database), Buffer.from([0, 1, 2, 255, 128]));
    assert.equal(await readFile(login, 'utf8'), 'retained-login-fixture');
    await space.rename(original.id, '工作微信');
    await assert.rejects(space.remove(original.id, { deleteData: true, confirmName: '确认删除微信' }), /确认删除工作微信/);
    await space.remove(original.id, { deleteData: true, confirmName: '确认删除工作微信' });
    await assert.rejects(access(home));
  } finally { await users.close(); await cleanup(dataRoot); }
});
