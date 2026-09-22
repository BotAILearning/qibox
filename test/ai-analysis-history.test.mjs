import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const stamp = value => Math.floor(Date.parse(value) / 1000);

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan();
  return { root, bridge, provider, a, contact: bridge.contacts[0].id };
}

test('分析报告用真实范围、统计和片段生成，并在长记录分块后保存快照', async t => {
  const { root, bridge, provider, a, contact } = await fixture(t);
  const first = stamp('2026-09-01T09:15:00+08:00'), second = stamp('2026-09-03T20:30:00+08:00');
  const messages = [
    { id: key('analysis-1'), direction: 'self', text: '周六去看展，记得带票。', timestamp: first },
    { id: key('analysis-2'), direction: 'other', text: '好，下午三点见。', timestamp: first + 3600 },
    ...Array.from({ length: 24 }, (_, index) => ({ id: key(`analysis-long-${index}`), direction: index % 2 ? 'other' : 'self', text: `长记录 ${index} ${'具体安排和上下文 '.repeat(180)}`, timestamp: first + 7200 + index * 3600 })),
    { id: key('analysis-3'), direction: 'other', text: '那周末见。', timestamp: second },
  ];
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages });
  provider.complete = async (_config, _system, input) => { provider.calls.push({ input }); return { report: `真实报告：${input.metrics.total}条，${input.actualRange.from}至${input.actualRange.to}，片段“${input.excerpts[0].text}”，要求：${input.userRequest}` }; };
  const selected = await a.analyze({ request: '保留具体约定', from: '2026-09-01', to: '2026-09-03', contacts: [contact] });
  const result = selected.reports[0];
  assert.equal(result.status, 'complete');
  assert.equal(result.actualRange.from, '2026-09-01'); assert.equal(result.actualRange.to, '2026-09-03');
  assert.equal(result.metrics.total, messages.length); assert.equal(result.metrics.self, 13); assert.equal(result.metrics.other, 14);
  assert.equal(result.excerpts[0].text, '周六去看展，记得带票。'); assert.ok(provider.calls.length > 1, `长记录实际触发分块调用，当前 ${provider.calls.length}`);
  assert.match(provider.calls[0].input.userRequest, /具体约定/);
  assert.equal(a.publicState().analysis.history.length, 1);
  const id = result.historyId, saved = a.analysisReport(id);
  assert.equal(saved.id, id); assert.equal(saved.report, result.report); assert.equal(saved.request, '保留具体约定');

  const reopened = new AIAssistant({ dataRoot: root, bridge, provider }); await reopened.init();
  t.after(async () => reopened.close());
  assert.equal(reopened.publicState().analysis.history.length, 1, '重启后仍能看到历史摘要');
  assert.equal(reopened.analysisReport(id).report, result.report, '详情读取保存快照');
});

test('同一联系人每次生成独立历史；空数据和模型失败不伪造历史', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  let mode = 'ok';
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: mode === 'empty' ? [] : [{ id: key('history-message'), direction: 'other', text: '可验证的聊天片段', timestamp: stamp('2026-09-02T10:00:00+08:00') }] });
  provider.complete = async () => { if (mode === 'fail') throw new Error('model unavailable'); return { report: `第${a.publicState().analysis.history.length + 1}份报告` }; };
  const one = await a.analyze({ request: '第一次要求', contacts: [contact] });
  const two = await a.analyze({ request: '第二次要求', contacts: [contact] });
  assert.notEqual(one.reports[0].historyId, two.reports[0].historyId);
  assert.equal(a.publicState().analysis.history.length, 2);
  mode = 'empty'; const empty = await a.analyze({ request: '空数据', contacts: [contact] });
  assert.equal(empty.reports[0].status, 'empty'); assert.equal(a.publicState().analysis.history.length, 2);
  mode = 'fail'; const failed = await a.analyze({ request: '模型失败', contacts: [contact] });
  assert.equal(failed.reports[0].status, 'error'); assert.equal(a.publicState().analysis.history.length, 2);
});

test('历史按微信账号隔离，删除需服务端成功且失败保留条目', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key('delete-message'), direction: 'self', text: '仅用于测试删除闭环', timestamp: stamp('2026-09-04T12:00:00+08:00') }] });
  provider.complete = async () => ({ report: '可删除的测试报告' });
  const generated = await a.analyze({ request: '删除测试', contacts: [contact] });
  const id = generated.reports[0].historyId;
  const originalSave = a.save.bind(a); a.save = async () => { throw new Error('disk full'); };
  await assert.rejects(a.deleteAnalysisReport(id), /disk full/);
  assert.equal(a.publicState().analysis.history.length, 1, '删除失败仍保留历史条目');
  a.save = originalSave;
  const otherAccount = key('account-two'); bridge.account = otherAccount;
  await a.scan();
  assert.equal(a.publicState().analysis.history.length, 0, '切换账号后旧报告不可见');
  assert.throws(() => a.analysisReport(id), /不存在或不属于当前微信账号/);
  bridge.account = key('account-one'); await a.scan();
  assert.equal(a.publicState().analysis.history.length, 1, '返回原账号后报告仍存在');
  await a.deleteAnalysisReport(id); assert.equal(a.publicState().analysis.history.length, 0);
});

test('保存报告期间账号变化会回滚快照，不把迟到成功写入新账号', async t => {
  const { a, bridge, provider, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key('race-message'), direction: 'other', text: '并发测试', timestamp: stamp('2026-09-05T12:00:00+08:00') }] });
  provider.complete = async () => ({ report: '并发报告' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), originalSave = a.save.bind(a); let saves = 0;
  a.save = async () => { if (++saves === 1) { entered.resolve(); await release.promise; return; } return originalSave(); };
  const account = a.data.account, pending = a.saveAnalysisReport({ contact, label: '测试对象', count: 1, skipped: 0, metrics: { total: 1 }, excerpts: [], actualRange: { from: '2026-09-05', to: '2026-09-05' }, report: '并发报告' }, { account, request: '', requestedRange: { from: null, to: null } });
  const rejected = assert.rejects(pending, /账号.*变化/);
  await entered.promise; a.data.account = key('account-raced'); release.resolve();
  await rejected;
  assert.equal(a.analysisHistory().length, 0); assert.equal(a.data.analysisReports.some(report => report.account === key('account-raced')), false);
  a.save = originalSave;
});

test('截断原因和全部范围实际日期随报告保留', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, truncated: true, truncatedReasons: ['message_length'], messages: [{ id: key('truncate-message'), direction: 'other', text: '保留的片段', timestamp: stamp('2026-09-06T08:00:00+08:00') }] });
  provider.complete = async () => ({ report: '标题\n\n正文' });
  const result = await a.analyze({ request: '', contacts: [contact] });
  assert.deepEqual(result.reports[0].truncatedReasons, ['message_length']);
  assert.deepEqual(a.analysisReport(result.reports[0].historyId).actualRange, { from: '2026-09-06', to: '2026-09-06' });
});
