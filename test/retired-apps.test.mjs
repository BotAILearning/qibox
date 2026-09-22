import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Instances } from '../server/instances.mjs';
import { applicationDefinition, APP_CATALOG } from '../server/catalog.mjs';
import { temp, cleanup, runtimeFactory } from './fixtures.mjs';

test('retired example instances stay on disk without loading or blocking WeChat; production rejects creating them', async t => {
  const root = await temp(), uid = '1000', userRoot = path.join(root, 'users', uid);
  const catalog = ['wechat', 'calculator', 'static-site'].map(appId => ({ appId, id: randomUUID(), name: appId }));
  await mkdir(userRoot, { recursive: true });
  await writeFile(path.join(userRoot, 'instances.json'), JSON.stringify(catalog));
  await writeFile(path.join(root, 'users.json'), JSON.stringify([uid]));
  for (const meta of catalog) { const home = path.join(userRoot, 'instances', meta.id, 'home'); await mkdir(home, { recursive: true }); await writeFile(path.join(home, 'owned.txt'), meta.appId); }
  const loaded = [];
  const owner = new Instances({ appRoot: path.resolve('.'), dataRoot: root, host: 'fnos', dev: true, library: { installed: () => ({ version: 'fixture' }) },
    runtimeFactory(...args) { loaded.push(args[1].definition.id); return runtimeFactory(...args); } });
  t.after(async () => { await owner.close(); await cleanup(root); });
  await owner.init(); const space = await owner.get(uid); await space.setConsent(true);
  assert.deepEqual(loaded, ['wechat']); assert.equal(space.instances.size, 1);
  assert.deepEqual(APP_CATALOG.map(a => a.id), ['wechat']);
  for (const appId of ['calculator', 'static-site']) { assert.throws(() => applicationDefinition(appId)); await assert.rejects(space.add(appId, appId)); }
  for (const meta of catalog) assert.equal(await readFile(path.join(userRoot, 'instances', meta.id, 'home/owned.txt'), 'utf8'), meta.appId);
});
