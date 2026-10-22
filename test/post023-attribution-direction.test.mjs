import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { explicitTurnRepair, unsupportedPersonalAnswer } from '../server/ai-personal-answer.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const now = Date.parse('2026-10-22T20:00:00+08:00');
const incoming = '我不是阿海，别把另一个人的安排套到我这里。';
const raw = '明白，安排是你的，不套到阿海身上。';
const reverseDenial = '明白，你的安排不归到阿海那里。';
const context = text => ({ now, kind: 'person', messages: [], pendingMessages: [{ direction: 'other', text, timestamp: now / 1000 }] });

for (const [number, answer] of [[258,raw],[286,reverseDenial]]) test(`actual #${number} cannot reverse an explicit other-person arrangement correction`, async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let clock = now;
  bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => clock, delay: async () => {}, random: min => min });
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  await a.configure(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id;
  await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true }); await a.tick();
  assert.equal(provider.calls.length, 0);
  provider.next = async () => ({ action: 'send', text: answer, followUp: false });
  Object.assign(bridge.push(contact, 'other', incoming), { timestamp: now / 1000 });
  await a.tick(); clock += 20000; await a.tick(); clock += 20000; await a.tick();
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(bridge.sent.map(x => x.text), ['明白，不把另一个人的安排归到你这里。']);
  clock += 20000; await a.tick();
  assert.equal(provider.calls.length, 1);
});

test('only a complete literal reversal can receive the finite attribution repair', () => {
  assert.equal(unsupportedPersonalAnswer([raw], context(incoming)), 'recipient-fact');
  assert.equal(explicitTurnRepair([raw], context(incoming)), '明白，不把另一个人的安排归到你这里。');
  assert.equal(unsupportedPersonalAnswer([reverseDenial], context(incoming)), 'recipient-fact');
  assert.equal(explicitTurnRepair([reverseDenial], context(incoming)), '明白，不把另一个人的安排归到你这里。');
  for (const text of [
    '明白，安排是你的。明天我帮你订票。',
    '你很有钱，安排是你的，不套到阿海身上。',
    '如果安排是你的，就告诉我。',
    '“安排是你的”是引用，不是结论。',
    '安排是你的吗？',
  ]) assert.equal(explicitTurnRepair([text], context(incoming)), '', text);
  assert.equal(explicitTurnRepair([raw, '另外补充一件事。'], context(incoming)), '');
  for (const text of [
    '明白，不把阿海的安排套到你这里。',
    '明白，另一个人的安排不归到你这里。',
    '你说“安排是你的”，对吗？',
    '如果安排是你的，就告诉我。',
  ]) assert.equal(unsupportedPersonalAnswer([text], context(incoming)), '', text);
  for (const message of [
    '我不是阿海，别把另一个人的安排套到我这里？',
    '我说“我不是阿海，别把另一个人的安排套到我这里。”',
    '如果我不是阿海，别把另一个人的安排套到我这里。',
    '我不是阿海，别把另一个人的安排套到我这里。我的安排是明天。',
  ]) assert.equal(explicitTurnRepair([raw], context(message)), '', message);
  assert.equal(explicitTurnRepair([raw], { ...context(incoming), pendingMessages: [...context(incoming).pendingMessages, { direction: 'other', text: '不过我们另有安排。' }] }), '');
});

test('a later independent question cannot excuse an earlier reversed ownership assertion',()=>{
  for(const text of ['明白，安排是你的，你下午有空吗？','安排归你，你要吃什么？','安排是你的。你下午有空吗？'])
    assert.equal(unsupportedPersonalAnswer([text],context(incoming)),'recipient-fact',text);
  for(const text of ['安排是你的吗？','安排是你的？','安排是你的，对吗？','安排是你的，是这样吗？','如果安排是你的，你就决定吧。','他问，安排是你的，你下午有空吗？'])
    assert.equal(unsupportedPersonalAnswer([text],context(incoming)),'',text);
  for(const text of ['他说过，安排是你的。','她表示过，安排是你的。','明白，他刚才说过，安排是你的。'])
    assert.equal(unsupportedPersonalAnswer([text],context(incoming)),'',text);
});
