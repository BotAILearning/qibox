import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  return { a, bridge, provider, advance: (ms = 8000) => { now += ms; } };
}

test('replies retain both speakers and confirmed AI answers across turns, with each incoming burst identified', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const contact = bridge.contacts[0].id, foreign = bridge.contacts[1].id;
  bridge.messages.set(contact, []);
  bridge.push(contact, 'other', '周六还是周日见面？');
  bridge.push(contact, 'self', '周六，地点还没定。');
  bridge.push(foreign, 'other', '另一位联系人的私有内容');
  await a.settings({ enabled: true }); await a.tick();
  const location = bridge.push(contact, 'other', '地点呢？'); await a.tick(); advance();
  provider.next = async () => ({ action: 'send', text: '你想在哪儿见？' }); await a.tick();
  assert.equal(bridge.sent.length, 1);
  const answer = bridge.messages.get(contact).at(-1);
  const first = bridge.push(contact, 'other', '公园吧');
  const second = bridge.push(contact, 'other', '下午三点可以吗？');
  await a.tick(); advance();
  provider.next = async () => ({ action: 'skip' }); await a.tick();
  const { input, system } = provider.calls.at(-1);
  assert.deepEqual(input.messages.map(m => [m.direction, m.text]), bridge.messages.get(contact).map(m => [m.direction, m.text]));
  assert.equal(input.messages.find(m => m.id === answer.id).aiGenerated, true);
  assert.equal(input.messages.find(m => m.id === location.id).direction, 'other');
  assert.deepEqual(input.conversation, { latestIncomingId: second.id, lastSelfId: answer.id, incomingSinceLastSelf: [first.id, second.id] });
  assert.equal(JSON.stringify(input).includes('另一位联系人的私有内容'), false);
  assert.match(system, /先结合前文识别话题/);
  assert.match(system, /不重复询问已经说明的信息/);
});

test('late incoming context cancels the old draft and is included on regeneration', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const contact = bridge.contacts[0].id;
  await a.settings({ enabled: true }); await a.tick();
  bridge.push(contact, 'other', '周六可以吗？'); await a.tick(); advance();
  let correction;
  provider.next = async () => {
    correction = bridge.push(contact, 'other', '说错了，是周日。');
    return { action: 'send', text: '周六没问题。' };
  };
  await a.tick(); assert.equal(bridge.sent.length, 0);
  advance(); provider.next = async () => ({ action: 'skip' }); await a.tick();
  const { input } = provider.calls.at(-1);
  assert.equal(input.conversation.latestIncomingId, correction.id);
  assert.equal(input.messages.at(-1).text, '说错了，是周日。');
  assert.equal(bridge.sent.length, 0);
});

test('group context keeps distinct senders and mention metadata', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  const push = (sender, text, self = false) => Object.assign(bridge.push(target.id, 'other', text), {
    sender: key(sender), mentions: { verified: true, self, all: false, others: false },
  });
  await a.setGroupOptions({ contact: target.id, atMe: true });
  await a.settings({ enabled: true }); await a.tick();
  const earlier = push('member-a', '我选周六。');
  const latest = push('member-b', '我选周日，你呢？', true);
  await a.tick(); advance(); provider.next = async () => ({ action: 'skip' }); await a.tick();
  const { input } = provider.calls.at(-1);
  assert.equal(input.kind, 'group');
  assert.equal(input.conversation.latestIncomingId, latest.id);
  assert.equal(input.messages.find(m => m.id === earlier.id).sender, key('member-a'));
  assert.equal(input.messages.find(m => m.id === latest.id).sender, key('member-b'));
  assert.equal(input.messages.at(-1).mentions.self, true);
});
