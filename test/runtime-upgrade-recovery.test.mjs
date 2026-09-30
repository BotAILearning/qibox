import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { clearRuntimeCache, Runtime } from '../server/runtime.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('protected stale runtime cache is retained outside the next upgrade target', async t => {
  const root = await temp(); t.after(() => cleanup(root));
  const cache = path.join(root, 'runtime.previous'); await mkdir(cache); await writeFile(path.join(cache, 'protected.pyc'), 'OLD_CACHE');
  await clearRuntimeCache(cache, { remove: async () => { throw Object.assign(Error('permission denied'), { code: 'EACCES' }); } });
  const retained = (await readdir(root)).find(name => name.startsWith('runtime.previous.retained-'));
  assert.ok(retained); assert.equal(await readFile(path.join(root, retained, 'protected.pyc'), 'utf8'), 'OLD_CACHE');
  assert.equal((await readdir(root)).includes('runtime.previous'), false);
  await assert.rejects(clearRuntimeCache(path.join(root, 'home')), /Unexpected runtime cache path/);
});

test('unprepared runtime retries preparation and never spawns an undefined display executable', async () => {
  const runtime = new Runtime({ appRoot: 'unused', dataRoot: 'unused' });
  runtime.status = 'error'; let prepared = 0, spawned = 0;
  runtime.stop = async () => { runtime.status = 'stopped'; };
  runtime.prepare = async () => { prepared++; runtime.status = 'error'; };
  runtime.child = () => { spawned++; throw Error('Must not spawn'); };
  await assert.rejects(runtime.start(), /应用尚未准备好/);
  assert.equal(prepared, 1); assert.equal(spawned, 0);
});
