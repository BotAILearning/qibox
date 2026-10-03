import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { wechatLibraryPath } from '../server/wechat-libraries.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('call SDK lookup preserves vendor bytes without exposing the conflicting codec', async t => {
  const root = await temp(); t.after(() => cleanup(root));
  const application = path.join(root, 'application'), session = path.join(root, 'session');
  const vendor = path.join(application, 'opt/wechat/RadiumWMPF/runtime');
  await mkdir(vendor, { recursive: true }); await mkdir(session);
  await writeFile(path.join(vendor, 'libtxffmpeg.so'), 'CALL_SDK');
  await writeFile(path.join(vendor, 'libffmpeg.so'), 'INCOMPATIBLE_BROWSER_CODEC');
  const search = await wechatLibraryPath(application, session, '/runtime', 'x86_64-linux-gnu');
  const scope = path.join(session, 'wechat-sdk-libraries');
  assert.ok(search.includes(`:${scope}:`));
  assert.deepEqual(await readdir(scope), ['libtxffmpeg.so']);
  assert.equal(await readFile(path.join(scope, 'libtxffmpeg.so'), 'utf8'), 'CALL_SDK');
  assert.equal((await stat(path.join(scope, 'libtxffmpeg.so'))).ino, (await stat(path.join(vendor, 'libtxffmpeg.so'))).ino);
  assert.equal(search.includes(`${vendor}:`), false);
  // An application upgrade which no longer has this dependency must not keep
  // a link to its previous installation or introduce a startup failure.
  const next = path.join(root, 'next'); await mkdir(next);
  const nextSearch = await wechatLibraryPath(next, session, '/runtime', 'aarch64-linux-gnu');
  assert.deepEqual(await readdir(scope), []);
  assert.equal(nextSearch.includes(scope), false);
});
