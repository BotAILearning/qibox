import test from 'node:test';
import assert from 'node:assert/strict';
import { taskDraft, taskPayload, readTaskDraft, contactChoices, scheduleLabel, proactivePage, proactiveTable, uncertainProfiles, createProactiveUI } from '../web/ai-proactive-view.mjs';
import { activityEntries, activityRows, activityPage, proactiveRecordRows, proactiveRecordEntries } from '../web/ai-activity-view.mjs';
import { proactiveSchedule } from '../server/ai-proactive-schedule.mjs';

const task = overrides => ({ id: 'task-1', name: '项目跟进', version: 7, taskType: 'work', contacts: [{ id: 'c1', label: '联系人甲', profileId: 'p1' }], goal: '确认下周安排', requirements: '不承诺日期', schedule: { cycle: 'daily', mode: 'fixed', time: '14:40' }, status: 'paused', ...overrides });
const state = overrides => ({ settings: { enabled: true, proactive: true }, contacts: [], profiles: [], proactiveTasks: [], proactiveRecords: [], activity: [], ...overrides });
const validDraft = () => ({ ...taskDraft(undefined, '2026-09-17'), name: '新任务', contacts: [{ id: 'c1', label: '甲' }], goal: '问候近况' });

test('create idempotency key stays with a draft; edit keeps goal and name independent and sends version', () => {
  const d = validDraft(), first = taskPayload(d), second = taskPayload(d);
  assert.match(first.requestId, /^[\da-f-]{36}$/); assert.equal(first.requestId, second.requestId);
  assert.notEqual(taskDraft().requestId, first.requestId);
  const value = taskPayload(taskDraft(task({ content: '不能用旧content代替goal' })));
  assert.equal(value.command, 'edit'); assert.equal(value.version, 7); assert.equal(value.goal, '确认下周安排'); assert.equal(value.name, '项目跟进');
  assert.equal(value.taskType, 'work'); assert.equal(value.requestId, undefined); assert.equal(value.status, undefined);
});

test('draft contacts and weekly selection do not mutate polled server objects', () => {
  const source = task({ schedule: { cycle: 'weekly', mode: 'fixed', time: '08:30', weekdays: [1, 0] } });
  const draft = taskDraft(source); draft.contacts[0].label = '本地'; draft.schedule.weekdays.push(3);
  assert.equal(source.contacts[0].label, '联系人甲'); assert.deepEqual(source.schedule.weekdays, [1, 0]);
  assert.deepEqual(taskDraft().contacts, []);
});

test('all five cycles serialize to a schedule accepted by the real backend normalizer', () => {
  for (const cycle of ['once', 'daily', 'weekdays', 'weekly', 'custom']) for (const mode of ['fixed', 'random']) {
    const d = validDraft(); Object.assign(d.schedule, { cycle, mode, start: '23:00', end: '01:00', weekdays: [0, 1, 5], intervalDays: 365 });
    const value = taskPayload(d), normalized = proactiveSchedule(value.schedule, Date.parse('2026-09-17T00:00:00Z'));
    assert.equal(normalized.cycle, cycle); assert.equal(normalized.timezone, 'Asia/Shanghai');
    if (cycle === 'custom') assert.equal(normalized.startDate, '2026-09-17');
  }
});

test('once ignores stale hidden inputs and does not render time controls', () => {
  const d = validDraft(); Object.assign(d.schedule, { cycle: 'once', mode: 'random', start: 'bad', end: 'bad', intervalDays: '', startDate: '' });
  assert.equal(proactiveSchedule(taskPayload(d).schedule).cycle, 'once');
  const html = proactivePage(state(), { editing: true, draft: d });
  assert.doesNotMatch(html, /type="time"|name="mode"/); assert.match(html, /立即执行一次/);
});

test('input and change during once-to-weekly keep default Monday until weekly DOM is rendered; clearing all stays empty', t => {
  const OriginalFormData = globalThis.FormData;
  t.after(() => { globalThis.FormData = OriginalFormData; });
  globalThis.FormData = class { constructor(form) { this.form = form; } has(key) { return key === 'cycle'; } get() { return 'weekly'; } getAll() { return this.form.checked; } };
  const form = { checked: [], renderedWeekly: false, querySelector(selector) { return selector === '[name="weekdays"]' && this.renderedWeekly ? {} : null; } };
  let d = readTaskDraft(form, validDraft()); d = readTaskDraft(form, d);
  assert.deepEqual(d.schedule.weekdays, [1]);
  form.renderedWeekly = true; form.checked = ['1', '5']; d = readTaskDraft(form, d);
  assert.deepEqual(d.schedule.weekdays, [1, 5]);
  form.checked = []; d = readTaskDraft(form, d); assert.deepEqual(d.schedule.weekdays, []);
  assert.throws(() => taskPayload(d), /星期/);
});

test('weekly empty selection, equal random bounds, bad anchor dates and intervals are rejected', () => {
  const cases = [
    { cycle: 'weekly', weekdays: [] }, { cycle: 'daily', mode: 'random', start: '18:00', end: '18:00' },
    { cycle: 'custom', startDate: '2026-02-30' }, { cycle: 'custom', intervalDays: 366 }, { cycle: 'custom', intervalDays: 1.5 },
  ];
  for (const patch of cases) { const d = validDraft(); Object.assign(d.schedule, patch); assert.throws(() => taskPayload(d)); }
  const d = validDraft(); d.goal = '长'.repeat(6000); d.requirements = '长'.repeat(6000); assert.equal(taskPayload(d).goal.length, 6000);
  d.goal += '长'; assert.throws(() => taskPayload(d), /6000/);
});

test('learned people sort before reply-enabled people; search and missing selected IDs retain identity', () => {
  const s = state({ settings: { replyScope: 'selected' }, contacts: [{ id: 'plain', label: '普通', kind: 'person' }, { id: 'reply', label: '自动', kind: 'person' }, { id: 'learned', label: '已学', kind: 'person', nickname: '家人' }, { id: 'group', label: '群', kind: 'group' }], profiles: [{ contact: 'learned', id: 'p1', learnedAt: 1 }, { contact: 'reply', id: 'p2', replyOptions: { enabled: true } }] });
  assert.deepEqual(contactChoices(s).map(c => c.id), ['learned', 'reply', 'plain']);
  assert.deepEqual(contactChoices(s, '家人').map(c => c.id), ['learned']);
  const missing = contactChoices(s, '保留', [{ id: 'offline', label: '保留选择' }]);
  assert.equal(missing[0].id, 'offline'); assert.equal(missing[0].missing, true);
});

test('task list filters status, escapes content, shows requirements and never invents generated copy', () => {
  const s = state({ proactiveTasks: [task({ goal: '<script>bad</script>', requirements: '真实要求', content: '旧生成假内容' }), task({ id: 'running', status: 'running' }), task({ id: 'deleted', deletedAt: 1 })] });
  const html = proactiveTable(s, { filter: 'paused', menu: 'task-1' });
  assert.match(html, /&lt;script&gt;/); assert.match(html, /真实要求/); assert.match(html, /data-proactive-command="resume"/); assert.match(html, /data-proactive-command="delete"/);
  assert.doesNotMatch(html, /旧生成假内容|data-proactive-task="running"|data-proactive-task="deleted"/);
});

test('ended editor is read-only, and unmapped migration cannot silently save as once', () => {
  const ended = task({ status: 'ended' });
  const html = proactivePage(state({ proactiveTasks: [ended] }), { editing: true, draft: taskDraft(ended) });
  assert.match(html, /<fieldset disabled>/); assert.doesNotMatch(html, /data-proactive-submit/);
  const migration = task({ migrationRequired: true, migrationScheduleMapped: false, migrationSummary: '旧时间：每隔五天', schedule: { cycle: 'once' } });
  const draft = taskDraft(migration); assert.equal(draft.schedule.cycle, ''); assert.throws(() => taskPayload(draft), /周期/);
  assert.match(proactivePage(state({ proactiveTasks: [migration] }), { editing: true, draft }), /旧时间：每隔五天/);
});

test('unknown send outcomes never expose a manual verification action', () => {
  const t = task({ status: 'failed', run: { items: [{ profileId: 'p1', contact: 'c1', status: 'uncertain' }, { profileId: 'p2', status: 'sent' }] } });
  assert.deepEqual(uncertainProfiles(t, state()), []);
  const html = proactiveTable(state({ proactiveTasks: [t] }), { menu: t.id });
  assert.doesNotMatch(html, /data-ai-review|待核对|核对结果/); assert.match(html, /仅重试失败项/);
});

test('record filtering uses Beijing dates and preserves deleted task snapshots', () => {
  const s = state({ proactiveRecords: [{ id: 'r', taskId: 'deleted', taskName: '已删除的任务', profileId: 'p1', label: '甲', at: '2026-09-16T17:00:00Z', status: 'uncertain', text: '待核对内容' }], proactiveRecordsPage: { hasMore: true, nextBefore: 'r' } });
  assert.equal(proactiveRecordEntries(s, { from: '2026-09-17', to: '2026-09-17' }).length, 1);
  assert.equal(proactiveRecordEntries(s, { to: '2026-09-16' }).length, 0);
  const html = proactiveRecordRows(s, { taskId: 'deleted' });
  assert.match(html, /已删除的任务|待核对内容/); assert.doesNotMatch(html, /待核验|核对结果|核验发送结果/); assert.match(html, /data-proactive-record-more/); assert.doesNotMatch(html, /全部执行记录/);
});

test('auto and historical records do not display proactive text, latest execution is first', () => {
  const s = state({ activity: [{ id: 'p1', label: '甲', hasSent: true, at: 2000 }], activityHistory: [{ id: 'legacy', label: '旧联系人', hasSent: true, at: 1000 }] });
  const records = [{ id: 'p1', messages: [{ at: 1000, source: 'reply', text: 'OLDER' }, { at: 2000, source: 'reply', text: 'NEWER' }, { at: 3000, source: 'proactive', text: 'PROACTIVE_ONLY' }, { at: 4000, source: 'unknown', text: 'UNKNOWN_ONLY' }] }];
  const html = activityRows(s, {}, records, false);
  assert.ok(html.indexOf('NEWER') < html.indexOf('OLDER')); assert.doesNotMatch(html, /PROACTIVE_ONLY|UNKNOWN_ONLY/);
  assert.deepEqual(activityEntries(s, { source: 'unknown' }).map(p => p.id), ['legacy']);
  const history = activityRows(s, { source: 'unknown' }, [{ id: 'legacy', messages: [{ source: 'unknown', text: 'LEGACY', at: 1000 }, { source: 'reply', text: 'NOT_LEGACY', at: 2000 }] }], false);
  assert.match(history, /来源未分类/); assert.doesNotMatch(history, /NOT_LEGACY/);
  assert.doesNotMatch(activityPage(s), /历史代发记录（来源未分类）|data-ai-record-source="all"/);
});

test('waiting requirements, weekday semantics and cross-midnight summaries are explicit', () => {
  const s = state({ proactiveRequirements: ['请先配置模型', '请打开微信'] });
  const d = validDraft(); d.schedule.cycle = 'weekdays';
  const html = proactivePage(s, { editing: true, draft: d });
  assert.doesNotMatch(html, /请先配置模型|任务可保存/); assert.match(html, /不按节假日调休调整/);
  assert.match(html, /对方后续消息按该联系人的自动回复设置处理/);
  assert.match(scheduleLabel({ cycle: 'daily', mode: 'random', start: '23:00', end: '01:00' }), /次日/);
});

test('controller reset discards another instance draft; failed edit retains unsaved fields and server status', async () => {
  let s = state({ proactiveTasks: [task()] }), fail = true, payload;
  const ui = createProactiveUI({ panel: { querySelector: () => null }, getState: () => s, context: () => 1, isBusy: () => false, render: () => {}, showRecords: async () => {}, refreshContacts: async () => {}, mutate: async (value, saved) => { payload = value; if (fail) throw new Error('冲突，请重新读取'); saved(); } });
  const button = dataset => ({ dataset, attributes: Object.keys(dataset).map(() => ({ name: 'data-proactive-command' })), hasAttribute: name => Object.keys(dataset).some(k => 'data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) === name), closest: () => ({}) });
  await ui.click(button({ proactiveCommand: 'edit', taskId: 'task-1' }));
  await assert.rejects(ui.submit(), /冲突/); assert.match(ui.page(), /value="项目跟进"/); assert.equal(payload.version, 7); assert.equal(s.proactiveTasks[0].status, 'paused');
  fail = false; await ui.submit(); assert.doesNotMatch(ui.page(), /id="ai-proactive-form"/);
  await ui.click(button({ proactiveCommand: 'edit', taskId: 'task-1' }));
  ui.reset(); s = state(); assert.doesNotMatch(ui.page(), /项目跟进|ai-proactive-form/);
});
