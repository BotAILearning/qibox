import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';

test('new proactive HTTP workflow enforces ownership, CSRF, validation and idempotent creation', async () => {
  const dataRoot = await temp(), bridge = new ChatFixture();
  const app = await createApplication({ appRoot: root, dataRoot, fetcher, extract: extractor, aiProvider: new AIModelFixture(), trustedHashes: [packageSha256],
    runtimeFactory: (...args) => ({ ...runtimeFactory(...args), aiBridge: bridge }) });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-proactive-${randomUUID()}` : path.join(dataRoot, 'test.sock');
  await new Promise(resolve => app.server.listen(socketPath, resolve));
  const call = (route, uid, data, csrf) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/app/qibox/api' + route, method: data === undefined ? 'GET' : 'POST', headers: {
      'x-trim-userid': uid, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { 'x-csrf-token': csrf } : {})
    } }, res => { let text = ''; res.on('data', x => { text += x; }); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) })); });
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  try {
    const token = (await call('/session', '1001')).value.csrf, other = (await call('/session', '1002')).value.csrf;
    await call('/consent', '1001', { accepted: true }, token); await call('/consent', '1002', { accepted: true }, other);
    await call('/install/download', '1001', {}, token); await app.library.working;
    const instance = (await call('/instances', '1001', { name: '主动任务接口验收' }, token)).value;
    const route = `/instances/${instance.id}/ai`;
    await call(`/instances/${instance.id}/start`, '1001', {}, token);
    const space = await app.users.get('1001'), ai = space.get(instance.id).ai; clearInterval(ai.timer);
    await call(route, '1001', { action: 'verify-provider', value: modelConfig }, token);
    await call(route, '1001', { action: 'scan' }, token);
    await call(route, '1001', { action: 'settings', value: { enabled: false, reply: false } }, token);
    const value = { command: 'create', requestId: randomUUID(), name: '周末邀约', taskType: 'invitation',
      contacts: [bridge.contacts[0].id], goal: '询问周末是否有空', requirements: '不要承诺具体地点',
      schedule: { cycle: 'weekly', mode: 'random', start: '18:00', end: '21:00', weekdays: [5, 6] } };
    const request = { action: 'proactive-task', value };
    assert.equal((await call(route, '1001', request)).status, 403);
    assert.equal((await call(route, '1002', request, other)).status, 404);
    assert.equal((await call(route, '1001', { ...request, value: { ...value, contacts: [] } }, token)).status, 400);
    assert.equal((await call(route, '1001', { ...request, value: { ...value, goal: '' } }, token)).status, 400);
    assert.equal((await call(route, '1001')).value.proactiveTasks.length, 0);
    const created = await call(route, '1001', request, token);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    assert.equal(created.value.settings.enabled, true); assert.equal(created.value.settings.proactive, true);
    assert.equal(created.value.settings.reply, false);
    assert.equal(created.value.proactiveTasks.length, 1);
    const task = created.value.proactiveTasks[0];
    assert.equal(task.goal, value.goal); assert.equal(task.requirements, value.requirements);
    assert.equal(task.contacts[0].id, bridge.contacts[0].id);
    assert.deepEqual(task.schedule.weekdays, [5, 6]); assert.ok(Number.isFinite(task.nextAt));
    const repeated = await call(route, '1001', request, token);
    assert.equal(repeated.status, 200); assert.equal(repeated.value.proactiveTasks.length, 1);
    assert.equal(repeated.value.proactiveTasks[0].id, task.id);
    assert.equal(repeated.value.proactiveTasks[0].nextAt, task.nextAt);
    assert.equal(JSON.stringify(repeated).includes(modelConfig.apiKey), false);
    const action = command => ({ action: 'proactive-task', value: { command, id: task.id } });
    assert.equal((await call(route, '1002', action('pause'), other)).status, 404);
    const paused = await call(route, '1001', action('pause'), token);
    assert.equal(paused.value.proactiveTasks[0].status, 'paused');
    const ended = await call(route, '1001', action('end'), token);
    assert.equal(ended.value.proactiveTasks[0].status, 'ended');
    assert.equal((await call(route, '1001', { action: 'proactive-records' })).status, 403);
    assert.equal((await call(route, '1002', { action: 'proactive-records' }, other)).status, 404);
    const records = await call(route, '1001', { action: 'proactive-records', value: { taskId: task.id } }, token);
    assert.equal(records.status, 200); assert.ok(Array.isArray(records.value.records));
    assert.equal(bridge.sent.length, 0);
  } finally { await app.close(); await cleanup(dataRoot); }
});
