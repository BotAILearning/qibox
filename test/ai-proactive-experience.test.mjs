import test from 'node:test';
import assert from 'node:assert/strict';
import { createProactiveUI, proactiveTable, taskTypes } from '../web/ai-proactive-view.mjs';

const task = (overrides = {}) => ({ id: 'task-1', name: '项目跟进', version: 7, taskType: 'work', contacts: [{ id: 'c1', label: '甲' }], goal: '确认昨天讨论的方案是否有效', schedule: { cycle: 'daily', mode: 'fixed', time: '14:40' }, status: 'paused', ...overrides });
const state = tasks => ({ contacts: [], profiles: [], settings: {}, proactiveTasks: tasks });
const button = dataset => ({
  dataset, connected: true,
  attributes: Object.keys(dataset).map(key => ({ name: 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) })),
  hasAttribute(name) { return this.attributes.some(attribute => attribute.name === name); },
  getAttribute(name) { const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return this.dataset[key]; },
  closest() { return this.connected ? {} : null; },
  setAttribute() {}, focus() {},
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function controller({ tasks = [task()], panel = { querySelector: () => null }, mutate = async (_, saved) => saved() } = {}) {
  let currentState = state(tasks), generation = 1;
  const ui = createProactiveUI({ panel, getState: () => currentState, context: () => generation, isBusy: () => false, mutate, render: () => {}, showRecords: async () => {}, refreshContacts: async () => {} });
  return { ui, replace(tasks) { generation++; ui.reset(); currentState = state(tasks); } };
}
async function edit(ui, id = 'task-1') { await ui.click(button({ proactiveCommand: 'edit', taskId: id })); }
function useFormData(t) {
  const previous = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.values = new Map(Object.entries(form.values)); }
    has(key) { return this.values.has(key); }
    get(key) { return this.values.get(key); }
    getAll() { return []; }
  };
  t.after(() => { globalThis.FormData = previous; });
}
function editor(values) {
  const fields = { disabled: false, isConnected: true }, submit = { disabled: false, isConnected: true }, error = { hidden: true, textContent: '' }, attributes = {};
  const goal = { get value() { return values.goal; }, set value(value) { values.goal = value; } };
  return { values, fields, submit, error, attributes, isConnected: true, elements: { goal }, setAttribute(name, value) { attributes[name] = value; }, querySelector(selector) { return { fieldset: fields, '[type=submit]': submit, '#ai-proactive-submit-error': error }[selector] || null; } };
}

test('changing the task type preserves a written goal while untouched templates can change', async t => {
  useFormData(t);
  let form = null;
  const { ui } = controller({ panel: { querySelector: () => form } });
  await edit(ui);
  form = editor({ taskType: 'greeting', goal: '问问昨天的方案试下来效果如何' });
  ui.change({ name: 'taskType', value: 'greeting', closest: () => ({}) });
  assert.match(ui.page(), /问问昨天的方案试下来效果如何/);
  assert.doesNotMatch(ui.page(), /<textarea[^>]*>自然问候对方近况，保持轻松联系。/);
  form.values.goal = taskTypes.find(([key]) => key === 'greeting')[2];
  ui.remember();
  form.values.taskType = 'work';
  ui.change({ name: 'taskType', value: 'work', closest: () => ({}) });
  assert.equal(form.values.goal, taskTypes.find(([key]) => key === 'work')[2]);
});

test('a pending save has one request, explicit progress and a recoverable draft after failure', async t => {
  useFormData(t);
  let form = null, calls = 0;
  const pending = deferred();
  const { ui } = controller({ panel: { querySelector: () => form }, mutate: async () => { calls++; await pending.promise; } });
  await edit(ui);
  form = editor({ name: '我的草稿', taskType: 'work', goal: '昨天的问题现在怎么样了', requirements: '保留语气' });
  const first = ui.submit();
  await ui.submit();
  assert.equal(calls, 1);
  assert.equal(form.fields.disabled, true);
  assert.equal(form.submit.textContent, '正在保存…');
  assert.equal(form.attributes['aria-busy'], 'true');
  assert.match(ui.page(), /aria-busy="true"/);
  assert.match(ui.page(), /data-proactive-submit disabled>正在保存…/);
  pending.reject(new Error('网络超时 <重试>'));
  await assert.rejects(first, /网络超时/);
  assert.equal(form.fields.disabled, false);
  assert.equal(form.submit.disabled, false);
  assert.equal(form.submit.textContent, '保存修改');
  assert.equal(form.attributes['aria-busy'], 'false');
  assert.equal(form.error.hidden, false);
  assert.match(form.error.textContent, /草稿已保留/);
  assert.match(ui.page(), /我的草稿|昨天的问题现在怎么样了|保留语气/);
  assert.match(ui.page(), /网络超时 &lt;重试&gt;/);
});

test('a late save callback cannot clear a new instance draft', async () => {
  const pending = deferred();
  let saved;
  const { ui, replace } = controller({ mutate: async (_, callback) => { saved = callback; await pending.promise; } });
  await edit(ui);
  const first = ui.submit();
  replace([task({ id: 'new-instance-task', name: '新实例草稿' })]);
  await edit(ui, 'new-instance-task');
  saved(); pending.resolve(); await first;
  assert.match(ui.page(), /新实例草稿/);
  assert.match(ui.page(), /id="ai-proactive-form"/);
  assert.doesNotMatch(ui.page(), /草稿已保留/);
});

test('an old instance save failure does not put old feedback into a new draft', async () => {
  const pending = deferred();
  const { ui, replace } = controller({ mutate: async () => pending.promise });
  await edit(ui);
  const first = ui.submit();
  replace([task({ id: 'new-instance-task', name: '新实例草稿' })]);
  await edit(ui, 'new-instance-task');
  pending.reject(new Error('旧实例失败'));
  await assert.rejects(first, /旧实例失败/);
  assert.match(ui.page(), /新实例草稿/);
  assert.doesNotMatch(ui.page(), /旧实例失败/);
});

test('closing an open menu keeps the next delegated filter click connected', async () => {
  let redraws = 0, removed = false;
  const filter = button({ proactiveFilter: 'paused' }), more = button({ proactiveMenu: 'task-1' });
  const host = { querySelector: () => null, set innerHTML(_) { redraws++; filter.connected = false; } };
  const panel = { querySelector: selector => selector === '#ai-proactive-list' ? host : null, querySelectorAll: selector => selector === '.ap-action-menu' ? [{ remove() { removed = true; } }] : selector === '[data-proactive-menu]' ? [more] : [] };
  const { ui } = controller({ panel });
  await ui.click(more);
  filter.connected = true;
  const before = redraws;
  ui.closeMenu();
  assert.equal(removed, true);
  assert.equal(redraws, before);
  assert.equal(filter.connected, true);
  assert.equal(await ui.click(filter), true);
  assert.match(ui.page(), /data-proactive-filter="paused" aria-pressed="true"/);
});

test('polling restores a focused filter without moving focus outside the task list', t => {
  const previous = globalThis.document;
  t.after(() => { globalThis.document = previous; });
  let focused = false, replacement;
  const initial = button({ proactiveFilter: 'all' });
  globalThis.document = { activeElement: initial };
  const host = { querySelector: () => null, contains: node => node === initial, set innerHTML(_) { replacement = button({ proactiveFilter: 'all' }); replacement.focus = options => { focused = options.preventScroll; }; } };
  const panel = { querySelector: selector => selector === '#ai-proactive-list' ? host : null, querySelectorAll: () => [replacement].filter(Boolean) };
  const { ui } = controller({ panel });
  ui.refresh();
  assert.equal(focused, true);
});

test('returning from an editor restores its task action and keeps a resumable draft', async () => {
  let taskFocused = 0, newFocused = 0;
  const more = button({ proactiveMenu: 'task-1' }); more.focus = () => { taskFocused++; };
  const panel = { querySelector: selector => selector === '[data-proactive-new]' ? { focus() { newFocused++; } } : null, querySelectorAll: () => [more] };
  const { ui } = controller({ panel });
  await edit(ui);
  await ui.click(button({ proactiveBack: '' }));
  assert.equal(taskFocused, 1);
  assert.match(ui.page(), /继续编辑任务/);
  await ui.click(button({ proactiveNew: '' }));
  await ui.click(button({ proactiveCancel: '' }));
  assert.equal(taskFocused, 2);
  assert.doesNotMatch(ui.page(), /继续编辑任务/);
  await ui.click(button({ proactiveNew: '' }));
  await ui.click(button({ proactiveBack: '' }));
  assert.equal(newFocused, 1);
  assert.match(ui.page(), /继续编辑任务/);
});

test('expanding and collapsing task details restores focus to the same rendered toggle', async () => {
  let ui, renderedToggles = [], activeElement = null;
  const otherTask = task({ id: 'task-2', name: '另一任务' });
  const panel = { querySelector: () => null, querySelectorAll: selector => selector === '[data-proactive-expand]' ? renderedToggles : [] };
  const render = () => {
    const html = ui.page();
    for (const node of renderedToggles) node.connected = false;
    activeElement = null;
    renderedToggles = [task(), otherTask].map(row => {
      const node = button({ proactiveExpand: row.id });
      node.expanded = html.includes(`data-proactive-expand="${row.id}" aria-expanded="true"`);
      node.focus = options => { assert.equal(options.preventScroll, true); activeElement = node; };
      return node;
    });
  };
  ui = createProactiveUI({ panel, getState: () => state([task(), otherTask]), context: () => 1, isBusy: () => false, mutate: async () => {}, render, showRecords: async () => {}, refreshContacts: async () => {} });
  render();
  const original = renderedToggles[0];
  await ui.click(original);
  assert.equal(original.connected, false);
  assert.notEqual(activeElement, original);
  assert.equal(activeElement, renderedToggles[0]);
  assert.equal(activeElement.dataset.proactiveExpand, 'task-1');
  assert.equal(activeElement.expanded, true);
  assert.equal(renderedToggles[1].expanded, false);
  const expanded = activeElement;
  await ui.click(expanded);
  assert.equal(expanded.connected, false);
  assert.notEqual(activeElement, expanded);
  assert.equal(activeElement, renderedToggles[0]);
  assert.equal(activeElement.dataset.proactiveExpand, 'task-1');
  assert.equal(activeElement.expanded, false);
  assert.equal(renderedToggles[1].expanded, false);
});

test('task timing uses only the real persisted occurrence and distinguishes an active run', () => {
  const nextAt = Date.parse('2026-10-02T12:23:00Z');
  const render = overrides => proactiveTable(state([task({ status: 'running', nextAt, schedule: { cycle: 'daily', mode: 'random', start: '19:00', end: '21:00' }, ...overrides })]));
  assert.match(render(), /下次计划 <time datetime="2026-10-02T12:23:00.000Z">2026\/10\/2 20:23:00/);
  assert.match(render({ run: { at: nextAt } }), /本次计划 <time/);
  assert.match(render({ run: { completedAt: nextAt - 1000 } }), /下次计划 <time/);
  for (const overrides of [{ nextAt: null }, { nextAt: Infinity }, { nextAt: 1e99 }, { status: 'paused' }, { status: 'ended' }]) assert.doesNotMatch(render(overrides), /(?:下次|本次)计划 <time/);
});

test('a contact removal confirmation from an old instance cannot alter a new task', async t => {
  const previous = globalThis.document;
  t.after(() => { globalThis.document = previous; });
  let modal;
  const element = () => ({ listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, focus() {} });
  globalThis.document = {
    activeElement: null,
    body: { append(node) { modal = node; } },
    createElement() {
      const dialog = element(), cancel = element(), close = element(), form = element();
      dialog.querySelector = selector => ({ '[data-cancel]': cancel, '.qbx-dialog-close': close, form }[selector]);
      dialog.showModal = () => {};
      dialog.remove = () => {};
      dialog.close = () => dialog.listeners.get('close')();
      return dialog;
    },
  };
  const { ui, replace } = controller();
  await edit(ui);
  const pending = ui.click(button({ proactiveRemove: 'c1' }));
  replace([task({ id: 'new-task', name: '新实例任务', contacts: [{ id: 'c1', label: '新实例联系人' }] })]);
  await edit(ui, 'new-task');
  modal.querySelector('form').listeners.get('submit')({ preventDefault() {} });
  assert.equal(await pending, true);
  assert.match(ui.page(), /新实例联系人/);
});
