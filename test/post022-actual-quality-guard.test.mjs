import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, key, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const now = Date.parse('2026-10-22T20:00:00+08:00');
const ts = Math.floor(now / 1000);
const send = text => ({ action: 'send', text, followUp: false });

class FixedRawProvider extends AIModelFixture {
  constructor(raw) { super(); this.raw = raw; }
  async complete(_config, system, input) {
    this.calls.push({ system, input });
    assert.equal(this.calls.length, 1, 'a fixed raw replay must never fall back to another generation');
    assert.equal(input.mode, 'reply');
    return send(this.raw);
  }
}

const scenarios = [
  {
    id: 'Q13 #191 neutral owner confirmation',
    incoming: '你今天在哪家公司上班？',
    raw: '这个得本人确认一下，我这边没有具体信息。',
    expected: '这个得本人确认一下',
  },
  {
    id: 'Q34 #213 changed topic removes unsupported nearby search',
    incoming: '昨天下雨那事已经过去了，现在只想找点吃的。',
    raw: '行呀，想吃什么？我帮你看看附近有什么吃的。',
    expected: '行呀，想吃什么？',
  },
  {
    id: 'Q39 #219 refund distinction keeps sourced sentence only',
    incoming: '东西已经退了，钱还没到账，客服说需要三天。我不急，只是怕你把“退款到账”和“申请成功”当成一回事。',
    raw: '你说得对，退款申请成功不等于已经到账。这个确实是我没区分清楚，抱歉。',
    expected: '你说得对，退款申请成功不等于已经到账。',
  },
  {
    id: 'GQ02 known atMe member asks about authorless system history',
    kind: 'group',
    history: [{ direction: 'system', text: '我已经订好餐厅了。', timestamp: ts - 300 }],
    incoming: '是谁订的？',
    raw: '这个我得确认一下，暂时不确定是谁订的。',
    expected: '暂时不确定是谁订的。',
  },
  {
    id: 'GQ04 same member correction removes unsupported daypart',
    kind: 'group',
    history: [
      { direction: 'other', text: '明天九点集合。', timestamp: ts - 300, sender: key('member-a') },
      { direction: 'other', text: '更正，刚才九点那条作废，改成十点。', timestamp: ts - 240, sender: key('member-a') },
    ],
    incoming: '所以几点？',
    raw: '明天上午十点集合。',
    expected: '明天十点集合。',
  },
];

for (const scenario of scenarios) test(`post022 actual raw replay: ${scenario.id}`, async t => {
  const dataRoot = await temp();
  const bridge = new ChatFixture();
  const provider = new FixedRawProvider(scenario.raw);
  let clock = now;
  bridge.stableMessageIds = true;
  const assistant = new AIAssistant({ dataRoot, bridge, provider, now: () => clock, delay: async () => {}, random: minimum => minimum });
  await assistant.init();
  clearInterval(assistant.timer); clearInterval(assistant.warmupTimer);
  t.after(async () => { await assistant.close(); await cleanup(dataRoot); });
  await assistant.configure(modelConfig);
  const contact = bridge.contacts[0];
  if (scenario.kind === 'group') contact.kind = 'group';
  await assistant.scan();
  for (const message of scenario.history || []) Object.assign(bridge.push(contact.id, message.direction, message.text), message);
  if (scenario.kind === 'group') await assistant.setGroupOptions({ contact: contact.id, atMe: true });
  else await assistant.setReplyOptions({ contact: contact.id, enabled: true, judgeReply: false });
  await assistant.settings({ enabled: true });
  await assistant.tick();
  assert.equal(provider.calls.length, 0, 'history/setup must not generate');

  const incoming = bridge.push(contact.id, 'other', scenario.incoming);
  Object.assign(incoming, { timestamp: ts, ...(scenario.kind === 'group' ? { sender: key('member-a'), mentions: { verified: true, self: true, all: false, others: false } } : {}) });
  await assistant.tick();
  clock += 20000;
  await assistant.tick();
  clock += 20000;
  await assistant.tick();

  assert.deepEqual(
    { providerCalls: provider.calls.length, sinkReplies: bridge.sent.length, sinkTexts: bridge.sent.map(item => item.text) },
    { providerCalls: 1, sinkReplies: 1, sinkTexts: [scenario.expected] },
    'one fixed raw generation must produce one exact repaired sink reply and no next-tick regeneration',
  );
  t.diagnostic(JSON.stringify({ fixedFakeProviderCalls: provider.calls.length, fixtureSinkReplies: bridge.sent.length, actualModelCalls: 0, realWechatSends: 0 }));
});
