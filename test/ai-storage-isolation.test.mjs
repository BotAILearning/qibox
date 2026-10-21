import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { Instances } from '../server/instances.mjs';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';

const runtimes = (...args) => ({ ...runtimeFactory(...args), aiBridge: new ChatFixture() });
for (const fault of ['wrong', 'missing', 'short', 'json']) test(`isolated ${fault} AI storage leaves this user's desktops and other users available`, async () => {
  const dataRoot = await temp(), provider = new AIModelFixture();
  const options = { dataRoot, appRoot: dataRoot, library: { installed: () => ({ version: '4.1.13.9' }) }, runtimeFactory: runtimes, aiProvider: provider };
  let users = new Instances(options);
  try {
    await users.init(); const first = await users.get('1001'), second = await users.get('1002');
    await first.setConsent(true); await second.setConsent(true);
    const bad = await first.add('合成故障微信'), good = await first.add('合成正常微信'), other = await second.add('另一用户微信');
    const saved = first.get(bad.id); await saved.ai.configure(modelConfig); const file = path.join(saved.dataRoot, 'ai-assistant.json'), keyFile = path.join(saved.dataRoot, 'ai-secret.key');
    await users.close(); const original = await readFile(file), originalKey = await readFile(keyFile);
    if (fault === 'missing') await rename(keyFile, path.join(saved.dataRoot, 'saved-original.key'));
    if (fault === 'wrong') { const wrong = Buffer.from(originalKey); wrong[0] ^= 1; await writeFile(keyFile, wrong); }
    if (fault === 'short') await writeFile(keyFile, 'short');
    if (fault === 'json') await writeFile(file, '{"PRIVATE_CORRUPT_MARKER":');
    const expectedBytes = await readFile(file), expectedKey = fault === 'missing' ? null : await readFile(keyFile);
    users = new Instances(options); await users.init();
    const space = await users.get('1001'), otherSpace = await users.get('1002');
    assert.equal(space.list().instances.length, 2); assert.equal(otherSpace.list().instances.length, 1);
    const unavailable = space.get(bad.id), error = unavailable.ai.storageError;
    assert.equal(error.status, 409); assert.match(error.message, /原数据已保留.*恢复.*重启栖盒/); assert.doesNotMatch(error.message, /PRIVATE_CORRUPT_MARKER/);
    assert.throws(() => unavailable.ai.publicState(), error);
    assert.throws(() => unavailable.ai.settings({ enabled: false }), error);
    assert.throws(() => unavailable.ai.saveModels({ models: [] }), error);
    assert.throws(() => unavailable.ai.data, error); assert.throws(() => unavailable.ai.models, error);
    await unavailable.ai.suspend(); await unavailable.ai.close(); await unavailable.runtime.manualInput({ source: 'fixture', type: 'pointer', held: true });
    assert.deepEqual(unavailable.ai.userActivity(), { noted: true }); unavailable.ai.invalidate();
    assert.ok(space.get(good.id).ai.publicState().schema); assert.ok(otherSpace.get(other.id).ai.publicState().schema);
    await space.start(bad.id); assert.equal(unavailable.runtime.status, 'running');
    await space.start(good.id); assert.equal(space.get(good.id).runtime.status, 'running');
    await space.stop(bad.id); assert.equal(unavailable.runtime.status, 'stopped'); assert.equal(space.get(good.id).runtime.status, 'running');
    assert.deepEqual(await readFile(file), expectedBytes);
    if (expectedKey) assert.deepEqual(await readFile(keyFile), expectedKey); else await assert.rejects(access(keyFile), { code: 'ENOENT' });
    await users.close(); assert.deepEqual(await readFile(file), expectedBytes);
    await writeFile(keyFile, originalKey); if (fault === 'json') await writeFile(file, original);
    users = new Instances(options); await users.init(); const recovered = (await users.get('1001')).get(bad.id);
    assert.equal(recovered.ai.storageError, null); assert.equal(recovered.ai.config.model, modelConfig.model);
    assert.equal(provider.calls.length, 0);
  } finally { await users.close(); await cleanup(dataRoot); }
});

test('HTTP exposes a clear recovery error for isolated AI while state, desktops and other instance AI remain usable', async () => {
  const dataRoot = await temp(), provider = new AIModelFixture();
  const options = { appRoot: root, dataRoot, fetcher, extract: extractor, trustedHashes: [packageSha256], runtimeFactory: runtimes, aiProvider: provider };
  let app = await createApplication(options);
  try {
    const space = await app.users.get('1001'); await space.setConsent(true);
    await app.library.download({}); await app.library.working;
    const bad = await space.add('合成损坏AI'), good = await space.add('合成正常AI');
    const originalItem = space.get(bad.id); await originalItem.ai.configure(modelConfig);
    const file = path.join(originalItem.dataRoot, 'ai-assistant.json'), keyFile = path.join(originalItem.dataRoot, 'ai-secret.key');
    await app.close(); const bytes = await readFile(file), wrong = await readFile(keyFile); wrong[0] ^= 1; await writeFile(keyFile, wrong);
    app = await createApplication(options);
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-storage-${process.pid}-${Date.now()}` : path.join(dataRoot, 'storage.sock');
    await new Promise(resolve => app.server.listen(socketPath, resolve));
    const call = (route, data, csrf) => new Promise((resolve, reject) => {
      const request = http.request({ socketPath, path: '/app/qibox/api' + route, method: data === undefined ? 'GET' : 'POST', headers: { 'x-trim-userid': '1001', ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { 'x-csrf-token': csrf } : {}) } }, response => {
        let text = ''; response.on('data', part => text += part); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      }); request.on('error', reject); request.end(data === undefined ? undefined : JSON.stringify(data));
    });
    const csrf = (await call('/session')).body.csrf, route = `/instances/${bad.id}/ai`;
    assert.equal((await call('/state')).status, 200);
    for (const suffix of ['', '?view=live', '/master']) {
      const response = await call(route + suffix); assert.equal(response.status, 409); assert.equal(response.body.code, 'ai_secret_invalid'); assert.match(response.body.error, /原数据已保留.*恢复.*重启栖盒/);
    }
    assert.equal((await call(`/instances/${good.id}/ai`)).status, 200);
    assert.equal((await call(route, { action: 'settings', value: { enabled: true } })).status, 403, 'CSRF boundary remains enforced.');
    for (const action of ['settings', 'configure', 'models-save', 'model-test', 'scan', 'learn', 'cancel', 'configuration', 'memory', 'mobile-master', 'reveal-key']) {
      const response = await call(route, { action, value: {}, modelId: 'fixture-model' }, csrf); assert.equal(response.status, 409, action); assert.equal(response.body.code, 'ai_secret_invalid', action);
    }
    const exported = await call(route + '/reports/export', { ids: ['11111111-1111-4111-8111-111111111111'], format: 'pdf' }, csrf); assert.equal(exported.status, 409); assert.equal(exported.body.code, 'ai_secret_invalid');
    assert.equal((await call(`/instances/${bad.id}/start`, {}, csrf)).status, 200);
    const loaded = (await app.users.get('1001')).get(bad.id); await loaded.runtime.manualInput({ source: 'fixture', type: 'keyboard', held: false });
    assert.equal((await call(`/instances/${bad.id}/stop`, {}, csrf)).status, 200);
    assert.deepEqual(await readFile(file), bytes); assert.deepEqual(await readFile(keyFile), wrong); assert.equal(provider.calls.length, 0);
  } finally { await app.close(); await cleanup(dataRoot); }
});
