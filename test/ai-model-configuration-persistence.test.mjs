import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const clone = value => structuredClone(value);
const modernModels = [{ ...modelConfig, id: 'old-model', label: '合成旧模型' }];

for (const operation of ['configure-legacy', 'configure-existing-model', 'saveModels']) {
  test(`${operation} leaves runtime and future saves unchanged after atomic rename failure`, async t => {
    const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
    const a = new AIAssistant({ dataRoot: root, bridge, provider });
    t.after(async () => { if (!a.closed) await a.close().catch(() => {}); await cleanup(root); });
    await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer); await a.scan();
    await a.configure(modelConfig);
    await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
    if (operation !== 'configure-legacy') {
      await a.saveModels({ models: modernModels, assignments: { chat: 'old-model', learningAnalysis: 'old-model' } });
    }
    const profile = a.profiles()[0];
    profile.preparedReply = { state: 'retry', keyVersion: 2, createdAt: 100, retryStartedAt: 200, key: 'synthetic-key', context: 'synthetic-context', body: a.vault.seal({ segments: ['synthetic answer'] }) };
    a.data.queue = { ...a.data.queue, status: 'running', nextAt: 123456, items: [{ id: profile.id, status: 'pending', attempts: 0 }] };
    a.modelDraftTests.set('draft-preserved', 'synthetic-draft-fingerprint');
    a.followUps.set(profile.id, { contextRevision: 'synthetic-follow-up' });
    await a.save();
    const beforeRuntime = { config: clone(a.config), models: clone(a.models), assignments: clone(a.assignments), modelTested: clone(a.modelTested), data: clone(a.data), drafts: [...a.modelDraftTests], followUps: [...a.followUps] };
    const beforeDisk = await fs.readFile(a.file);
    const backup = `${a.file}.fault-backup`;
    await fs.rename(a.file, backup);
    await fs.mkdir(a.file);
    try {
      if (operation === 'saveModels') {
        await assert.rejects(a.saveModels({ models: [{ ...modelConfig, id: 'new-model', label: '合成新模型', model: 'uncommitted-model' }], assignments: { chat: 'new-model', learningAnalysis: 'new-model' } }), error => ['EPERM', 'EISDIR'].includes(error.code));
      } else {
        await assert.rejects(a.configure({ ...modelConfig, baseUrl: 'https://models.example.test/new', model: 'uncommitted-model' }), error => ['EPERM', 'EISDIR'].includes(error.code));
      }
      assert.deepEqual({ config: a.config, models: a.models, assignments: a.assignments, modelTested: a.modelTested, data: a.data, drafts: [...a.modelDraftTests], followUps: [...a.followUps] }, beforeRuntime);
      assert.deepEqual(await fs.readFile(backup), beforeDisk);
    } finally {
      await fs.rm(a.file, { recursive: true, force: true });
      await fs.rename(backup, a.file);
    }
    await a.save();
    assert.deepEqual(await fs.readFile(a.file), beforeDisk, 'a later ordinary save must not persist the failed model candidate');
    assert.equal(provider.calls.length, 0);
    assert.equal(bridge.sent.length, 0);
    await a.close();
  });
}

test('label-only model save preserves prepared reply, running queue, and draft tests', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider });
  t.after(async () => { if (!a.closed) await a.close().catch(() => {}); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer); await a.configure(modelConfig); await a.scan();
  await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
  const profile = a.profiles()[0];
  profile.preparedReply = { state: 'retry', keyVersion: 2, createdAt: 100, retryStartedAt: 200, key: 'synthetic-key', context: 'synthetic-context', body: a.vault.seal({ segments: ['synthetic answer'] }) };
  a.data.queue = { ...a.data.queue, status: 'running', nextAt: 123456, items: [{ id: profile.id, status: 'pending', attempts: 0 }] };
  a.modelDraftTests.set('draft-preserved', 'synthetic-draft-fingerprint');
  a.followUps.set(profile.id, { contextRevision: 'synthetic-follow-up' });
  const prepared = clone(profile.preparedReply), queue = clone(a.data.queue), drafts = [...a.modelDraftTests];
  await a.saveModels({ models: modernModels, assignments: { chat: 'old-model', learningAnalysis: 'old-model' } });
  assert.deepEqual(profile.preparedReply, prepared, 'Legacy-to-modern representation with identical effective providers must preserve prepared reply');
  assert.deepEqual(a.data.queue, queue, 'Representation-only migration must not pause queued work');
  assert.deepEqual([...a.modelDraftTests], drafts);
  assert.equal(a.followUps.size, 0, 'Successful model save still cancels scheduled follow-ups');
  a.followUps.set(profile.id, { contextRevision: 'synthetic-follow-up' });
  await a.saveModels({ models: [{ ...modernModels[0], label: '仅改显示名称' }], assignments: { chat: 'old-model', learningAnalysis: 'old-model' } });
  assert.deepEqual(profile.preparedReply, prepared);
  assert.deepEqual(a.data.queue, queue);
  assert.deepEqual([...a.modelDraftTests], drafts);
  await a.saveModels({ models: [
    { ...modernModels[0], label: '保留的原模型' },
    { ...modernModels[0], id: 'alias-model', label: '同配置不同管理ID' },
  ], assignments: { chat: 'alias-model', learningAnalysis: 'alias-model' } });
  assert.deepEqual(profile.preparedReply, prepared, 'Changing assignment IDs without changing effective provider configuration must preserve the cached answer');
  assert.deepEqual(a.data.queue, queue);
  await a.close();
});

test('effective model change invalidates prepared reply and pauses queued work after save', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider });
  t.after(async () => { if (!a.closed) await a.close().catch(() => {}); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer); await a.configure(modelConfig); await a.scan();
  await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
  await a.saveModels({ models: modernModels, assignments: { chat: 'old-model', learningAnalysis: 'old-model' } });
  const profile = a.profiles()[0];
  profile.preparedReply = { state: 'retry', keyVersion: 2, createdAt: 100, retryStartedAt: 200, key: 'synthetic-key', context: 'synthetic-context', body: a.vault.seal({ segments: ['synthetic answer'] }) };
  a.data.queue = { ...a.data.queue, status: 'running', nextAt: 123456, items: [{ id: profile.id, status: 'pending', attempts: 0 }] };
  await a.saveModels({ models: [{ ...modernModels[0], model: 'replacement-model' }], assignments: { chat: 'old-model', learningAnalysis: 'old-model' } });
  assert.equal(a.config.model, 'replacement-model');
  assert.equal(profile.preparedReply, undefined);
  assert.equal(a.data.queue.status, 'paused');
  assert.equal(a.data.queue.nextAt, null);
  await a.close();
});
