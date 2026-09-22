import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Instances } from '../server/instances.mjs';
import { temp, cleanup, runtimeFactory } from './fixtures.mjs';

const conflict = error => error.status === 409 && error.code === 'NAME_CONFLICT';
const options = dataRoot => ({ dataRoot, appRoot: dataRoot, library: { installed: () => ({ version: '4.1.13.9' }) }, runtimeFactory });

test('create and rename reserve both active and retained names, trim spaces and keep users independent', async () => {
  const dataRoot = await temp(), users = new Instances(options(dataRoot));
  try {
    await users.init(); const space = await users.get('1001'), other = await users.get('1002');
    await space.setConsent(true); await other.setConsent(true);
    const first = await space.add('微信'), second = await space.add('工作微信');
    await assert.rejects(space.add('  微信  '), conflict);
    await space.rename(first.id, ' 微信 '); assert.equal(space.get(first.id).meta.name, '微信');
    await assert.rejects(space.rename(second.id, '微信'), conflict);
    await space.remove(first.id);
    const before = await readdir(path.join(space.root, 'instances'));
    await assert.rejects(space.add('微信'), conflict);
    await assert.rejects(space.rename(second.id, ' 微信 '), conflict);
    assert.deepEqual(await readdir(path.join(space.root, 'instances')), before);
    assert.equal(space.get(second.id).meta.name, '工作微信');
    assert.equal((await other.add('微信')).name, '微信');
    await space.remove(first.id, { deleteData: true, confirmName: '确认删除微信' });
    assert.equal((await space.add('微信')).name, '微信', 'permanent removal releases the name');
  } finally { await users.close(); await cleanup(dataRoot); }
});

test('concurrent create and rename requests cannot claim the same name', async () => {
  const dataRoot = await temp(), users = new Instances(options(dataRoot));
  try {
    await users.init(); const space = await users.get('1001'); await space.setConsent(true);
    const additions = await Promise.allSettled([space.add('微信'), space.add('微信')]);
    assert.equal(additions.filter(x => x.status === 'fulfilled').length, 1);
    assert.ok(conflict(additions.find(x => x.status === 'rejected').reason));
    const first = additions.find(x => x.status === 'fulfilled').value;
    const mixed = await Promise.allSettled([space.rename(first.id, '办公'), space.add('办公')]);
    assert.equal(mixed.filter(x => x.status === 'fulfilled').length, 1);
    assert.ok(conflict(mixed.find(x => x.status === 'rejected').reason));
    assert.equal(space.list().instances.filter(x => x.name === '办公').length, 1);
  } finally { await users.close(); await cleanup(dataRoot); }
});

test('legacy restore conflicts require a valid new name and preserve the original data through restart', async () => {
  const dataRoot = await temp(); let users = new Instances(options(dataRoot));
  try {
    await users.init(); let space = await users.get('1001'); await space.setConsent(true);
    const old = await space.add('原微信'), active = await space.add('工作微信'), retained = await space.add('保留微信');
    const home = space.get(old.id).home, file = path.join(home, 'chat-data');
    await writeFile(file, Buffer.from([0, 1, 128, 255]));
    await space.remove(old.id); await space.remove(retained.id); await users.close();
    // Old releases allowed an active application and retained data to share a name.
    const catalog = JSON.parse(await readFile(space.file, 'utf8'));
    catalog.find(x => x.id === old.id).name = active.name;
    await writeFile(space.file, JSON.stringify(catalog));
    users = new Instances(options(dataRoot)); await users.init(); space = await users.get('1001');
    const before = await readFile(space.file, 'utf8');
    await assert.rejects(space.restore(old.id), conflict);
    await assert.rejects(space.restore(old.id, ' 保留微信 '), conflict);
    for (const invalid of ['', '  ', null, 42, '微'.repeat(31)]) await assert.rejects(space.restore(old.id, invalid), /请输入/);
    assert.equal(await readFile(space.file, 'utf8'), before);
    assert.equal(space.instances.has(old.id), false); assert.equal(space.list().retained.length, 2);
    const restored = await space.restore(old.id, ' 恢复微信 ');
    assert.equal(restored.name, '恢复微信'); assert.equal(restored.id, old.id);
    assert.equal(space.get(old.id).home, home); assert.equal(space.get(old.id).scheduler.settings.mode, 'manual');
    assert.deepEqual(await readFile(file), Buffer.from([0, 1, 128, 255]));
    await users.close(); users = new Instances(options(dataRoot)); await users.init(); space = await users.get('1001');
    assert.equal(space.get(old.id).meta.name, '恢复微信'); assert.equal(space.get(old.id).home, home);
    assert.deepEqual(await readFile(file), Buffer.from([0, 1, 128, 255]));
  } finally { await users.close(); await cleanup(dataRoot); }
});

test('restore checks other retained data and serializes competing restores to a new name', async () => {
  const dataRoot = await temp(); let users = new Instances(options(dataRoot));
  try {
    await users.init(); let space = await users.get('1001'); await space.setConsent(true);
    const first = await space.add('微信'), second = await space.add('工作微信');
    await space.remove(first.id); await space.remove(second.id); await users.close();
    const catalog = JSON.parse(await readFile(space.file, 'utf8')); catalog[1].name = catalog[0].name;
    await writeFile(space.file, JSON.stringify(catalog));
    users = new Instances(options(dataRoot)); await users.init(); space = await users.get('1001');
    await assert.rejects(space.restore(first.id), conflict); await assert.rejects(space.restore(second.id), conflict);
    const results = await Promise.allSettled([space.restore(first.id, '恢复微信'), space.restore(second.id, '恢复微信')]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.ok(conflict(results.find(x => x.status === 'rejected').reason));
    assert.equal(space.list().retained.length, 1);
    // Once the other instance changes its name, this original name is available.
    await space.restore(space.list().retained[0].id);
    assert.deepEqual(space.list().instances.map(x => x.name).sort(), ['微信', '恢复微信'].sort());
  } finally { await users.close(); await cleanup(dataRoot); }
});
