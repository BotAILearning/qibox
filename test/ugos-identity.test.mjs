import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { gatewayIdentity, validUserKey } from '../server/platform.mjs';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';

const account = 'b9726d36-9f52-4d2b-a212-bcb4a2d546ac';
const headers = (uid, kind = 'users') => ({ 'ugreen-user-id': uid, ...kind === 'absent' ? {} : { 'ugreen-user-type': kind } });
const request = (uid, kind) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: headers(uid, kind) });

test('UGOS accepts opaque account IDs without changing numeric users or merging distinct accounts', () => {
  assert.equal(gatewayIdentity(request('1000', 'admin'), 'ugos').uid, '1000');
  const user = gatewayIdentity(request(account, 'admin'), 'ugos');
  assert.match(user.uid, /^ugos-[a-f0-9]{64}$/);
  assert.equal(user.isAdmin, true);
  assert.equal(validUserKey(user.uid, { host: 'ugos' }), true);
  assert.equal(validUserKey(user.uid, { host: 'fnos' }), false);
  assert.match(gatewayIdentity(request('1'.repeat(256)), 'ugos').uid, /^ugos-[a-f0-9]{64}$/);
  assert.equal(gatewayIdentity(request(account), 'ugos').uid, user.uid);
  for (const other of [account.toUpperCase(), account + '1', user.uid, '1000']) assert.notEqual(gatewayIdentity(request(other), 'ugos').uid, user.uid);
  for (const invalid of [undefined, '', '../1000', 'a/b', 'a\\b', '1000,1001', ['1000', '1001'], 'x'.repeat(257)]) {
    assert.throws(() => gatewayIdentity(request(invalid, 'admin'), 'ugos'), error => error.status === 401);
  }
  assert.throws(() => gatewayIdentity({ ...request(account, 'admin'), socket: { remoteAddress: '192.168.1.9' } }, 'ugos'), error => error.status === 403);
  for (const kind of ['', 'administrator', 'root', '1', 'admin,users', ['admin']]) {
    const req = request(account); req.headers['ugreen-user-type'] = kind;
    assert.throws(() => gatewayIdentity(req, 'ugos'), error => error.status === 401);
  }
});

test('UGOS 1.19 gateway identity remains usable when the optional role header is absent', () => {
  const req = request('1001'); delete req.headers['ugreen-user-type'];
  assert.deepEqual(gatewayIdentity(req, 'ugos'), { uid: '1001', username: '', isAdmin: false });
  delete req.headers['ugreen-user-id'];
  assert.throws(() => gatewayIdentity(req, 'ugos'), error => error.code === 'UGOS_USER_ID_MISSING');
});

for (const missingRole of [false, true]) test(`opaque UGOS users ${missingRole ? 'without a role header' : 'with a users role'} reach ARM catalog and keep separate persistent desktops and CSRF tokens`, async () => {
  const dataRoot = await temp();
  const options = { appRoot: root, dataRoot, host: 'ugos', arch: 'arm64', runtimeFactory, extract: extractor, fetcher, trustedHashes: [packageSha256] };
  let app = await createApplication(options);
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  await listen();
  const call = (route, uid, data, csrf, kind = missingRole ? 'absent' : 'users') => fetch(`http://127.0.0.1:${app.server.address().port}${app.prefix}/api${route}`, {
    method: data === undefined ? 'GET' : 'POST', headers: { ...headers(uid, kind), 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: data === undefined ? undefined : JSON.stringify(data)
  });
  try {
    const response = await call('/session', account); assert.equal(response.status, 200);
    const one = await response.json(), two = await (await call('/session', account.toUpperCase())).json();
    assert.notEqual(one.csrf, two.csrf); assert.notEqual(one.user.uid, two.user.uid);
    const catalog = await (await call('/state', account)).json();
    assert.equal(catalog.catalog[0].architecture, 'ARM64'); assert.equal(catalog.catalog[0].library.installed, null);
    assert.equal((await call('/consent', account, { accepted: true }, one.csrf)).status, 200);
    assert.equal((await call('/consent', account.toUpperCase(), { accepted: true }, two.csrf)).status, 200);
    assert.equal((await call('/apps/wechat/install/download', account, {}, one.csrf)).status, 202); await app.library.working;
    const added = await call('/instances', account, { name: 'ARM微信' }, one.csrf); assert.equal(added.status, 201);
    const item = await added.json();
    assert.equal((await call('/instances', account.toUpperCase(), { name: '越权应用' }, one.csrf)).status, 403);
    assert.equal((await call(`/instances/${item.id}/start`, account.toUpperCase(), {}, two.csrf)).status, 404);
    assert.equal((await call('/apps/wechat/install/uninstall', account, { deleteData: false }, one.csrf)).status, 403);
    const saved = await readFile(path.join(dataRoot, 'users', one.user.uid, 'instances.json'), 'utf8');
    assert.match(saved, /ARM微信/);
    await app.close(); app = await createApplication(options); await listen();
    const state = await (await call('/state', account)).json();
    assert.equal(state.instances[0].id, item.id); assert.equal(state.catalog[0].library.installed.version, '4.1.13.9');
    assert.equal((await (await call('/state', account.toUpperCase())).json()).instances.length, 0);
    assert.equal(await readFile(path.join(dataRoot, 'users', one.user.uid, 'instances.json'), 'utf8'), saved);
  } finally { await app.close(); await cleanup(dataRoot); }
});
