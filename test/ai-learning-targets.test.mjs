import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { readMemory, editMemory } from '../server/ai-wiki.mjs';
import { AppError } from '../server/files.mjs';
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
    respond: fn => { provider.complete = async (config, system, input, signal, options) => { provider.calls.push({ system, input, options }); const result = await fn(input, signal); return options?.validate ? options.validate(result) : result; }; } };
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

test('single-contact style learning without dates uses one full-range read before one model call', async t => {
  const f = await fixture(t); let reads = 0;
  const readRange = f.bridge.readRange.bind(f.bridge);
  f.bridge.readRange = async args => { reads++; return readRange(args); };
  f.respond(() => ({ style: { ...layers } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'style' });
  assert.equal(reads, 1);
  assert.equal(f.provider.calls.length, 1);
  assert.equal(f.provider.calls[0].input.material.length, 2);
  assert.equal(f.provider.calls[0].options?.retry, undefined, 'provider keeps its bounded default retry policy');
});

test('default style learning accepts the same five layers', async t => {
  const f = await fixture(t);
  f.respond(() => ({ style: { language: '书面语为主', rhythm: '慢回复', interaction: '多陈述', emotion: '克制', role: '主导者' } }));
  await f.a.learn({ contacts: f.contacts.slice(0, 2), asDefault: true });
  assert.equal(f.provider.calls.length, 3, 'two per-contact learning calls plus one summary call');
  assert.ok(f.provider.calls.every(call => call.options?.retry !== false));
  assert.deepEqual(f.provider.calls.slice(0, 2).map(call => call.input.contact), f.contacts.slice(0, 2));
  assert.ok(f.provider.calls.slice(0, 2).every(call => call.input.defaultStyle && call.input.material.length === 2 && !Object.hasOwn(call.input, 'conversations')));
  assert.ok(f.provider.calls.slice(0, 2).every(call => call.system.includes('只学习 direction=self')));
  assert.equal(f.provider.calls[2].input.profiles.length, 2);
  assert.ok(f.provider.calls[2].input.profiles.every(profile => Object.keys(profile.style).sort().join(',') === 'emotion,interaction,language,rhythm,role'));
  assert.equal(f.a.data.learnedDefaultStyle.style.summary, '语言：书面语为主\n节奏：慢回复\n互动：多陈述\n情感：克制\n角色：主导者');
});

test('default style with other perspective reuses one-person learning input and the other-speaker prompt', async t => {
  const f = await fixture(t);
  f.respond(() => ({ style: { ...layers } }));
  await f.a.learn({ contacts: [f.contacts[0]], asDefault: true, perspective: 'other' });
  const call = f.provider.calls[0];
  assert.equal(f.provider.calls.length, 1);
  assert.equal(call.input.material.length, 2);
  assert.match(call.system, /只学习 direction=other/);
  assert.doesNotMatch(call.system, /只学习 direction=self/);
});

test('memory-only learning sends the full in-limit range once and parks its result', async t => {
  const f = await fixture(t, { long: true });
  f.respond(input => ({ memory: { entries: [{ text: '整理出的记忆' }] } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  const profile = f.profile(), call = f.provider.calls[0];
  assert.equal(f.provider.calls.length, 1, 'one request per contact');
  assert.equal(call.input.material.length, 600);
  assert.equal(call.input.coverage.includedMessages, 600);
  assert.equal(call.input.coverage.truncated, false);
  assert.deepEqual(call.input.material.map(row => row.text), Array.from({ length: 600 }, (_, i) => `第 ${i} 条聊天内容，用于分批学习的长期记忆素材`));
  assert.match(call.system, /人物卡/);
  assert.equal(readMemory(f.a.vault, profile).summary, '', 'stored memory is untouched until confirmed');
  assert.ok(profile.pendingMemory, 'the result waits for confirmation');
  assert.match(f.a.notice, /聊天记忆学习完成/);
});

test('memory learning uses the full range to retain several durable facts and ignore boilerplate', async t => {
  const f = await fixture(t);
  const material = [
    ['other', '通过好友验证'],
    ['other', '你好呀'],
    ['other', '我对花生过敏，点餐时请避开花生和花生油'],
    ['self', '记下了，下次订餐会避开'],
    ['other', '去年冬天我们在杭州看了《宇宙探索》展览'],
    ['other', '[链接]'],
    ['other', '我生日是 11 月 12 日'],
    ['self', '收到'],
  ].map(([direction, text], index) => ({ id: `fact-${index}`, direction, text, timestamp: 1789000000 + index }));
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: structuredClone(material) });
  f.respond(input => {
    assert.equal(input.material.length, material.length, 'the complete supplied range reaches the model');
    assert.deepEqual(input.material.map(row => row.text), material.map(row => row.text));
    const system = f.provider.calls.at(-1).system;
    assert.match(system, /先通读本次实际提供的全部聊天材料/);
    assert.match(system, /排除好友验证\/通过好友验证/);
    assert.match(system, /有多条证据时逐项提取/);
    return { memory: { entries: [
      { text: '对方对花生过敏，点餐需避开花生和花生油' },
      { text: '去年冬天双方在杭州看过《宇宙探索》展览' },
      { text: '对方生日是 11 月 12 日' },
    ] } };
  });
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory', scope: 'range' });
  const pending = f.a.pendingMemoryOf(f.profile());
  assert.deepEqual(pending.entries.map(entry => entry.text), [
    '对方对花生过敏，点餐需避开花生和花生油',
    '去年冬天双方在杭州看过《宇宙探索》展览',
    '对方生日是 11 月 12 日',
  ]);
  assert.equal(f.provider.calls.length, 1);
});

test('desktop activity and input do not cancel an in-progress read-only learning task', async t => {
  const f = await fixture(t);
  let entered, release, observedSignal, idleCalls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.bridge.readRange = async args => {
    observedSignal = args.signal;
    entered();
    await gate;
    return { account: args.account, contact: args.contact, messages: [
      { id: 'incoming', direction: 'other', text: '对方说周末去看展', timestamp: 1789000000 },
      { id: 'outgoing', direction: 'self', text: '好呀我来查时间', timestamp: 1789000060 },
    ] };
  };
  f.bridge.waitForIdle = async () => { idleCalls++; };
  f.respond(() => ({ memory: { entries: [{ text: '双方计划周末看展' }] } }));
  const learning = f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  await started;
  f.a.ticking = true; // A stale scheduler tick must not let UI activity abort learning.
  f.a.userActivity();
  await f.a.manualInput({ source: 'desktop', type: 'pointerdown' });
  assert.equal(observedSignal.aborted, false);
  assert.equal(idleCalls, 1, 'manual input still waits for the native bridge interlock');
  assert.ok(f.a.userBusyUntil > 0, 'the normal user-busy window remains active');
  release();
  await learning;
  assert.equal(observedSignal.aborted, false);
  assert.equal(f.a.pendingMemoryOf(f.profile()).summary, '双方计划周末看展');
});

test('learning surfaces a concrete logged-out error instead of rewriting it as cancellation', async t => {
  const f = await fixture(t);
  f.bridge.readRange = async () => { throw new AppError('微信当前未登录，请在应用里登录后重试', 409, 'ai_wechat_logged_out'); };
  await assert.rejects(f.a.learn({ contacts: [f.contacts[0]], target: 'memory' }), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /联系人0：微信当前未登录/);
    assert.doesNotMatch(error.message, /学习已取消/);
    return true;
  });
  assert.equal(f.a.profiles().some(profile => f.a.pendingMemoryOf(profile)), false);
});

test('explicit cancellation during learning still returns the cancellation result', async t => {
  const f = await fixture(t);
  f.bridge.readRange = async args => new Promise((_resolve, reject) => {
    args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true });
  });
  const learning = f.a.learn({ contacts: [f.contacts[0]], target: 'memory' });
  const cancelled = assert.rejects(learning, /学习已取消/);
  while (f.a.operation?.phase !== 'reading') await new Promise(resolve => setImmediate(resolve));
  await f.a.cancel();
  await cancelled;
  assert.equal(f.a.profiles().some(profile => f.a.pendingMemoryOf(profile)), false);
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

test('combined learning sends one continuous bounded material per contact without duplicate memory payload', async t => {
  const f = await fixture(t);
  const source = Array.from({ length: 1600 }, (_, index) => ({
    id: `full-${index}`, direction: index % 2 ? 'self' : 'other', timestamp: 1789000000 + index,
    text: `完整范围记录${index}，含有可长期记住的事实。`,
  }));
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: structuredClone(source) });
  f.respond((input) => {
    assert.equal(input.material.length, source.length);
    assert.deepEqual(input.material.map(row => row.text), source.map(row => row.text));
    assert.equal(input.memoryCoverage.includedMessages, source.length);
    assert.equal(Object.hasOwn(input, 'memoryMaterial'), false, 'the same source must not be sent twice');
    return { style: { ...layers }, memory: { entries: [{ text: '完整范围事实' }] } };
  });
  await f.a.learn({ contacts: [f.contacts[0]], scope: 'range' });
  assert.equal(f.provider.calls.length, 1, 'style and memory share one request per contact');
  assert.notEqual(f.provider.calls[0].options?.retry, false);
  assert.equal(readMemory(f.a.vault, f.profile()).summary, '完整范围事实');
});

test('combined batch bounds each contact to 150000 codepoints and sends one material copy', async t => {
  const f = await fixture(t, { count: 2 });
  const source = Array.from({ length: 2 }, (_, contactIndex) => Array.from({ length: 2 }, (_, row) => ({
    id: `${contactIndex}-${row}`, direction: row ? 'self' : 'other', timestamp: 1789000000 + row,
    text: (contactIndex ? 'B' : 'A').repeat(80000),
  })));
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: structuredClone(source[f.contacts.indexOf(args.contact)]) });
  f.respond(input => {
    assert.equal(input.material.length, 2);
    assert.equal(Array.from(input.material, part => Array.from(part.text).length).reduce((a, b) => a + b, 0), 150000);
    assert.equal(input.memoryCoverage.includedChars, 150000);
    assert.equal(input.memoryCoverage.truncated, true);
    assert.equal(Object.hasOwn(input, 'memoryMaterial'), false);
    return { style: { ...layers }, memory: { entries: [{ text: `事实 ${input.contact}` }] } };
  });
  await f.a.learn({ contacts: f.contacts, scope: 'range' });
  assert.equal(f.provider.calls.length, 2, 'each contact is read and learned separately');
  assert.ok(f.provider.calls.every(call => call.options?.retry !== false));
  assert.deepEqual(new Set(f.provider.calls.map(call => call.input.contact)), new Set(f.contacts));
});

test('memory learning trims the oldest text to 150000 codepoints and marks coverage', async t => {
  const f = await fixture(t);
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [
    { id: 'oversized-memory-row', direction: 'self', text: '😀'.repeat(150001), timestamp: 1789000000 },
  ], rangeRevision: 'oversized-memory-range' });
  f.respond(input => ({ memory: { entries: [{ text: '可读的保留内容' }] } }));
  await f.a.learn({ contacts: [f.contacts[0]], target: 'memory', scope: 'range' });
  const call = f.provider.calls[0];
  assert.equal(f.provider.calls.length, 1);
  assert.equal(call.input.coverage.totalChars, 150001);
  assert.equal(call.input.coverage.includedChars, 150000);
  assert.equal(call.input.coverage.truncated, true);
  assert.equal(Array.from(call.input.material[0].text).length, 150000);
  assert.match(f.a.notice, /150000 个 Unicode 字符/);
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
  f.respond(input => ({ memory: { entries: [{ text: `记忆 ${input.contact}` }] } }));
  await f.a.learn({ contacts: f.contacts, target: 'memory' });
  assert.equal(f.provider.calls.length, 6, 'there is no selected-contact ceiling');
  f.provider.calls.length = 0;
  await assert.rejects(f.a.learn({ contacts: [f.contacts[0]], target: 'memory', asDefault: true }), /默认风格不包含聊天记忆/);
  const bridge = f.bridge.readRange; delete f.bridge.readRange;
  try { await assert.rejects(f.a.learn({ contacts: [f.contacts[0]], target: 'memory' }), /不支持读取全部聊天记录/); }
  finally { f.bridge.readRange = bridge; }
});
