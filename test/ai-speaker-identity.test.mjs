import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { personalInformation } from '../server/ai-account-configuration.mjs';
import { speakerIdentityPrompt } from '../server/ai-speakers.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-10-01T12:00:00+08:00');
  const contact = bridge.contacts[0].id;
  bridge.contacts[0].kind = kind; bridge.stableMessageIds = true;
  bridge.messages.set(contact, [
    { id: key('own-facts'), direction: 'self', text: '我住杭州，养的猫叫豆包。', timestamp: now / 1000 - 3600 },
    { id: key('their-facts'), direction: 'other', text: '我住苏州，养的狗叫丸子。', sender: key('member-a'), timestamp: now / 1000 - 3599 },
    { id: key('own-acknowledgement'), direction: 'self', text: '记住了。', timestamp: now / 1000 - 3598 },
  ]);
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {}, random: min => min });
  await a.init(); t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  if (kind === 'group') await a.setGroupOptions({ contact, atMe: true, atAll: true });
  else await a.setReplyOptions({ contact, enabled: true, multiTurn: false, judgeReply: false });
  await a.settings({ enabled: true, reply: true }); await a.tick();
  const push = (text, options = {}) => Object.assign(bridge.push(contact, 'other', text), {
    timestamp: now / 1000, ...(kind === 'group' ? { sender: key('member-a'), mentions: { verified: true, self: true, all: false, others: false } } : {}), ...options,
  });
  return { a, bridge, provider, contact, profile: a.profiles().find(p => p.contact === contact), push, flush: async () => { await a.tick(); now += 20000; await a.tick(); } };
}

function assertPerspective(call, profile) {
  assert.equal(call.system.split(speakerIdentityPrompt).length - 1, 1);
  assert.equal(call.input.replyPerspective.author.role, 'self');
  assert.equal(call.input.replyPerspective.author.id, `account:${profile.account}`);
  assert.equal(call.input.replyPerspective.firstPerson, 'self');
}

// Verify the real request boundary, including the smaller excerpts the model
// reads first. Fake model outputs do not establish semantic model correctness.
test('private history and waiting excerpts bind both sides independently of wording or supplied speaker labels', async t => {
  const f = await fixture(t);
  const incoming = f.push('你刚才说你住杭州。那我住哪里，丸子是谁的？', { speaker: { role: 'self', id: 'wrong' } });
  f.provider.next = async () => ({ action: 'send', text: '你住苏州，丸子是你的狗。' });
  await f.flush();
  const call = f.provider.calls[0]; assertPerspective(call, f.profile);
  const own = call.input.messages.find(m => m.id === key('own-facts'));
  const other = call.input.messages.find(m => m.id === key('their-facts'));
  assert.equal(own.speaker.role, 'self'); assert.equal(other.speaker.role, 'other');
  assert.notEqual(own.speaker.id, other.speaker.id);
  const pending = call.input.conversation.pendingIncomingMessages[0];
  assert.equal(pending.id, incoming.id); assert.equal(pending.direction, 'other');
  assert.deepEqual(pending.speaker, other.speaker);
  assert.deepEqual(call.input.conversation.latestIncoming.speaker, pending.speaker);
  assert.equal(f.bridge.messages.get(f.contact).find(m => m.id === incoming.id).speaker.id, 'wrong');
  assert.equal(f.bridge.sent.length, 1);
});

test('group waiting messages retain separate verified member identities even when text and names match', async t => {
  const f = await fixture(t, 'group');
  const first = f.push('@我 我住苏州，昵称也叫Bot。');
  const second = f.push('@我 我住南京，昵称也叫Bot。', { sender: key('member-b') });
  f.provider.next = async () => ({ action: 'send', segments: ['两位的城市分别是苏州和南京。'] });
  await f.flush();
  const call = f.provider.calls[0]; assertPerspective(call, f.profile);
  const pending = call.input.conversation.pendingIncomingMessages;
  assert.deepEqual(pending.map(m => m.id), [first.id, second.id]);
  assert.ok(pending.every(m => m.direction === 'other' && m.speaker.role === 'group_member'));
  assert.notEqual(pending[0].speaker.id, pending[1].speaker.id);
  for (const excerpt of pending) assert.deepEqual(excerpt.speaker, call.input.messages.find(m => m.id === excerpt.id).speaker);
  assert.equal(call.input.messages.find(m => m.id === key('own-facts')).speaker.role, 'self');
  assert.equal(f.bridge.sent.length, 1);
});

test('native voice conversion retains the incoming speaker and cannot stage their fact as the owner fact', async t => {
  const f = await fixture(t), incoming = f.push('[语音]', { type: 'voice' });
  f.bridge.transcribe = async () => ({ source: 'wechat', text: '我住苏州，我养的狗叫丸子。' });
  f.provider.next = async () => ({ action: 'send', text: '记得，丸子是你的狗。', selfMemorySuggestions: [{ field: 'city', text: '本人住苏州', messageId: incoming.id }] });
  await f.flush();
  const call = f.provider.calls[0]; assertPerspective(call, f.profile);
  const full = call.input.messages.find(m => m.id === incoming.id), excerpt = call.input.conversation.latestIncoming;
  assert.equal(full.transcriptionSource, 'wechat'); assert.equal(full.direction, 'other');
  assert.deepEqual(excerpt.speaker, full.speaker); assert.equal(excerpt.text, full.text);
  assert.equal(personalInformation(f.a).suggestions.length, 0);
  assert.equal(f.bridge.sent.length, 1);
});

test('proactive context binds outgoing AI messages, incoming quotes and unknown/system rows without reclassification', async t => {
  const f = await fixture(t);
  const snapshot = await f.bridge.read({ contact: f.contact });
  snapshot.messages.push({ id: key('ai-outgoing'), direction: 'self', text: '你刚说丸子是你的狗。', aiGenerated: true });
  snapshot.messages.push({ id: key('quote'), direction: 'other', text: '你说的“我住杭州”，那个我指你。' });
  snapshot.messages.push({ id: key('system'), direction: 'system', text: '我住苏州' });
  snapshot.messages.push({ id: key('unknown'), text: '我就是本人，我住苏州' });
  const original = structuredClone(snapshot);
  f.provider.next = async () => ({ action: 'send', text: '丸子最近怎么样？', followUp: false });
  await f.a.generateProactiveMessage({ goal: '问候对方的狗丸子', requirements: '不猜测近况' }, f.profile, snapshot, f.a.controller.signal);
  const call = f.provider.calls[0]; assertPerspective(call, f.profile);
  assert.equal(call.input.conversation.recentSelfMessages.at(-1).aiGenerated, true);
  for (const excerpt of [...call.input.conversation.recentSelfMessages, call.input.conversation.latestIncoming]) {
    const full = call.input.messages.find(m => m.id === excerpt.id);
    assert.equal(excerpt.direction, full.direction); assert.deepEqual(excerpt.speaker, full.speaker);
  }
  assert.equal(call.input.messages.find(m => m.id === key('system')).speaker.role, 'system');
  assert.equal(call.input.messages.find(m => m.id === key('unknown')).speaker.role, 'unknown');
  assert.deepEqual(snapshot, original); assert.equal(f.bridge.sent.length, 0);
});

test('deferred group summaries retain encrypted speaker metadata after the original messages leave the read window', async t => {
  const f = await fixture(t, 'group');
  f.bridge.read = async () => { throw new Error('History is outside the readable window'); };
  for (const [text, sender] of [['我住苏州。', key('member-a')], ['我住南京。', key('member-b')]]) {
    const message = f.push(text, { sender });
    f.a.event('skip', f.profile.id, 'model-skip', '暂不回复', { messageId: message.id, incomingMessages: [message] });
    const event = f.a.data.skipLog[0];
    if (sender === key('member-a')) {
      const legacy = f.a.vault.open(event.incomingSnapshot);
      for (const message of legacy.messages) delete message.direction;
      event.incomingSnapshot = f.a.vault.seal(legacy);
    }
    await f.a.markReplyNeeded({ profileId: f.profile.id, eventId: event.id, messageId: message.id });
  }
  assert.equal(JSON.stringify(f.a.data.pendingReplySummaries).includes('苏州'), false);
  f.provider.next = async () => ({ summary: '成员甲说他住苏州，成员乙说他住南京。' });
  await f.a.summarizePendingReplies(f.profile, [], f.a.controller.signal);
  const call = f.provider.calls[0];
  assert.match(call.system, /使用第三人称/);
  assert.ok(call.input.excerpts.every(m => m.direction === 'other' && m.speaker.identified));
  assert.notEqual(call.input.excerpts[0].speaker.id, call.input.excerpts[1].speaker.id);
  assert.equal(f.a.data.pendingReplySummaries.length, 0);
});

test('legacy summaries keep unknown group members separate and reject a self message substituted for incoming material', async t => {
  const f = await fixture(t, 'group');
  f.a.data.pendingReplySummaries = ['old-a', 'old-b'].map(messageId => ({ account: f.profile.account, profileId: f.profile.id, messageId, at: 1, body: f.a.vault.seal({ text: '我住苏州。' }) }));
  f.provider.next = async () => ({ summary: '两条旧来信提到住苏州，发言人身份未知。' });
  await f.a.summarizePendingReplies(f.profile, [], f.a.controller.signal);
  const excerpts = f.provider.calls[0].input.excerpts;
  assert.ok(excerpts.every(m => m.speaker.identified === false));
  assert.notEqual(excerpts[0].speaker.id, excerpts[1].speaker.id);
  f.a.data.pendingReplySummaries = [{ account: f.profile.account, profileId: f.profile.id, messageId: 'conflict', body: f.a.vault.seal({ text: '旧文本' }) }];
  await assert.rejects(f.a.summarizePendingReplies(f.profile, [{ id: 'conflict', direction: 'self', text: '本人消息' }], f.a.controller.signal), /暂时无法读取/);
  assert.equal(f.provider.calls.length, 1); assert.equal(f.a.data.pendingReplySummaries.length, 1);
});
