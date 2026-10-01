import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { replyWindowPrompt } from '../server/ai-prompts.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-10-01T12:00:00+08:00');
  const contact = bridge.contacts[0].id;
  bridge.contacts[0].kind = kind;
  bridge.stableMessageIds = true;
  bridge.push(contact, 'other', '窗口开始前的旧问题');
  for (const message of bridge.messages.get(contact)) message.timestamp = Math.floor(now / 1000) - 3600;
  const delays = [];
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now,
    delay: async ms => { delays.push(ms); }, random: min => min });
  await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  if (kind === 'group') await a.setGroupOptions({ contact, atMe: true, atAll: true, realtime: false });
  else await a.setReplyOptions({ contact, enabled: true, multiTurn: false });
  await a.settings({ enabled: true, reply: true, multiTurn: false }); await a.tick();
  const push = (text, sender, mention = '') => Object.assign(bridge.push(contact, 'other', text), {
    timestamp: Math.floor(now / 1000), ...(sender ? { sender: key(sender) } : {}),
    ...(kind === 'group' ? { mentions: { verified: true, self: mention === 'self', all: mention === 'all', others: mention === 'others' } } : {})
  });
  return { a, bridge, provider, contact, delays, push, advance: ms => { now += ms; } };
}

test('private reply waits for the full window and keeps earlier questions when the final incoming is a thanks', async t => {
  const f = await fixture(t);
  const first = f.push('时间定在几点？'); await f.a.tick();
  f.advance(5000); const second = f.push('地址也发我一下'); await f.a.tick();
  f.advance(5000); const last = f.push('好的，谢谢'); await f.a.tick();
  assert.equal(f.provider.calls.length, 0);
  f.advance(19999); await f.a.tick(); assert.equal(f.provider.calls.length, 0);
  f.provider.next = async input => {
    assert.deepEqual(input.conversation.pendingIncomingIds, [first.id, second.id, last.id]);
    assert.equal(input.conversation.latestIncomingId, last.id);
    assert.equal(input.messages.some(message => message.text === '窗口开始前的旧问题'), true);
    return { action: 'send', segments: ['先回复时间问题', '再回复地址问题'], followUp: true };
  };
  f.advance(1); await f.a.tick();
  assert.equal(f.provider.calls.length, 1);
  assert.equal(f.provider.calls[0].system.includes(replyWindowPrompt), true);
  assert.deepEqual(f.bridge.sent.map(message => message.text), ['先回复时间问题', '再回复地址问题']);
  assert.equal(f.a.followUps.size, 0);
  await f.a.tick(); assert.equal(f.provider.calls.length, 1);
});

test('different group mentions and their unmentioned supplements stay grouped by sender across the wait', async t => {
  const f = await fixture(t, 'group');
  const first = f.push('@我 时间呢？', 'member-a', 'self'); await f.a.tick();
  f.advance(1000); const second = f.push('@所有人 地址呢？', 'member-b', 'all'); await f.a.tick();
  f.advance(1000); const supplement = f.push('我想确认具体几点', 'member-a'); await f.a.tick();
  f.advance(1000); const thanks = f.push('谢谢', 'member-b'); await f.a.tick();
  f.advance(1000); const excluded = f.push('@其他人 这句是问别人的', 'member-a', 'others'); await f.a.tick();
  assert.equal(f.provider.calls.length, 0);
  f.provider.next = async input => {
    assert.equal(input.conversation.latestIncomingId, excluded.id);
    assert.deepEqual(input.conversation.pendingIncomingIds, [first.id, second.id, supplement.id, thanks.id]);
    assert.deepEqual(input.groupState.triggerMessages.map(message => message.id), [first.id, second.id]);
    assert.deepEqual(input.conversation.pendingBySender, [
      { sender: key('member-a'), messageIds: [first.id, supplement.id] },
      { sender: key('member-b'), messageIds: [second.id, thanks.id] }
    ]);
    assert.equal(input.allowSegments, true); assert.equal(input.multiTurn, false);
    return { action: 'send', segments: ['关于时间的问题先回复这一条', '关于地址的问题单独回复这一条'], followUp: false };
  };
  f.advance(3000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1);
  assert.equal(f.bridge.sent.length, 2);
  assert.equal(f.a.profiles()[0].rounds, 2);
});

test('five reply segments are delivered in order and counted individually even with later dialogue disabled', async t => {
  const f = await fixture(t);
  const incoming = Array.from({ length: 5 }, (_, index) => f.push(`请回答事项${index + 1}`));
  await f.a.tick();
  const segments = Array.from({ length: 5 }, (_, index) => `事项${index + 1}的答复`);
  f.provider.next = async input => {
    assert.deepEqual(input.conversation.pendingIncomingIds, incoming.map(message => message.id));
    return { action: 'send', segments, followUp: true };
  };
  f.advance(20000); await f.a.tick();
  assert.deepEqual(f.bridge.sent.map(message => message.text), segments);
  assert.equal(f.delays.length, 4);
  const profile = f.a.profiles()[0];
  assert.equal(profile.rounds, 5);
  assert.equal(profile.delivery.segmentsTotal, 5);
  assert.equal(profile.delivery.segmentsSent, 5);
  assert.equal(f.a.followUps.size, 0);
});

test('a sixth segment is rejected before any message is sent and leaves the window pending', async t => {
  const f = await fixture(t);
  f.push('请回复这些内容'); await f.a.tick();
  f.provider.next = async () => ({ action: 'send', segments: Array.from({ length: 6 }, (_, index) => `事项${index + 1}`) });
  f.advance(20000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 0);
  assert.match(f.a.notice, /1–5 段/);
  assert.equal(f.a.cursors.get(f.a.profiles()[0].id).pending, true);
});

test('a full five-text round does not generate or append a sixth media message', async t => {
  const f = await fixture(t);
  f.bridge.supportsMediaOutput = true;
  await f.a.configure({ ...modelConfig, baseUrl: 'https://api.minimaxi.com/anthropic', protocol: 'anthropic' });
  await f.a.setReplyOptions({ contact: f.contact, enabled: true, multiTurn: false, sendImages: true });
  await f.a.tick();
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('A full round must not generate extra media'); });
  f.push('回复这五项'); await f.a.tick();
  f.provider.next = async () => ({ action: 'send', segments: Array.from({ length: 5 }, (_, i) => `答复${i + 1}`), media: [{ type: 'image', prompt: '测试图片' }] });
  f.advance(20000); await f.a.tick();
  assert.equal(fetches, 0);
  assert.equal(f.bridge.sent.length, 5);
});
