import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { analysisOptions } from '../server/ai-analysis.mjs';
import { learnedObjectDraft } from '../web/ai-learning-draft.mjs';
import { desktopAction, desktopStatus } from '../web/wechat-state.mjs';
import { defaultStyle } from '../server/ai-schema.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  await a.learn({ contacts: [bridge.contacts[0].id] });
  return { a, bridge, provider, p: a.profiles()[0] };
}
test('desktop reconnect preserves logged-in distinction and offers login after an aged explicit logout', () => {
  assert.match(desktopStatus({ status: 'running', loginStatus: 'logged-in' }, false, false), /仍已登录.*连接已断开/);
  assert.equal(desktopAction({ status: 'running', loginStatus: 'unknown', lastLoginStatus: 'relogin-required' }, false).login, true);
  assert.equal(desktopAction({ status: 'running', loginStatus: 'unknown', lastLoginStatus: 'logged-in' }, false).login, false);
  assert.match(desktopStatus({ status: 'error', message: '启动失败' }, false, false), /启动失败/);
});
test('explicit contact multi-turn survives a single-message proactive continuation', async t => {
  const { a, p } = await fixture(t);
  a.data.settings.proactive = true; a.data.proactiveTargets = [p.id]; p.continuation = { strategy: { sendMode: 'single' } };
  p.replyOptions = { multiTurn: true };
  assert.equal(a.multiTurn(p, 'reply'), true); assert.equal(a.multiTurn(p, 'proactive', { sendMode: 'single' }), false);
  p.replyOptions.multiTurn = false; assert.equal(a.multiTurn(p, 'reply', { sendMode: 'segments' }), false);
});
test('nonempty learned memory is preserved without a lock; cleared memory can be filled by a new learning', async t => {
  const { a, p, provider } = await fixture(t);
  p.memory = a.vault.seal({ summary: '已有正式记忆' }); p.memoryLocked = false;
  provider.next = async () => ({ style: defaultStyle, memory: { summary: '新候选' } });
  await a.learn({ contacts: [p.contact] });
  let result = a.publicState().profiles.find(x => x.id === p.id);
  assert.equal(result.memory.summary, '已有正式记忆\n新候选'); assert.ok(!result.memorySuggestion);
  await a.editMemory(p.id, { summary: '' });
  provider.next = async () => ({ style: defaultStyle, memory: { summary: '空内容重新填入' } });
  await a.learn({ contacts: [p.contact] }); result = a.publicState().profiles.find(x => x.id === p.id);
  assert.equal(result.memory.summary, '空内容重新填入'); assert.ok(!result.memorySuggestion);
});
test('learning fills a stale blank draft but preserves text and strategy edited during learning', () => {
  const learned = { style: { summary: '新风格' }, styleId: 'custom', memory: { summary: '新记忆' } };
  const before = { summary: '', styleId: '', memorySummary: '', replyGoal: '旧策略' };
  assert.equal(learnedObjectDraft(before, before, { memory: { summary: '' } }, learned).memorySummary, '新记忆');
  const current = { ...before, summary: '学习期间修改', memorySummary: '正在手填', replyGoal: '新策略' };
  const next = learnedObjectDraft(current, before, {}, learned);
  assert.equal(next.summary, '学习期间修改'); assert.equal(next.memorySummary, '正在手填'); assert.equal(next.replyGoal, '新策略');
});
test('analysis reads exact date bounds and isolates reports without sending messages or saving bodies', async t => {
  const { a, bridge, provider } = await fixture(t), ids = bridge.contacts.slice(0, 2).map(c => c.id), calls = [];
  const options = analysisOptions({ request: '总结约定', contacts: ids, from: '2026-09-01', to: '2026-09-02' });
  bridge.readRange = async args => { calls.push(args); return { account: args.account, contact: args.contact, rangeRevision: key(args.contact), messages: [{ id: key(args.contact), timestamp: options.from, direction: 'self', text: args.contact }] }; };
  provider.complete = async (_config, _system, input) => ({ report: '报告：' + input.messages[0].text });
  const result = await a.analyze({ request: '总结约定', contacts: ids, from: '2026-09-01', to: '2026-09-02' });
  assert.deepEqual(result.reports.map(r => r.report), ids.map(id => '报告：' + id));
  assert.ok(calls.every(c => c.from === options.from && c.to === options.to)); assert.equal(bridge.sent.length, 0);
  assert.equal(a.operation, null); assert.equal(a.publicState().reports, undefined);
});
test('analysis rejects out-of-range data before any model call and marks per-contact failure', async t => {
  const { a, bridge, provider, p } = await fixture(t); let called = false;
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, rangeRevision: key('range'), messages: [{ timestamp: args.to, text: 'outside' }] });
  provider.complete = async () => { called = true; };
  const result = await a.analyze({ request: '总结', contacts: [p.contact], from: '2026-09-01', to: '2026-09-02' });
  assert.equal(called, false); assert.equal(result.reports[0].status, 'error');
});
test('analysis validates real calendar dates and preserves inclusive end dates', () => {
  assert.throws(() => analysisOptions({ request: 'a', contacts: ['a'], from: '2026-02-30', to: '2026-03-01' }));
  assert.throws(() => analysisOptions({ request: 'a', contacts: ['a'], from: '2026-03-02', to: '2026-03-01' }));
  const range = analysisOptions({ request: 'a', contacts: ['a'], from: '2026-09-01', to: '2026-09-01' });
  assert.equal(range.to - range.from, 86400);
});
