import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const at = text => Date.parse(text + '+08:00');
const low = (min) => min;
const baseTime = at('2026-09-17T12:00:00');
// The manual-activity wait calls ai.delay(), so the injected delay advances the
// same virtual clock the rest of the suite reads through now().
async function fixture(t, options = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let time = baseTime;
  const args = { dataRoot: root, bridge, provider, now: () => time, random: low, delay: async ms => { time += ms; }, ...options };
  const a = new AIAssistant(args); await a.init(); await a.configure(modelConfig); await a.scan();
  await a.settings({ reply: false });
  t.after(async () => { if (!a.closed) await a.close(); await cleanup(root); });
  return { a, bridge, provider, advance: n => time += n, now: () => time };
}
function input(bridge, values = {}) { return { command: 'create', name: '测试任务', taskType: 'greeting', contacts: [bridge.contacts[0].id], goal: '询问周末是否有空', requirements: '', schedule: { cycle: 'once' }, ...values }; }
async function create(a, bridge, values) { const before = new Set(a.data.proactiveTasks.map(t => t.id)); await a.proactiveTaskAction(input(bridge, values)); return a.data.proactiveTasks.find(t => !before.has(t.id)); }
async function ticks(a, count = 6) { for (let n = 0; n < count; n++) await a.tick(); }

test('a manual reply no longer cancels the proactive message, it waits the window out and then sends', async t => {
  const { a, bridge, now } = await fixture(t);
  await create(a, bridge);
  const profile = a.profiles().find(p => p.contact === bridge.contacts[0].id);
  profile.lastManualAt = now();
  await ticks(a);
  assert.equal(bridge.sent.length, 1, 'the message must still go out');
  assert.equal(a.data.proactiveRecords[0].status, 'sent');
  assert.ok(now() >= baseTime + 300000, 'it should have waited for the manual-activity window');
});

test('a recurring task re-queues failed recipients for the next occurrence', async t => {
  const { a, bridge } = await fixture(t);
  const task = await create(a, bridge, { schedule: { cycle: 'daily', mode: 'fixed', time: '12:00' } });
  const tasks = a.proactiveV2;
  const item = { ...tasks.item(task.contacts[0]), status: 'failed', attempts: 1 };
  task.run = { id: 'run-1', at: a.now(), occurrenceDate: '2026-09-17', schedule: structuredClone(task.schedule), items: [item] };
  tasks.settle(task);
  assert.equal(task.status, 'running', 'a retryable failure must not park the task');
  assert.ok(task.nextAt > a.now(), 'the next occurrence is scheduled');
  // That occurrence coming due revives only the failed recipient.
  task.nextAt = a.now();
  tasks.reviveRetryable(task);
  assert.equal(item.status, 'pending'); assert.equal(task.run.completedAt, undefined);
  assert.equal(task.run.occurrenceDate, task.occurrenceDate);
});

test('the retry cap stops a recurring task after three attempts and asks for a manual retry', async t => {
  const { a, bridge } = await fixture(t);
  const task = await create(a, bridge, { schedule: { cycle: 'daily', mode: 'fixed', time: '12:00' } });
  const tasks = a.proactiveV2;
  const item = { ...tasks.item(task.contacts[0]), status: 'failed', attempts: 3 };
  task.run = { id: 'run-1', at: a.now(), occurrenceDate: '2026-09-17', schedule: structuredClone(task.schedule), items: [item] };
  tasks.settle(task);
  assert.equal(task.status, 'failed'); assert.equal(task.nextAt, null);
  assert.match(task.reason, /自动重试 3 次/);
  task.nextAt = a.now();
  tasks.reviveRetryable(task);
  assert.equal(item.status, 'failed', 'a spent recipient stays failed');
});

test('an incoming message during generation regenerates the copy once instead of cancelling', async t => {
  const { a, bridge, provider } = await fixture(t);
  const contact = bridge.contacts[0].id;
  await create(a, bridge);
  // The model call is where a new message from the other side lands.
  provider.next = async () => { bridge.push(contact, 'other', 'CHAT_NEW_MARKER'); return { action: 'send', text: 'GENERATED_PRIVATE_MARKER' }; };
  provider.calls.length = 0;
  await ticks(a);
  assert.equal(provider.calls.length, 2, 'exactly one regeneration');
  assert.equal(bridge.sent.length, 1, 'the message is still delivered');
  assert.equal(a.data.proactiveRecords[0].status, 'sent');
});

test('an unconfirmed send never auto-retries', async t => {
  const { a, bridge } = await fixture(t);
  const task = await create(a, bridge, { schedule: { cycle: 'daily', mode: 'fixed', time: '12:00' } });
  const tasks = a.proactiveV2;
  const item = { ...tasks.item(task.contacts[0]), status: 'uncertain', attempts: 1 };
  task.run = { id: 'run-1', at: a.now(), occurrenceDate: '2026-09-17', schedule: structuredClone(task.schedule), items: [item] };
  tasks.settle(task);
  assert.equal(task.status, 'failed'); assert.match(task.reason, /待核对/);
  task.nextAt = a.now();
  tasks.reviveRetryable(task);
  assert.equal(item.status, 'uncertain');
});
