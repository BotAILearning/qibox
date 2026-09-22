import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageBytes, packageSha256 } from './fixtures.mjs';
test('production socket gateway: authentication, CSRF, installer, cross-user authorization and data deletion', async () => {
  const dataRoot = await temp(); const app = await createApplication({ appRoot: root, dataRoot, runtimeFactory, extract: extractor, fetcher, trustedHashes: [packageSha256] });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-test-${process.pid}-${Date.now()}` : path.join(dataRoot, 'test.sock');
  await new Promise(resolve => app.server.listen(socketPath, resolve));
  const call = (route, uid, data, csrf) => new Promise((resolve, reject) => {
    const headers = { ...(uid ? { 'x-trim-userid': uid } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(data !== undefined ? { 'content-type': 'application/json' } : {}) };
    const req = http.request({ socketPath, path: '/app/qibox/api' + route, method: data === undefined ? 'GET' : 'POST', headers }, res => { let text = ''; res.on('data', d => text += d); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  try {
    assert.equal((await call('/session')).status, 401);
    const token1 = (await call('/session', '1001')).data.csrf, token2 = (await call('/session', '1002')).data.csrf;
    assert.notEqual(token1, token2);
    assert.equal((await call('/consent', '1001', { accepted: true })).status, 403);
    assert.equal((await call('/install/download', '1001', {}, token1)).status, 403);
    assert.equal((await call('/consent', '1001', { accepted: true }, token1)).status, 200);
    await call('/consent', '1002', { accepted: true }, token2);
    const before = (await call('/state', '1001')).data;
    assert.deepEqual(before.catalog.map(x => x.id), ['wechat']);
    assert.equal(before.catalog[0].library.installed, null);
    assert.equal((await call('/apps/unknown/install/download', '1001', {}, token1)).status, 404);
    assert.equal((await call('/apps/wechat/install/download', '1001', {}, token1)).status, 202); await app.library.working;
    assert.equal((await call('/instances', '1001', { name: '未知应用', appId: 'unknown' }, token1)).status, 404);
    const a = (await call('/instances', '1001', { name: '微信 1', appId: 'wechat' }, token1)).data;
    assert.equal(a.appId, 'wechat');
    const installedState = (await call('/state', '1001')).data;
    assert.deepEqual(installedState.catalog[0].library, installedState.library);
    assert.equal((await call(`/instances/${a.id}/start`, '1001', {}, token2)).status, 403);
    for (const action of ['start', 'stop', 'rename', 'settings', 'auto-login', 'desktop', 'show', 'login', 'delete', 'files', 'audio']) assert.equal((await call(`/instances/${a.id}/${action}`, '1002', {}, token2)).status, 404, action);
    assert.equal((await call(`/instances/${a.id}/audio`, '1001', {})).status, 403);
    assert.equal((await call(`/instances/${a.id}/auto-login`, '1001', {}, 'invalid')).status, 403);
    const recheck = await call(`/instances/${a.id}/auto-login`, '1001', { idleAvailable: true }, token1);
    assert.equal(recheck.status, 404);
    for (const action of ['show', 'login']) assert.equal((await call(`/instances/${a.id}/${action}`, '1001', {})).status, 403, action);
    assert.equal((await call(`/instances/${a.id}/start`, '1001', {}, token1)).status, 200);
    for (const action of ['show', 'login']) assert.equal((await call(`/instances/${a.id}/${action}`, '1001', {}, token1)).status, 200, action);
    assert.equal((await call(`/instances/${a.id}/settings`, '1001', { mode: 'idle', startTime: '02:00', endTime: '02:30' }, token1)).status, 200);
    assert.equal((await call(`/instances/${a.id}/settings`, '1001', { mode: 'idle', startTime: '02:00', endTime: '02:30', autoLoginReady: true, idleAvailable: true }, token1)).status, 200);
    assert.equal((await call('/state', '1002')).data.instances.length, 0);
    assert.equal((await call(`/instances/${a.id}/delete`, '1001', { deleteData: true }, token1)).status, 400);
    const duplicate = await call('/instances', '1001', { name: ' 微信 1 ' }, token1);
    assert.equal(duplicate.status, 409); assert.equal(duplicate.data.code, 'NAME_CONFLICT');
    await call(`/instances/${a.id}/delete`, '1001', { deleteData: false }, token1);
    assert.equal((await call('/instances', '1001', { name: '微信 1' }, token1)).status, 409);
    const b = (await call('/instances', '1001', { name: '工作微信' }, token1)).data;
    assert.equal((await call(`/instances/${b.id}/rename`, '1001', { name: '微信 1' }, token1)).status, 409);
    assert.equal((await call(`/instances/${a.id}/restore`, '1002', { name: '越权恢复' }, token2)).status, 404);
    assert.equal((await call(`/instances/${a.id}/restore`, '1001', { name: '工作微信' }, token1)).status, 409);
    const restored = await call(`/instances/${a.id}/restore`, '1001', { name: '恢复微信' }, token1);
    assert.equal(restored.status, 200); assert.equal(restored.data.id, a.id); assert.equal(restored.data.name, '恢复微信');
  } finally { await app.close(); await cleanup(dataRoot); }
});
test('production rejects spoofed gateway headers over TCP and dev requires its private cookie', async () => {
  const dataRoot = await temp(); let app;
  try {
    app = await createApplication({ appRoot: root, dataRoot, runtimeFactory }); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    let base = `http://127.0.0.1:${app.server.address().port}/app/qibox`;
    assert.equal((await fetch(`${base}/api/session`, { headers: { 'x-trim-userid': '1000' } })).status, 403); await app.close();
    app = await createApplication({ appRoot: root, dataRoot, runtimeFactory, dev: true }); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}/app/qibox`;
    assert.equal((await fetch(`${base}/api/session`)).status, 401);
    assert.equal((await fetch(`${base}/api/session`, { headers: { cookie: `qibox_dev=${app.devKey}` } })).status, 200);
  } finally { await app?.close(); await cleanup(dataRoot); }
});
