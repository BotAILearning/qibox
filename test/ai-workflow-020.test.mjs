import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { parseSchedule, advanceSchedule } from '../server/ai-schedule.mjs';
import { styleValue } from '../server/ai-schema.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key, learnedStyle } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-09-14T10:00:00+08:00');
  bridge.stableMessageIds = true;
  const push = bridge.push.bind(bridge); bridge.push = (...args) => { const m = push(...args); m.timestamp = Math.floor(now / 1000); return m; };
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, random: (min, max) => min, interval: () => 120000 });
  await a.init(); await a.configure(modelConfig); // Model connectivity deliberately not retested.
  t.after(async () => { await a.close(); await cleanup(root); });
  const tick = async () => { await a.tick(); if (!a.available) await a.tick(); };
  const enable = async () => { await a.settings({ enabled: true, replyScope: 'all' }); await tick(); await tick(); };
  const receive = async (contact, text, answer) => { bridge.push(contact, 'other', text); await tick(); now += 8000; if (answer) provider.next = async () => answer; await tick(); };
  return { a, bridge, provider, root, enable, receive, tick, setTime: value => { now = value; }, advance: value => { now += value; } };
}

test('step 2: explicitly enabling all personal contacts ignores old history and requires a model reply', async t => {
  const { a, bridge, provider, enable, receive } = await fixture(t);
  await enable(); assert.equal(a.data.settings.enabled, true); assert.equal(a.data.settings.replyDelay, 3); assert.equal(a.configured(), false); assert.equal(bridge.sent.length, 0);
  await receive(bridge.contacts[0].id, '你觉得怎么样？', { action: 'send', text: '挺好的，你呢？' });
  assert.equal(bridge.sent.length, 1); assert.equal(provider.calls[0].input.judgeReply, false);
  await receive(bridge.contacts[0].id, '不用回了', { action: 'skip' }); assert.equal(bridge.sent.length, 2);
  assert.equal(a.publicState().skipRecords.some(record => record.source === 'model-skip'), false);
});

test('step 3 and 6: simultaneous contacts retain separate custom styles, strategies and destination identities', async t => {
  const { a, bridge, provider, enable, tick, advance } = await fixture(t); await enable();
  const [one, two] = bridge.contacts;
  await a.saveReplyProfile({ contact: one.id, style: { summary: '叫对方宝，温柔简短' }, strategy: { replyGoal: '安慰', facts: '甲的事实' } });
  await a.saveReplyProfile({ contact: two.id, style: { summary: '正式清晰' }, strategy: { replyGoal: '解释', facts: '乙的事实' } });
  const complete = provider.complete.bind(provider);
  provider.complete = async (...args) => { const input = args[2]; provider.next = async () => ({ action: 'send', text: input.style.summary.includes('宝') ? '宝，明白啦。' : '收到，我说明一下。' }); return complete(...args); };
  bridge.push(one.id, 'other', '甲的问题'); bridge.push(two.id, 'other', '乙的问题'); await tick(); advance(8000); await tick();
  assert.deepEqual(bridge.sent.map(x => [x.contact, x.text]), [[one.id, '宝，明白啦。'], [two.id, '收到，我说明一下。']]);
  for (const [index, call] of provider.calls.entries()) { assert.equal(call.input.strategy.facts, index ? '乙的事实' : '甲的事实'); assert.equal(JSON.stringify(call.input).includes(index ? '甲的问题' : '乙的问题'), false); }
});

test('resuming a paused contact ignores earlier incoming messages, including messages from the same second', async t => {
  const { a, bridge, provider, enable, receive, tick, advance } = await fixture(t); await enable();
  const profile = a.profiles().find(p => p.contact === bridge.contacts[0].id);
  bridge.push(profile.contact, 'other', '尚未回复的旧消息'); await tick();
  await a.editProfile(profile.id, { style: profile.style, paused: true });
  bridge.push(profile.contact, 'other', '暂停期间的消息');
  await a.editProfile(profile.id, { style: profile.style, paused: false });
  advance(8000); await tick(); assert.equal(provider.calls.length, 0); assert.equal(bridge.sent.length, 0);
  await receive(profile.contact, '恢复后的新问题', { action: 'send', text: '新消息已收到。' });
  assert.equal(bridge.sent.length, 1); assert.equal(bridge.sent[0].contact, profile.contact);
});

test('slow model responses overlap across contacts and out-of-order completion retains the right context and recipient', async t => {
  const { a, bridge, provider, enable, tick, advance } = await fixture(t); await enable();
  const [one, two] = bridge.contacts;
  await a.saveReplyProfile({ contact: one.id, style: { summary: '第一位的简短风格' }, strategy: {} });
  await a.saveReplyProfile({ contact: two.id, style: { summary: '第二位的详细风格' }, strategy: {} });
  bridge.push(one.id, 'other', '第一位的新问题'); bridge.push(two.id, 'other', '第二位的新问题'); await tick(); advance(4000);
  const started = Promise.withResolvers(), release = Promise.withResolvers(); let calls = 0;
  provider.complete = async (config, system, input) => {
    const first = input.style.summary.includes('第一位'); calls++;
    if (first) await release.promise;
    else { assert.equal(calls, 2); assert.equal(input.messages.some(m => m.text === '第一位的新问题'), false); started.resolve(); }
    return { action: 'send', text: first ? '第一位的回答。' : '第二位的回答。' };
  };
  const running = tick();
  try { await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('models did not overlap')), 1000))]); }
  finally { release.resolve(); }
  await running;
  assert.equal(bridge.sent.length, 2);
  assert.deepEqual(new Map(bridge.sent.map(m => [m.contact, m.text])), new Map([[one.id, '第一位的回答。'], [two.id, '第二位的回答。']]));
});

test('background polling notices a second sender while the first reply is still generating', async t => {
  const { a, bridge, provider, enable, advance } = await fixture(t); await enable();
  const [one, two] = bridge.contacts, gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const seen = [];
  provider.complete = async (config, system, input) => {
    const first = input.messages.some(m => m.text === '先来的问题');
    seen.push(first ? one.id : two.id);
    if (first) { entered.resolve(); await gate.promise; }
    return { action: 'send', text: first ? '第一位的回答。' : '第二位的回答。' };
  };
  bridge.push(one.id, 'other', '先来的问题'); await a.tick({ background: true }); advance(4000); await a.tick({ background: true });
  await entered.promise;
  try {
    bridge.push(two.id, 'other', '后来的问题'); await a.tick({ background: true }); advance(4000); await a.tick({ background: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [one.id, two.id]);
    assert.equal(a.activeRuns.has(a.profiles().find(p => p.contact === one.id).id), true);
  } finally { gate.resolve(); }
  await Promise.allSettled([...a.activeRuns.values()]);
  assert.deepEqual(new Map(bridge.sent.map(m => [m.contact, m.text])), new Map([[one.id, '第一位的回答。'], [two.id, '第二位的回答。']]));
});

test('background proactive polling never starts a second recipient before the configured interval', async t => {
  const { a, bridge, provider, enable, advance } = await fixture(t); await enable();
  await a.prepareTargets({ contacts: bridge.contacts.slice(0, 2).map(c => c.id) });
  await a.saveStrategy({ purpose: '问候', content: '问好' }); await a.settings({ proactive: true }); await a.queueAction('start');
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); let calls = 0;
  provider.complete = async () => { calls++; entered.resolve(); await gate.promise; return { action: 'send', text: '你好。' }; };
  await a.tick({ background: true }); await entered.promise;
  for (let i = 0; i < 3; i++) { advance(4000); await a.tick({ background: true }); }
  assert.equal(calls, 1); gate.resolve(); await Promise.allSettled([...a.activeRuns.values()]);
  await a.tick({ background: true }); assert.equal(calls, 1);
  advance(120000); await a.tick({ background: true }); advance(3000); await a.tick({ background: true }); await Promise.allSettled([...a.activeRuns.values()]);
  assert.equal(calls, 2); assert.equal(bridge.sent.length, 2);
});

test('step 4: batch learning calls each contact with a valid five-layer result', async t => {
  const { a, bridge, provider, enable, receive } = await fixture(t); await enable();
  provider.next = async input => ({ style: learnedStyle(input.contact === bridge.contacts[0].id ? '习惯称呼对方为【宝】，例如【宝，吃饭了吗？】。' : '礼貌，直接说明。') });
  await a.learn({ contacts: bridge.contacts.slice(0, 2).map(c => c.id) });
  const profile = a.profiles().find(p => p.contact === bridge.contacts[0].id); assert.match(profile.style.summary, /【宝】/);
  assert.equal(provider.calls.length, 2); assert.ok(provider.calls.every(call => call.input.material && !Object.hasOwn(call.input, 'conversations')));
  await a.editProfile(profile.id, { style: { summary: '称呼对方为【宝贝】，少量问句。', customAvoid: '不要催促' } });
  await receive(profile.contact, '现在方便吗？', { action: 'send', text: '宝贝，方便的。' });
  assert.equal(provider.calls.at(-1).input.style.summary, profile.style.summary); assert.equal(provider.calls.at(-1).input.style.customAvoid, '不要催促');
  assert.equal(styleValue({ summary: '完全自定义的风格，不依赖分类。' }).summary, '完全自定义的风格，不依赖分类。');
});

test('reply format retains punctuation and skips model self introductions', async t => {
  const { a, bridge, provider, enable, receive } = await fixture(t); await enable();
  await receive(bridge.contacts[0].id, '你好', { action: 'send', text: '你好呀' }); assert.equal(bridge.sent[0].text, '你好呀');
  await receive(bridge.contacts[0].id, '你是AI吗', { action: 'send', text: '作为AI，我可以帮助你。' }); assert.equal(bridge.sent.length, 1);
  assert.match(provider.calls.at(-1).system, /不要永远不用问句/); assert.match(provider.calls.at(-1).system, /表示是本人/);
  assert.ok(a.profiles()[0].generatedIds.length);
});

test('review reads the exact chat, rejects stale confirmation and resumes without repeating an uncertain send', async t => {
  const { a, bridge, enable, receive, tick, advance } = await fixture(t); await enable();
  bridge.delivery = async () => ({ status: 'uncertain' });
  await receive(bridge.contacts[0].id, '收到吗？', { action: 'send', text: '收到了。' });
  const profile = a.profiles().find(p => p.contact === bridge.contacts[0].id);
  assert.equal(profile.paused, false); assert.equal(profile.delivery.status, 'uncertain');
  const first = await a.review(profile.id); assert.equal(first.messages.at(-1).text, '收到吗？');
  bridge.push(profile.contact, 'self', '手动处理了。');
  await assert.rejects(a.review(profile.id, { resolve: true, revision: first.revision }), /新变化/);
  const fresh = await a.review(profile.id); await a.review(profile.id, { resolve: true, revision: fresh.revision });
  assert.equal(profile.delivery.status, 'reviewed'); bridge.delivery = null;
  advance(8000); await tick(); assert.equal(bridge.sent.length, 0);
  await receive(profile.contact, '下一个问题', { action: 'send', text: '好的。' }); assert.equal(bridge.sent.length, 1);
});

test('step 5: scheduled openings run once, retain their strategy, persist and cancel without sending', async t => {
  const { a, bridge, provider, enable, tick, setTime, root } = await fixture(t); await enable(); await a.settings({ proactive: true });
  const strategy = { purpose: '关心甲', content: '简单问候', persona: '' };
  await a.scheduleAction({ contacts: [bridge.contacts[0].id], strategy, time: '10分钟后' });
  const task = a.data.schedules[0]; await a.saveStrategy({ purpose: '其他目标', content: '无关内容' });
  assert.equal(JSON.parse(await readFile(a.file)).schedules[0].nextAt, task.nextAt);
  setTime(task.nextAt - 1); await tick(); await tick(); assert.equal(bridge.sent.length, 0);
  setTime(task.nextAt); await tick(); assert.equal(bridge.sent.length, 1); assert.equal(provider.calls.at(-1).input.strategy.purpose, '关心甲');
  assert.equal(task.status, 'completed'); await tick(); assert.equal(bridge.sent.length, 1);
  await a.scheduleAction({ contacts: [bridge.contacts[1].id], strategy, time: '每天晚上' });
  await a.scheduleAction({ command: 'cancel', id: a.data.schedules[1].id }); assert.equal(a.data.schedules[1].nextAt, null);
});

test('fuzzy repeating schedules draw a fresh time each day, retain calendar bounds and do not replay missed days', () => {
  const now = Date.parse('2026-09-14T10:00:00+08:00'); let draws = 0;
  const random = (min, max) => { draws++; return draws % 2 ? min + 90 : min + 100; };
  const schedule = parseSchedule('每天晚上', now, random);
  assert.equal(new Date(schedule.nextAt).toISOString(), '2026-09-14T12:30:00.000Z');
  schedule.nextAt = advanceSchedule(schedule, schedule.nextAt, random);
  assert.equal(new Date(schedule.nextAt).toISOString(), '2026-09-15T12:40:00.000Z'); assert.equal(draws, 2);
  schedule.nextAt = advanceSchedule(schedule, Date.parse('2026-09-20T23:00:00+08:00'), (min, max) => max);
  assert.equal(new Date(schedule.nextAt).toISOString(), '2026-09-21T13:00:00.000Z');
  for (const text of ['明晚', '明天晚上八点半', '每周五下午3点', '每天上午', '2026-09-15T20:30:00+08:00']) assert.ok(parseSchedule(text, now).nextAt > now);
  for (const text of ['随便', '每天25点', '每天8点80分', '2026-09-13T10:00:00+08:00']) assert.throws(() => parseSchedule(text, now));
});

test('legacy random schedules preserve their original timing in the migration archive and do not run after upgrade', async t => {
  const { a, bridge, provider, root, enable, setTime } = await fixture(t); await enable();
  await a.settings({ proactive: true });
  await a.scheduleAction({ contacts: [bridge.contacts[0].id], strategy: { purpose: '问候', content: '简单问候' }, time: '每天晚上' });
  const dueAt = a.data.schedules[0].nextAt; await a.close(); let draws = 0;
  const restarted = new AIAssistant({ dataRoot: root, bridge, provider, now: () => dueAt, random: (min, max) => { draws++; return max; } });
  await restarted.init(); t.after(() => restarted.close());
  assert.equal(restarted.data.proactiveLegacy.schedules[0].nextAt, dueAt); assert.equal(draws, 0);
  assert.equal(restarted.data.schedules[0].nextAt, null);
  assert.equal(restarted.publicState().proactiveTasks[0].migrationRequired, true);
  assert.equal(restarted.publicState().proactiveTasks[0].status, 'paused');
  await restarted.scan(); await restarted.tick();
  assert.equal(bridge.sent.length, 0); assert.equal(draws, 0);
  await restarted.tick(); assert.equal(bridge.sent.length, 0);
});

test('learning excludes previous AI-generated outgoing messages and never resumes an uncertain delivery', async t => {
  const { a, bridge, provider, enable, receive } = await fixture(t); await enable();
  await receive(bridge.contacts[0].id, '你好', { action: 'send', text: 'AI代发的文字。' });
  const profile = a.profiles().find(p => p.contact === bridge.contacts[0].id); profile.paused = true; profile.delivery = { status: 'uncertain' };
  provider.next = async input => { assert.equal(JSON.stringify(input).includes('AI代发的文字'), false); return { style: learnedStyle('简短自然。') }; };
  await a.learn({ contacts: [profile.contact] }); assert.equal(a.profile(profile.id).paused, true); assert.equal(a.profile(profile.id).delivery.status, 'uncertain');
});
