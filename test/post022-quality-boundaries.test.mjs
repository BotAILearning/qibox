import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { neutralGeneratedReplyRepair, unsupportedChatTime, ownerConfirmationRepair } from '../server/ai-personal-answer.mjs';
import { AIModelFixture, ChatFixture, key, modelConfig, strategy } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const now = Date.parse('2026-10-22T20:00:00+08:00'), ts = now / 1000;
const memberA = key('member-a'), memberB = key('member-b');
const other = (text, extra = {}) => ({ direction: 'other', text, timestamp: ts - 60, sender: memberA, ...extra });
const human = text => ({ direction: 'self', authorship: 'human', text, timestamp: ts - 60 });

async function fixture(t, { kind = 'group', history = [] } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let clock = now;
  bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => clock, delay: async () => {}, random: min => min });
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  await a.configure(modelConfig); bridge.contacts[0].kind = kind; await a.scan();
  const contact = bridge.contacts[0].id;
  for (const row of history) Object.assign(bridge.push(contact, row.direction || 'other', row.text), row);
  if (kind === 'group') await a.setGroupOptions({ contact, atMe: true });
  else await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true }); await a.tick(); assert.equal(provider.calls.length, 0);
  return { a, bridge, provider, contact, advance: ms => { clock += ms; } };
}

async function replay(t, { history, raw = '明天上午十点集合。', expected, media }) {
  const f = await fixture(t, { history });
  f.provider.complete = async (_config, system, input) => {
    f.provider.calls.push({ system, input });
    assert.equal(f.provider.calls.length, 1, 'a final local boundary must not generate again');
    return { action: 'send', text: raw, followUp: false, ...(media ? { media } : {}) };
  };
  Object.assign(f.bridge.push(f.contact, 'other', '所以几点？'), {
    timestamp: ts, sender: memberA, mentions: { verified: true, self: true, all: false, others: false },
  });
  await f.a.tick(); f.advance(20000); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.deepEqual(f.bridge.sent.map(row => row.text), expected);
  assert.equal(f.provider.calls.length, 1);
  t.diagnostic(JSON.stringify({ fixedMockRequests: 1, fixtureSinkReplies: f.bridge.sent.length, actualModelRequests: 0, realWechatMessages: 0 }));
  return f;
}

for (const [id, history] of [
  ['old-day different event', [other('昨天十点开会。', { timestamp: ts - 86400 })]],
  ['another member', [other('明天十点集合。', { sender: memberB })]],
  ['future message timestamp', [other('明天十点集合。', { timestamp: ts + 60 })]],
]) test(`clock source rejects ${id} through production`, async t => { await replay(t, { history, expected: [] }); });

test('an unrelated event daypart cannot authorize the current event', async t => {
  await replay(t, { history: [other('明天十点集合。', { timestamp: ts - 300 }), other('今天下午五点吃饭。', { timestamp: ts - 240 })], expected: ['明天十点集合。'] });
});

for (const raw of ['好，明天上午十点集合。', '明天上午十点集合。收到。', '明天上午十点集合，带上材料。']) {
  test(`compound clock assertion is blocked without cleaning: ${raw}`, async t => {
    await replay(t, { history: [other('明天十点集合。')], raw, expected: [] });
  });
}

test('the exact supplied event daypart remains unchanged', async t => {
  await replay(t, { history: [other('明天上午十点集合。')], expected: ['明天上午十点集合。'] });
});

test('shared production generation preserves proactive and follow-up time semantics', async t => {
  for (const mode of ['proactive', 'followUp']) {
    const f = await fixture(t, { kind: 'person' }), profile = f.a.profiles().find(row => row.contact === f.contact);
    const raw = '明天上午十点集合。';
    if (mode === 'proactive') {
      await f.a.saveStrategy({ ...strategy, styleSource: 'manual', purpose: '通知已经确定的集合时间', content: raw, facts: raw }, profile.id);
      await f.a.targets([profile.id], 'proactive');
      await f.a.settings({ enabled: true, proactive: true });
      f.provider.complete = async (_config, system, input) => { f.provider.calls.push({ system, input }); assert.equal(f.provider.calls.length, 1); return { action: 'send', text: raw, followUp: false }; };
      const snapshot = await f.a.read(profile, f.a.controller.signal);
      await f.a.generate(profile, snapshot, 'proactive', f.a.revision, f.a.controller.signal);
      assert.equal(f.provider.calls.length, 1, mode);
      assert.deepEqual(f.bridge.sent.map(row => row.text), [raw], mode);
      assert.equal(f.provider.calls[0].input.mode, 'proactive');
      assert.equal(f.provider.calls[0].input.followUp, false);
    } else {
      await f.a.settings({ enabled: true, reply: true, followUpEnabled: true });
      await f.a.saveReplyProfile({ contact: f.contact, style: { summary: '自然简短' }, strategy: { ...strategy, facts: raw }, preserveSwitches: true,
        rhythm: { inherit: false, personal: {
          timing: { replyDelay: 20, replyMaxWait: 60, segmentDelayMin: 15, segmentDelayMax: 60, followUpDelayMin: 11, followUpDelayMax: 11 },
          takeover: { enabled: false, minutes: 9 }, segmentReplies: true, followUpEnabled: true,
        } } });
      const currentProfile = f.a.profiles().find(row => row.contact === f.contact);
      assert.equal(f.a.multiTurn(currentProfile, 'reply'), true, 'follow-up must be enabled through the saved rhythm');
      f.provider.complete = async (_config, system, input) => {
        f.provider.calls.push({ system, input });
        assert(f.provider.calls.length <= 2, 'only the opening and its scheduled follow-up may generate');
        return { action: 'send', text: input.followUp ? raw : '好的。', followUp: !input.followUp };
      };
      Object.assign(f.bridge.push(f.contact, 'other', '把已经确定的集合时间再说一下。'), { timestamp: ts });
      await f.a.tick(); f.advance(20000); await f.a.tick();
      assert.equal(f.provider.calls.length, 1, 'the opening generates exactly once');
      assert.deepEqual(f.bridge.sent.map(row => row.text), ['好的。']);
      assert.equal(f.a.followUps.size, 1, 'a completed opening must schedule the real follow-up');
      f.advance(10999); await f.a.tick(); assert.equal(f.provider.calls.length, 1, 'no early follow-up');
      f.advance(1); await f.a.tick();
      assert.equal(f.provider.calls.length, 2, 'one additional production follow-up generation');
      assert.deepEqual(f.bridge.sent.map(row => row.text), ['好的。', raw]);
      assert.equal(f.provider.calls[1].input.mode, 'reply');
      assert.equal(f.provider.calls[1].input.followUp, true);
      assert.equal(f.a.followUps.size, 0);
      f.advance(20000); await f.a.tick(); assert.equal(f.provider.calls.length, 2, 'no unexpected later regeneration');
    }
  }
});

test('fragment cleaning refuses quotes, substantive tails, existing owner sources and widened input shapes', () => {
  const food = { now, mode: 'reply', followUp: false, kind: 'person', messages: [], pendingMessages: [other('想找点吃的。')] };
  for (const raw of ['行呀，想吃什么？他说“我帮你看看附近有什么吃的”。', '行呀，想吃什么？如果我帮你看看附近有什么吃的。', '行呀，想吃什么？我帮你看看附近有什么吃的，顺便替你下单。', '你很有钱。行呀，想吃什么？我帮你看看附近有什么吃的。']) assert.equal(neutralGeneratedReplyRepair([raw], food), '', raw);
  const raw = '行呀，想吃什么？我帮你看看附近有什么吃的。';
  assert.equal(neutralGeneratedReplyRepair(['行呀，想吃什么？', '我帮你看看附近有什么吃的。'], food), '');
  assert.equal(neutralGeneratedReplyRepair([raw], { ...food, pendingMessages: [...food.pendingMessages, other('再说一遍。')] }), '');
  assert.equal(neutralGeneratedReplyRepair([raw], { ...food, mode: 'proactive' }), '');
  assert.equal(neutralGeneratedReplyRepair([raw], { ...food, followUp: true }), '');
  for (const mode of [{ mode: 'proactive' }, { mode: 'reply', followUp: true }]) {
    assert.equal(unsupportedChatTime(['明天上午十点集合。'], { ...food, ...mode }), '', 'only the newly added initial-reply precision rule is out of scope');
    assert.equal(unsupportedChatTime(['昨晚你说过。'], { ...food, ...mode }), 'time-fact', 'existing time protections still apply');
  }
  const refund = { ...food, messages: [human('这个确实是我没区分清楚。')], pendingMessages: [other('退款申请成功不等于到账。')] };
  assert.equal(neutralGeneratedReplyRepair(['退款申请成功不等于已经到账。这个确实是我没区分清楚，抱歉。'], refund), '');
  const employment = { pendingMessages: [other('你今天在哪家公司上班？')], facts: '我在甲公司任职。' };
  assert.equal(ownerConfirmationRepair(['这个得本人确认一下，我这边没有具体信息。'], employment), '');
  const unknown = { ...food, kind: 'group', pendingMessages: [other('是谁订的？')], messages: [other('餐厅是我订好的。')] };
  assert.equal(neutralGeneratedReplyRepair(['这个我得确认一下，暂时不确定是谁订的。'], unknown), '');
});

test('media-bearing initial replies cannot enter text fragment cleaning', async t => {
  const f = await replay(t, { history: [other('明天十点集合。')], media: [{ type: 'audio', text: '明天上午十点集合。' }], expected: [] });
  assert(f.a.data.events.some(row => row.reasonCode === 'unverified-time-fact'), 'the unsupported time must remain visible to the final guard, not be silently cleaned');
});

test('exact literal current facts add no clock precision and do not override a conflicting message', () => {
  const raw = '明天上午十点集合。', context = { now, mode: 'reply', followUp: false, kind: 'person', messages: [], pendingMessages: [other('时间说一下。')], facts: raw };
  assert.equal(unsupportedChatTime([raw], context), '');
  assert.equal(neutralGeneratedReplyRepair([raw], context), '');
  assert.equal(unsupportedChatTime([raw], { ...context, facts: '今天下午五点吃饭。' }), 'time-fact');
  assert.equal(unsupportedChatTime([raw], { ...context, messages: [other('明天九点集合。')] }), 'time-fact');
  assert.equal(unsupportedChatTime([raw], { ...context, facts: '明天十点集合。' }), 'time-fact');
  assert.equal(neutralGeneratedReplyRepair([raw], { ...context, facts: '明天十点集合。' }), '');
  assert.equal(unsupportedChatTime([raw], { ...context, messages: [other('明天十点集合。')] }), '', 'matching message without a daypart does not contradict the exact supplied fact');
  assert.equal(unsupportedChatTime([raw], { ...context, messages: [other('明天晚上十点集合。')] }), 'time-fact');
  assert.equal(unsupportedChatTime([raw], { ...context, facts: '明天上午十点集合。\n明天晚上十点集合。' }), 'time-fact');
  assert.equal(unsupportedChatTime(['如果明天上午十点集合呢？明天上午十点集合。'], { ...context, facts: '' }), 'time-fact', 'an earlier conditional question cannot authorize the next independent assertion');
});
