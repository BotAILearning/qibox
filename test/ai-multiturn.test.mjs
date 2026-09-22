import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let now = 1000000;
  const delays = [], randomCalls = [];
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, interval: () => 180000,
    delay: async ms => { delays.push(ms); }, random: (min, max) => { randomCalls.push([min, max]); return max; } });
  await a.init(); t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  await a.learn({ contacts: [bridge.contacts[0].id] }); const target = a.profiles()[0];
  await a.targets([target.id]); await a.saveStrategy(strategy); await a.saveStrategy(strategy, undefined, 'reply');
  const advance = ms => now += ms;
  const enableReply = async (value = {}) => { await a.settings({ reply: true, multiTurn: true, enabled: true, ...value }); await a.tick(); };
  const incoming = async (result, text = '新的问题') => {
    bridge.push(target.contact, 'other', text); await a.tick(); advance(a.data.settings.replyDelay * 1000);
    if (result) provider.next = async () => result;
    await a.tick();
  };
  const launch = async (sendMode = 'segments', value = {}) => {
    await a.saveStrategy({ ...strategy, sendMode }); await a.settings({ proactive: true, reply: false, enabled: true, ...value }); await a.queueAction('start');
  };
  return { a, bridge, provider, target, root, delays, randomCalls, advance, enableReply, incoming, launch };
}

test('multi-turn settings have backward-compatible defaults and validate ranges before changes', async t => {
  const { a, root, bridge, provider } = await fixture(t);
  const expected = { multiTurn: false, segmentDelayMin: 2, segmentDelayMax: 8, followUpDelayMin: 45, followUpDelayMax: 120 };
  for (const [key, value] of Object.entries(expected)) assert.equal(a.publicState().settings[key], value);
  for (const value of [{ multiTurn: 'true' }, { segmentDelayMin: 0 }, { segmentDelayMax: 31 }, { segmentDelayMin: 2.5 }, { segmentDelayMin: 9 }, { followUpDelayMin: 14 }, { followUpDelayMax: 601 }, { followUpDelayMax: 44 }]) {
    await assert.rejects(a.settings(value));
    for (const [key, value] of Object.entries(expected)) assert.equal(a.data.settings[key], value);
  }
  await a.settings({ multiTurn: true, segmentDelayMin: 1, segmentDelayMax: 30, followUpDelayMin: 15, followUpDelayMax: 600 });
  await a.close(); const persisted = JSON.parse(await readFile(a.file, 'utf8'));
  for (const key of Object.keys(expected)) delete persisted.settings[key];
  await writeFile(a.file, JSON.stringify(persisted));
  const restarted = new AIAssistant({ dataRoot: root, bridge, provider }); await restarted.init();
  for (const [key, value] of Object.entries(expected)) assert.equal(restarted.data.settings[key], value);
  await restarted.close();
});

test('learning and per-reply style updates identify the owner as self rather than the contact', async t => {
  const { a, provider, enableReply, incoming } = await fixture(t);
  const learning = provider.calls[0]; assert.equal(learning.input.styleOwner, 'self');
  assert.match(learning.system, /只学习 direction=self/); assert.match(learning.system, /不能模仿对方/);
  await enableReply({ updateStyle: true }); await incoming({ action: 'send', text: '好的' });
  const reply = provider.calls.at(-1); assert.equal(reply.input.styleOwner, 'self'); assert.match(reply.system, /只分析用户本人的 self 消息/);
});

test('a conversation with only other-party messages cannot be learned as the user style', async t => {
  const { a, bridge, provider } = await fixture(t), contact = bridge.contacts[1].id;
  bridge.messages.set(contact, []); bridge.push(contact, 'other', '只有对方发言的风格样本');
  const calls = provider.calls.length;
  await assert.rejects(a.learn({ contacts: [contact] }), /没有你的发言/);
  assert.equal(provider.calls.length, calls); assert.equal(a.profiles().some(profile => profile.contact === contact), false);
});

test('independent multi-turn replies send only needed segments with random verified delays and a count per confirmed message', async t => {
  const { a, bridge, provider, target, delays, randomCalls, enableReply, incoming } = await fixture(t);
  await a.saveStrategy({...strategy,maxRounds:10},undefined,'reply'); await enableReply({ segmentDelayMin: 3, segmentDelayMax: 6 });
  await incoming({ action: 'send', segments: ['PRIVATE_SEGMENT_ONE。', 'PRIVATE_SEGMENT_TWO。', 'PRIVATE_SEGMENT_THREE。'] });
  assert.deepEqual(bridge.sent.map(x => x.text), ['PRIVATE_SEGMENT_ONE。', 'PRIVATE_SEGMENT_TWO。', 'PRIVATE_SEGMENT_THREE。']);
  assert.deepEqual(delays, [6000, 6000]); assert.deepEqual(randomCalls, [[3, 6], [3, 6]]);
  assert.equal(target.rounds, 3); assert.equal(provider.calls.at(-1).input.multiTurn, true); assert.equal(provider.calls.at(-1).input.followUp, false);
  assert.equal(provider.calls.at(-1).input.continuation, false); assert.equal(a.followUps.size, 0);
  assert.equal((await readFile(a.file, 'utf8')).includes('PRIVATE_SEGMENT_'), false);
  await incoming({ action: 'send', text: '只需一句。' }); assert.equal(bridge.sent.at(-1).text, '只需一句。'); assert.equal(delays.length, 2);
});

test('disabled multi-turn rejects invalid segments and never joins or schedules them', async t => {
  const { a, bridge, provider, delays, enableReply, incoming, advance } = await fixture(t);
  await enableReply({ multiTurn: false }); await incoming({ action: 'send', segments: ['第一句。', '第二句。'], followUp: true });
  assert.deepEqual(bridge.sent, []); assert.equal(delays.length, 0); assert.equal(a.followUps.size, 0);
  assert.equal(provider.calls.at(-1).input.multiTurn, false);
  assert.match(a.notice, /单条发送/);
});

test('a follow-up is generated from current context only when due and cannot rearm itself', async t => {
  const { a, bridge, provider, target, advance, enableReply, incoming, randomCalls } = await fixture(t);
  await enableReply({ followUpDelayMin: 15, followUpDelayMax: 20 });
  await incoming({ action: 'send', text: 'INITIAL_FOLLOW_UP_PRIVATE。', followUp: true });
  const pending = a.followUps.get(target.id); assert.ok(pending); assert.deepEqual(randomCalls.at(-1), [15, 20]);
  assert.deepEqual(Object.keys(pending).sort(), ['contextRevision', 'dueAt', 'revision']);
  const saved = await readFile(a.file, 'utf8'); assert.equal(saved.includes('INITIAL_FOLLOW_UP_PRIVATE。'), false); assert.equal(saved.includes('contextRevision'), false);
  const calls = provider.calls.length; advance(19999); await a.tick(); assert.equal(provider.calls.length, calls);
  provider.next = async input => {
    assert.equal(input.followUp, true); assert.equal(input.mode, 'reply'); assert.equal(input.messages.at(-1).text, 'INITIAL_FOLLOW_UP_PRIVATE。');
    return { action: 'send', text: 'FOLLOW_UP_PRIVATE_QUESTION。', followUp: true };
  };
  advance(1); await a.tick(); assert.equal(bridge.sent.length, 2); assert.equal(a.followUps.size, 0); assert.equal(target.rounds, 2);
  advance(1000000); await a.tick(); assert.equal(bridge.sent.length, 2); assert.equal(provider.calls.length, calls + 1);
  assert.equal((await readFile(a.file, 'utf8')).includes('FOLLOW_UP_PRIVATE_QUESTION。'), false);
});

test('optional follow-up can skip even when ordinary reply judgment is disabled', async t => {
  const { a, bridge, provider, target, advance, enableReply, incoming } = await fixture(t);
  await enableReply({ judgeReply: false }); await incoming({ action: 'send', text: '先这样', followUp: true });
  provider.next = async input => { assert.equal(input.followUp, true); assert.equal(input.judgeReply, true); return { action: 'skip' }; };
  advance(120000); await a.tick(); assert.equal(bridge.sent.length, 1); assert.equal(target.paused, false); assert.equal(target.handoffReason, undefined);
  assert.equal(a.followUps.size, 0); assert.equal(a.data.events[0].code, 'skip');
});

test('new incoming messages cancel old follow-ups and enter the regular merged reply path', async t => {
  const { a, bridge, provider, target, advance, enableReply, incoming } = await fixture(t);
  await enableReply(); await incoming({ action: 'send', text: '第一轮', followUp: true }); assert.equal(a.followUps.size, 1);
  advance(120000); bridge.push(target.contact, 'other', '对方先回复了'); const calls = provider.calls.length;
  await a.tick(); assert.equal(a.followUps.size, 0); assert.equal(provider.calls.length, calls);
  advance(8000); await a.tick(); assert.equal(bridge.sent.length, 2); assert.equal(provider.calls.at(-1).input.followUp, false);
  assert.equal(provider.calls.at(-1).input.messages.at(-1).text, '对方先回复了');
});

test('messages arriving during follow-up generation prevent the stale follow-up from being sent', async t => {
  const { a, bridge, provider, target, advance, enableReply, incoming } = await fixture(t);
  await enableReply(); await incoming({ action: 'send', text: '先回复', followUp: true });
  provider.next = async () => { bridge.push(target.contact, 'other', '刚来的新消息'); return { action: 'send', text: 'STALE_FOLLOW_UP' }; };
  advance(120000); await a.tick(); assert.equal(bridge.sent.length, 1); assert.equal(a.followUps.size, 0); assert.equal(a.cursors.get(target.id).pending, true);
  advance(8000); await a.tick(); assert.equal(bridge.sent.length, 2); assert.equal(provider.calls.at(-1).input.followUp, false);
});

test('manual takeover while a follow-up model call is in progress discards its late result', async t => {
  const { a, bridge, provider, advance, enableReply, incoming } = await fixture(t);
  await enableReply(); await incoming({ action: 'send', text: '已答复', followUp: true });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  provider.next = async input => { assert.equal(input.followUp, true); entered.resolve(); return release.promise; };
  advance(120000); const pending = a.tick(); await entered.promise; await a.manualInput({type: 'key', held:true});
  release.resolve({ action: 'send', text: '接管后的过期追问', followUp: true }); await pending;
  assert.equal(bridge.sent.length, 1); assert.equal(a.followUps.size, 0); assert.equal(a.data.settings.enabled, true);
});

for (const change of ['manual', 'account', 'incoming']) test(`a ${change} during random segment delay interrupts the rest and never schedules a follow-up`, async t => {
  const { a, bridge, provider, target, enableReply, incoming } = await fixture(t);
  a.delay = async () => {
    if (change === 'manual') bridge.push(target.contact, 'self', '我来接着说');
    if (change === 'incoming') bridge.push(target.contact, 'other', '稍等');
    if (change === 'account') bridge.account = key('changed-account');
  };
  await enableReply(); await incoming({ action: 'send', segments: ['确认前缀。', '不应发送'], followUp: true });
  assert.deepEqual(bridge.sent.map(x => x.text), ['确认前缀。']); assert.equal(a.followUps.size, 0);
  if (change === 'manual') assert.equal(target.paused, false);
  if (change === 'account') assert.equal(a.data.settings.enabled, false);
  if (change === 'incoming') assert.equal(a.cursors.get(target.id).pending, true);
});

test('master cancellation aborts a real timer during a segment wait without sending the remainder', async t => {
  const { a, bridge, provider, enableReply, incoming } = await fixture(t);
  const entered = Promise.withResolvers();
  const realDelay = new AIAssistant({ dataRoot: '.', bridge }).delay;
  a.delay = (ms, signal) => { entered.resolve(); return realDelay(ms, signal); };
  await enableReply({ segmentDelayMin: 30, segmentDelayMax: 30 });
  const sending = incoming({ action: 'send', segments: ['第一条', '不能发送的第二条'], followUp: true });
  await entered.promise; await a.settings({ enabled: false }); await sending;
  assert.equal(bridge.sent.length, 1); assert.equal(a.followUps.size, 0); assert.equal(a.profiles()[0].delivery.interrupted, true);
});

for (const action of ['master', 'multiTurn', 'reply', 'target', 'strategy', 'profile', 'cancel', 'pause', 'end', 'skip', 'manualInput', 'userActivity', 'account', 'scan', 'suspend', 'configure']) {
  test(`${action} cancels a pending follow-up`, async t => {
    const { a, bridge, provider, target, advance, enableReply, incoming } = await fixture(t);
    await enableReply(); await incoming({ action: 'send', text: '已回复', followUp: true }); assert.equal(a.followUps.size, 1);
    if (action === 'master') await a.settings({ enabled: false });
    if (action === 'multiTurn') await a.settings({ multiTurn: false });
    if (action === 'reply') await a.settings({ reply: false, proactive: true });
    if (action === 'target') await a.targets([], 'reply');
    if (action === 'strategy') await a.saveStrategy(strategy, undefined, 'reply');
    if (action === 'profile') await a.editProfile(target.id, { style: target.style, paused: true });
    if (action === 'cancel') await a.cancel();
    if (action === 'pause' || action === 'end') await a.queueAction(action);
    if (action === 'skip') { a.data.queue.items = [{ id: target.id, status: 'pending' }]; await a.queueAction('skip'); }
    if (action === 'manualInput') await a.manualInput({ held: true });
    if (action === 'userActivity') a.userActivity();
    if (action === 'account') { bridge.account = key('changed-before-follow-up'); await a.tick(); }
    if (action === 'scan') await a.scan();
    if (action === 'suspend') await a.suspend();
    if (action === 'configure') await a.configure(modelConfig);
    assert.equal(a.followUps.size, 0);
    const calls = provider.calls.length; advance(1000000); await a.tick(); assert.equal(provider.calls.length, calls); assert.equal(bridge.sent.length, 1);
  });
}

test('observed manual chat takes over before a pending follow-up can generate', async t => {
  const { a, bridge, provider, target, advance, enableReply, incoming } = await fixture(t);
  await enableReply(); await incoming({ action: 'send', text: '已回复', followUp: true });
  const calls = provider.calls.length; bridge.push(target.contact, 'self', '本人手动回复'); advance(120000); await a.tick();
  assert.equal(target.paused, false); assert.equal(a.followUps.size, 0); assert.equal(provider.calls.length, calls);
});

test('restart preserves delay preferences but never resumes a scheduled follow-up', async t => {
  const { a, root, bridge, provider, enableReply, incoming } = await fixture(t);
  await enableReply({ followUpDelayMin: 15, followUpDelayMax: 15 }); await incoming({ action: 'send', text: '旧消息', followUp: true });
  assert.equal(a.followUps.size, 1); await a.close();
  const restarted = new AIAssistant({ dataRoot: root, bridge, provider }); await restarted.init();
  assert.equal(restarted.followUps.size, 0); assert.equal(restarted.data.settings.enabled, true); assert.equal(restarted.data.settings.followUpDelayMax, 15);
  const calls = provider.calls.length; await restarted.tick(); assert.equal(provider.calls.length, calls); await restarted.close();
});

test('a follow-up consumes a reply round and no scheduled or incoming turn exceeds the configured limit', async t => {
  const { a, bridge, provider, target, advance, enableReply, incoming } = await fixture(t);
  await a.saveStrategy({ ...strategy, maxRounds: 2 }, undefined, 'reply'); await enableReply();
  await incoming({ action: 'send', text: '第一轮', followUp: true }); advance(120000);
  provider.next = async () => ({ action: 'send', text: '第二轮', followUp: true }); await a.tick();
  assert.equal(target.rounds, 2); assert.equal(a.followUps.size, 0);
  const calls = provider.calls.length; await incoming(); assert.equal(target.paused, true); assert.equal(bridge.sent.length, 2); assert.equal(provider.calls.length, calls);
  assert.equal(a.data.events[0].code, 'limit');
});

test('the final permitted ordinary round does not request a follow-up', async t => {
  const { a, target, enableReply, incoming } = await fixture(t);
  await a.saveStrategy({ ...strategy, maxRounds: 1 }, undefined, 'reply'); await enableReply();
  await incoming({ action: 'send', text: '到此为止', followUp: true }); assert.equal(target.rounds, 1); assert.equal(a.followUps.size, 0);
});

test('proactive segments and later replies pursue the same objective while the independent multi-turn switch is off', async t => {
  const { a, bridge, provider, target, launch, advance, incoming } = await fixture(t);
  await launch('segments', { multiTurn: false });
  provider.next = async input => { assert.equal(input.multiTurn, true); return { action: 'send', segments: ['你好', '想邀请你'], followUp: true }; };
  await a.tick(); assert.equal(a.data.settings.reply, false); assert.equal(a.followUps.size, 1);
  advance(120000); provider.next = async input => {
    assert.equal(input.continuation, true); assert.equal(input.followUp, true); assert.equal(input.multiTurn, true); assert.equal(input.strategy.purpose, strategy.purpose);
    return { action: 'send', text: '想了解活动吗？', followUp: true };
  };
  await a.tick(); assert.equal(a.followUps.size, 0);
  await incoming({ action: 'send', segments: ['明白', '活动时间还没定'] }, '说说活动吧');
  const input = provider.calls.at(-1).input; assert.equal(input.continuation, true); assert.equal(input.multiTurn, true); assert.equal(input.followUp, false); assert.equal(input.strategy.purpose, strategy.purpose);
  assert.equal(bridge.sent.length, 5); assert.equal(target.rounds, 3);
});

test('single-message proactive conversations stay single even when independent multi-turn replies are enabled', async t => {
  const { a, bridge, provider, launch, incoming } = await fixture(t);
  await launch('single', { multiTurn: true }); provider.next = async () => ({ action: 'send', text: '开场', followUp: true }); await a.tick();
  assert.equal(provider.calls.at(-1).input.multiTurn, false); assert.equal(a.followUps.size, 0);
  await incoming({ action: 'send', segments: ['继续。', '说明。'], followUp: true });
  assert.equal(provider.calls.at(-1).input.multiTurn, false); assert.equal(bridge.sent.length, 1); assert.match(a.notice, /单条发送/); assert.equal(a.followUps.size, 0);
});

test('disabling replies cannot turn a reply-only follow-up into an unrelated proactive conversation', async t => {
  const { a, bridge, provider, target, enableReply, incoming, advance } = await fixture(t);
  await a.prepareTargets({ contacts: [bridge.contacts[1].id] }); await enableReply();
  await incoming({ action: 'send', text: '独立回复', followUp: true }); assert.equal(a.followUps.size, 1); assert.equal(target.continuation, undefined);
  await a.settings({ reply: false, proactive: true }); const calls = provider.calls.length;
  bridge.push(target.contact, 'other', '不应再自动回复'); await a.tick(); advance(1000000); await a.tick();
  assert.equal(a.followUps.size, 0); assert.equal(provider.calls.length, calls); assert.equal(bridge.sent.length, 1);
});

test('proactive follow-ups are revoked when proactive mode or its selected scope changes', async t => {
  for (const change of ['switch', 'scope', 'end', 'pause']) await t.test(change, async t => {
    const { a, bridge, provider, launch, advance } = await fixture(t);
    await launch(); provider.next = async () => ({ action: 'send', text: '主动开场', followUp: true }); await a.tick(); assert.equal(a.followUps.size, 1);
    if (change === 'switch') await a.settings({ proactive: false, enabled: false });
    if (change === 'scope') await a.prepareTargets({ contacts: [bridge.contacts[1].id] });
    if (change === 'end' || change === 'pause') await a.queueAction(change);
    assert.equal(a.followUps.size, 0); const calls = provider.calls.length; advance(1000000); await a.tick(); assert.equal(provider.calls.length, calls);
  });
});



