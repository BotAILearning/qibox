import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { activityRows, skipRecordsView } from '../web/ai-activity-view.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-09-24T10:00:00+08:00');
  bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now });
  await a.init(); await a.configure(modelConfig); await a.scan();
  for (const contact of bridge.contacts) await a.saveReplyProfile({ contact: contact.id, style: { summary: '简洁自然' }, strategy: { replyGoal: '回复对方问题', boundaries: '不作承诺' } });
  bridge.openChat = async () => ({ opened: true });
  t.after(async () => { if (!a.closed) await a.close(); await cleanup(root); });
  return { a, bridge, provider, root, now: () => now, setNow(value) { now = value; } };
}

test('record lists expose confirmed deletion, summary ranges, and reply-needed action', () => {
  const html = activityRows({ activity: [{ id: 'p1', label: '甲', kind: 'person', hasSent: true, at: Date.now() }] }, { source: 'reply', page: 0 }, [{ id: 'p1', messages: [{ id: 'sent-1', at: Date.now(), text: 'AI答复' }] }], false);
  assert.match(html, /data-ai-delete-record="sent-1"/);
  for (const range of ['takeover', 'all', 'day', 'week', 'month']) assert.match(html, new RegExp(`value="${range}"`));
  const skips = skipRecordsView({ profiles: [{ id: 'p1', contact: 'c1', label: '甲' }], contacts: [], events: [{ id: 'e1', target: 'p1', at: Date.now(), code: 'skip', source: 'system-skip', reasonCode: 'model-no-reply', messageId: 'incoming-1' }] });
  assert.match(skips, /data-ai-open-conversation/);
  assert.match(skips, /打开聊天/);
  assert.doesNotMatch(skips, /data-ai-locate-message|定位触发消息|定位到该消息/);
  assert.match(skips, /data-ai-mark-reply="p1"/);
  assert.match(skips, /data-ai-delete-source="skip"/);
});

test('opening the exact chat never waits for history reads or requests a message location', async t => {
  const { a, bridge } = await fixture(t), [profile, other] = a.profiles();
  bridge.read = async () => { throw new Error('history unavailable'); };
  bridge.readRange = async () => { throw new Error('history unavailable'); };
  let request;
  bridge.openChat = async value => { request = value; return { opened: true }; };
  const result = await a.openConversation(profile.id);
  assert.deepEqual(result, { opened: true, id: profile.id, account: profile.account, contact: profile.contact });
  assert.equal(request.account, profile.account);
  assert.equal(request.contact, profile.contact);
  assert.equal(request.locate, undefined);
  other.account = 'different-account';
  await assert.rejects(a.openConversation(other.id), /请选择当前账号的对象/);
});

test('reply records delete only when their profile belongs to the active account', async t => {
  const { a } = await fixture(t), [profile] = a.profiles();
  profile.sentMessages = [{ id: 'owned-send', source: 'reply', at: Date.now(), body: a.vault.seal({ text: 'AI代回复' }) }];
  await a.deleteActivityRecord({ source: 'reply', id: 'owned-send' });
  assert.ok(a.data.deletedActivityRecords.some(row => row.account === a.data.account && row.id === 'owned-send'));
  profile.account = 'foreign-account';
  profile.sentMessages.push({ id: 'foreign-send', source: 'reply', at: Date.now() });
  await assert.rejects(a.deleteActivityRecord({ source: 'reply', id: 'foreign-send' }), /运行记录不存在/);
});

test('marked replies persist, summarize before reply, and then remove the raw skip record', async t => {
  const { a, bridge, provider, root } = await fixture(t), [profile] = a.profiles();
  const original = bridge.push(profile.contact, 'other', '请确认周五是否可以交付？');
  a.event('skip', profile.id, 'system-skip', '需要后续回复', { messageId: original.id, reasonCode: 'model-no-reply' });
  const eventId = a.data.skipLog[0].id;
  await a.markReplyNeeded({ profileId: profile.id, eventId, messageId: original.id });
  assert.equal(a.data.pendingReplySummaries.length, 1);
  assert.equal(JSON.stringify(a.data.pendingReplySummaries).includes('请确认周五'), false);
  await a.save(); await a.close();
  const restored = new AIAssistant({ dataRoot: root, bridge, provider, now: () => Date.parse('2026-09-24T10:00:00+08:00') });
  await restored.init(); await restored.scan();
  try {
    assert.equal(restored.data.pendingReplySummaries.length, 1);
    const restoredProfile = restored.profile(profile.id), snapshot = await restored.read(restoredProfile, restored.controller.signal);
    provider.complete = async (_config, system, input) => { assert.match(system, /聊天内容/); assert.match(input.excerpts[0].text, /周五/); return { summary: '需确认周五交付时间' }; };
    const context = await restored.summarizePendingReplies(restoredProfile, snapshot.messages, restored.controller.signal);
    assert.match(context, /周五交付时间/);
    assert.match(restoredProfile.replySummaryContext, /周五交付时间/);
    assert.equal(restored.data.pendingReplySummaries.length, 0);
    assert.equal(restored.data.skipLog.some(row => row.id === eventId), false);
  } finally { await restored.close(); }
});

test('failed deferred summary retains raw queue and retries on the next call', async t => {
  const { a, bridge, provider } = await fixture(t), [profile] = a.profiles();
  const incoming = bridge.push(profile.contact, 'other', '請回复这件事');
  a.event('skip', profile.id, 'system-skip', '待处理', { messageId: incoming.id });
  const eventId = a.data.skipLog[0].id;
  await a.markReplyNeeded({ profileId: profile.id, eventId, messageId: incoming.id });
  const snapshot = await a.read(profile, a.controller.signal);
  provider.complete = async () => { throw new Error('temporary model failure'); };
  await assert.rejects(a.summarizePendingReplies(profile, snapshot.messages, a.controller.signal), /temporary model failure/);
  assert.equal(a.data.pendingReplySummaries.length, 1);
  assert.equal(a.data.skipLog.some(row => row.id === eventId), true);
  provider.complete = async () => ({ summary: '请回复这件事' });
  await a.summarizePendingReplies(profile, snapshot.messages, a.controller.signal);
  assert.equal(a.data.pendingReplySummaries.length, 0);
  assert.equal(profile.replySummaryContext.includes('请回复这件事'), true);
});

test('summary failure does not block the current reply and retries before the next one', async t => {
  const { a, bridge, provider } = await fixture(t), [profile] = a.profiles();
  await a.settings({ enabled: true });
  const incoming = bridge.push(profile.contact, 'other', '原始未回复问题');
  a.event('skip', profile.id, 'system-skip', '待处理', { messageId: incoming.id });
  const eventId = a.data.skipLog[0].id;
  await a.markReplyNeeded({ profileId: profile.id, eventId, messageId: incoming.id });
  const firstSnapshot = await a.read(profile, a.controller.signal);
  let summaries = 0;
  provider.complete = async (_config, _system, input) => {
    if (input.excerpts) { summaries++; throw new Error('临时总结错误'); }
    return { action: 'send', text: '先回复当前来信' };
  };
  await a.generate(profile, firstSnapshot, 'reply', a.revision, a.controller.signal);
  assert.equal(bridge.sent.length, 1);
  assert.equal(a.data.pendingReplySummaries.length, 1);
  assert.equal(a.data.skipLog.some(row => row.id === eventId), true);
  const next = bridge.push(profile.contact, 'other', '新的后续问题');
  const retrySnapshot = await a.read(profile, a.controller.signal);
  provider.complete = async (_config, _system, input) => input.excerpts ? { summary: '此前还有一项原始未回复问题' } : { action: 'send', text: '回复后续问题' };
  await a.generate(profile, retrySnapshot, 'reply', a.revision, a.controller.signal);
  assert.equal(bridge.sent.length, 2);
  assert.equal(a.data.pendingReplySummaries.length, 0);
  assert.match(profile.replySummaryContext, /原始未回复问题/);
  assert.equal(a.data.skipLog.some(row => row.id === eventId), false);
  assert.ok(next.id);
  assert.equal(summaries, 1);
});

test('activity summary is contact scoped and labels AI generated replies explicitly', async t => {
  const { a, bridge, provider, now, setNow } = await fixture(t), [one, two] = a.profiles();
  const first = bridge.messages.get(one.contact); first.push({ id: 'other-1', direction: 'other', text: '一号问什么时候到', timestamp: Math.floor(now() / 1000) - 2 });
  first.push({ id: 'ai-1', direction: 'self', text: 'AI回答：明天到', timestamp: Math.floor(now() / 1000) - 1 });
  a.profile(one.id).generatedIds = [];
  a.profile(one.id).sentMessages = [{ id: 'ai-1', source: 'reply', at: now() - 1000 }];
  bridge.messages.get(two.contact).push({ id: 'foreign-1', direction: 'other', text: '二号的私密内容', timestamp: Math.floor(now() / 1000) - 2 });
  setNow(now() - 5000); a.event('manual', one.id); setNow(now() + 5000);
  provider.complete = async (_config, _system, input) => { assert.equal(input.conversation.some(row => row.text.includes('二号')), false); return { summary: '对方询问到货时间，AI代为回答明天到。' }; };
  const result = await a.summarizeActivity(one.id, 'takeover');
  assert.equal(result.aiReplyCount, 1);
  assert.equal(result.count, 3);
  assert.equal(result.summary.includes('明天到'), true);
  await assert.rejects(a.summarizeActivity('missing-profile', 'all'));
});

test('first AI takeover summary uses the reply watch start when there is no manual handover yet', async t => {
  const { a, bridge, provider, now, setNow } = await fixture(t), [profile] = a.profiles();
  const from = now();
  bridge.messages.get(profile.contact).push({ id: 'first-question', direction: 'other', text: '首次接管问题', timestamp: Math.floor(from / 1000) + 1 });
  bridge.messages.get(profile.contact).push({ id: 'first-ai-reply', direction: 'self', text: '首次接管回复', timestamp: Math.floor(from / 1000) + 2 });
  profile.generatedIds = [];
  profile.sentMessages = [{ id: 'first-ai-reply', source: 'reply', at: from + 2000 }];
  setNow(from + 5000);
  provider.complete = async (_config, _system, input) => { assert.ok(input.conversation.some(row => row.text === '首次接管问题')); assert.ok(input.conversation.some(row => row.side === 'AI代你回复')); return { summary: '首次接管问题和 AI 回复' }; };
  const result = await a.summarizeActivity(profile.id, 'takeover');
  assert.equal(result.aiReplyCount, 1);
  assert.equal(result.total, 3);
});
