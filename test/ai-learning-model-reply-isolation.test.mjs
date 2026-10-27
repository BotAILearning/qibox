import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig, learnedStyle } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const answer = '合成缓存答复：收到，谢谢。';
const models = [
  { ...modelConfig, id: 'chat', label: '聊天' },
  { ...modelConfig, id: 'learning', label: '学习', model: 'learning-old' },
  { ...modelConfig, id: 'alternative', label: '另一学习模型', model: 'learning-new' },
];
const assignments = { chat: 'chat', learningAnalysis: 'learning' };

async function fixture(t, { blocked = true, deferred = false, shared = false } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true;
  let now = Date.parse('2026-10-27T10:00:00+08:00'), attempts = 0;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {}, random: min => min });
  provider.complete = async (config, system, input, signal) => {
    provider.calls.push({ model: config.model, input: structuredClone(input), signal });
    if (deferred) { entered.resolve(); await release.promise; signal.throwIfAborted(); }
    return { action: 'send', text: answer, followUp: false };
  };
  const sender = bridge.send.bind(bridge);
  bridge.send = async request => {
    attempts++;
    return blocked ? { status: 'not-sent', diagnostic: { phase: 'native-prepare', code: 'controls-unavailable' } } : sender(request);
  };
  t.after(async () => { release.resolve(); await a.close(); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  await a.configure(modelConfig); await a.saveModels({ models, assignments: shared ? { chat: 'chat', learningAnalysis: 'chat' } : assignments }); await a.scan();
  const contact = bridge.contacts[0].id;
  await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true, autoLearning: false, segmentReplies: false }); await a.tick();
  const incoming = bridge.push(contact, 'other', '这条合成来信请简单回应。'); incoming.timestamp = now / 1000;
  await a.tick(); now += 20000;
  let running;
  if (deferred) { running = a.tick(); await entered.promise; }
  else await a.tick();
  const p = a.profiles().find(row => row.contact === contact);
  const change = operation => operation === 'configure'
    ? a.configure({ ...modelConfig, model: 'learning-new' }, 'analysis')
    : a.saveModels({ models, assignments: { ...assignments, learningAnalysis: 'alternative' } });
  return { a, p, bridge, provider, contact, incoming, change, release, running, root,
    advance: ms => { now += ms; }, recover: () => { blocked = false; }, get attempts() { return attempts; } };
}

for (const operation of ['configure', 'assignment']) {
  test(`learning-only ${operation} reuses a definite-not-sent reply and its original retry deadline`, async t => {
    const f = await fixture(t), before = structuredClone(f.p.preparedReply), key = f.a.preparedReplyKey(f.p, f.a.strategy(f.p, 'reply'));
    assert.equal(f.provider.calls.length, 1); assert.equal(before.state, 'retry');
    const revision = f.a.revision;
    f.a.data.queue = { ...f.a.data.queue, status: 'running', nextAt: 123456, items: [] };
    const queue = structuredClone(f.a.data.queue);
    f.a.followUps.set(f.p.id, { revision, dueAt: 9999999999999, contextRevision: 'synthetic-followup' });
    await f.change(operation);
    assert.equal(f.a.modelFor('analysis').model, 'learning-new');
    assert.equal(f.a.modelFor('chat').model, modelConfig.model);
    assert.equal(f.a.preparedReplyKey(f.p, f.a.strategy(f.p, 'reply')), key);
    assert.deepEqual(f.p.preparedReply, before);
    assert.equal(f.a.revision, revision, 'unrelated chat epoch must remain usable');
    assert.deepEqual(f.a.data.queue, queue, 'unrelated proactive queue must remain unchanged');
    assert.equal(f.a.followUps.size, 1);
    const disk = JSON.parse(await fs.readFile(f.a.file, 'utf8'));
    assert.deepEqual(disk.profiles[f.p.id].preparedReply, before);
    f.a.followUps.clear(); f.recover(); f.advance(31000); await f.a.tick();
    assert.equal(f.provider.calls.length, 1); assert.equal(f.attempts, 2);
    assert.deepEqual(f.bridge.sent.map(row => row.text), [answer]);
    assert.equal(f.p.preparedReply, undefined);
    f.advance(31000); await f.a.tick(); assert.equal(f.provider.calls.length, 1);
  });
}

test('learning-model change near expiry cannot restart the five-minute send retry or regenerate the incoming', async t => {
  const f = await fixture(t), before = structuredClone(f.p.preparedReply);
  f.advance(240000); await f.change('configure');
  assert.equal(f.p.preparedReply?.retryStartedAt, before.retryStartedAt);
  f.advance(60001); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.attempts, 1); assert.equal(f.p.preparedReply, undefined);
  f.recover(); f.advance(31000); await f.a.tick(); assert.equal(f.provider.calls.length, 1);
  const next = f.bridge.push(f.contact, 'other', '后面这条新的合成消息请回应。');
  next.timestamp = (before.retryStartedAt + 340001) / 1000;
  await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.provider.calls.length, 2); assert.equal(f.bridge.sent.length, 1);
  assert.notDeepEqual(f.provider.calls[0].input.conversation.pendingIncomingIds, f.provider.calls[1].input.conversation.pendingIncomingIds);
});

test('learning-only model save does not abort an already entered chat request', async t => {
  const f = await fixture(t, { blocked: false, deferred: true });
  await f.change('configure');
  assert.equal(f.provider.calls[0].signal.aborted, false);
  f.release.resolve(); await f.running;
  assert.equal(f.provider.calls.length, 1); assert.deepEqual(f.bridge.sent.map(row => row.text), [answer]);
});

test('editing a model shared by learning and chat still invalidates chat even through analysis scope', async t => {
  const f = await fixture(t, { shared: true });
  const before = structuredClone(f.p.preparedReply), revision = f.a.revision;
  assert.ok(before);
  await f.a.configure({ ...modelConfig, model: 'changed-shared-model' }, 'analysis');
  assert.equal(f.a.modelFor('chat').model, 'changed-shared-model');
  assert.equal(f.p.preparedReply, undefined); assert.ok(f.a.revision > revision);
});

test('failed learning-model persistence preserves chat cache, signal, and both effective models', async t => {
  const f = await fixture(t), before = structuredClone(f.p.preparedReply), revision = f.a.revision;
  const file = f.a.file, backup = file + '.fault-backup';
  await fs.rename(file, backup); await fs.mkdir(file);
  try {
    await assert.rejects(f.change('configure'), error => ['EPERM', 'EISDIR'].includes(error.code));
    assert.deepEqual(f.p.preparedReply, before); assert.equal(f.a.revision, revision);
    assert.equal(f.a.modelFor('chat').model, modelConfig.model); assert.equal(f.a.modelFor('analysis').model, 'learning-old');
  } finally { await fs.rm(file, { recursive: true, force: true }); await fs.rename(backup, file); }
});

test('learning-only model change still cancels the old learning result even if the provider ignores abort', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let signal;
  f.provider.complete = async (_config, _system, _input, currentSignal) => {
    signal = currentSignal; entered.resolve(); await release.promise;
    return { style: learnedStyle('未获采用的旧模型结果') };
  };
  const learning = f.a.learn({ text: '合成本人发言：先忙我的，回头再聊。', label: '合成学习', target: 'style', previewOnly: true });
  const rejected = assert.rejects(learning);
  await entered.promise;
  try { await f.change('configure'); assert.equal(signal.aborted, true); }
  finally { release.resolve(); }
  await rejected;
  assert.equal(f.a.profiles().some(p => p.pendingStyle?.language === '未获采用的旧模型结果'), false);
  assert.equal(f.a.operation, null);
});

test('learning-only model change cannot save a late memory-only result or start an empty-result recheck', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  f.provider.complete = async () => {
    calls++; entered.resolve(); await release.promise;
    return { memory: { entries: [{ text: '未获采用的合成记忆', evidence: [] }] } };
  };
  const task = f.a.learn({ text: '合成本人发言：我在合成城市工作。', contact: f.contact, target: 'memory' });
  const rejected = assert.rejects(task);
  await entered.promise;
  try { await f.change('configure'); } finally { release.resolve(); }
  await rejected;
  assert.equal(calls, 1); assert.equal(f.a.pendingMemoryOf(f.p), null);
});

test('changing only the learning model aborts an active report and keeps report history unchanged', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let signal, calls = 0;
  f.bridge.readRange = async request => ({ account: request.account, contact: request.contact,
    messages: [{ id: f.incoming.id, timestamp: Date.parse('2026-09-01T12:00:00+08:00') / 1000, direction: 'other', text: '合成报告材料' }] });
  f.provider.complete = async (_config, _system, _input, s) => { calls++; signal = s; entered.resolve(); await release.promise; return { report: '不应保存的旧模型报告' }; };
  const task = f.a.analyze({ request: '合成总结', from: '2026-09-01', to: '2026-09-02', contacts: [f.contact] });
  const rejected = assert.rejects(task);
  await entered.promise;
  try { await f.change('configure'); assert.equal(signal.aborted, true); } finally { release.resolve(); }
  await rejected;
  assert.equal(calls, 1); assert.equal(f.a.analysisHistory().length, 0);
});
