import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { cleanup, temp } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000;
  bridge.stableMessageIds = true;
  const contact = bridge.contacts[0]; contact.kind = kind;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.scan();
  if (kind === 'group') await a.setGroupOptions({ contact: contact.id, atMe: false, atAll: false, realtime: false });
  else await a.setReplyOptions({ contact: contact.id, enabled: true, judgeReply: true });
  await a.settings({ enabled: true }); await a.tick();
  t.after(async () => { if (!a.closed) await a.close(); await cleanup(root); });
  return { a, bridge, provider, root, profile: a.profiles()[0], contact, advance(ms) { now += ms; } };
}

test('skip snapshots preserve raw incoming messages encrypted and expose verified sender fields', async t => {
  const { a, bridge, profile, root } = await fixture(t, 'group');
  const senderId = 'a'.repeat(64);
  const first = Object.assign(bridge.push(profile.contact, 'other', '前一条原始来信'), { sender: senderId, senderName: '群成员甲', timestamp: 1700000000 });
  const anchor = Object.assign(bridge.push(profile.contact, 'other', '[语音]'), { sender: senderId, senderName: '群成员甲', type: 'voice', timestamp: 1700000001 });
  a.event('skip', profile.id, 'model-skip', '模型判断：本轮无需回复', { messageId: anchor.id, incomingMessages: [first, anchor] });

  const row = a.publicState().skipRecords[0];
  assert.deepEqual(row.incomingMessages.map(({ id, senderName, senderId: member }) => ({ id, senderName, senderId: member })), [
    { id: first.id, senderName: '群成员甲', senderId }, { id: anchor.id, senderName: '群成员甲', senderId },
  ]);
  assert.equal(row.incomingMessages[1].text, '[语音]');
  assert.equal(Object.hasOwn(row, 'incomingSnapshot'), false);
  assert.equal(Object.hasOwn(a.data.events[0], 'incomingMessages'), false);
  const persisted = await readFile(`${root}/ai-assistant.json`, 'utf8');
  assert.equal(persisted.includes('前一条原始来信'), false);
  assert.equal(persisted.includes('群成员甲'), false);
  assert.equal(persisted.includes('[语音]'), false);
});

test('model skip call stores all pending original messages without keeping a transcription', async t => {
  const { a, bridge, provider, profile, advance } = await fixture(t);
  const first = Object.assign(bridge.push(profile.contact, 'other', '先问一个问题'), { timestamp: 1700000000 });
  const second = Object.assign(bridge.push(profile.contact, 'other', '再补充一句'), { timestamp: 1700000001 });
  provider.next = async () => ({ action: 'skip' });
  await a.tick(); advance(20000); await a.tick();
  const row = a.publicState().skipRecords.find(item => item.reasonCode === 'model-no-reply');
  assert.ok(row, JSON.stringify({ events: a.data.events.slice(0, 8), notice: a.notice, waiting: a.publicState().waiting, calls: provider.calls.length }));
  assert.deepEqual(row.incomingMessages.map(message => message.id), [first.id, second.id]);
  assert.deepEqual(row.incomingMessages.map(message => message.text), ['先问一个问题', '再补充一句']);
});

test('disabled realtime skip snapshots only the current pending incoming burst', async t => {
  const { a, bridge, profile, advance } = await fixture(t, 'group');
  await a.setGroupOptions({ contact: profile.contact, atMe: true });
  const sender = 'b'.repeat(64);
  const incoming = Object.assign(bridge.push(profile.contact, 'other', '群里这条尚未回复'), {
    timestamp: 1700000000, sender, senderName: '群成员乙', mentions: { verified: true, self: false, all: false, others: false },
  });
  await a.tick(); advance(3000); await a.tick();
  const row = a.publicState().skipRecords.find(item => item.reasonCode === 'group-realtime-disabled');
  assert.ok(row);
  assert.deepEqual(row.incomingMessages.map(message => message.id), [incoming.id]);
  assert.equal(row.incomingMessages[0].senderName, '群成员乙');
});

test('explicit-question protection skip stores the original question after model retries', async t => {
  const { a, bridge, provider, profile, advance } = await fixture(t);
  let calls = 0; provider.complete = async () => { calls++; return { action: 'skip' }; };
  const incoming = Object.assign(bridge.push(profile.contact, 'other', '这件事接下来应该怎么安排？'), { timestamp: 1700000000 });
  await a.tick(); advance(20000); await a.tick();
  const row = a.publicState().skipRecords.find(item => item.reasonCode === 'explicit-question-no-response');
  assert.ok(row);
  assert.equal(calls, 2);
  assert.equal(row.incomingMessages[0].id, incoming.id);
  assert.equal(row.incomingMessages[0].text, '这件事接下来应该怎么安排？');
});

test('batched legacy content reads one bounded history per contact, caches encrypted bodies, and enables reply marking', async t => {
  const { a, bridge, profile } = await fixture(t);
  const old = Object.assign(bridge.push(profile.contact, 'other', '历史原始未回复内容'), { timestamp: 1000 });
  const latest = Object.assign(bridge.push(profile.contact, 'other', '当前新来信'), { timestamp: 2000 });
  const rows = [
    { id: 'legacy-one', account: a.data.account, target: profile.id, at: 1000000, messageId: old.id, code: 'skip' },
    { id: 'legacy-two', account: a.data.account, target: profile.id, at: 2000000, messageId: latest.id, code: 'skip' },
    { id: 'foreign', account: 'foreign-account', target: profile.id, at: 1000000, messageId: old.id, code: 'skip' },
  ];
  a.data.events.unshift(...rows);
  a.data.skipLog.unshift(...rows.slice(0, 2));
  const read = bridge.read.bind(bridge), rangeCalls = [];
  bridge.read = async request => ({ ...await read(request), messages: (await read(request)).messages.filter(message => message.id !== old.id) });
  bridge.readRange = async ({ account, contact, from, to }) => {
    rangeCalls.push({ contact, from, to });
    return { account, contact, messages: [old, latest].filter(message => message.timestamp >= from && message.timestamp < to).map(message => ({ ...message, direction: 'other' })) };
  };
  const response = await a.loadSkipRecordContent({ eventIds: ['legacy-one', 'legacy-two', 'foreign'] });
  assert.equal(response.account, a.data.account);
  assert.equal(response.records.length, 2);
  assert.equal(rangeCalls.length, 1, 'nearby legacy messages share one bounded range read');
  assert.deepEqual(response.records.map(row => row.incomingMessages[0].text), ['历史原始未回复内容', '当前新来信']);
  assert.equal(response.records.some(row => row.id === 'foreign'), false);
  assert.equal(JSON.stringify(a.data.skipLog).includes('历史原始未回复内容'), false);
  bridge.read = async () => { throw new Error('cached snapshot should avoid another history read'); };
  await a.markReplyNeeded({ profileId: profile.id, eventId: 'legacy-one', messageId: old.id });
  assert.equal(a.data.pendingReplySummaries.length, 1);
  assert.equal(a.vault.open(a.data.pendingReplySummaries[0].body).text, '历史原始未回复内容');
});
