import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { readMemory, editMemory } from '../server/ai-wiki.mjs';
import { AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const layers = { language: '口语短句，句号很少', rhythm: '回复快，一次说一段', interaction: '爱先抛话题再提问', emotion: '温和，几乎不发 emoji', role: '偏跟随者，听得多' };
const composedSummary = '语言：口语短句，句号很少\n节奏：回复快，一次说一段\n互动：爱先抛话题再提问\n情感：温和，几乎不发 emoji\n角色：偏跟随者，听得多';

// The fixture records every model call itself because tests replace provider.complete.
async function fixture(t, { long = false, count = 3 } = {}) {
  const root = await temp(), provider = new AIModelFixture(); let now = Date.now();
  const bridge = {
    account: key('learning-account'),
    contacts: Array.from({ length: count }, (_, i) => ({ id: key(`target-${i}`), label: `联系人${i}`, kind: 'person' })),
    async scan() { return { available: true, account: this.account, contacts: this.contacts }; },
    async read({ contact }) { return { account: this.account, contact, messages: [{ id: key(`snapshot-${contact}`), direction: 'self', text: '快照发言' }], revision: key(`rev-${contact}`) }; },
  };
  const messages = long
    ? Array.from({ length: 600 }, (_, i) => ({ id: key(`long-${i}`), direction: i % 2 ? 'self' : 'other', timestamp: 1789000000 + i, text: `第 ${i} 条聊天内容，用于分批学习的长期记忆素材` }))
    : [{ id: key('self-0'), direction: 'self', timestamp: 1789000000, text: '初始本人发言' }, { id: key('other-0'), direction: 'other', timestamp: 1789000060, text: '对方回复' }];
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: structuredClone(messages) });
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {}, random: min => min });
  await a.init(); await a.configure(modelConfig); await a.scan();
  const contacts = bridge.contacts.map(c => c.id);
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, contacts, bridge, provider, profile: () => a.profiles().find(p => p.contact === contacts[0]),
    respond: fn => { provider.complete = async (config, system, input, signal) => { provider.calls.push({ system, input }); return fn(input, signal); }; } };
}

test('learning only style composes five layers and leaves the stored memory untouched', async t => {
  const f = await fixture(t);
  f.respond(() => ({ memory: { entries: [{ text: '手工维护的旧记忆' }] } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  await f.a.applyPendingMemory(f.profile().id);
  const seeded = f.profile(), memoryBefore = readMemory(f.a.vault, seeded).summary, learnedAtBefore = seeded.memoryLearnedAt;
  f.respond(() => ({ style: { ...layers }, ignoredRaw: 'CHAT_PRIVATE_MARKER' }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'style' });
  const profile = f.profile();
  assert.equal(profile.style.summary, composedSummary);
  assert.equal(profile.styleId, 'learned');
  assert.equal(readMemory(f.a.vault, profile).summary, memoryBefore);
  assert.equal(profile.memoryLearnedAt, learnedAtBefore);
  assert.equal(f.provider.calls.length, 2);
  assert.doesNotMatch(f.provider.calls.at(-1).system, /在同一个 JSON 中返回 memory/);
});

test('default style learning accepts the same five layers', async t => {
  const f = await fixture(t);
  f.respond(() => ({ style: { language: '书面语为主', rhythm: '慢回复', interaction: '多陈述', emotion: '克制', role: '主导者' } }));
  await f.a.learn({ contacts: f.contacts.slice(0, 2), asDefault: true });
  assert.equal(f.a.data.learnedDefaultStyle.style.summary, '语言：书面语为主\n节奏：慢回复\n互动：多陈述\n情感：克制\n角色：主导者');
});

test('memory-only learning reads the history in one request and parks the result instead of writing', async t => {
  const f = await fixture(t, { long: true });
  f.respond(input => ({ memory: { entries: [{ text: '整理出的记忆' }] } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  const profile = f.profile(), call = f.provider.calls.at(-1);
  assert.equal(f.provider.calls.length, 1, 'one request per contact, no batching');
  assert.ok(Array.isArray(call.input.material) && call.input.material.length);
  assert.ok(JSON.stringify(call.input.material).length <= 80000, 'material stays inside the budget');
  assert.equal(call.input.partial, undefined);
  assert.match(call.system, /人物卡/);
  assert.equal(readMemory(f.a.vault, profile).summary, '', 'stored memory is untouched until confirmed');
  assert.ok(profile.pendingMemory, 'the result waits for confirmation');
  assert.match(f.a.notice, /聊天记忆学习完成/);
});

test('a short chat takes one request and reads every readable message', async t => {
  const f = await fixture(t);
  f.respond(() => ({ memory: { entries: [{ text: '约定明年一起去成都看展' }] } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  assert.equal(f.provider.calls.length, 1);
  assert.equal(f.provider.calls[0].input.material.length, 2);
  await f.a.applyPendingMemory(f.profile().id);
  assert.equal(readMemory(f.a.vault, f.profile()).summary, '约定明年一起去成都看展');
  assert.equal(f.profile().pendingMemory, undefined);
});

test('applying replaces the memory, discarding leaves it alone and merging asks the model once more', async t => {
  const f = await fixture(t);
  f.respond(() => ({ memory: { entries: [{ text: '旧记忆：她是素食主义者' }] } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  await f.a.applyPendingMemory(f.profile().id);
  Object.assign(f.profile(), editMemory(f.a.vault, f.profile(), { summary: '手工修正：她是素食主义者' }, 1));
  f.respond(() => ({ memory: { entries: [{ text: '2025-06 一起去过成都' }] } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  // 学习本身不动已有记忆：只有用户确认后才写。
  assert.equal(readMemory(f.a.vault, f.profile()).summary, '手工修正：她是素食主义者');
  await f.a.discardPendingMemory(f.profile().id);
  assert.equal(readMemory(f.a.vault, f.profile()).summary, '手工修正：她是素食主义者');
  assert.equal(f.profile().pendingMemory, undefined);
  // 合并是另一次模型调用，结果仍然只是待确认。
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  f.respond(() => ({ memory: { entries: [{ text: '合并后的记忆' }] } }));
  await f.a.mergePendingMemory(f.profile().id);
  for (let i = 0; i < 50 && f.profile().memoryMerge?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.profile().memoryMerge?.status, 'done');
  const merged = f.provider.calls.at(-1);
  assert.equal(merged.input.current.entries.length, 1);
  assert.equal(merged.input.incoming.entries[0].text, '2025-06 一起去过成都');
  assert.equal(readMemory(f.a.vault, f.profile()).summary, '手工修正：她是素食主义者', 'a merge is not applied on its own');
  assert.equal(f.profile().pendingMemorySource, 'merge');
  await f.a.applyPendingMemory(f.profile().id);
  assert.equal(readMemory(f.a.vault, f.profile()).summary, '合并后的记忆');
});

test('memory learning guards the contact limit, the default-style mix and a bridge without full reads', async t => {
  const f = await fixture(t, { count: 6 });
  await assert.rejects(f.a.learn({ contacts: f.contacts, target: 'memory' }), /最多学习 5 位联系人的聊天记忆/);
  await assert.rejects(f.a.learn({ contacts: [f.contacts[0]], target: 'memory', asDefault: true }), /默认风格不包含聊天记忆/);
  const bridge = f.bridge.readRange; delete f.bridge.readRange;
  try { await assert.rejects(f.a.learn({ contacts: [f.contacts[0]], target: 'memory' }), /不支持读取全部聊天记录/); }
  finally { f.bridge.readRange = bridge; }
});
