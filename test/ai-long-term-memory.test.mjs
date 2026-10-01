import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { memoryIsHistorical, selectMemoryForChat } from '../server/ai-memory-context.mjs';
import { editMemory, memoryValue, mergeMemory, readMemory } from '../server/ai-wiki.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const now = Date.UTC(2026, 8, 29, 12);

test('a long-term memory stays stored while a reply receives only relevant, time-aware context', () => {
  const memory = { entries: [
    { field: 'other', text: '不喜欢当导师' },
    { field: 'other', text: '上周生病了', observedAt: now - 7 * 86400000 },
    { field: 'residence', text: '以前住在杭州', status: 'historical', recordedAt: now - 365 * 86400000 },
    { field: 'birthday', text: '农历正月初八' },
  ] };
  const teaching = selectMemoryForChat(memory, { query: '当导师会很累吗', now });
  assert.ok(teaching.entries.some(entry => entry.text === '不喜欢当导师' && entry.contextRole === 'current'));
  assert.ok(!teaching.entries.some(entry => entry.text.includes('生病')));
  assert.ok(!teaching.entries.some(entry => entry.text.includes('杭州')));
  const health = selectMemoryForChat(memory, { query: '之前生病的事', now });
  assert.equal(health.entries.find(entry => entry.text.includes('生病')).contextRole, 'historical');
  assert.equal(memory.entries.length, 4, 'selection must not delete or rewrite saved memories');
  assert.equal(memoryIsHistorical({ field: 'group_plan', text: '下周讨论预算' }, now), true);
});

test('newer confirmed address becomes current while the former address remains historical', () => {
  const vault = { seal: value => structuredClone(value), open: value => structuredClone(value) };
  const profile = {};
  Object.assign(profile, mergeMemory(vault, profile, { entries: [{ field: 'residence', text: '住在杭州', recordedAt: 1000, observedAt: 1000 }] }, 1000));
  Object.assign(profile, mergeMemory(vault, profile, { entries: [{ field: 'residence', text: '搬到上海', recordedAt: 2000, observedAt: 2000, evidence: ['new-message'] }] }, 2000, { evidence: new Set(['new-message']) }));
  const entries = readMemory(vault, profile).entries;
  assert.equal(entries.find(entry => entry.text === '住在杭州').status, 'historical');
  assert.equal(entries.find(entry => entry.text === '搬到上海').status, undefined);
  assert.deepEqual(entries.find(entry => entry.text === '搬到上海').evidence, ['new-message']);
  const context = selectMemoryForChat(readMemory(vault, profile), { query: '住哪儿', now: 3000 });
  assert.ok(context.entries.some(entry => entry.text === '搬到上海'));
  assert.ok(!context.entries.some(entry => entry.text === '住在杭州'));
  Object.assign(profile, editMemory(vault, profile, { entries: entries.map(({ id, field, text, recordedAt }) => ({ id, field, text, recordedAt })) }, 3000));
  assert.equal(readMemory(vault, profile).entries.find(entry => entry.text === '住在杭州').status, 'historical', 'unchanged UI edits preserve internal history metadata');
  Object.assign(profile, mergeMemory(vault, profile, { entries: [{ field: 'residence', text: '住在杭州', recordedAt: 4000, observedAt: 4000, evidence: ['returned'] }] }, 4000, { evidence: new Set(['returned']) }));
  assert.equal(readMemory(vault, profile).entries.find(entry => entry.text === '住在杭州').status, undefined, 'a later return to the old address can become current again');
  assert.equal(readMemory(vault, profile).entries.find(entry => entry.text === '搬到上海').status, 'historical');
});

test('manual facts and older observations are not silently replaced', () => {
  const vault = { seal: value => structuredClone(value), open: value => structuredClone(value) };
  const profile = {};
  Object.assign(profile, editMemory(vault, profile, { entries: [{ field: 'workplace', text: '在北京工作', recordedAt: 3000 }] }, 3000));
  Object.assign(profile, mergeMemory(vault, profile, { entries: [{ field: 'workplace', text: '在上海工作', observedAt: 4000, evidence: ['m1'] }] }, 4000, { evidence: new Set(['m1']) }));
  assert.deepEqual(readMemory(vault, profile).entries.map(entry => entry.text), ['在北京工作']);
  assert.equal(readMemory(vault, profile, 'memorySuggestion').entries[0].text, '在上海工作');
});

test('the full long-term record survives beyond the old summary-length limit', () => {
  const entries = Array.from({ length: 180 }, (_, index) => ({ field: 'other', text: `长期事实${index}：${'明确内容'.repeat(15)}` }));
  const memory = memoryValue({ entries });
  assert.equal(memory.entries.length, 180);
  assert.ok(memory.summary.length <= 12000);
  assert.equal(memory.entries.at(-1).text, entries.at(-1).text);
  const context = selectMemoryForChat(memory, { query: '长期事实179', now });
  assert.ok(context.entries.some(entry => entry.text === entries.at(-1).text));
});

test('reply generation receives selected memory and stores verified source time and ID', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let current = now;
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => current, delay: async () => {} });
  await assistant.init();
  t.after(async () => { await assistant.close(); await cleanup(root); });
  await assistant.configure(modelConfig); await assistant.scan();
  const contact = bridge.contacts[0].id;
  await assistant.setReplyOptions({ contact, enabled: true });
  const profile = assistant.profiles().find(row => row.contact === contact);
  Object.assign(profile, mergeMemory(assistant.vault, profile, { entries: [
    { field: 'other', text: '不喜欢当导师' },
    { field: 'other', text: '上周感冒了' },
  ] }, current));
  await assistant.save();
  await assistant.settings({ enabled: true }); await assistant.tick();
  const incoming = bridge.push(contact, 'other', '导师这件事你怎么看？');
  incoming.timestamp = Math.floor(current / 1000);
  await assistant.tick(); current += 20000;
  provider.next = async () => ({ action: 'send', text: '当导师会不会挺费心的？', memoryUpdates: [{ field: 'other', text: '对方现在在准备毕业论文', evidence: [incoming.id] }] });
  await assistant.tick();
  const call = provider.calls.at(-1);
  assert.ok(call.input.memory.entries.some(entry => entry.text === '不喜欢当导师'));
  assert.ok(!call.input.memory.entries.some(entry => entry.text.includes('感冒')));
  assert.match(call.system, /historical 只表示过去/);
  assert.match(call.system, /比较 messages 的时间戳与 currentTime/);
  assert.match(call.system, /先回应其明说的处境或感受/);
  const saved = readMemory(assistant.vault, profile).entries.find(entry => entry.text === '对方现在在准备毕业论文');
  assert.deepEqual(saved?.evidence, [incoming.id]);
  assert.equal(saved?.observedAt, incoming.timestamp * 1000);
});

test('learning keeps source time only when it matches an actually supplied message', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await assistant.init();
  t.after(async () => { await assistant.close(); await cleanup(root); });
  await assistant.configure(modelConfig); await assistant.scan();
  const contact = bridge.contacts[0].id, sourceAt = Math.floor(now / 1000);
  bridge.messages.set(contact, [
    { id: 'self-source', direction: 'self', text: '最近工作怎么样？', timestamp: sourceAt - 1 },
    { id: 'source', direction: 'other', text: '我不喜欢当导师', timestamp: sourceAt },
  ]);
  provider.next = async () => ({ memory: { entries: [
    { field: 'other', text: '不喜欢当导师', observedAt: sourceAt * 1000 },
    { field: 'other', text: '喜欢看电影', observedAt: (sourceAt + 999999) * 1000, evidence: ['invented-id'] },
  ] } });
  await assistant.learn({ contacts: [contact], target: 'memory' });
  const pending = assistant.pendingMemoryOf(assistant.profiles().find(profile => profile.contact === contact));
  assert.equal(pending.entries[0].observedAt, sourceAt * 1000);
  assert.equal(pending.entries[1].observedAt, undefined);
  assert.equal(pending.entries[1].evidence, undefined);
});
