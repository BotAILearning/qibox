import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
import { readGroupInbox, nextGroupBatch, groupContextCanAdvance } from '../server/ai-group-inbox.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true; bridge.contacts[0].kind = 'group';
  let now = 1000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  await a.setGroupOptions({ contact: bridge.contacts[0].id, atMe: true, atAll: true, realtime: true, confirmRealtime: true });
  await a.settings({ enabled: true }); await a.tick();
  const profile = a.profiles().find(p => p.contact === bridge.contacts[0].id);
  const push = (sender, self = true, text = '请回答我的问题') => Object.assign(bridge.push(profile.contact, 'other', text), {
    timestamp: Math.floor(now / 1000), sender: key(sender), mentions: { verified: true, self, all: false, others: false },
  });
  return { a, bridge, provider, profile, push, advance: ms => { now += ms; } };
}

test('new group traffic during model generation cannot overwrite an @me obligation', async t => {
  const { a, bridge, provider, profile, push, advance } = await fixture(t);
  const mention = push('甲'); await a.tick(); advance(3000);
  provider.next = async () => { push('乙', false, '普通的新话题'); return { action: 'send', text: '这是给甲的回复' }; };
  await a.tick();
  assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0].text, '这是给甲的回复');
  assert.deepEqual(profile.sentMessages[0].replyTo, [mention.id]);
  assert.ok(readGroupInbox(a.vault, profile).pending.every(row => row.id !== mention.id));
});

test('multiple group members share one frozen generation with separate reply segments', async t => {
  const { a, bridge, provider, profile, push, advance } = await fixture(t);
  const one = push('甲'), two = push('乙'); await a.tick(); advance(3000);
  const targets = [];
  provider.complete = async (_config, _system, input) => {
    targets.push(input.conversation.pendingIncomingIds);
    assert.deepEqual(input.conversation.pendingIncomingIds, [one.id, two.id]);
    assert.deepEqual(input.conversation.pendingBySender, [{ sender: key('甲'), messageIds: [one.id] }, { sender: key('乙'), messageIds: [two.id] }]);
    return { action: 'send', segments: ['答甲', '答乙'] };
  };
  await a.tick();
  assert.deepEqual(bridge.sent.map(row => row.text), ['答甲', '答乙']);
  assert.deepEqual(targets, [[one.id, two.id]]);
  assert.equal(readGroupInbox(a.vault, profile).pending.length, 0);
  await a.tick(); assert.equal(bridge.sent.length, 2);
});

test('insufficient context preserves messages and uses subsequent clarification', async t => {
  const { a, bridge, provider, profile, push, advance } = await fixture(t);
  const one = push('甲', true, '我把情况说完再问你'); await a.tick(); advance(3000);
  provider.next = async () => ({ action: 'wait' }); await a.tick();
  assert.equal(bridge.sent.length, 0);
  assert.ok(readGroupInbox(a.vault, profile).pending.some(row => row.id === one.id));
  const two = push('甲', true, '补充完成，现在你觉得该如何处理？'); await a.tick(); advance(3000);
  await a.tick(); assert.equal(bridge.sent.length, 1);
  assert.deepEqual(profile.sentMessages[0].replyTo, [one.id, two.id]);
});

test('incoming-only changes may advance but a manual outgoing message invalidates the reply', () => {
  const before = { messages: [{ id: 'self-1', direction: 'self' }] };
  assert.equal(groupContextCanAdvance(before, { messages: [...before.messages, { id: 'incoming', direction: 'other' }] }), true);
  assert.equal(groupContextCanAdvance(before, { messages: [...before.messages, { id: 'manual', direction: 'self' }] }), false);
});

test('a mixed known and unknown sender batch never narrows its recipients to the known member', () => {
  const batch = nextGroupBatch({ pending: [{ id: 'known', sender: key('甲'), trigger: 'atMe' }, { id: 'unknown', trigger: 'atMe' }] });
  assert.equal(batch.sender, null);
  assert.deepEqual(batch.ids, ['known', 'unknown']);
});

test('seven group members share the five-segment cap and are settled together after one generation', async t => {
  const { a, bridge, provider, profile, push, advance } = await fixture(t);
  const incoming = Array.from({ length: 7 }, (_, i) => push(`成员${i + 1}`));
  await a.tick(); advance(3000);
  provider.next = async input => {
    assert.deepEqual(input.conversation.pendingIncomingIds, incoming.map(row => row.id));
    assert.equal(input.conversation.pendingBySender.length, 7);
    return { action: 'send', segments: Array.from({ length: 5 }, (_, i) => `合并答复${i + 1}`) };
  };
  await a.tick();
  assert.equal(provider.calls.length, 1);
  assert.equal(bridge.sent.length, 5);
  assert.equal(profile.rounds, 5);
  assert.equal(readGroupInbox(a.vault, profile).pending.length, 0);
  await a.tick(); assert.equal(bridge.sent.length, 5);
});

test('a missed snapshot is backfilled without losing an earlier mention outside the current window', async t => {
  const { a, bridge, provider, profile, push, advance } = await fixture(t);
  await a.setGroupOptions({ contact: profile.contact, realtime: false });
  push('历史', false); await a.tick(); advance(1000);
  const mention = push('甲', true); advance(1000);
  for (let i=0; i<6; i++) push('乙', false, `补充${i}`);
  const read = bridge.read.bind(bridge);
  bridge.read = async args => { const snapshot = await read(args); return { ...snapshot, messages: snapshot.messages.slice(-3) }; };
  bridge.readRange = async ({ account, contact, from, to }) => {
    const snapshot = await read({ account, contact });
    return { ...snapshot, messages: snapshot.messages.filter(message => message.timestamp >= from && message.timestamp < to) };
  };
  await a.tick(); advance(3000); await a.tick();
  assert.equal(bridge.sent.length, 1);
  assert.deepEqual(profile.sentMessages[0].replyTo, [mention.id]);
  assert.equal(provider.calls[0].input.conversation.pendingIncomingIds[0], mention.id);
});

test('manual group reply settles earlier obligations and leaves later incoming messages pending', async t => {
  const { a, bridge, profile, push, advance } = await fixture(t);
  const one = push('甲'); await a.tick(); advance(1000);
  Object.assign(bridge.push(profile.contact, 'self', '我已经手动回答了甲'), { timestamp: Math.floor(a.now()/1000) });
  advance(1000); const two = push('乙'); await a.tick();
  const inbox = readGroupInbox(a.vault, profile);
  assert.ok(inbox.settled.includes(one.id));
  assert.deepEqual(inbox.pending.filter(message => message.trigger === 'atMe').map(message => message.id), [two.id]);
  assert.equal(bridge.sent.length, 0);
});


test('ignored group messages retain their distinct verified reasons instead of claiming configuration is missing', async t => {
  const { a, bridge, profile, push } = await fixture(t);
  await a.setGroupOptions({ contact: profile.contact, atMe: false, atAll: false, realtime: true });
  const others = push('甲', false, '@其他成员 的问题'); others.mentions.others = true;
  const unknown = push('乙', false, '无法确认提及'); unknown.mentions.verified = false;
  const atMe = push('丙', true, '@我 的问题');
  const atAll = push('丁', false, '@所有人 的问题'); atAll.mentions.all = true;
  await a.tick();
  const records = a.publicState().skipRecords.filter(row => row.target === profile.id);
  for (const [message, reason, trigger] of [[others, 'group-at-others', undefined], [unknown, 'group-mentions-unverified', undefined], [atMe, 'group-at-me-disabled', 'atMe'], [atAll, 'group-at-all-disabled', 'atAll']]) {
    const record = records.find(row => row.messageId === message.id);
    assert.equal(record.reasonCode, reason); assert.equal(record.trigger, trigger);
    assert.deepEqual(record.incomingMessages.map(row => row.id), [message.id]);
  }
  assert.equal(bridge.sent.length, 0);
});

test('ordinary group traffic identifies the disabled realtime switch while mentions remain enabled', async t => {
  const { a, profile, push } = await fixture(t);
  await a.setGroupOptions({ contact: profile.contact, realtime: false });
  const message = push('甲', false, '普通消息'); await a.tick();
  const record = a.publicState().skipRecords.find(row => row.messageId === message.id);
  assert.equal(record.reasonCode, 'group-realtime-disabled'); assert.equal(record.trigger, 'realtime');
});
