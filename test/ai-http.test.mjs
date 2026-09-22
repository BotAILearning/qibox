import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { replyPresets } from '../server/ai-presets.mjs';

test('AI HTTP requires owner and CSRF, hides secrets and suspends with instance stop', async () => {
  const dataRoot = await temp(), bridge = new ChatFixture();
  const app = await createApplication({ appRoot: root, dataRoot, fetcher, extract: extractor, aiProvider: new AIModelFixture(), trustedHashes: [packageSha256],
    runtimeFactory: (...args) => ({ ...runtimeFactory(...args), aiBridge: bridge }) });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-test-ai-${process.pid}` : path.join(dataRoot, 'test.sock');
  await new Promise(r => app.server.listen(socketPath, r));
  const call = (route, uid, data, csrf) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/app/qibox/api' + route, method: data === undefined ? 'GET' : 'POST', headers: {
      'x-trim-userid': uid, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { 'x-csrf-token': csrf } : {}) } }, res => {
      let text = ''; res.on('data', x => text += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, value: JSON.parse(text) }));
    }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  try {
    const token = (await call('/session', '1001')).value.csrf, other = (await call('/session', '1002')).value.csrf;
    await call('/consent', '1001', { accepted: true }, token); await call('/consent', '1002', { accepted: true }, other);
    await call('/install/download', '1001', {}, token); await app.library.working;
    const instance = (await call('/instances', '1001', { name: 'AI 测试' }, token)).value, route = `/instances/${instance.id}/ai`;
    assert.equal((await call(route, '1002')).status, 404);
    const emptyKey = await call(route, '1001', { action: 'reveal-key' }, token);
    assert.equal(emptyKey.status, 400); assert.equal(JSON.stringify(emptyKey).includes(modelConfig.apiKey), false);
    assert.equal((await call(route, '1001', { action: 'configure', value: modelConfig })).status, 403);
    assert.equal((await call(route, '1002', { action: 'configure', value: modelConfig }, other)).status, 404);
    assert.equal((await call(route, '1001', { action: 'configure', value: modelConfig }, token)).status, 200);
    const state = await call(route, '1001'); assert.equal(state.value.provider.hasKey, true); assert.equal(JSON.stringify(state).includes(modelConfig.apiKey), false);
    assert.equal((await call(route, '1001', { action: 'reveal-key' })).status, 403);
    assert.equal((await call(route, '1002', { action: 'reveal-key' }, other)).status, 404);
    const revealed = await call(route, '1001', { action: 'reveal-key' }, token);
    assert.equal(revealed.status, 200); assert.equal(revealed.value.apiKey, modelConfig.apiKey);
    assert.equal(revealed.value.baseUrl, modelConfig.baseUrl); assert.equal(revealed.headers['cache-control'], 'no-store');
    assert.equal(revealed.value.protocol, 'openai');
    const changed = await call(route, '1001', { action: 'configure', value: { ...modelConfig, apiKey: '********' } }, token);
    assert.equal(changed.status, 400);
    assert.equal((await call(route, '1001', { action: 'reveal-key' }, token)).value.apiKey, modelConfig.apiKey);
    assert.equal(JSON.stringify(await call(route, '1001')).includes(modelConfig.apiKey), false);
    assert.equal((await call(route, '1001', { action: '__proto__' }, token)).status, 400);
    assert.equal((await call(route, '1001', { action: 'test' }, token)).status, 200);
    assert.equal((await call(route, '1001', { action: 'models', value: modelConfig })).status, 403);
    assert.equal((await call(route, '1002', { action: 'models', value: modelConfig }, other)).status, 404);
    const models = await call(route, '1001', { action: 'models', value: { ...modelConfig, model: '', apiKey: '' } }, token);
    assert.deepEqual(models.value, { models: ['fixture-chat', 'fixture-chat-pro'] });
    assert.equal((await call(route, '1001')).value.provider.tested, true);
    await call(`/instances/${instance.id}/start`, '1001', {}, token);
    const scanned = (await call(route, '1001', { action: 'scan' }, token)).value; assert.equal(scanned.available, true);
    const prepare = { action: 'prepare-targets', value: { contacts: [scanned.contacts[0].id] } };
    assert.equal((await call(route, '1001', prepare)).status, 403);
    assert.equal((await call(route, '1002', prepare, other)).status, 404);
    const prepared = (await call(route, '1001', prepare, token)).value;
    assert.equal(prepared.profiles[0].source, 'manual'); assert.equal(prepared.profiles[0].learnedAt, null);
    assert.equal(prepared.targets[0], prepared.profiles[0].id); assert.equal(bridge.sent.length, 0);
    const manualReply = { action: 'reply-profile', value: { contact: scanned.contacts[1].id, ...replyPresets[0] } };
    assert.equal((await call(route, '1001', manualReply)).status, 403);
    assert.equal((await call(route, '1002', manualReply, other)).status, 404);
    const manual = await call(route, '1001', manualReply, token);
    assert.equal(manual.status, 200);
    const replyProfile = manual.value.profiles.find(p => p.contact === scanned.contacts[1].id);
    assert.equal(replyProfile.learnedAt, null); assert.ok(replyProfile.replyConfiguredAt);
    assert.deepEqual(manual.value.replyTargets, [replyProfile.id]);
    assert.deepEqual(manual.value.proactiveTargets, prepared.proactiveTargets); assert.equal(bridge.sent.length, 0);
    assert.equal(manual.value.settings.enabled, false);
    await call(`/instances/${instance.id}/stop`, '1001', {}, token);
    assert.equal((await call(route, '1001')).value.settings.enabled, false);
  } finally { await app.close(); await cleanup(dataRoot); }
});
