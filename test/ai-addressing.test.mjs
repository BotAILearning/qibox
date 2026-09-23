import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, strategy, learnedStyle } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
import { stripUnauthorizedProactiveVocatives } from '../server/ai-reply-rules.mjs';

test('proactive output strips a pet name found only in old AI text, but keeps authorized or repeatedly human-used names', () => {
  const aiOnlyProfile = { generatedIds: ['old-ai'] };
  const aiOnlyHistory = { messages: [
    { id: 'old-ai', direction: 'self', text: '晚安宝', aiGenerated: true },
    { id: 'recent', direction: 'other', text: '明天见' }
  ] };
  assert.equal(stripUnauthorizedProactiveVocatives('想你了宝', aiOnlyProfile, aiOnlyHistory), '想你了');
  assert.equal(stripUnauthorizedProactiveVocatives('宝，我想你', aiOnlyProfile, aiOnlyHistory), '我想你');

  const explicit = { replyStyleSource: 'manual', style: { summary: '称呼对方为【宝】，说话自然。' } };
  assert.equal(stripUnauthorizedProactiveVocatives('想你了宝', explicit, { messages: [] }), '想你了宝');
  const humanEvidence = { messages: [
    { id: 'human-1', direction: 'self', text: '宝，吃饭了吗？' },
    { id: 'human-2', direction: 'self', text: '想你了宝。' },
    { id: 'model', direction: 'self', text: '晚安宝', aiGenerated: true }
  ] };
  assert.equal(stripUnauthorizedProactiveVocatives('想你了宝', { generatedIds: ['model'] }, humanEvidence), '想你了宝');
});

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  return { a, bridge, provider, advance: () => { now += 8000; } };
}

for (const source of ['learned', 'paste']) test(`${source} reference stays distinct from recipient style for opening and continuation`, async t => {
  const { a, bridge, provider } = await fixture(t);
  const contact = bridge.contacts[0].id;
  await a.prepareTargets({ contacts: [contact] });
  const target = a.profiles()[0];
  await a.editProfile(target.id, { style: { summary: '直接说正文，不加称呼。' } });
  provider.next = async () => ({ style: learnedStyle('称呼对方为【宝】，温柔简短。') });
  if (source === 'learned') await a.learn({ contacts: [bridge.contacts[1].id] });
  else await a.learn({ text: '我：宝，吃饭了吗？', label: '参考样本' });
  const reference = a.profiles().find(p => p.learnedAt);
  await a.saveStrategy({ ...strategy, styleSource: source, styleProfileId: reference.id });
  await a.settings({ proactive: true, reply: false, enabled: true });
  await a.queueAction('start'); await a.tick();
  const opening = provider.calls.at(-1);
  assert.equal(bridge.sent.length, 1);
  assert.deepEqual(opening.input.style, reference.style);
  assert.deepEqual(opening.input.addressing, { styleScope: 'reference', currentStyle: target.style });
  assert.match(opening.system, /这不是当前对象的专属风格/);
  assert.doesNotMatch(opening.system, /本轮用户为当前联系人设置的风格如下/);
  bridge.push(contact, 'other', '活动具体是什么？');
  await a.generate(target, await a.read(target, a.controller.signal), 'reply', a.revision, a.controller.signal);
  const continuation = provider.calls.at(-1);
  assert.equal(continuation.input.continuation, true);
  assert.equal(continuation.input.addressing.styleScope, 'reference');
  assert.deepEqual(continuation.input.addressing.currentStyle, target.style);
});

test('explicit current-contact salutation remains available while other-party and AI messages are not evidence', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const contact = bridge.contacts[0].id;
  await a.saveReplyProfile({ contact, style: { summary: '称呼对方为【小林】，不要每句都叫。' }, strategy: {} });
  const profile = a.profiles().find(p => p.contact === contact);
  const generated = bridge.push(contact, 'self', '宝，好的。');
  profile.generatedIds = [generated.id];
  await a.settings({ enabled: true }); await a.tick();
  bridge.push(contact, 'other', '老板，这个安排怎么样？');
  await a.tick(); advance();
  provider.next = async () => ({ action: 'send', text: '小林，我觉得可以。' });
  await a.tick();
  const call = provider.calls.at(-1);
  assert.equal(call.input.addressing.styleScope, 'current-chat');
  assert.equal(call.input.style.summary, profile.style.summary);
  assert.equal(call.input.messages.find(m => m.id === generated.id).aiGenerated, true);
  assert.match(call.system, /默认不加称呼/);
  assert.match(call.system, /不得把对方对用户的称呼反向用回去/);
  assert.equal(bridge.sent.at(-1).text, '小林，我觉得可以。');
});

test('a contact display name supplies no salutation to a default reply', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const target = bridge.contacts[0]; target.label = '林宝平_Bot';
  await a.scan(); await a.setReplyOptions({ contact: target.id, enabled: true }); await a.settings({ enabled: true }); await a.tick();
  bridge.push(target.id, 'other', '今天有时间吗？'); await a.tick(); advance();
  provider.next = async () => ({ action: 'send', text: '有时间，什么事？' });
  await a.tick();
  const call = provider.calls.at(-1);
  assert.equal(call.input.addressing.styleScope, 'current-chat');
  assert.equal(JSON.stringify(call.input).includes(target.label), false);
  assert.match(call.system, /不得从联系人昵称、备注、群名、关系分类或亲切程度推断称呼/);
  assert.equal(bridge.sent.at(-1).text, '有时间，什么事？');
});

test('single and batch learning identify groups without seeding a pet name', async t => {
  const { a, bridge, provider } = await fixture(t);
  bridge.contacts[1].kind = 'group'; await a.scan();
  await a.learn({ contacts: [bridge.contacts[1].id] });
  assert.equal(provider.calls.at(-1).input.kind, 'group');
  const beforeBatch = provider.calls.length;
  await a.learn({ contacts: bridge.contacts.slice(0, 2).map(c => c.id) });
  const calls = provider.calls.slice(beforeBatch);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.input.kind), ['person', 'group']);
  assert.ok(calls.every(call => !Object.hasOwn(call.input, 'conversations')));
  for (const { system } of provider.calls) {
    assert.match(system, /默认不加称呼/);
    assert.match(system, /不能把用户对某个成员的称呼总结为全群通用称呼/);
    assert.doesNotMatch(system, /宝|宝贝/);
  }
});
