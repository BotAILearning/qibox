import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { unsupportedPersonalAnswer, explicitTurnRepair } from '../server/ai-personal-answer.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const now = Date.parse('2026-10-22T12:00:00+08:00');
const human = (text, extra = {}) => ({ direction: 'self', authorship: 'human', text, timestamp: Math.floor(now / 1000) - 60, ...extra });
const correction = '你记错了，胃疼的是我，不是你。';
const turn = (incoming = correction, self = human('那今天好点没？')) => ({ now, pendingMessages: [{ direction: 'other', text: incoming }], messages: [self] });

test('explicit past colloquial claims require the same human source; bare current acknowledgement is not presumed historical', () => {
  for (const text of ['我刚才就说照片怎么今天才发。', '我之前还纳闷照片怎么今天才发。', '我当时也琢磨过这件事。']) {
    assert.equal(unsupportedPersonalAnswer([text], { now }), 'personal-fact', text);
    assert.equal(unsupportedPersonalAnswer([text], { now, messages: [human(text)] }), '', text);
    for (const source of [human(text, { aiGenerated: true }), human(text, { authorship: 'unknown' }), human('我今天喝茶。'), human(text, { timestamp: Math.floor(now / 1000) + 60 })])
      assert.equal(unsupportedPersonalAnswer([text], { now, messages: [source] }), 'personal-fact');
  }
  for (const text of ['哈哈，我就说照片怎么今天才突然冒出来。', '我就说一句，整理照片挺费时间。', '我觉得照片挺好看。', '他说“我刚才就说照片怎么今天才发”。', '小王说，我之前还纳闷照片怎么今天才发。', '如果我之前还纳闷照片怎么今天才发，那只是个假设。', '不是说我刚才就说过这件事。', '我刚才就说照片怎么今天才发了吗？'])
    assert.equal(unsupportedPersonalAnswer([text], { now }), '', text);
});

test('a complete actor-only correction removes only an equivalent last human question and preserves its generated acknowledgement', () => {
  assert.equal(explicitTurnRepair(['对对，是你说昨天胃疼。今天好点没？'], turn()), '对对，是你说昨天胃疼。');
  assert.equal(explicitTurnRepair(['对，是你胃疼。那今天好点没?'], turn()), '对，是你胃疼。');
  assert.equal(explicitTurnRepair(['明白，是你胃疼。今天好', '点没？'], turn()), '明白，是你胃疼。');
});

test('correction deduplication never deletes negation, quotes, compound questions, new information or a different last human turn', () => {
  const reply = ['对，是你胃疼。今天好点没？'];
  for (const incoming of ['不是说胃疼的是我，不是你。', '胃疼的不是我，是你。', '他说“胃疼的是我，不是你”。', '他说胃疼的是我，不是你。', '如果胃疼的是我，不是你呢？', '你记错了，胃疼的是我，不是你。今天更疼了。', '胃疼的是我，不是你，你明白吗？'])
    assert.equal(explicitTurnRepair(reply, turn(incoming)), '', incoming);
  for (const texts of [['对，是你胃疼。今天好点没，还是更疼了？'], ['对，是你胃疼。他问“今天好点没？”'], ['对，是你胃疼。不是问今天好点没？'], ['今天好点没？'], ['。今天好点没？']])
    assert.equal(explicitTurnRepair(texts, turn()), '', texts.join(''));
  for (const self of [human('吃过药了吗？'), human('那今天好点没？', { aiGenerated: true }), human('那今天好点没？', { authorship: 'unknown' }), human('那今天好点没？', { timestamp: Math.floor(now / 1000) + 60 }), human('今天好点没，还是更疼了？')])
    assert.equal(explicitTurnRepair(reply, turn(correction, self)), '');
  assert.equal(explicitTurnRepair(reply, { ...turn(), pendingMessages: [...turn().pendingMessages, { direction: 'other', text: '我还要问别的事。' }] }), '');
});

test('unknown personal questions permit a neutral owner confirmation without releasing invented facts, reasons or callbacks', () => {
  for (const question of ['你今天在哪家公司上班？', '你现在具体在哪个地方？']) {
    const context = { now, pendingMessages: [{ direction: 'other', text: question }] };
    for (const text of ['这个得本人确认一下。', '需要本人确认。', '具体位置需要本人确认。', '具体工作情况得本人确认。'])
      assert.equal(unsupportedPersonalAnswer([text], context), '', text);
    for (const text of ['这个得本人确认一下。我在家呢。', '这个得本人确认一下。我没有在哪家公司上班。', '这个得本人确认一下。稍后告诉你。', '这个得本人确认一下。我不方便说。'])
      assert.ok(unsupportedPersonalAnswer([text], context), text);
  }
});

test('original006 blocked corrections and unknown personal answers remain blocked without rewriting them', () => {
  for (const [incoming, raw] of [
    ['我不是阿海，别把另一个人的安排套到我这里。', '明白，你是，不是阿海。之前是我认错了。'],
    ['我只说喜欢茶，没说我每天都喝咖啡。', '对，是我理解错了。喜欢茶也不等于每天都喝咖啡。'],
    ['东西已经退了，钱还没到账，客服说需要三天。', '你说得对，这两件事不是一回事。刚才是我表达得不严谨，抱歉。'],
    ['你今天在哪家公司上班？', '我今天还在哪上班，得先确认一下。'],
    ['你现在具体在哪个地方？', '我这边还没确认具体在哪，等我确认一下。'],
  ]) assert.ok(unsupportedPersonalAnswer([raw], { now, pendingMessages: [{ direction: 'other', text: incoming }] }), incoming);
});

for (const scenario of [
  { name: 'actor-only correction', incoming: correction, history: [human('那今天好点没？')], candidate: '对对，是你说昨天胃疼。今天好点没？', expected: ['对对，是你说昨天胃疼。'] },
  { name: 'unknown employer confirmation', incoming: '你今天在哪家公司上班？', candidate: '这个得本人确认一下。', expected: ['这个得本人确认一下。'] },
  { name: 'unknown location confirmation', incoming: '你现在具体在哪个地方？', candidate: '具体位置需要本人确认。', expected: ['具体位置需要本人确认。'] },
  { name: 'unsupported explicit past thought', incoming: '我去年旅行拍的照片今天才整理。', candidate: '我刚才就说照片怎么今天才发。', expected: [] },
]) test(`single-request production pipeline: ${scenario.name}`, async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let clock = now;
  bridge.stableMessageIds = true; const contact = bridge.contacts[0].id;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => clock, delay: async () => {}, random: min => min });
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer); await a.configure(modelConfig); await a.scan();
  for (const message of scenario.history || []) Object.assign(bridge.push(contact, 'self', message.text), message);
  await a.setReplyOptions({ contact, enabled: true, judgeReply: false }); await a.settings({ enabled: true }); await a.tick();
  provider.next = async () => ({ action: 'send', text: scenario.candidate, followUp: false });
  Object.assign(bridge.push(contact, 'other', scenario.incoming), { timestamp: Math.floor(clock / 1000) });
  await a.tick(); clock += 20000; await a.tick();
  assert.equal(provider.calls.length, 1, 'Local final checks must not generate another model request');
  assert.deepEqual(bridge.sent.map(row => row.text), scenario.expected);
  if (!scenario.expected.length) assert.ok(a.data.events.some(row => row.code === 'skip'));
  t.diagnostic(JSON.stringify({ mockProviderCalls: provider.calls.length, fixtureSends: bridge.sent.length, realProviderCalls: 0, realWechatSends: 0 }));
});
