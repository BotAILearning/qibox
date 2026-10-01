import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { naturalChatPrompt, reflectiveReplyPrompt } from '../server/ai-prompts.mjs';
import { identityPrompt } from '../server/ai-reply-rules.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-10-01T12:00:00+08:00');
  bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  return { a, bridge, provider, advance: () => { now += 20000; }, now: () => now };
}

// Inspect the request reaching the model boundary, so an unused exported
// prompt cannot satisfy these checks. The provider and sends stay in memory;
// these tests verify wiring and contracts, not a real model's naturalness.
function assertChatRules(call) {
  for (const prompt of [naturalChatPrompt, reflectiveReplyPrompt]) {
    assert.equal(call.system.split(prompt).length - 1, 1);
  }
  assert.match(call.system, /事实边界（最高优先级/);
  assert.match(call.system, /只返回 JSON 本身/);
}

test('automatic replies pass natural-chat rules to the model while retaining the saved voice and reply contract', async t => {
  const { a, bridge, provider, advance, now } = await fixture(t);
  const contact = bridge.contacts[0].id;
  const summary = '工作沟通使用正式礼貌的语气，完整句子和句号，不用表情或网络梗。';
  await a.saveReplyProfile({ contact, style: { summary }, strategy: {} });
  await a.settings({ enabled: true, reply: true, acknowledgeAI: true }); await a.tick();
  Object.assign(bridge.push(contact, 'other', '今天又临时加会，活都干不完'), { timestamp: Math.floor(now() / 1000) });
  await a.tick(); advance();
  provider.next = async () => ({ action: 'send', text: '临时加会，手上的活更赶了。', followUp: false });
  await a.tick();
  assert.equal(provider.calls.length, 1);
  const call = provider.calls[0];
  assertChatRules(call);
  assert.equal(call.input.mode, 'reply');
  assert.equal(call.input.style.summary, summary);
  assert.equal(call.input.multiTurn, false);
  assert.equal(call.input.allowSegments, true);
  assert.match(call.system, /segments 为 1–5 段/);
  assert.match(call.system, /followUp 必须为 false/);
  assert.ok(call.system.includes(identityPrompt(false)));
  assert.equal(bridge.sent.at(-1).text, '临时加会，手上的活更赶了。');
});

test('independent proactive requests receive the same rules with their task, saved voice and no-follow-up contract', async t => {
  const { a, bridge, provider } = await fixture(t);
  const contact = bridge.contacts[0].id;
  const summary = '熟人之间说话简短，偶尔幽默，不添加称呼。';
  await a.saveReplyProfile({ contact, style: { summary }, strategy: {} });
  const profile = a.profiles().find(item => item.contact === contact);
  const task = { goal: '询问对方是否有兴趣一起看展', requirements: '只询问兴趣，不擅自约定时间或替对方决定。' };
  provider.next = async () => ({ action: 'send', text: '有兴趣一起看个展吗？', followUp: false });
  const result = await a.generateProactiveMessage(task, profile, { messages: [] }, new AbortController().signal);
  assert.equal(provider.calls.length, 1);
  const call = provider.calls[0];
  assertChatRules(call);
  assert.equal(call.input.mode, 'proactive');
  assert.equal(call.input.style.summary, summary);
  assert.equal(call.input.strategy.purpose, task.goal);
  assert.equal(call.input.strategy.boundaries, task.requirements);
  assert.equal(call.input.followUpAllowed, false);
  assert.match(call.system, /followUp 必须为 false，不安排延迟续聊/);
  assert.deepEqual(result, { action: 'send', text: '有兴趣一起看个展吗？', followUp: false });
  assert.equal(bridge.sent.length, 0);
});

test('style learning retains its own JSON contract without chat-generation rules', async t => {
  const { a, bridge, provider } = await fixture(t);
  await a.learn({ contacts: [bridge.contacts[0].id] });
  assert.equal(provider.calls.length, 1);
  const call = provider.calls[0];
  assert.equal(call.system.includes(naturalChatPrompt), false);
  assert.equal(call.system.includes(reflectiveReplyPrompt), false);
  assert.match(call.system, /style 必须包含且只包含 language、rhythm、interaction、emotion、role 五个非空字符串/);
  assert.equal(bridge.sent.length, 0);
});
