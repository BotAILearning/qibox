import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { proactiveSchedule, nextProactiveOccurrence } from '../server/ai-proactive-schedule.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const at = text => Date.parse(text + '+08:00');
const low = (min) => min, high = (min, max) => max;
const baseTime = at('2026-09-17T12:00:00');
async function fixture(t, options = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let time = baseTime;
  // Proactive sends now wait out the manual-activity window through ai.delay(),
  // so the injected delay advances the same virtual clock now() reports instead
  // of sleeping for real. Without it every manual-window case costs five minutes.
  const args = { dataRoot: root, bridge, provider, now: () => time, random: low, delay: async ms => { time += ms; }, ...options };
  const a = new AIAssistant(args); await a.init(); await a.configure(modelConfig); await a.scan();
  // All message dispatches in this suite use the in-memory fixture, never native.
  await a.settings({ reply: false });
  const instances = [a];
  t.after(async () => { for (const instance of instances) if (!instance.closed) await instance.close(); await cleanup(root); });
  return { a, bridge, provider, root, args, advance: n => time += n,
    async restart() { await a.close(); const b = new AIAssistant(args); instances.push(b); await b.init(); await b.scan(); return b; } };
}
function input(bridge, values = {}) { return { command: 'create', name: '测试任务', taskType: 'greeting', contacts: [bridge.contacts[0].id], goal: '询问周末是否有空', requirements: '', schedule: { cycle: 'once' }, ...values }; }
async function create(a, bridge, values) { const before = new Set(a.data.proactiveTasks.map(t => t.id)); await a.proactiveTaskAction(input(bridge, values)); return a.data.proactiveTasks.find(t => !before.has(t.id)); }
async function ticks(a, count = 5) { for (let n = 0; n < count; n++) await a.tick(); }

test('calendar: immediate ignores hidden time fields; explicit Shanghai dates independent of host zone', () => {
  const once = proactiveSchedule({ cycle: 'once', mode: 'garbage', time: 'bad', startDate: 'bad' }, baseTime);
  assert.equal(nextProactiveOccurrence(once, baseTime, low).nextAt, baseTime);
  const daily = proactiveSchedule({ cycle: 'daily', mode: 'fixed', time: '14:40' }, baseTime);
  assert.equal(nextProactiveOccurrence(daily, baseTime, low).nextAt, at('2026-09-17T14:40:00'));
  assert.equal(nextProactiveOccurrence(daily, at('2026-09-17T15:00:00'), low).nextAt, at('2026-09-18T14:40:00'));
});

test('calendar: weekdays are Monday-Friday, weekly supports multiple days, custom anchors every N days', () => {
  const weekday = proactiveSchedule({ cycle: 'weekdays', mode: 'fixed', time: '09:00' }, baseTime);
  assert.equal(nextProactiveOccurrence(weekday, at('2026-09-18T12:00:00'), low).nextAt, at('2026-09-21T09:00:00'));
  const weekly = proactiveSchedule({ cycle: 'weekly', mode: 'fixed', time: '09:00', weekdays: [0, 1, 3, 1] }, baseTime);
  assert.deepEqual(weekly.weekdays, [0, 1, 3]);
  assert.equal(nextProactiveOccurrence(weekly, baseTime, low).nextAt, at('2026-09-20T09:00:00'));
  const custom = proactiveSchedule({ cycle: 'custom', mode: 'fixed', time: '09:00', intervalDays: 2, startDate: '2026-09-16' }, baseTime);
  assert.equal(nextProactiveOccurrence(custom, baseTime, low).nextAt, at('2026-09-18T09:00:00'));
  assert.equal(nextProactiveOccurrence(custom, at('2026-09-24T10:00:00'), low, '2026-09-18').nextAt, at('2026-09-26T09:00:00'));
});

test('calendar: cross-midnight random belongs to starting day and cannot repeat that window', () => {
  const schedule = proactiveSchedule({ cycle: 'weekly', mode: 'random', start: '23:00', end: '02:00', weekdays: [5], startDate: '2026-09-01' }, baseTime);
  const friday = nextProactiveOccurrence(schedule, at('2026-09-18T20:00:00'), high);
  assert.deepEqual(friday, { nextAt: at('2026-09-19T02:00:00'), occurrenceDate: '2026-09-18' });
  const saturday = nextProactiveOccurrence(schedule, at('2026-09-19T00:30:00'), low);
  assert.equal(saturday.nextAt, at('2026-09-19T00:30:00'));
  assert.equal(saturday.occurrenceDate, '2026-09-18');
  assert.equal(nextProactiveOccurrence(schedule, saturday.nextAt, low, saturday.occurrenceDate).nextAt, at('2026-09-25T23:00:00'));
  for (const value of [{ cycle: 'custom', intervalDays: 0 }, { cycle: 'weekly', weekdays: [] }, { cycle: 'daily', mode: 'random', start: '18:00', end: '18:00' }, { cycle: 'daily', startDate: '2026-02-30' }, { cycle: 'daily', time: '24:00' }]) {
    assert.throws(() => proactiveSchedule({ mode: 'fixed', time: '12:00', ...value }, baseTime));
  }
});

test('creation is account-scoped idempotent, persists taskType and version, only enables requested switches', async t => {
  const { a, bridge } = await fixture(t);
  const payload = input(bridge, { requestId: 'request-unique-001' });
  const [first, second] = await Promise.all([a.proactiveTaskAction(payload), a.proactiveTaskAction(payload)]);
  assert.equal(a.data.proactiveTasks.length, 1); assert.equal(first.proactiveTasks[0].id, second.proactiveTasks[0].id);
  assert.deepEqual([a.data.settings.enabled, a.data.settings.proactive, a.data.settings.reply], [true, true, false]);
  const task = a.data.proactiveTasks[0];
  assert.equal(first.proactiveTasks[0].version, 1); assert.equal(task.taskType, 'greeting');
  await a.proactiveTaskAction({ command: 'edit', id: task.id, version: 1, taskType: 'work', goal: '跟进活动' });
  assert.equal(task.taskType, 'work'); assert.equal(task.revision, 2);
  await assert.rejects(a.proactiveTaskAction({ command: 'edit', id: task.id, version: 1, name: '覆盖' }), /已被修改/);
  await a.proactiveTaskAction({ command: 'delete', id: task.id });
  await a.proactiveTaskAction(payload); assert.equal(a.data.proactiveTasks.length, 1); assert.equal(a.publicState().proactiveTasks.length, 0);
});

test('save is allowed without model, prerequisites exposed, switches prevent dispatch', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  a.config = null; const task = await create(a, bridge);
  assert.ok(a.publicState().proactiveRequirements.some(x => x.includes('模型'))); await ticks(a); assert.equal(provider.calls.length, 0);
  await a.configure(modelConfig); await a.settings({ proactive: false }); await ticks(a); assert.equal(bridge.sent.length, 0);
  await a.settings({ proactive: true, enabled: false }); await ticks(a); assert.equal(bridge.sent.length, 0);
  await a.settings({ enabled: true }); await ticks(a); assert.equal(bridge.sent.length, 1); assert.equal(task.status, 'ended');
});

test('each recipient uses own learned style or natural default and persisted exact confirmed record', async t => {
  const { a, bridge, provider, root } = await fixture(t);
  await a.learn({ contacts: [bridge.contacts[0].id] });
  const learned = a.profiles().find(p => p.contact === bridge.contacts[0].id); learned.learnedStyle = { summary: '旧学习快照' }; learned.style = { summary: '仅甲适用的学习风格' };
  provider.calls.length = 0;
  const task = await create(a, bridge, { contacts: bridge.contacts.map(c => c.id) }); await ticks(a);
  assert.equal(bridge.sent.length, 3); assert.equal(task.status, 'ended'); assert.equal(provider.calls.length, 3);
  assert.equal(provider.calls[0].input.style.summary, '仅甲适用的学习风格');
  assert.match(provider.calls[1].input.style.summary, /自然/); assert.match(provider.calls[2].input.style.summary, /自然/);
  assert.equal(a.data.proactiveRecords.length, 3);
  for (const record of a.data.proactiveRecords) {
    assert.equal(record.status, 'sent'); assert.equal(a.proactiveRecords({}).records.find(r => r.id === record.id).text, 'GENERATED_PRIVATE_MARKER'); assert.ok(record.messageId); assert.equal(record.taskName, task.name);
    assert.equal(a.data.profiles[record.profileId].sentMessages.at(-1).taskId, task.id);
  }
  assert.equal(a.activitySummaries().length, 0);
  const disk = JSON.parse(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'));
  assert.equal(disk.proactiveRecords.length, 3); assert.equal(disk.proactiveTasks[0].status, 'ended');
  assert.equal(JSON.stringify(disk).includes('GENERATED_PRIVATE_MARKER'), false);
});

test('an affection task respects confirmed plans, avoids invented body facts and sends one grounded message', async t => {
  const { a, bridge, provider, advance } = await fixture(t);
  const contact = bridge.contacts[0].id;
  const filler = Array.from({ length: 43 }, (_, index) => ({ id: key(`older-${index}`), direction: index % 2 ? 'self' : 'other',
    text: `较早的普通聊天记录 ${index}`, timestamp: Math.floor(at('2026-09-16T09:00:00') / 1000) + index }));
  const recent = [
    { id: key('dinner-plan'), direction: 'self', text: '我今晚约朋友吃饭', timestamp: Math.floor(at('2026-09-17T13:30:00') / 1000) },
    { id: key('pickup-offer'), direction: 'other', text: '明天我来宿舍接你', timestamp: Math.floor(at('2026-09-17T13:31:00') / 1000) },
    { id: key('pickup-confirmed'), direction: 'self', text: '好，明天你来接我', timestamp: Math.floor(at('2026-09-17T13:34:00') / 1000) },
    { id: key('old-ai-1'), direction: 'self', text: '老公，我好喜欢你呀', timestamp: Math.floor(at('2026-09-17T14:13:00') / 1000) },
    { id: key('old-ai-2'), direction: 'self', text: '明天见~晚安宝', timestamp: Math.floor(at('2026-09-17T14:14:00') / 1000) },
    { id: key('runny-nose'), direction: 'other', text: '我有点流鼻涕', timestamp: Math.floor(at('2026-09-17T15:46:00') / 1000) },
    { id: key('care-already-sent'), direction: 'self', text: '流鼻涕要注意哦，多喝热水', timestamp: Math.floor(at('2026-09-17T15:51:00') / 1000) },
  ];
  bridge.messages.set(contact, [...filler, ...recent]);
  a.data.settings.enabled = true; a.data.settings.reply = true; a.data.settings.replyScope = 'all'; a.ensureDefaultProfiles();
  const profile = a.profiles().find(row => row.contact === contact);
  profile.generatedIds = recent.filter(message => message.id === key('old-ai-1') || message.id === key('old-ai-2')).map(message => message.id);
  profile.replyStyleSet = true;
  advance(4 * 3600000);
  let generatedInput, generatedSystem;
  provider.next = async input => {
    generatedInput = input; generatedSystem = provider.calls.at(-1).system;
    return { action: 'send', text: '想你了宝' };
  };
  await create(a, bridge, { goal: '表达爱意', requirements: '根据历史消息，日常关心', sendMode: 'segments' });
  a.profiles().find(row => row.contact === contact).style.summary = '自然、简洁；没有依据时不添加称呼';
  await ticks(a);
  assert.equal(generatedInput.strategy.purpose, '表达爱意');
  assert.equal(generatedInput.strategy.content, '表达爱意');
  assert.equal(generatedInput.strategy.facts, '');
  assert.equal(generatedInput.strategy.boundaries, '根据历史消息，日常关心');
  assert.deepEqual(generatedInput.messages.slice(-7).map(message => message.text), recent.map(message => message.text));
  assert.ok(generatedInput.messages.slice(-7).filter(message => message.id === key('old-ai-1') || message.id === key('old-ai-2')).every(message => message.aiGenerated));
  assert.ok(generatedInput.conversation.recentSelfMessages.some(message => message.text.includes('今晚约朋友吃饭')));
  assert.ok(generatedInput.conversation.recentSelfMessages.some(message => message.text.includes('多喝热水')));
  assert.ok(generatedInput.conversation.recentSelfMessages.filter(message => message.text.includes('老公') || message.text.includes('晚安宝')).every(message => message.aiGenerated));
  assert.equal(generatedInput.conversation.latestIncoming.text, '我有点流鼻涕');
  assert.equal(generatedInput.timezone, 'Asia/Shanghai'); assert.match(generatedInput.currentTime, /^2026-09-17T16:/);
  assert.match(generatedSystem, /最近明确安排优先于旧计划/);
  assert.match(generatedSystem, /开车回去.*不能推断.*身体酸痛、需要按摩/);
  assert.match(generatedSystem, /本人已经表达过的关心/);
  assert.match(generatedSystem, /默认用一条自然连贯的 text/);
  assert.match(generatedSystem, /已确认事项按已定事实处理/);
  assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0].text, '想你了');
  assert.doesNotMatch(bridge.sent[0].text, /腰酸|按摩|早点回来|今晚回来|明天来接|流鼻涕|多喝热水|宝/);
  assert.equal(a.data.proactiveRecords[0].status, 'sent');
});

test('random draws persist across polling, pause/resume and restart; next draw only after occurrence completes', async t => {
  let draws = 0;
  const f = await fixture(t, { random: (min, max) => { draws++; return max - 60000; } });
  const task = await create(f.a, f.bridge, { schedule: { cycle: 'daily', mode: 'random', start: '13:00', end: '14:00' } });
  const chosen = task.nextAt; assert.equal(draws, 1);
  await ticks(f.a); f.a.publicState(); await f.a.proactiveTaskAction({ command: 'pause', id: task.id }); await f.a.proactiveTaskAction({ command: 'resume', id: task.id });
  assert.equal(task.nextAt, chosen); assert.equal(draws, 1);
  const b = await f.restart(); assert.equal(b.data.proactiveTasks[0].nextAt, chosen); assert.equal(draws, 1);
  f.advance(2 * 3600000 - 60000); await ticks(b); assert.equal(draws, 2); assert.equal(b.data.proactiveTasks[0].nextAt, at('2026-09-18T13:59:00')); assert.equal(f.bridge.sent.length, 1);
});

test('paused and failed tasks do not block unrelated tasks or remaining recipients', async t => {
  const { a, bridge, provider } = await fixture(t);
  const paused = await create(a, bridge); await a.proactiveTaskAction({ command: 'pause', id: paused.id });
  const failing = await create(a, bridge, { name: '部分失败', contacts: [bridge.contacts[0].id, bridge.contacts[1].id] });
  const okay = await create(a, bridge, { name: '独立任务', contacts: [bridge.contacts[2].id] });
  provider.next = async () => { throw new Error('fixture model failure'); };
  await ticks(a, 8);
  assert.equal(paused.status, 'paused'); assert.equal(failing.status, 'failed'); assert.equal(okay.status, 'ended');
  assert.equal(bridge.sent.length, 2); assert.equal(a.available, true); assert.equal(a.retryAt || 0, 0);
  await a.proactiveTaskAction({ command: 'retry', id: failing.id }); await ticks(a);
  assert.equal(bridge.sent.length, 3); assert.equal(failing.status, 'ended');
  assert.equal(bridge.sent.filter(s => s.contact === bridge.contacts[1].id).length, 1);
});

test('native not-sent is isolated/retryable; unknown is terminal and does not block other contacts', async t => {
  const { a, bridge } = await fixture(t);
  const task = await create(a, bridge, { contacts: bridge.contacts.map(c => c.id) });
  bridge.delivery = async r => r.contact === bridge.contacts[0].id ? { status: 'uncertain' } : r.contact === bridge.contacts[1].id ? { status: 'not-sent' } : { status: 'sent', messageId: key('confirmed'), revision: r.revision };
  await ticks(a);
  assert.deepEqual(task.run.items.map(i => i.status), ['unknown', 'failed', 'sent']); assert.equal(task.status, 'failed'); assert.equal(a.available, true);
  const calls = [];
  bridge.delivery = async r => { calls.push(r.contact); return { status: 'sent', messageId: key('confirmed retry'), revision: r.revision }; };
  await a.proactiveTaskAction({ command: 'retry', id: task.id }); await ticks(a);
  assert.deepEqual(calls, [bridge.contacts[1].id]); assert.equal(task.status, 'ended');
  await assert.rejects(a.proactiveTaskAction({ command: 'retry', id: task.id }), /任务已结束/);
});

test('pause/edit/end/delete during model generation cancel stale text without reviving task', async t => {
  for (const command of ['pause', 'edit', 'end', 'delete']) {
    const { a, bridge, provider } = await fixture(t);
    const task = await create(a, bridge);
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    provider.next = async () => { started.resolve(); await release.promise; return { action: 'send', text: '过期正文' }; };
    const running = a.tick(); await started.promise;
    await a.proactiveTaskAction({ command, id: task.id, ...(command === 'edit' ? { goal: '新目标', version: task.revision } : {}) });
    release.resolve(); await running;
    assert.equal(bridge.sent.length, 0, command);
    if (command === 'edit') { await ticks(a); assert.equal(provider.calls.at(-1).input.strategy.purpose, '新目标'); assert.equal(bridge.sent.length, 1); }
    else if (command === 'pause') { await a.proactiveTaskAction({ command: 'resume', id: task.id }); await ticks(a); assert.equal(bridge.sent.length, 1); }
    else { await ticks(a); assert.equal(bridge.sent.length, 0); assert.equal(task.status, 'ended'); }
  }
});

test('native cancellation keeps late confirmed receipt, soft deletion tombstone and immutable task name', async t => {
  const { a, bridge } = await fixture(t);
  const task = await create(a, bridge, { name: '发送时名称' });
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  bridge.delivery = async r => { started.resolve(); await release.promise; assert.equal(r.signal.aborted, true); return { status: 'sent', messageId: key('late receipt'), revision: r.revision }; };
  const running = a.tick(); await started.promise;
  await a.proactiveTaskAction({ command: 'delete', id: task.id }); release.resolve(); await running;
  assert.equal(task.status, 'ended'); assert.ok(task.deletedAt); assert.equal(a.publicState().proactiveTasks.length, 0);
  const record = a.proactiveRecords({ taskId: task.id }).records[0]; assert.equal(record.status, 'sent'); assert.equal(record.taskName, '发送时名称');
  await ticks(a); assert.equal(a.data.proactiveRecords.length, 1);
});

test('pause during native submission with confirmed receipt does not repeat once task on resume', async t => {
  const { a, bridge } = await fixture(t); const task = await create(a, bridge);
  const started = Promise.withResolvers(), release = Promise.withResolvers(); let calls = 0;
  bridge.delivery = async r => { calls++; started.resolve(); await release.promise; return { status: 'sent', messageId: key('pause receipt'), revision: r.revision }; };
  const running = a.tick(); await started.promise; await a.proactiveTaskAction({ command: 'pause', id: task.id }); release.resolve(); await running;
  await a.proactiveTaskAction({ command: 'resume', id: task.id }); await ticks(a);
  assert.equal(calls, 1); assert.equal(task.status, 'ended');
});

test('cancelled native submission: stale can resume, unknown is consumed without verification', async t => {
  for (const status of ['stale', 'uncertain']) {
    const { a, bridge } = await fixture(t); const task = await create(a, bridge);
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    bridge.delivery = async () => { started.resolve(); await release.promise; return { status }; };
    const running = a.tick(); await started.promise; await a.proactiveTaskAction({ command: 'pause', id: task.id }); release.resolve(); await running;
    if (status === 'stale') { bridge.delivery = null; await a.proactiveTaskAction({ command: 'resume', id: task.id }); await ticks(a); assert.equal(bridge.sent.length, 1); }
    else { assert.equal(task.run.items[0].status, 'unknown'); assert.equal(task.status, 'paused'); assert.equal(bridge.sent.length, 0); await a.proactiveTaskAction({ command: 'resume', id: task.id }); assert.equal(task.status, 'ended'); }
  }
});

test('restart clears legacy pending verification and resumes pre-submit generation safely', async t => {
  for (const phase of ['generating', 'sending']) {
    const { a, bridge, root, args } = await fixture(t); const task = await create(a, bridge);
    task.run = { id: 'crash-run', at: baseTime, occurrenceDate: 'once', items: [{ ...a.proactiveV2.item(task.contacts[0]), status: phase }] };
    await a.save(); await a.close();
    const b = new AIAssistant(args); t.after(() => b.close()); await b.init(); await b.scan(); await ticks(b);
    assert.equal(bridge.sent.length, phase === 'generating' ? 1 : 0);
    if (phase === 'sending') { assert.equal(b.data.proactiveTasks[0].status, 'ended'); assert.equal(b.proactiveRecords({}).records[0].status, 'unknown'); }
    const disk = JSON.parse(await readFile(path.join(root, 'ai-assistant.json'), 'utf8')); assert.equal(disk.proactiveVersion, 2);
    await b.close();
  }
});

test('startup migrates legacy pending verification data without resending', async t => {
  const { a, bridge, root, args } = await fixture(t), task = await create(a, bridge);
  const profile = a.data.profiles[task.contacts[0].profileId];
  profile.delivery = { status: 'uncertain', source: 'reply' };
  profile.proactiveDelivery = { status: 'uncertain', source: 'proactive' };
  profile.paused = true; profile.pauseReason = 'uncertain';
  profile.sentMessages = [{ id: 'legacy-pending', at: baseTime, body: a.vault.seal({ text: '旧待核验内容' }), source: 'reply', confirmed: false }];
  task.status = 'failed'; task.reason = '发送结果待核对';
  task.run = { id: 'legacy-run', at: baseTime, schedule: structuredClone(task.schedule), occurrenceDate: 'once', completedAt: baseTime,
    items: [{ ...a.proactiveV2.item(task.contacts[0]), status: 'uncertain', recordId: 'legacy-record' }] };
  a.data.proactiveRecords.push({ id: 'legacy-record', account: task.account, taskId: task.id, profileId: profile.id, contact: profile.contact, status: 'uncertain', body: a.vault.seal({ text: '旧待核验正文' }) });
  a.data.queue = { status: 'paused', items: [{ id: profile.id, status: 'uncertain' }, { id: 'legacy-sending', status: 'sending' }], nextAt: null };
  await a.save(); await a.close();
  const b = new AIAssistant(args); t.after(() => b.close()); await b.init();
  const migratedProfile = b.data.profiles[profile.id];
  assert.equal(migratedProfile.delivery.status, 'unknown'); assert.equal(migratedProfile.proactiveDelivery.status, 'unknown');
  assert.equal(migratedProfile.paused, false); assert.equal(migratedProfile.pauseReason, undefined); assert.deepEqual(migratedProfile.sentMessages, []);
  assert.deepEqual(b.data.queue.items.map(item => item.status), ['skipped', 'skipped']); assert.equal(b.data.queue.status, 'completed');
  assert.equal(b.data.proactiveTasks[0].run.items[0].status, 'unknown'); assert.equal(b.data.proactiveTasks[0].status, 'ended');
  const record = b.data.proactiveRecords.find(row => row.id === 'legacy-record');
  assert.equal(record.status, 'unknown'); assert.equal(record.body, undefined); assert.equal(record.text, undefined);
  assert.equal(bridge.sent.length, 0);
});

test('account switch hides tasks/records, cannot mutate foreign task, in-flight account remains bound', async t => {
  const { a, bridge, provider } = await fixture(t); const task = await create(a, bridge, { requestId: 'account-request' });
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  provider.next = async () => { started.resolve(); await release.promise; return { action: 'send', text: 'old account' }; };
  const running = a.tick(); await started.promise; const firstAccount = bridge.account;
  bridge.account = key('second account'); await a.scan(); release.resolve(); await running;
  assert.equal(bridge.sent.length, 0); assert.equal(a.publicState().proactiveTasks.length, 0); assert.deepEqual(a.proactiveRecords({}).records, []);
  await assert.rejects(a.proactiveTaskAction({ command: 'delete', id: task.id }), /当前账号/);
  const other = await create(a, bridge, { requestId: 'account-request' }); assert.notEqual(other.id, task.id); await ticks(a);
  bridge.account = firstAccount; await a.scan(); assert.equal(a.publicState().proactiveTasks.length, 1); assert.equal(a.publicState().proactiveTasks[0].id, task.id);
});

test('legacy migration preserves data paused, requires review, and legacy ticks cannot execute after switch', async t => {
  const { a, bridge, root, args } = await fixture(t);
  await a.prepareTargets({ contacts: [bridge.contacts[0].id] });
  const profile = a.profiles()[0];
  a.data.queue = { status: 'running', items: [{ id: profile.id, status: 'pending' }], nextAt: baseTime };
  a.data.schedules = [{ id: 'legacy', account: a.data.account, status: 'active', targets: [profile.id], strategy: { purpose: '旧目标', content: '旧内容' }, nextAt: baseTime }];
  await a.save(); await a.close();
  const b = new AIAssistant(args); t.after(() => b.close()); await b.init(); await b.scan(); await b.settings({ enabled: true, proactive: true }); await ticks(b);
  assert.equal(bridge.sent.length, 0); assert.equal(b.data.proactiveTasks.length, 2); assert.ok(b.data.proactiveTasks.every(t => t.status === 'paused' && t.migrationRequired));
  assert.equal(b.data.proactiveLegacy.schedules[0].strategy.content, '旧内容');
  await assert.rejects(b.proactiveTaskAction({ command: 'resume', id: b.data.proactiveTasks[0].id }), /核对/);
  b.data.queue.status = 'running'; b.data.queue.nextAt = baseTime; await b.proactiveTick(b.revision, b.controller.signal); await b.scheduledTick(b.revision);
  assert.equal(bridge.sent.length, 0); assert.equal(JSON.parse(await readFile(path.join(root, 'ai-assistant.json'), 'utf8')).proactiveVersion, 2);
  await b.close();
});

test('records paginate by stable id, deleted task retains history and automatic activity excludes proactive/unknown', async t => {
  const { a, bridge, restart } = await fixture(t); const task = await create(a, bridge, { contacts: bridge.contacts.map(c => c.id) }); await ticks(a);
  const first = a.proactiveRecords({ limit: 2 }), next = a.proactiveRecords({ limit: 2, before: first.page.nextBefore });
  assert.equal(first.page.total, 3); assert.equal(first.page.hasMore, true); assert.equal(next.records.length, 1); assert.equal(next.page.hasMore, false);
  assert.equal(new Set([...first.records, ...next.records].map(r => r.id)).size, 3);
  await a.proactiveTaskAction({ command: 'delete', id: task.id }); assert.equal(a.proactiveRecords({ taskId: task.id }).records.length, 3);
  const p = a.profiles()[0], auto = bridge.push(p.contact, 'self', '自动回复正文'), unknown = bridge.push(p.contact, 'self', '历史未知正文');
  p.generatedIds.push(auto.id, unknown.id); p.sentMessages.push({ id: auto.id, at: baseTime, source: 'reply' });
  const reply = await a.activityRecords([p.id]); assert.deepEqual(reply.records[0].messages.map(m => m.text), ['自动回复正文']); assert.equal(reply.records[0].messages[0].source, 'reply');
  const history = await a.activityRecords([p.id], { source: 'unknown' }); assert.deepEqual(history.records[0].messages.map(m => m.text), ['历史未知正文']);
  const proactive = await a.activityRecords([p.id], { source: 'proactive' }); assert.equal(proactive.records[0].messages[0].taskId, task.id);
  await a.deleteActivityRecord({ source: 'reply', id: auto.id });
  assert.deepEqual((await a.activityRecords([p.id])).records[0].messages, []);
  await a.deleteActivityRecord({ source: 'proactive', id: first.records[0].id });
  assert.equal(a.proactiveRecords({}).records.length, 2);
  const reloaded = await restart();
  assert.equal(reloaded.proactiveRecords({}).records.length, 2);
  assert.deepEqual((await reloaded.activityRecords([p.id])).records[0].messages, []);
});

test('task input validation rejects invalid targets/type/schema without partial activation', async t => {
  const { a, bridge } = await fixture(t);
  for (const fields of [{ contacts: [] }, { contacts: [key('foreign')] }, { name: '' }, { goal: '' }, { taskType: 'invented' }, { schedule: { cycle: 'custom', mode: 'fixed', time: '12:00', intervalDays: 0 } }, { requestId: {} }]) await assert.rejects(a.proactiveTaskAction(input(bridge, fields)));
  assert.equal(a.data.proactiveTasks.length, 0); assert.equal(a.data.settings.enabled, false);
});

// A hand-typed reply is no longer a failure: the recipient waits out the
// manual-activity window and is still contacted inside the same occurrence.
test('manual activity delays a proactive send instead of failing the task', async t => {
  const { a, bridge, provider } = await fixture(t); const task = await create(a, bridge);
  const profile = a.data.profiles[task.contacts[0].profileId];
  a.observeManual(profile, bridge.messages.get(profile.contact).at(-1));
  await ticks(a); assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 1);
  assert.equal(profile.paused, false); assert.equal(task.run.items[0].status, 'sent'); assert.equal(task.status, 'ended');
  assert.ok(a.now() - profile.lastManualAt >= a.manualActivityWindow, 'the manual window has to pass before sending');
});

test('editing a learned contact keeps current style and identity/media safeguards still apply', async t => {
  const { a, bridge, provider } = await fixture(t);
  await a.learn({ contacts: [bridge.contacts[0].id] }); const profile = a.profiles()[0];
  await a.editProfile(profile.id, { style: { summary: '明确称呼小陈；句子简短。' } });
  const task = await create(a, bridge); provider.next = async () => ({ action: 'send', text: '我是AI助手' });
  await ticks(a); assert.equal(provider.calls.at(-1).input.style.summary, '明确称呼小陈；句子简短。');
  assert.equal(task.run.items[0].status, 'skipped'); assert.equal(bridge.sent.length, 0);
  assert.match(a.proactiveRecords({}).records[0].reason, /身份/);
});

test('unknown send receipt needs no review and recurring tasks continue at next occurrence', async t => {
  const { a, bridge, advance } = await fixture(t);
  const task = await create(a, bridge, { schedule: { cycle: 'daily', mode: 'fixed', time: '12:00' } });
  bridge.delivery = async () => ({ status: 'uncertain' }); await ticks(a); assert.equal(task.status, 'running');
  assert.equal(task.nextAt, at('2026-09-18T12:00:00'));
  assert.equal(a.proactiveRecords({}).records[0].status, 'unknown');
  bridge.delivery = null; advance(86400000); await ticks(a); assert.equal(bridge.sent.length, 1);
});

test('encrypted records survive restart, public replies never expose ciphertext and deleted history remains readable', async t => {
  const f = await fixture(t); const task = await create(f.a, f.bridge); await ticks(f.a);
  await f.a.proactiveTaskAction({ command: 'delete', id: task.id });
  const disk = await readFile(path.join(f.root, 'ai-assistant.json'), 'utf8'); assert.equal(disk.includes('GENERATED_PRIVATE_MARKER'), false);
  const b = await f.restart(), record = b.proactiveRecords({ taskId: task.id }).records[0];
  assert.equal(record.text, 'GENERATED_PRIVATE_MARKER'); assert.equal(Object.hasOwn(record, 'body'), false); assert.equal(b.publicState().proactiveTasks.length, 0);
});

test('missed random and fixed occurrences skip after offline days; immediate task can recover', async t => {
  for (const schedule of [{ cycle: 'daily', mode: 'random', start: '18:00', end: '21:00' }, { cycle: 'daily', mode: 'fixed', time: '18:00' }]) {
    const f = await fixture(t); const task = await create(f.a, f.bridge, { schedule });
    f.advance(at('2026-09-20T03:00:00') - baseTime); await ticks(f.a);
    assert.equal(f.bridge.sent.length, 0); assert.equal(task.status, 'running'); assert.equal(task.nextAt, at('2026-09-20T18:00:00'));
    assert.equal(f.a.proactiveRecords({}).records[0].status, 'skipped');
  }
  const f = await fixture(t); const task = await create(f.a, f.bridge); f.advance(5 * 86400000); await ticks(f.a);
  assert.equal(f.bridge.sent.length, 1); assert.equal(task.status, 'ended');
});

test('fixed schedule allows tick delays inside its hour but will not replay an expired fixed occurrence', async t => {
  for (const minutes of [4, 61]) {
    const f = await fixture(t); const task = await create(f.a, f.bridge, { schedule: { cycle: 'daily', mode: 'fixed', time: '12:00' } });
    f.advance(minutes * 60000); await ticks(f.a); assert.equal(f.bridge.sent.length, minutes === 4 ? 1 : 0);
    assert.equal(task.nextAt, at('2026-09-18T12:00:00'));
  }
});

test('cross-midnight recovery sends only inside the saved occurrence window without redrawing', async t => {
  for (const time of ['2026-09-18T01:00:00', '2026-09-18T03:00:00']) {
    let draws = 0; const f = await fixture(t, { random: min => { draws++; return min; } });
    const task = await create(f.a, f.bridge, { schedule: { cycle: 'daily', mode: 'random', start: '23:00', end: '02:00' } });
    const sampled = task.nextAt; assert.equal(draws, 1);
    f.advance(at(time) - baseTime); const b = await f.restart(); assert.equal(b.data.proactiveTasks[0].nextAt, sampled); assert.equal(draws, 1);
    await ticks(b); assert.equal(f.bridge.sent.length, time.includes('01:') ? 1 : 0); assert.equal(draws, 2);
    assert.equal(b.data.proactiveTasks[0].nextAt, at('2026-09-18T23:00:00'));
  }
});

test('partially completed run preserves sent prefix and skips remaining contacts after window end', async t => {
  const f = await fixture(t);
  const task = await create(f.a, f.bridge, { contacts: f.bridge.contacts.map(c => c.id), schedule: { cycle: 'daily', mode: 'random', start: '12:00', end: '12:01' } });
  await f.a.tick(); assert.equal(f.bridge.sent.length, 1); f.advance(16 * 60000); await ticks(f.a);
  assert.equal(f.bridge.sent.length, 1); assert.deepEqual(task.run.items.map(i => i.status), ['sent', 'skipped', 'skipped']);
  assert.equal(task.nextAt, at('2026-09-18T12:00:00'));
});

test('model finishing outside its occurrence window cannot submit late text', async t => {
  const f = await fixture(t);
  const task = await create(f.a, f.bridge, { schedule: { cycle: 'daily', mode: 'random', start: '12:00', end: '12:01' } });
  // A one-minute random window is floored at fifteen minutes from its draw now,
  // so lateness has to be measured past that floor.
  f.provider.next = async () => { f.advance(16 * 60000); return { action: 'send', text: '已经过时' }; };
  await ticks(f.a); assert.equal(f.bridge.sent.length, 0); assert.equal(task.run.items[0].status, 'skipped');
});

test('same-contact tasks share the execution lock while independent model requests can progress', async t => {
  const { a, bridge, provider } = await fixture(t);
  const first = await create(a, bridge), second = await create(a, bridge), third = await create(a, bridge, { contacts: [bridge.contacts[1].id] });
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  provider.next = async () => { started.resolve(); await release.promise; return { action: 'send', text: '第一项' }; };
  await a.tick({ background: true }); await started.promise;
  await Promise.allSettled([...a.activeRuns.entries()].filter(([id]) => id !== first.contacts[0].profileId).map(([, p]) => p));
  assert.equal(third.status, 'ended'); assert.equal(second.run?.items[0].status, 'pending');
  assert.equal(provider.calls.length, 2); release.resolve(); await Promise.allSettled([...a.activeRuns.values()]);
  await ticks(a); assert.equal(bridge.sent.length, 3); assert.equal(second.status, 'ended');
});

test('legacy recurring schedules prefill safely and preserve full original instructions; unmapped requires explicit schedule', async t => {
  const f = await fixture(t); await f.a.prepareTargets({ contacts: [f.bridge.contacts[0].id] });
  const profileId = f.a.profiles()[0].id;
  f.a.data.schedules = [
    { id: 'old-weekly', account: f.a.data.account, status: 'active', targets: [profileId], repeat: 'weekly', weekday: 5, minuteStart: 1080, minuteEnd: 1260, text: '每周五晚上', nextAt: at('2026-09-18T18:30:00'), strategy: { purpose: '邀请', content: '询问周末是否有空', facts: '地点未定', boundaries: '不要承诺费用' } },
    { id: 'old-once', account: f.a.data.account, status: 'active', targets: [profileId], repeat: 'once', text: '明天晚上八点', nextAt: at('2026-09-18T20:00:00'), strategy: { purpose: '问候', content: '轻松一点' } }
  ];
  await f.a.save(); const b = await f.restart();
  const [weekly, once] = b.publicState().proactiveTasks;
  assert.equal(weekly.status, 'paused'); assert.equal(weekly.migrationScheduleMapped, true);
  assert.equal(weekly.schedule.cycle, 'weekly'); assert.deepEqual(weekly.schedule.weekdays, [5]); assert.equal(weekly.schedule.start, '18:00');
  assert.equal(weekly.legacyScheduleText, '每周五晚上'); assert.match(weekly.migrationSummary, /地点未定/); assert.match(weekly.requirements, /不要承诺费用/);
  assert.equal(b.data.proactiveLegacy.schedules[0].nextAt, at('2026-09-18T18:30:00'));
  assert.equal(once.migrationScheduleMapped, false);
  await assert.rejects(b.proactiveTaskAction({ command: 'edit', id: once.id, goal: '新问候' }), /明确选择/);
  await b.proactiveTaskAction({ command: 'edit', id: weekly.id }); assert.equal(b.data.proactiveTasks[0].migrationRequired, undefined);
  await b.proactiveTaskAction({ command: 'resume', id: weekly.id }); assert.equal(b.data.proactiveTasks[0].status, 'running');
  await assert.rejects(b.queueAction('start'), /迁移/); await assert.rejects(b.scheduleAction({ command: 'resume', id: 'old-weekly' }), /迁移/);
});

test('global invalidation cancels model work but does not discard pending task or enable continuation', async t => {
  const { a, bridge, provider } = await fixture(t); const task = await create(a, bridge);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  provider.next = async () => { started.resolve(); await release.promise; return { action: 'send', text: '已作废' }; };
  const running = a.tick(); await started.promise; await a.settings({ proactive: false }); release.resolve(); await running;
  assert.equal(bridge.sent.length, 0); assert.equal(task.run.items[0].status, 'pending');
  await a.settings({ proactive: true }); await ticks(a); assert.equal(bridge.sent.length, 1); assert.equal(a.profiles()[0].continuation, undefined);
});

test('missing profile or unavailable contact fails only its item and does not spin indefinitely', async t => {
  const { a, bridge } = await fixture(t); const task = await create(a, bridge, { contacts: bridge.contacts.map(c => c.id) });
  delete a.data.profiles[task.contacts[0].profileId]; a.contacts.delete(task.contacts[1].id);
  await ticks(a); assert.deepEqual(task.run.items.map(i => i.status), ['failed', 'failed', 'sent']); assert.equal(a.available, true);
});

test('native account-switch receipt remains attached to original account and never contaminates new account cursor', async t => {
  const { a, bridge } = await fixture(t); const task = await create(a, bridge);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  bridge.delivery = async r => { started.resolve(); await release.promise; return { status: 'sent', messageId: key('old-account-receipt'), revision: r.revision }; };
  const running = a.tick(); await started.promise;
  const oldAccount = bridge.account; bridge.account = key('new-account-native'); await a.scan(); release.resolve(); await running;
  assert.equal(task.run.items[0].status, 'sent'); assert.equal(a.proactiveRecords({}).records.length, 0); assert.equal(a.cursors.has(task.contacts[0].profileId), false);
  assert.equal(a.data.proactiveRecords[0].account, oldAccount);
});

// The RANDOM_MIN_GRACE_MS floor keeps an occurrence alive for fifteen minutes
// from the moment it really started, so a draw landing on the very end of its
// window is no longer decided by whichever tick happens to wake up next.
test('random occurrence keeps a fifteen-minute floor from its actual start, so a brief generation still delivers', async t => {
  const { a, bridge, provider } = await fixture(t, { random: high });
  const task = await create(a, bridge, { schedule: { cycle: 'daily', mode: 'random', start: '11:59', end: '12:00' } });
  assert.equal(task.nextAt, baseTime);
  provider.next = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { action: 'send', text: '窗口末端也发出去的消息' }; };
  await ticks(a);
  assert.equal(task.run.items[0].status, 'sent'); assert.equal(bridge.sent.length, 1);
  assert.equal(task.nextAt, at('2026-09-18T12:00:00')); assert.equal(a.available, true);
  assert.equal(a.proactiveRecords({}).records.length, 1);
});
