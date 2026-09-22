import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';

for (const host of ['fnos', 'ugos']) for (const arch of ['x64', 'arm64']) test(`${host}/${arch}: uninstall/reinstall retains original homes; optional purge removes only the requesting user data and retained copies`, async () => {
  const dataRoot = await temp();
  const app = await createApplication({ appRoot: root, dataRoot, host, arch, runtimeFactory, extract: extractor, fetcher, trustedHashes: [packageSha256] });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-test-uninstall-${process.pid}-${Date.now()}` : path.join(dataRoot, 'test.sock');
  await new Promise(resolve => host === 'ugos' ? app.server.listen(0, '127.0.0.1', resolve) : app.server.listen(socketPath, resolve));
  const call = (route, uid, data, csrf, admin = false) => new Promise((resolve, reject) => {
    const identity = host === 'ugos' ? { 'ugreen-user-id': uid, ...admin ? { 'ugreen-user-type': 'admin' } : {} } : { 'x-trim-userid': uid, 'x-trim-isadmin': String(admin) };
    const headers = { ...identity, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(data !== undefined ? { 'content-type': 'application/json' } : {}) };
    const target = host === 'ugos' ? { host: '127.0.0.1', port: app.server.address().port } : { socketPath };
    const req = http.request({ ...target, path: app.prefix + '/api' + route, method: data === undefined ? 'GET' : 'POST', headers }, res => { let text = ''; res.on('data', d => text += d); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  try {
    const token1 = (await call('/session', '1001')).data.csrf, token2 = (await call('/session', '1002')).data.csrf;
    await call('/consent', '1001', { accepted: true }, token1); await call('/consent', '1002', { accepted: true }, token2);
    await call('/install/download', '1001', {}, token1); await app.library.working;
    const one = await app.users.get('1001'), two = await app.users.get('1002');
    const a = await one.add('工作微信'), retained = await one.add('旧微信'), other = await two.add('微信');
    const aHome = one.get(a.id).home, rHome = one.get(retained.id).home, oHome = two.get(other.id).home;
    for (const home of [aHome, rHome, oHome]) await writeFile(path.join(home, 'data'), home);
    await one.remove(retained.id); await one.schedule(a.id, { mode: 'continuous', startTime: '02:00', endTime: '02:30' });
    assert.equal(one.get(a.id).runtime.status, 'running', 'saving continuous mode starts without waiting for the next timer');
    await one.start(a.id); await two.start(other.id);
    assert.equal((await call('/install/uninstall', '1002', { deleteData: false }, token2)).status, 403);
    assert.equal((await call('/install/uninstall', '1001', { deleteData: false }, undefined, true)).status, 403);
    assert.equal((await call('/install/uninstall', '1001', { deleteData: true, confirmName: '微信' }, token1, true)).status, 400);
    assert.equal(one.get(a.id).runtime.status, 'running');
    assert.equal((await call('/install/uninstall', '1001', { deleteData: false }, token1, true)).status, 200);
    assert.equal(app.library.installed(), null); assert.equal(one.get(a.id).runtime.status, 'stopped'); assert.equal(two.get(other.id).runtime.status, 'stopped');
    assert.equal(one.get(a.id).scheduler.publicState().paused, true);
    for (const home of [aHome, rHome, oHome]) assert.equal(await readFile(path.join(home, 'data'), 'utf8'), home);
    assert.equal((await call(`/instances/${retained.id}/restore`, '1001', {}, token1)).status, 409);
    await call('/install/download', '1001', {}, token1); await app.library.working;
    await one.restore(retained.id); assert.equal(one.get(retained.id).home, rHome); await one.start(a.id); assert.equal(one.get(a.id).home, aHome);
    await one.remove(retained.id);
    assert.equal((await call('/install/uninstall', '1001', { deleteData: true, confirmName: '确认删除微信' }, token1, true)).status, 200);
    assert.equal(one.list().instances.length, 0); assert.equal(one.list().retained.length, 0);
    await assert.rejects(access(aHome)); await assert.rejects(access(rHome));
    assert.equal(await readFile(path.join(oHome, 'data'), 'utf8'), oHome); assert.equal(two.list().instances[0].id, other.id);
  } finally { await app.close(); await cleanup(dataRoot); }
});
