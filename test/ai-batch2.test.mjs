import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { orderedContacts } from '../server/ai-contact-order.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
const learningStyle = { language: '口语简洁', rhythm: '回复及时', interaction: '自然提问', emotion: '温和', role: '平等交流' };
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.scan(); await a.settings({ enabled: true, replyScope: 'all' }); await a.tick();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, root, bridge, provider, p: a.profiles().find(p => p.contact === bridge.contacts[0].id), advance(ms) { now += ms; a.lastScanAt = now; } };
}

test('已设置自动回复的排前面（按设置先后升序，先设置的在前），未设置按最新消息时间倒序，置顶无优先级', () => {
  const contacts = [
    { id: 'u-empty', contactOrder: 0 }, { id: 's-empty-b', contactOrder: 4 },
    { id: 'u-new', lastChatAt: 500 }, { id: 's-old', lastChatAt: 10, pinned: true },
    { id: 's-mixed', lastChatAt: 999 }, { id: 's-new', lastChatAt: 100 }, { id: 's-empty-a', contactOrder: 2 },
  ];
  const profiles = [
    { contact: 's-new', replyStyleSet: true, learnedAt: 300 },
    { contact: 's-old', replyStyleSet: true, replyConfiguredAt: 100 },
    { contact: 's-mixed', replyStyleSet: true, learnedAt: 350, replyConfiguredAt: 150 },
    { contact: 's-empty-a', replyStyleSet: true, learnedAt: 200 },
    { contact: 's-empty-b', replyStyleSet: true, replyConfiguredAt: 400 },
  ];
  // 已设置组按设置时间（learnedAt/replyConfiguredAt 最早一次）升序：
  // s-old(100) → s-mixed(150) → s-empty-a(200) → s-new(300) → s-empty-b(400)
  assert.deepEqual(orderedContacts(contacts, profiles).map(c => c.id), ['s-old', 's-mixed', 's-empty-a', 's-new', 's-empty-b', 'u-new', 'u-empty']);
  // s-old 取消设置后进入未设置组，按最新消息时间倒序（u-new 500 → s-old 10 → u-empty 无消息保持目录序）
  profiles.find(p => p.contact === 's-old').replyStyleSet = false;
  assert.deepEqual(orderedContacts(contacts, profiles).map(c => c.id), ['s-mixed', 's-empty-a', 's-new', 's-empty-b', 'u-new', 's-old', 'u-empty']);
});

test('learned memory is encrypted, used only for this contact, and never updates from a reply result', async t => {
  const { a, root, bridge, provider, p, advance } = await fixture(t);
  provider.next = async () => ({ style: learningStyle, memory: { summary: '对方偏好 MEMORY_PRIVATE_MARKER' } });
  await a.learn({ contacts: [p.contact] });
  assert.equal(a.publicState().profiles.find(x => x.id === p.id).memory.summary, '对方偏好 MEMORY_PRIVATE_MARKER');
  assert.doesNotMatch(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'), /MEMORY_PRIVATE_MARKER/);
  await a.tick(); bridge.push(p.contact, 'other', '普通问题'); await a.tick(); advance(10000);
  provider.next = async input => { assert.match(input.memory.summary, /MEMORY_PRIVATE_MARKER/); return { action: 'send', text: '好的。', memory: { summary: 'UNSOLICITED' } }; };
  await a.tick();
  assert.match(a.publicState().profiles.find(x => x.id === p.id).memory.summary, /MEMORY_PRIVATE_MARKER/);
  const second = a.profiles().find(x => x.contact === bridge.contacts[1].id);
  bridge.push(second.contact, 'other', '其他对象'); await a.tick(); advance(10000);
  provider.next = async input => { assert.equal(input.memory.summary, ''); return { action: 'skip' }; };
  await a.tick();
});

test('nonempty manual memory survives learning; explicitly deleted facts stay suppressed', async t => {
  const { a, provider, p } = await fixture(t);
  for (const summary of ['本人确认：周六再联系', '']) {
    await a.editMemory(p.id, { summary });
    provider.next = async input => { assert.equal(input.previousMemory.summary, summary); return { style: learningStyle, memory: { summary: '模型新整理' } }; };
    await a.learn({ contacts: [p.contact] });
    const result = a.publicState().profiles.find(x => x.id === p.id);
    assert.equal(result.memory.summary, summary ? summary + '\n模型新整理' : '');
    assert.ok(!result.memorySuggestion, 'non-conflicting facts append without replacing manual text');
  }
  provider.next = async () => ({ style: learningStyle }); await a.learn({ contacts: [p.contact] });
  assert.match(a.publicState().profiles.find(x => x.id === p.id).memoryNotice, /未返回/);
});

test('contact activity includes only confirmed self message IDs; no plaintext persists; body failure does not prevent opening or pause the chat', async t => {
  const { a, root, bridge, p } = await fixture(t);
  const confirmed = bridge.push(p.contact, 'self', 'ACTIVITY_CONFIRMED_PRIVATE');
  bridge.push(p.contact, 'self', 'MANUAL_PRIVATE');
  const fake = bridge.push(p.contact, 'other', 'not ours');
  p.generatedIds = [confirmed.id, fake.id, key('never-sent')];
  p.sentMessages = [{ id: confirmed.id, at: 123, source: 'reply' }];
  await a.save();
  assert.equal(a.publicState().activity.length, 1);
  const records = await a.activityRecords([p.id]);
  assert.deepEqual(records.records[0].messages.map(x => x.text), ['ACTIVITY_CONFIRMED_PRIVATE']);
  assert.doesNotMatch(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'), /ACTIVITY_CONFIRMED_PRIVATE|MANUAL_PRIVATE/);
  bridge.read = async () => { throw new Error('body unavailable'); };
  assert.equal((await a.activityRecords([p.id])).records[0].unavailable, false);
  delete p.sentMessages[0].body;
  assert.equal((await a.activityRecords([p.id])).records[0].unavailable, true);
  let opened = 0; bridge.openChat = async request => { assert.equal(request.contact, p.contact); opened++; return { opened: true }; };
  assert.equal((await a.openConversation(p.id)).opened, true);
  assert.equal(opened, 1); assert.equal(!!p.paused, false);
  a.pauseProfile(p, 'uncertain'); p.delivery = { status: 'uncertain' };
  await a.openConversation(p.id); assert.equal(p.pauseReason, 'uncertain');
  assert.equal(a.publicState().activity[0].needsHelp, true);
  p.account = key('foreign');
  assert.equal(a.publicState().activity.length, 0);
  await assert.rejects(a.activityRecords([p.id])); await assert.rejects(a.openConversation(p.id));
});
