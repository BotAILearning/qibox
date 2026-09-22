import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { defaultStyle, strategyValue } from '../server/ai-schema.mjs';
import { AIModelFixture, ChatFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, { segments = false, contacts = 1 } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let now = 1000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, interval: () => 180000, delay: async () => {} }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  await a.prepareTargets({ contacts: bridge.contacts.slice(0, contacts).map(x => x.id) });
  await a.saveStrategy({ ...strategy, sendMode: segments ? 'segments' : 'single' });
  await a.saveStrategy(strategy, undefined, 'reply'); await a.settings({ reply: false });
  return { a, bridge, provider, root, advance: ms => now += ms };
}
async function launch(a) { await a.settings({ proactive: true, enabled: true }); await a.queueAction('start'); }
const opening = ['SEGMENT_PRIVATE_ONE。', 'SEGMENT_PRIVATE_TWO。', 'SEGMENT_PRIVATE_THREE。'];

test('strategy validates optional source and message mode with compatible defaults', () => {
  assert.equal(strategyValue(strategy).sendMode, 'single');
  assert.equal(strategyValue(strategy).styleSource, 'manual');
  assert.equal(strategyValue(strategy).styleProfileId, '');
  for (const value of [{ sendMode: 'many' }, { styleSource: 'guess' }, { styleProfileId: 'not-an-id' }]) assert.throws(() => strategyValue({ ...strategy, ...value }));
});

test('manual targets require detected scope, stay distinct from learning results and do not send while preparing', async t => {
  const { a, bridge, provider } = await fixture(t);
  const profile = a.profiles()[0];
  assert.equal(profile.source, 'manual'); assert.equal(profile.learnedAt, null);
  assert.deepEqual(profile.style, defaultStyle); assert.equal(provider.calls.length, 0); assert.equal(bridge.sent.length, 0);
  assert.deepEqual(a.publicState().labels, { available: false, groups: [] });
  await assert.rejects(a.prepareTargets({ contacts: [key('unseen')] }), /检测到/);
  await a.settings({ proactive: true, reply: true }); assert.equal(a.data.settings.enabled, false);
  await a.targets([profile.id], 'reply');
  await a.settings({ enabled: true }); assert.equal(a.data.settings.enabled, true);
  await a.settings({ reply: false }); await launch(a); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(provider.calls[0].input.style.summary, strategy.persona);
});

test('preparing a learned target preserves edits and learning provenance', async t => {
  const { a } = await fixture(t);
  const first = a.profiles()[0]; await a.learn({ contacts: [first.contact] });
  const learned = a.profiles()[0]; await a.editProfile(learned.id, { style: { ...learned.style, customTone: '自己的口吻' } });
  await a.prepareTargets({ contacts: [learned.contact, learned.contact] });
  assert.equal(a.profiles()[0].source, 'learned'); assert.ok(a.profiles()[0].learnedAt);
  assert.equal(a.profiles()[0].style.customTone, '自己的口吻'); assert.equal(a.data.targets.length, 1);
});

for (const source of ['learned', 'paste']) test(`proactive can reuse a ${source} style without learning every target`, async t => {
  const { a, bridge, provider } = await fixture(t);
  const target = a.profiles()[0];
  await a.saveStrategy({ ...strategy, styleSource: source });
  await a.settings({ proactive: true, enabled: true }); await assert.rejects(a.queueAction('start'), /已学习的风格/);
  if (source === 'paste') await a.learn({ text: 'PASTED_PRIVATE_STYLE', label: '参考风格' });
  else await a.learn({ contacts: [bridge.contacts[1].id] });
  const learned = a.profiles().find(p => p.learnedAt);
  await a.saveStrategy({ ...strategy, styleSource: source, styleProfileId: learned.id });
  await launch(a); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(bridge.sent[0].contact, target.contact);
  assert.deepEqual(provider.calls.at(-1).input.style, learned.style); assert.equal(target.learnedAt, null);
});

test('segments are separate verified sends and persist only progress metadata', async t => {
  const { a, bridge, provider, root } = await fixture(t, { segments: true });
  const requests = [], send = bridge.send.bind(bridge);
  bridge.send = request => { requests.push(request); return send(request); };
  provider.next = async () => ({ action: 'send', segments: opening });
  await launch(a); await a.tick();
  assert.deepEqual(bridge.sent.map(x => x.text), opening); assert.equal(new Set(requests.map(x => x.operationId)).size, 3);
  assert.equal(new Set(requests.map(x => x.revision)).size, 3);
  assert.equal(a.data.queue.items[0].status, 'done'); assert.equal(a.data.queue.items[0].segmentsSent, 3);
  assert.equal(a.profiles()[0].delivery.segmentsSent, 3);
  const persisted = await readFile(path.join(root, 'ai-assistant.json'), 'utf8');
  for (const text of opening) assert.equal(persisted.includes(text), false);
});

test('invalid segment counts, empty content and unsupported promises are rejected before the first send', async t => {
  for (const segments of [[], [''], [...opening, 'four'], [opening[0], '我马上给你打电话']]) await t.test(JSON.stringify(segments), async t => {
    const { a, bridge, provider } = await fixture(t, { segments: true });
    provider.next = async () => ({ action: 'send', segments }); await launch(a); await a.tick();
    assert.equal(bridge.sent.length, 0);
  });
});

for (const change of ['incoming', 'manual', 'account', 'cancel', 'deselect', 'disabled']) test(`a ${change} between segments stops the remainder without replaying the confirmed prefix`, async t => {
  const { a, bridge, provider, advance } = await fixture(t, { segments: true });
  const target = a.profiles()[0], save = a.save.bind(a); let changed = false;
  a.save = async () => {
    await save();
    if (!changed && target.delivery?.status === 'sent' && target.delivery.segmentsSent === 1) {
      changed = true;
      if (change === 'incoming') bridge.push(target.contact, 'other', '先等一下');
      if (change === 'manual') bridge.push(target.contact, 'self', '我来处理');
      if (change === 'account') bridge.account = key('changed-account');
      if (change === 'cancel') await a.cancel();
      if (change === 'deselect') await a.targets([]);
      if (change === 'disabled') await a.settings({ enabled: false });
    }
  };
  provider.next = async () => ({ action: 'send', segments: opening }); await launch(a); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(a.data.queue.items[0].status, 'done');
  if (change === 'manual') assert.equal(target.paused, false);
  if (change === 'account') assert.equal(a.data.settings.enabled, false);
  if (['cancel', 'disabled'].includes(change)) {
    await a.settings({ enabled: true }); await assert.rejects(a.queueAction('resume'), /队列已完成/);
    advance(200000); await a.tick(); assert.equal(bridge.sent.length, 1);
  }
});

test('each segment checks cancellation after its persisted intent before native sending', async t => {
  const { a, bridge, provider } = await fixture(t, { segments: true });
  const target = a.profiles()[0], save = a.save.bind(a); let cancelled = false;
  a.save = async () => {
    await save();
    if (!cancelled && target.delivery?.status === 'sending' && target.delivery.segmentsSent === 1) { cancelled = true; await a.cancel(); }
  };
  provider.next = async () => ({ action: 'send', segments: opening }); await launch(a); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(a.data.queue.items[0].status, 'done');
  assert.equal(target.delivery.interrupted, true); assert.equal(target.continuation, undefined);
});

test('an uncertain second segment pauses without retrying after restart', async t => {
  const { a, bridge, provider, root } = await fixture(t, { segments: true });
  const send = bridge.send.bind(bridge); let attempts = 0;
  bridge.send = request => ++attempts === 2 ? Promise.resolve({ status: 'uncertain' }) : send(request);
  provider.next = async () => ({ action: 'send', segments: opening }); await launch(a); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(a.data.queue.items[0].status, 'uncertain');
  assert.equal(a.profiles()[0].delivery.segmentsSent, 1); await assert.rejects(a.queueAction('resume'), /核对/);
  const restarted = new AIAssistant({ dataRoot: root, bridge, provider }); await restarted.init();
  assert.equal(restarted.data.queue.items[0].status, 'uncertain'); assert.equal(restarted.data.settings.enabled, true);
  await restarted.close(); assert.equal(attempts, 2);
});

test('stale second segment finishes the partial opening without duplicating it on a later tick', async t => {
  const { a, bridge, provider, advance } = await fixture(t, { segments: true });
  const send = bridge.send.bind(bridge); let attempts = 0;
  bridge.send = request => ++attempts === 2 ? Promise.resolve({ status: 'stale' }) : send(request);
  provider.next = async () => ({ action: 'send', segments: opening }); await launch(a); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(a.data.queue.items[0].status, 'done');
  advance(200000); await a.tick(); assert.equal(bridge.sent.length, 1); assert.equal(attempts, 2);
});

test('only actively contacted targets continue replies with the original purpose while reply mode is off', async t => {
  const { a, bridge, provider, advance } = await fixture(t, { contacts: 2 });
  await launch(a); await a.tick(); const [first, pending] = a.profiles();
  assert.equal(a.data.settings.reply, false); assert.ok(first.continuation); assert.equal(pending.continuation, undefined);
  bridge.push(first.contact, 'other', '我有兴趣'); bridge.push(pending.contact, 'other', '你好');
  await a.tick(); advance(8000); await a.tick();
  assert.equal(bridge.sent.length, 2); assert.equal(bridge.sent[1].contact, first.contact);
  const call = provider.calls.at(-1).input;
  assert.equal(call.mode, 'reply'); assert.equal(call.continuation, true); assert.equal(call.strategy.purpose, strategy.purpose);
  assert.equal(first.rounds, 1);
  await a.settings({ proactive: false, enabled: false }); assert.equal(first.continuation, undefined);
  bridge.push(first.contact, 'other', '继续'); advance(10000); await a.tick(); assert.equal(bridge.sent.length, 2);
});

test('ending the proactive queue revokes its continuation even with master enabled', async t => {
  const { a, bridge, advance } = await fixture(t);
  await launch(a); await a.tick(); const target = a.profiles()[0];
  await a.queueAction('end'); assert.equal(target.continuation, undefined);
  bridge.push(target.contact, 'other', '继续'); await a.tick(); advance(8000); await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('personal reply overrides cannot replace the new proactive purpose or its continuation', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const target = a.profiles()[0];
  await a.saveStrategy({ ...strategy, purpose: '旧目的', replyGoal: '个人回复规则', facts: '普通回复专用信息', boundaries: '普通回复限制' }, target.id, 'reply');
  await a.saveStrategy({ ...strategy, purpose: '本次新的主动目的' });
  await launch(a); await a.tick();
  assert.equal(provider.calls.at(-1).input.strategy.purpose, '本次新的主动目的');
  bridge.push(target.contact, 'other', '说来听听'); await a.tick(); advance(8000); await a.tick();
  assert.equal(provider.calls.at(-1).input.strategy.purpose, '本次新的主动目的');
  assert.equal(target.replyStrategy.replyGoal, '个人回复规则'); assert.equal(target.strategy, undefined);
  assert.equal(provider.calls.at(-1).input.strategy.replyGoal, '个人回复规则');
  assert.equal(provider.calls.at(-1).input.strategy.facts, strategy.facts);
  assert.equal(provider.calls.at(-1).input.strategy.boundaries, strategy.boundaries);
  assert.equal(Object.hasOwn(target.replyStrategy, 'purpose'), false);
});

test('existing personal strategies remain explicit overrides for proactive openings', async t => {
  const { a, provider } = await fixture(t); const target = a.profiles()[0];
  await a.saveStrategy({ ...strategy, purpose: '给此人的专属目的' }, target.id);
  await a.saveStrategy({ ...strategy, purpose: '公共目的' }); await launch(a); await a.tick();
  assert.equal(provider.calls.at(-1).input.strategy.purpose, '给此人的专属目的');
  assert.equal(target.continuation.strategy.purpose, '给此人的专属目的');
});

test('reply targets stay separate when proactive contacts have never been learned', async t => {
  const { a, bridge, advance, provider } = await fixture(t);
  const proactive = a.profiles()[0];
  await a.learn({ contacts: [bridge.contacts[1].id] });
  const reply = a.profiles().find(p => p.learnedAt);
  await a.targets([reply.id], 'reply'); await a.settings({ reply: true });
  await a.prepareTargets({ contacts: [proactive.contact] }); await launch(a); await a.tick();
  assert.deepEqual(a.publicState().replyTargets, [reply.id]); assert.deepEqual(a.publicState().proactiveTargets, [proactive.id]);
  assert.deepEqual(new Set(a.data.targets), new Set([reply.id, proactive.id]));
  assert.deepEqual(a.data.queue.items.map(x => x.id), [proactive.id]);
  assert.equal(bridge.sent.length, 1); assert.equal(bridge.sent[0].contact, proactive.contact);
  bridge.push(reply.contact, 'other', '请介绍一下'); bridge.push(proactive.contact, 'other', '感兴趣'); bridge.push(bridge.contacts[2].id, 'other', '没有选中的对象');
  await a.tick(); advance(8000); await a.tick();
  assert.equal(bridge.sent.length, 3);
  assert.deepEqual(new Set(bridge.sent.slice(1).map(x => x.contact)), new Set([reply.contact, proactive.contact]));
  assert.deepEqual(provider.calls.slice(-2).map(x => x.input.continuation), [false, true]);
});

test('proactive scope is rechecked after an intent write even if the contact remains selected for replies', async t => {
  const { a, bridge, provider } = await fixture(t, { contacts: 2 });
  const [first, second] = a.profiles(); await a.targets([first.id], 'reply');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), save = a.save.bind(a); let gated = false;
  a.save = async () => {
    await save();
    if (!gated && first.delivery?.status === 'sending') { gated = true; entered.resolve(); await release.promise; }
  };
  await launch(a); const work = a.tick(); await entered.promise;
  await a.targets([second.id], 'proactive'); release.resolve(); await work;
  assert.equal(bridge.sent.length, 0); assert.ok(a.data.targets.includes(first.id));
  assert.equal(a.data.queue.items[0].status, 'skipped');
  await a.settings({ enabled: true }); const calls = provider.calls.length;
  await a.generate(first, await bridge.read({ contact: first.contact }), 'proactive', a.revision, a.controller.signal);
  assert.equal(provider.calls.length, calls); assert.equal(bridge.sent.length, 0);
});

test('legacy shared targets migrate into both scopes and default target updates retain compatibility', async t => {
  const { a, bridge, provider, root } = await fixture(t, { contacts: 2 });
  const ids = a.profiles().map(p => p.id); await a.targets(ids);
  assert.deepEqual(a.data.replyTargets, ids); assert.deepEqual(a.data.proactiveTargets, ids);
  const persisted = JSON.parse(await readFile(a.file, 'utf8'));
  delete persisted.replyTargets; delete persisted.proactiveTargets; delete persisted.replyStrategy;
  await writeFile(a.file, JSON.stringify(persisted));
  const restarted = new AIAssistant({ dataRoot: root, bridge, provider }); await restarted.init();
  assert.deepEqual(restarted.data.replyTargets, ids); assert.deepEqual(restarted.data.proactiveTargets, ids);
  assert.equal(restarted.publicState().replyStrategy.replyGoal, strategy.replyGoal);
  assert.equal(restarted.publicState().replyStrategy.boundaries, strategy.boundaries);
  assert.equal(restarted.data.settings.enabled, false); await restarted.close();
});

test('global reply strategy is independent from proactive edits and never overrides a proactive continuation', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const proactive = a.profiles()[0]; await a.learn({ contacts: [bridge.contacts[1].id] });
  const reply = a.profiles().find(p => p.learnedAt); await a.targets([reply.id], 'reply');
  await a.saveStrategy({ ...strategy, purpose: '不应保存为主动目的', replyGoal: '原回复目标', facts: '原回复事实', boundaries: '原回复限制' }, undefined, 'reply');
  assert.equal(a.publicState().strategy.purpose, strategy.purpose);
  await a.saveStrategy({ ...strategy, purpose: '本轮主动目标', content: '本轮主动话术', persona: '本轮主动人设', facts: '本轮主动事实', boundaries: '本轮主动限制' });
  assert.equal(a.publicState().replyStrategy.replyGoal, '原回复目标');
  await a.settings({ reply: true }); await launch(a); await a.tick();
  bridge.push(reply.contact, 'other', '请答复'); bridge.push(proactive.contact, 'other', '感兴趣'); await a.tick(); advance(8000); await a.tick();
  const [independent, continuation] = provider.calls.slice(-2).map(x => x.input);
  assert.equal(independent.strategy.replyGoal, '原回复目标'); assert.equal(independent.strategy.facts, '原回复事实'); assert.equal(independent.strategy.boundaries, '原回复限制');
  for (const field of ['purpose', 'content', 'persona', 'styleProfileId']) assert.equal(independent.strategy[field], '');
  for (const marker of ['本轮主动目标', '本轮主动话术', '本轮主动人设']) assert.equal(JSON.stringify(independent).includes(marker), false);
  assert.equal(continuation.strategy.purpose, '本轮主动目标'); assert.equal(continuation.strategy.facts, '本轮主动事实'); assert.equal(continuation.strategy.boundaries, '本轮主动限制');
  assert.equal(continuation.strategy.content, '本轮主动话术'); assert.equal(continuation.strategy.persona, '本轮主动人设');
  assert.equal(continuation.continuation, true);
});
