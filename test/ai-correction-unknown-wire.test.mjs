import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

// This verifies production wiring and unchanged guards with a mock provider.
// Actual model wording and naturalness require separate human-reviewed runs.
const correction = '你记错了，胃疼的是我，不是你。';
for (const scenario of [
  { name: 'correction acknowledges the supplied fact', incoming: correction, history: ['那今天好点没？'], text: '哦，是你胃疼。', sent: true },
  { name: 'unverified personal location uncertainty remains blocked', incoming: '你现在具体在哪个地方？', text: '具体位置我这边暂时没法准确确认，不能瞎报一个给你。', sent: false },
  { name: 'unknown location can clarify intent without inventing a fact', incoming: '你现在具体在哪个地方？', text: '你找我有什么事？', sent: true },
  { name: 'an explicit current human location remains usable', incoming: '你现在具体在哪个地方？', history: ['我现在在家。'], text: '我现在在家。', sent: true },
  { name: 'intent question does not license a new unsupported location', incoming: '你现在具体在哪个地方？', text: '你找我有什么事？我现在在公司。', sent: false },
  { name: 'correction does not license an unsupported admission', incoming: correction, history: ['那今天好点没？'], text: '哦，是你胃疼，我记岔了。', sent: false },
]) test(scenario.name, async t => {
  const root = await temp(), bridge = new ChatFixture(), wires = [];
  let clock = Date.parse('2026-10-24T10:00:00+08:00');
  bridge.stableMessageIds = true;
  const contact = bridge.contacts[0].id;
  bridge.messages.set(contact, (scenario.history || []).map((text, i) => ({ id: key(scenario.name + i), direction: 'self', authorship: 'human', text, timestamp: clock / 1000 - 60 + i })));
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    wires.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'send', text: scenario.text, followUp: false }) }, finish_reason: 'stop' }] });
  } });
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => clock, delay: async () => {}, random: min => min });
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  await a.configure(modelConfig); await a.scan();
  await a.saveReplyProfile({ contact, style: { summary: '自然简短，保留本人明确要求。' }, strategy: {}, options: { judgeReply: false }, replyEnabled: true });
  await a.settings({ enabled: true, autoLearning: false, segmentReplies: false, followUpEnabled: false }); await a.tick();
  Object.assign(bridge.push(contact, 'other', scenario.incoming), { timestamp: clock / 1000 });
  await a.tick(); clock += 61000; await a.tick();
  assert.equal(wires.length, 1, 'One existing generation request; no independent review or added retry');
  const system = wires[0].messages.find(m => m.role === 'system').content;
  assert.match(system, /用一句自然询问来意的接话/);
  assert.doesNotMatch(system, /可简短表示需本人确认/);
  assert.match(system, /更正时接住新确认的事实，不复述上轮问法为自己辩解/);
  assert.equal(bridge.sent.length, scenario.sent ? 1 : 0);
  if (scenario.sent) assert.equal(bridge.sent[0].text, scenario.text, 'No mechanical rewrite');
  else assert(a.data.events.some(e => e.reasonCode === 'unverified-personal-fact'));
});
