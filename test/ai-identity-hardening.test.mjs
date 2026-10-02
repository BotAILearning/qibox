import test from 'node:test';
import assert from 'node:assert/strict';
import { asksIdentity } from '../server/ai-reply-rules.mjs';
import { disclosesAIIdentity, replySafetyViolation } from '../server/ai-reply-safety.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const incoming = '@Bot 机器人🤖你健身吗';
const bad = '机器人不用健身，保持出厂设置就好哈哈';

test('a robot address is an identity cue; robotics topics and self history are not', () => {
  for (const text of [incoming, 'AI，你吃饭吗？', '机器人，你会累吗', 'bot, 你睡觉吗', '机\u2060器人🤖你健身吗'])
    assert.equal(asksIdentity([{ direction: 'other', text }]), true, text);
  for (const text of ['机器人产业发展很快', 'AI芯片的性能怎么样', '这台机器人的设计方案怎么写'])
    assert.equal(asksIdentity([{ direction: 'other', text }]), false, text);
  assert.equal(asksIdentity([{ direction: 'self', text: incoming }]), false);
});

test('machine-persona jokes, spacing and speech cannot bypass identity protection', () => {
  for (const text of [bad, '机器人不需要健身', '我靠充电就行', '我是机 器 人', '我 是 Ａ Ｉ', '我是机\u2060器人'])
    assert.equal(disclosesAIIdentity(text), true, text);
  for (const text of ['保持出厂设置就好哈哈', '没有身体怎么健身', '靠充电就够了', 'AI只会接话'])
    assert.equal(replySafetyViolation([text], { identityAsked: true }), 'identity', text);
  assert.equal(replySafetyViolation(['机器', '人不用健身，保持出厂设置就好哈哈']), 'identity');
  assert.equal(replySafetyViolation(['收到'], { identityAsked: true, audioText: bad }), 'identity');
  for (const text of ['机器人可以用于工厂搬运', '我是做机器人研发的', '手机恢复出厂设置之前要备份', '他说机器人不用健身', '例如机器人不用健身'])
    assert.equal(replySafetyViolation([text], { identityAsked: true }), '', text);
});

test('disclosing this account previous AI replies is blocked without banning AI topics or attributed quotations', () => {
  const rejected = ['之前那条是AI回复时发的，不是我本人的说法', '昨天那条是AI代发的', '前面的回复是由AI生成的',
    '我之前让AI代回那条消息', '刚才那条不是我本人写的', '之前那条不是我本人的说法', '之前那条是Ａ Ｉ回复的', '之前那条是AI'];
  for (const text of rejected) {
    assert.equal(disclosesAIIdentity(text), true, text);
    assert.equal(replySafetyViolation([text], { identityAsked: false }), 'identity', text);
    assert.equal(replySafetyViolation([text], { allowIdentity: true, identityAsked: true }), '', text);
  }
  assert.equal(replySafetyViolation(['之前那条是A', 'I回复时发的']), 'identity');
  assert.equal(replySafetyViolation(['收到'], { audioText: rejected[0] }), 'identity');
  for (const text of ['AI回复的质量差别很大', '那条是在讨论AI回复质量', '我的回复是在讨论AI话题',
    '你之前那条是AI代发的吗？', '他的这条回复是AI写的', '小周的回复是AI生成的',
    '他说“之前那条是AI回复的”', '原话是“那条不是我本人的说法”', '如果那条是AI代发的，也要核对内容'])
    assert.equal(replySafetyViolation([text]), '', text);
});

async function fixture(t, kind = 'group') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-10-02T12:00:00+08:00');
  bridge.stableMessageIds = true; bridge.contacts[0].kind = kind;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id;
  if (kind === 'group') await a.setGroupOptions({ contact, atMe: true });
  else await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true, acknowledgeAI: false }); await a.tick();
  const p = a.profiles().find(p => p.contact === contact);
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, bridge, provider, p, async receive(text = incoming) {
    Object.assign(bridge.push(contact, 'other', text), { timestamp: now / 1000,
      ...(kind === 'group' ? { sender: key('member'), mentions: { verified: true, self: true, all: false, others: false } } : {}) });
    await a.tick(); now += 20000; await a.tick();
  } };
}

for (const kind of ['group', 'person']) test(`${kind}: the real robot-joke regression is corrected once and persistent admissions stay unsent`, async t => {
  const f = await fixture(t, kind);
  let calls = 0;
  f.provider.complete = async (_config, system, input) => {
    calls++; assert.equal(input.identityPolicy.asked, true); assert.equal(input.identityPolicy.allowDisclosure, false);
    return { action: 'send', text: calls === 1 ? bad : '哪里听着不自然？' };
  };
  await f.receive();
  assert.equal(calls, 2); assert.deepEqual(f.bridge.sent.map(s => s.text), ['哪里听着不自然？']);
  f.provider.complete = async () => ({ action: 'send', text: bad });
  await f.receive();
  assert.equal(f.bridge.sent.length, 1);
  assert.ok(f.a.publicState().skipRecords.some(r => r.reasonCode === 'identity-rule-block'));
  assert.equal(f.p.paused, false);
});

test('the native delivery boundary rejects split identity and speech before the first segment', async t => {
  const f = await fixture(t, 'person'), snapshot = await f.bridge.read({ contact: f.p.contact });
  for (const segments of [['机器', '人不用健身'], ['收到', { mediaType: 'audio', description: bad }]])
    await assert.rejects(f.a.deliver(f.p, snapshot, 'reply', f.a.revision, f.a.controller.signal, null, segments, f.a.strategy(f.p, 'reply')), { code: 'ai_identity_blocked' });
  assert.equal(f.bridge.sent.length, 0);
  assert.notEqual(f.p.delivery?.status, 'sending');
});

test('delivery rechecks disclosure permission and does not borrow an earlier identity question', async t => {
  const f = await fixture(t, 'person'), snapshot = await f.bridge.read({ contact: f.p.contact });
  await f.a.settings({ acknowledgeAI: true });
  await assert.rejects(f.a.deliver(f.p, snapshot, 'reply', f.a.revision, f.a.controller.signal, null, ['我是AI'], f.a.strategy(f.p, 'reply')), { code: 'ai_identity_blocked' });
  await f.a.settings({ acknowledgeAI: false });
  await assert.rejects(f.a.deliver(f.p, snapshot, 'reply', f.a.revision, f.a.controller.signal, null, ['我是AI'], f.a.strategy(f.p, 'reply'), 'reply', false, null, true), { code: 'ai_identity_blocked' });
  assert.equal(f.bridge.sent.length, 0);
});
