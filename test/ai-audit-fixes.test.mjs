import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { activityEntries, activityRows } from '../web/ai-activity-view.mjs';
import { objectPage } from '../web/ai-object-view.mjs';
import { styleChoice } from '../web/ai-style-view.mjs';
import { migrateLearnedStyle } from '../server/ai-style.mjs';
import { defaultStyle } from '../server/ai-schema.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key, strategy, learnedStyle } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-09-15T10:00:00+08:00');
  const options = { dataRoot: root, bridge, provider, now: () => now, delay: async () => {}, interval: () => 120000 };
  const a = new AIAssistant(options);
  await a.init(); await a.configure(modelConfig); await a.scan();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, bridge, provider, options, advance: ms => now += ms };
}
test('AI-01 default profile retains custom style after memory/reply-goal saves and reload', async t => {
  const { a, bridge, options, provider } = await fixture(t);
  await a.settings({ enabled: true });
  const contact = bridge.contacts[0].id, text = '始终称呼对方王老师，表达正式简短。';
  await a.saveReplyProfile({ contact, style: { summary: text }, styleId: 'custom', strategy: {}, preserveSwitches: true, replyEnabled: true });
  let p = a.profiles().find(p => p.contact === contact);
  assert.equal(p.source, 'manual'); assert.deepEqual(styleChoice(p), { summary: text, styleId: 'custom' });
  const html = objectPage(a.publicState(), { selected: contact, kind: 'person', search: '' });
  assert.match(html, /始终称呼对方王老师/); assert.match(html, /data-ai-style="custom" aria-pressed="true"/);
  const draftHtml = objectPage(a.publicState(), { selected: contact, kind: 'person', search: '', draft: { styleId: 'custom', summary: '临时自定义' } });
  assert.match(draftHtml, /data-ai-style="custom" aria-pressed="true"/);
  await a.editMemory(p.id, { summary: '对方周六有空。' });
  await a.saveReplyProfile({ contact, style: p.style, styleId: p.styleId, strategy: { replyGoal: '确认周六时间' }, preserveSwitches: true });
  const b = new AIAssistant(options); await b.init(); await b.scan();
  try {
    p = b.profiles().find(p => p.contact === contact);
    assert.equal(p.style.summary, text); assert.equal(styleChoice(p).styleId, 'custom');
    await b.tick(); bridge.push(contact, 'other', '周六几点见？'); await b.tick();
    const snapshot = await b.read(p, b.controller.signal);
    await b.generate(p, snapshot, 'reply', b.revision, b.controller.signal);
    assert.equal(provider.calls.at(-1).input.style.summary, text);
  } finally { await b.close(); }
});
test('AI-07 learned snapshot survives preset/custom/default selections and restart', async t => {
  const { a, bridge, provider, options } = await fixture(t), contact = bridge.contacts[0].id;
  provider.next = async () => ({ style: learnedStyle('独特的学习结果。') });
  await a.learn({ contacts: [contact] });
  const p = a.profiles()[0], learned = structuredClone(p.learnedStyle), preset = a.publicState().schema.replyPresets[0];
  await a.saveReplyProfile({ contact, style: preset.style, styleId: `preset:${preset.id}`, strategy: {} });
  assert.equal(p.styleId, `preset:${preset.id}`); assert.deepEqual(p.learnedStyle, learned);
  await a.saveReplyProfile({ contact, style: { summary: '手动补充。' }, styleId: 'learned', strategy: {} });
  assert.equal(p.styleId, 'custom'); assert.deepEqual(p.learnedStyle, learned);
  await a.saveReplyProfile({ contact, style: learned, styleId: 'learned', strategy: {} });
  assert.equal(p.styleId, 'learned'); assert.deepEqual(p.style, learned);
  const b = new AIAssistant(options); await b.init();
  try { assert.deepEqual(b.profiles()[0].learnedStyle, learned); } finally { await b.close(); }
  const lost = { style: preset.style, learnedAt: 1, replyConfiguredAt: 2, replyStyleSource: 'manual' };
  migrateLearnedStyle(lost); assert.equal(lost.learnedStyle, undefined);
});
for (const pause of ['manual', 'restart', 'provider']) test(`AI-02 schedule-only queue resumes after ${pause}`, async t => {
  const { a, bridge, advance, options } = await fixture(t);
  await a.scheduleAction({ time: '1分钟后', strategy, contacts: [bridge.contacts[0].id] });
  await a.settings({ enabled: true, proactive: true, reply: false }); advance(61000); await a.scheduledTick(a.revision);
  let runner = a;
  if (pause === 'manual') await a.queueAction('pause');
  if (pause === 'provider') await a.verifyProvider(modelConfig);
  if (pause === 'restart') { await a.save(); runner = new AIAssistant(options); await runner.init(); await runner.scan(); }
  try {
    assert.equal(runner.data.queue.status, 'paused'); assert.deepEqual(runner.data.proactiveTargets, []);
    if (pause === 'restart') {
      const migrated = runner.publicState().proactiveTasks[0];
      assert.equal(migrated.status, 'paused'); assert.equal(migrated.migrationRequired, true);
      await assert.rejects(runner.proactiveTaskAction({ command: 'resume', id: migrated.id }), /核对/);
      advance(121000); await runner.tick(); assert.equal(bridge.sent.length, 0);
      return;
    }
    await runner.queueAction('resume'); advance(121000); await runner.tick();
    assert.equal(bridge.sent.length, 1); assert.equal(runner.data.queue.status, 'completed');
    assert.equal(runner.data.schedules[0].lastRun.items[0].status, 'done');
  } finally { if (runner !== a) await runner.close(); }
});
test('AI-02 unknown send receipt still blocks schedule resumption and retries', async t => {
  const { a, bridge, advance } = await fixture(t);
  await a.scheduleAction({ time: '1分钟后', strategy, contacts: [bridge.contacts[0].id] });
  await a.settings({ enabled: true, proactive: true, reply: false }); advance(61000);
  bridge.delivery = async () => ({ status: 'uncertain' }); await a.tick();
  assert.equal(a.data.queue.items[0].status, 'uncertain');
  await assert.rejects(a.queueAction('resume'), /待核对/);
  await assert.rejects(a.queueAction('retry-failed'), /待核对/);
});
for (const mention of ['self', 'all']) for (const otherSpeaker of [false, true]) test(`AI-03 ${mention} followed by ${otherSpeaker ? 'other member' : 'same member'} retains trigger once`, async t => {
  const { a, bridge, provider, advance } = await fixture(t), c = bridge.contacts[0];
  c.kind = 'group'; await a.scan(); await a.setGroupOptions({ contact: c.id, [mention === 'self' ? 'atMe' : 'atAll']: true });
  await a.settings({ enabled: true, replyScope: 'selected' }); await a.tick();
  const push = (text, field, sender) => Object.assign(bridge.push(c.id, 'other', text), { sender: key(sender), mentions: { verified: true, self: field === 'self', all: field === 'all', others: false } });
  const first = push('@你 周六有空吗？', mention, 'one'); await a.tick(); advance(1000);
  push('下午一起喝咖啡。', '', otherSpeaker ? 'two' : 'one'); await a.tick(); advance(3000); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(provider.calls[0].input.groupState.triggerMessages[0].id, first.id);
  push('普通补充。', '', 'one'); await a.tick(); advance(4000); await a.tick();
  assert.equal(provider.calls.length, 1);
});
test('AI-03 @all and @me skips are not replayed, and old mentions stay unprocessed', async t => {
  const { a, bridge, provider, advance } = await fixture(t), c = bridge.contacts[0]; c.kind = 'group'; await a.scan();
  const push = field => Object.assign(bridge.push(c.id, 'other', '测试'), { sender: key('one'), mentions: { verified: true, self: field === 'self', all: field === 'all', others: false } });
  const complete = provider.complete.bind(provider);
  push('self'); await a.setGroupOptions({ contact: c.id, atMe: true }); await a.settings({ enabled: true, replyScope: 'selected' });
  push(''); await a.tick(); advance(4000); await a.tick(); assert.equal(provider.calls.length, 0);

  const profile = a.profiles().find(value => value.contact === c.id);
  provider.complete = async (config, system, input) => { provider.calls.push({ system, input }); return { action: 'skip' }; };
  push('self'); await a.tick(); advance(4000); await a.tick();
  assert.equal(provider.calls.length, 1);
  assert.equal(bridge.sent.length, 0);
  assert.ok(profile.handledIncomingId);
  assert.equal(profile.paused, false);
  push(''); await a.tick(); advance(4000); await a.tick(); assert.equal(provider.calls.length, 1);

  provider.complete = complete;
  await a.setGroupOptions({ contact: c.id, atMe: false, atAll: true });
  await a.tick(); // Establish the all-mention boundary before generating new input.
  provider.next = async () => ({ action: 'skip' });
  push('all'); await a.tick(); advance(4000); await a.tick();
  assert.equal(provider.calls.length, 2);
  assert.equal(bridge.sent.length, 0);
  assert.equal(a.data.events[0].code, 'skip');
  push(''); await a.tick(); advance(4000); await a.tick(); assert.equal(provider.calls.length, 2);
});
test('AI-03 pending burst survives restart with its original unprocessed boundary', async t => {
  const { a, bridge, provider, advance, options } = await fixture(t), c = bridge.contacts[0]; bridge.stableMessageIds = true; c.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: c.id, atMe: true }); await a.settings({ enabled: true, replyScope: 'selected' });
  await a.tick(); // Establish the historical boundary before this fixture's timestamp-less incoming messages.
  Object.assign(bridge.push(c.id, 'other', '@你 周六见？'), { mentions: { verified: true, self: true }, sender: key('one') }); await a.tick();
  Object.assign(bridge.push(c.id, 'other', '在咖啡店。'), { mentions: { verified: true }, sender: key('one') }); await a.tick();
  const b = new AIAssistant(options); await b.init(); await b.scan(); advance(4000);
  try { await b.tick(); assert.equal(bridge.sent.length, 1); assert.equal(provider.calls.at(-1).input.groupState.trigger, 'atMe'); } finally { await b.close(); }
});
test('AI-04 date filters keep deliveries and manual-help entries independent at UTC+8 midnight', async t => {
  const { a, bridge } = await fixture(t); await a.settings({ enabled: true });
  await a.saveReplyProfile({ contact: bridge.contacts[0].id, style: defaultStyle, strategy: {}, preserveSwitches: true, replyEnabled: false });
  const p = a.profiles()[0], dates = ['2026-09-13T23:59:59+08:00', '2026-09-14T00:00:00+08:00', '2026-09-14T23:59:59+08:00', '2026-09-15T00:00:00+08:00'];
  p.sentMessages = dates.map((date, i) => ({ id: bridge.push(p.contact, 'self', `BODY_${i}`).id, at: Date.parse(date), source: 'reply' })); p.generatedIds = p.sentMessages.map(m => m.id);
  a.pauseProfile(p, 'limit'); a.event('limit', p.id);
  const state = a.publicState(), filters = { from: '2026-09-14', to: '2026-09-14' };
  const entries = activityEntries(state, filters); assert.equal(entries.length, 1); assert.equal(entries[0].needsHelp, false);
  const { records } = await a.activityRecords([p.id], filters); assert.deepEqual(records[0].messages.map(m => m.text), ['BODY_1', 'BODY_2']);
  assert.equal(activityEntries(state, { ...filters, query: 'BODY_1' }, records).length, 1);
  assert.equal(activityEntries(state, { ...filters, query: 'no-match' }, records).length, 0);
  const html = activityRows(state, filters, records, false); assert.match(html, /BODY_1/); assert.doesNotMatch(html, /BODY_0|BODY_3|需要你发送/);
  assert.equal(activityEntries(state, { ...filters, code: 'help' }).length, 0);
  assert.equal(activityEntries(state, { from: '2026-09-15', to: '2026-09-15', code: 'help' }).length, 1);
  await assert.rejects(a.activityRecords([p.id], { from: '2026-09-16', to: '2026-09-15' }), /开始日期/);
  await assert.rejects(a.activityRecords([p.id], { from: '2026-02-30' }), /日期无效/);
  bridge.read = async () => { throw new Error('unreadable'); }; assert.equal((await a.activityRecords([p.id], filters)).records[0].unavailable, false);
  for (const m of p.sentMessages) delete m.body;
  assert.equal((await a.activityRecords([p.id], filters)).records[0].unavailable, true);
});
for (const old of ['把文件发给我', '看一下图片', '[语音]']) test(`AI-05 old ${old} does not replace new text proactive task`, async t => {
  const { a, bridge, provider } = await fixture(t), c = bridge.contacts[0];
  const m = bridge.push(c.id, 'other', old); if (old === '[语音]') m.type = 'voice';
  bridge.transcribe = async () => { throw new Error('old voice must not be converted'); };
  await a.saveStrategy({ ...strategy, purpose: '确认周六聚会人数', content: '询问是否参加周六聚会' });
  await a.prepareTargets({ contacts: [c.id] }); await a.settings({ enabled: true, proactive: true, reply: false });
  await a.queueAction('start'); await a.tick();
  assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 1); assert.equal(a.profiles()[0].handoffReason, undefined);
});
for (const content of ['把文件发给我', '给对方打电话']) test(`AI-05 model skip for ${content} prevents sending and creates a skip ledger row`, async t => {
  const { a, bridge, provider } = await fixture(t);
  provider.next = async () => ({action:'skip'});
  await a.saveStrategy({ ...strategy, content }); await a.prepareTargets({ contacts: [bridge.contacts[0].id] });
  await a.settings({ enabled: true, proactive: true, reply: false }); await a.queueAction('start'); await a.tick();
  assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 0);
  assert.equal(a.publicState().skipRecords[0].source, 'model-skip');
  assert.equal(a.publicState().skipRecords[0].reasonCode, 'model-no-reply');
});
test('AI-05 stop-contact history remains in model input and stop response prevents sending', async t => {
  const { a, bridge, provider } = await fixture(t); const c = bridge.contacts[0]; bridge.push(c.id, 'other', '不要再联系我');
  await a.saveStrategy(strategy); await a.prepareTargets({ contacts: [c.id] }); await a.settings({ enabled: true, proactive: true, reply: false });
  provider.next = async input => { assert.equal(input.messages.at(-1).text, '不要再联系我'); return { action: 'stop' }; };
  await a.queueAction('start'); await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(a.profiles()[0].pauseReason, 'stop');
});
for (const partial of [false, true]) test(`AI-06 ${partial ? 'partial' : 'all'} missing schedule targets remain visible and retry only failed objects`, async t => {
  const { a, bridge, advance } = await fixture(t), missing = bridge.contacts[0], targets = bridge.contacts.slice(0, partial ? 2 : 1);
  await a.scheduleAction({ time: '1分钟后', strategy, contacts: targets.map(c => c.id) });
  await a.settings({ enabled: true, proactive: true, reply: false }); bridge.contacts.shift(); await a.scan(); advance(61000); await a.tick();
  assert.equal(a.data.queue.status, 'failed'); assert.equal(a.data.queue.items[0].status, 'failed');
  assert.equal(a.data.schedules[0].status, 'failed'); assert.match(a.data.schedules[0].lastRun.items[0].reason, /本次未发送/);
  assert.equal(a.activitySummaries('proactive').filter(x => x.queueFailed).length, 1);
  assert.equal(bridge.sent.length, partial ? 1 : 0); await assert.rejects(a.queueAction('start'), /结束当前队列/);
  await assert.rejects(a.queueAction('retry-failed'), /刷新列表/);
  bridge.contacts.unshift(missing); await a.scan(); await a.queueAction('retry-failed'); advance(121000); await a.tick();
  assert.equal(bridge.sent.length, targets.length); assert.equal(new Set(bridge.sent.map(m => m.contact)).size, targets.length);
  assert.equal(a.data.schedules[0].status, 'completed'); assert.equal(a.data.queue.status, 'completed');
});
test('AI-06 unreadable history becomes an explicit failure and can be skipped after restart', async t => {
  const { a, bridge, advance, options } = await fixture(t);
  await a.scheduleAction({ time: '1分钟后', strategy, contacts: [bridge.contacts[0].id] });
  await a.settings({ enabled: true, proactive: true, reply: false }); bridge.read = async () => { throw new Error('read unavailable'); }; advance(61000); await a.tick();
  assert.equal(a.data.queue.status, 'failed'); assert.equal(bridge.sent.length, 0);
  const b = new AIAssistant(options); await b.init(); await b.scan();
  try { assert.equal(b.data.queue.items[0].status, 'failed'); await b.queueAction('skip-failed'); assert.equal(b.data.queue.status, 'completed'); } finally { await b.close(); }
});
