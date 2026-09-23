import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { groupRateState } from '../server/ai-group.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true;
  bridge.contacts[0].kind = 'group';
  let now = 1000000;
  const options = { dataRoot: root, bridge, provider, now: () => now, delay: async ms => { now += ms; } };
  const a = new AIAssistant(options); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const contact = bridge.contacts[0].id;
  await a.setGroupOptions({ contact, atMe: true, realtime: true, confirmRealtime: true });
  await a.settings({ enabled: true }); await a.tick();
  const profile = a.profiles().find(p => p.contact === contact);
  const push = (self = false) => Object.assign(bridge.push(contact, 'other'), { timestamp: Math.floor(now / 1000), sender: key('member'), mentions: { verified: true, self, all: false, others: false } });
  return { a, bridge, provider, profile, options, push, advance: ms => { now += ms; } };
}

test('group budget counts uncertain submissions and expires exactly at the rolling boundary', () => {
  const p = { sentMessages: Array.from({ length: 5 }, (_, i) => ({ at: 100000 + i, source: 'reply', confirmed: false })) };
  assert.equal(groupRateState(p, 699999).limited, true);
  assert.equal(groupRateState(p, 700000).limited, false);
  assert.equal(groupRateState(p, 700000).count, 4);
});

test('realtime coalesces new group messages for 60 seconds, then evaluates once', async t => {
  const { a, bridge, provider, profile, advance } = await fixture(t);
  await a.settings({ judgeReply: false });
  const msg = Object.assign(bridge.push(profile.contact, 'other', '群友讨论的问题'), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: false, others: false } });
  await a.tick();
  for (let i = 0; i < 2; i++) {
    advance(20000);
    Object.assign(bridge.push(profile.contact, 'other', `持续讨论 ${i}`), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: false, others: false } });
    await a.tick();
  }
  advance(19000); await a.tick();
  assert.equal(provider.calls.length, 0); assert.equal(bridge.sent.length, 0);
  advance(1000);
  Object.assign(bridge.push(profile.contact, 'other', '持续讨论到周期点'), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: false, others: false } });
  await a.tick();
  assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 1);
  assert.equal(provider.calls[0].input.judgeReply, true);
  await a.tick(); assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 1);
  assert.ok(msg.id);
});

test('realtime interval survives restart and @me interrupts the batch wait', async t => {
  const { a, bridge, provider, profile, options, advance } = await fixture(t);
  Object.assign(bridge.push(profile.contact, 'other', '实时消息'), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: false, others: false } });
  await a.tick(); advance(30000);
  Object.assign(bridge.push(profile.contact, 'other', '仍在持续讨论'), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: false, others: false } });
  await a.tick(); await a.close();
  const restarted = new AIAssistant(options); await restarted.init();
  try {
    await restarted.tick(); advance(29999); await restarted.tick();
    assert.equal(provider.calls.length, 0);
    advance(1); await restarted.tick();
    assert.equal(provider.calls.length, 1);
  } finally { await restarted.close(); }

  const second = new AIAssistant(options); await second.init();
  try {
    await second.settings({ enabled: true });
    Object.assign(bridge.push(profile.contact, 'other', '普通群消息'), { timestamp: Math.floor(second.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: false, others: false } });
    await second.tick(); advance(10000);
    Object.assign(bridge.push(profile.contact, 'other', '@我 请回答'), { timestamp: Math.floor(second.now() / 1000), sender: key('member'), mentions: { verified: true, self: true, all: false, others: false } });
    await second.tick(); advance(3000); await second.tick();
    assert.equal(provider.calls.length, 2);
  } finally { await second.close(); }
});

test('a disabled explicit mention is not reintroduced by realtime', async t => {
  const { a, bridge, provider, profile, advance } = await fixture(t);
  await a.setGroupOptions({ contact: profile.contact, atMe: false, realtime: true, confirmRealtime: true });
  Object.assign(bridge.push(profile.contact, 'other', '@我 只在关闭的开关下'), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); advance(60000); await a.tick();
  assert.equal(provider.calls.length, 0); assert.equal(bridge.sent.length, 0);
});

test('@all still asks the model when the rate limit is full and keeps a send pending', async t => {
  const { a, bridge, provider, profile, advance } = await fixture(t);
  profile.groupOptions = { atMe: true, atAll: true, realtime: false };
  profile.sentMessages = Array.from({ length: 5 }, (_, i) => ({ id: `recent-${i}`, at: a.now() - 1000 + i, source: 'reply' }));
  Object.assign(bridge.push(profile.contact, 'other', '@所有人 看一下'), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: true, others: false } });
  await a.tick(); advance(4000);
  provider.next = async () => ({ action: 'send', text: '我来确认一下' });
  await a.tick();
  assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 0);
  assert.equal(profile.groupWait.trigger, 'atAll'); assert.ok(profile.groupWait.dueAt > a.now());
});

test('expired model waits re-read and rejudge instead of consuming the pending message', async t => {
  const { a, bridge, provider, profile, advance } = await fixture(t);
  await a.setGroupOptions({ contact: profile.contact, atMe: false, atAll: true, realtime: false });
  Object.assign(bridge.push(profile.contact, 'other', '@所有人 请判断'), { timestamp: Math.floor(a.now() / 1000), sender: key('member'), mentions: { verified: true, self: false, all: true, others: false } });
  await a.tick(); advance(4000);
  provider.next = async () => ({ action: 'wait', waitSeconds: 1 });
  await a.tick();
  assert.equal(profile.groupWait.kind, 'model');
  advance(60000); provider.next = async () => ({ action: 'send', text: '我来确认这个问题' }); await a.tick();
  assert.equal(provider.calls.length, 2); assert.equal(bridge.sent.length, 1);
  assert.equal(a.data.events.some(e => e.code === 'skip'), false);
});

test('fifth group message exhausts the budget across segments, restart and explicit mentions', async t => {
  const { a, bridge, provider, profile, options, push, advance } = await fixture(t);
  profile.sentMessages = Array.from({ length: 4 }, (_, i) => ({ id: `old-${i}`, at: a.now() - 1000 + i, source: 'reply' }));
  profile.replyOptions = { multiTurn: true };
  push(true); await a.tick(); advance(4000);
  provider.next = async () => ({ action: 'send', segments: ['fifth', 'must not send sixth'] });
  await a.tick(); assert.deepEqual(bridge.sent.map(m => m.text), ['fifth']);
  const b = new AIAssistant(options); await b.init(); await b.scan(); await b.tick();
  try {
    push(true); await b.tick(); advance(4000); const before = provider.calls.length; await b.tick();
    assert.equal(provider.calls.length, before + 1); assert.equal(bridge.sent.length, 1);
    assert.equal(b.profiles().find(p => p.id === profile.id).groupWait.trigger, 'atMe');
    await b.close();
    const c = new AIAssistant(options); await c.init(); await c.scan();
    try {
      advance(600000); await c.tick(); advance(4000); await c.tick();
      assert.equal(bridge.sent.length, 2, 'pending verified @me is sent after the rolling limit expires');
      push(true); await c.tick(); advance(4000); await c.tick(); assert.equal(bridge.sent.length, 3);
    } finally { await c.close(); }
  } finally { await b.close(); }
});

test('group send is rechecked if budget changes while the model is running', async t => {
  const { a, bridge, provider, profile, push, advance } = await fixture(t);
  push(true); await a.tick(); advance(4000);
  provider.next = async () => {
    profile.sentMessages = Array.from({ length: 5 }, (_, i) => ({ id: `sent-${i}`, at: a.now(), source: 'reply' }));
    return { action: 'send', text: 'must not send' };
  };
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(a.cursors.get(profile.id).pending, true);
  assert.equal(profile.groupWait.trigger, 'atMe');
});
