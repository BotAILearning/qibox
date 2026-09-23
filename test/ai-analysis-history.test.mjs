import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { tailWithinLimit } from '../server/ai-analysis.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const stamp = value => Math.floor(Date.parse(value) / 1000);
const batchReport = (_input, report = '分析报告') => ({ report });

test('analysis retains the newest 150000 Unicode code points and marks a partial source message', () => {
  const messages = [
    { id: 'first', direction: 'self', text: '旧内容', timestamp: 1000 },
    { id: 'large', direction: 'other', text: '😀'.repeat(150001), timestamp: 2000 },
    { id: 'last', direction: 'other', text: '后来确认', timestamp: 3000 },
  ];
  const { messages: kept, coverage } = tailWithinLimit(messages);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].id, 'large');
  assert.equal(Array.from(kept[0].text).length, 149996);
  assert.equal(kept[1].id, 'last');
  assert.equal(coverage.analyzedChars, 150000);
  assert.equal(coverage.totalChars, 150008);
  assert.equal(coverage.omittedMessages, 1);
  assert.equal(coverage.partialMessages, 1);
  assert.equal(coverage.truncated, true);
});

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan();
  return { root, bridge, provider, a, contact: bridge.contacts[0].id };
}

test('单联系人一次请求覆盖全部消息并保存完整统计，不保存聊天片段', async t => {
  const { root, bridge, provider, a, contact } = await fixture(t);
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: key(`analysis-long-${index}`), direction: index % 2 ? 'other' : 'self', text: `关键安排 ${index}：${'具体事件与双方约定。'.repeat(90)}`, timestamp: stamp('2026-09-01T09:15:00+08:00') + index * 86400 }));
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages });
  let calls = 0, captured = null;
  provider.complete = async (_config, system, input) => {
    provider.calls.push({ input, system }); calls++; captured = input;
    return batchReport(input, '完整分析报告');
  };
  const result = (await a.analyze({ request: '提取关键事件', contacts: [contact] })).reports[0];
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(calls, 1);
  assert.match(provider.calls[0].system, /4–6 个短章节/); assert.match(provider.calls[0].system, /每章标题不超过 20 字，正文约 60–140 字/);
  assert.match(provider.calls[0].system, /用户明确指定格式时优先按其格式/); assert.equal(captured.userRequest, '提取关键事件');
  assert.ok(captured.messages.every(message => Array.isArray(message) && Number.isSafeInteger(message[1]) && message.length === 3));
  assert.deepEqual(captured.messages.map(row => row[2]), messages.map(row => row.text));
  assert.deepEqual(captured.messages[0].slice(0, 2), ['s', messages[0].timestamp]);
  assert.equal(captured.coverage.truncated, false);
  assert.equal(captured.coverage.analyzedChars, messages.reduce((sum, row) => sum + Array.from(row.text).length, 0));
  assert.equal(Object.hasOwn(result, 'sampledCount'), false);
  assert.equal(result.scope, 'full');
  assert.equal(Object.hasOwn(result, 'excerpts'), false); assert.equal(result.metrics.total, 100); assert.equal(a.publicState().analysis.history.length, 1);
  const saved = a.analysisReport(result.historyId); assert.equal(Object.hasOwn(saved, 'excerpts'), false); assert.equal(saved.report, result.report); assert.equal(saved.request, '提取关键事件');
  const reopened = new AIAssistant({ dataRoot: root, bridge, provider }); await reopened.init(); t.after(async () => reopened.close());
  assert.equal(Object.hasOwn(reopened.analysisReport(result.historyId), 'excerpts'), false);
});
test('多人单请求被拒绝，必须由前端逐人排队', async t => {
  const { bridge, provider, a } = await fixture(t);
  bridge.contacts = Array.from({ length: 10 }, (_, index) => ({ id: key(`batch-contact-${index}`), label: `测试对象${index}`, kind: 'person' }));
  await a.scan();
  const ids = bridge.contacts.map(contact => contact.id), messageIds = new Map(ids.map(id => [id, key(`message-${id}`)]));
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: messageIds.get(args.contact), direction: 'other', text: `synthetic-${args.contact}`, timestamp: stamp('2026-09-02T10:00:00+08:00') }] });
  let calls = 0;
  provider.complete = async () => { calls++; return { report: '不应发生' }; };
  await assert.rejects(a.analyze({ request: '总结', contacts: ids }), /每次请求只能分析一位联系人/);
  assert.equal(calls, 0);
});

test('默认报告把模型的 Markdown 标题整理为短章节，用户指定格式时保留原文', async t => {
  const { a, bridge, provider, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact,
    messages: [{ id: key('format-report'), direction: 'other', text: '下周一起看展', timestamp: stamp('2026-09-02T10:00:00+08:00') }] });
  provider.complete = async () => ({ report: '# 数据开场\n\n有依据的正文\n\n# 收尾\n\n简短收尾' });
  const plain = (await a.analyze({ request: '', contacts: [contact] })).reports[0];
  assert.equal(plain.status, 'complete');
  assert.equal(plain.report, '数据开场\n有依据的正文\n\n收尾\n简短收尾');
  const custom = (await a.analyze({ request: '请用 Markdown 标题格式', contacts: [contact] })).reports[0];
  assert.equal(custom.status, 'complete');
  assert.match(custom.report, /^# 数据开场\n\n/);
  provider.complete = async () => ({ report: '共有一段可分析的聊天。\n\n聊天节奏\n正文二\n\n关键片段\n正文三\n\n收尾\n正文四' });
  const missingTitle = (await a.analyze({ request: '', contacts: [contact] })).reports[0];
  assert.match(missingTitle.report, /^数据开场\n共有一段可分析的聊天。/);
});

test('desktop activity does not abort an in-progress analysis read', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  let entered, release, observedSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  bridge.readRange = async args => {
    observedSignal = args.signal;
    entered();
    await gate;
    return { account: args.account, contact: args.contact, messages: [
      { id: key('during-activity'), direction: 'other', text: '这周末一起去看展', timestamp: stamp('2026-09-02T10:00:00+08:00') },
    ] };
  };
  a.ticking = true;
  provider.complete = async (_config, _system, input) => batchReport(input, '周末看展是这段对话的主题');
  const analyzing = a.analyze({ request: '', contacts: [contact] });
  await started;
  a.userActivity();
  assert.equal(observedSignal.aborted, false);
  release();
  const report = (await analyzing).reports[0];
  assert.equal(report.status, 'complete');
  assert.equal(report.report, '周末看展是这段对话的主题');
});
test('超过 150000 Unicode 字符时保留最近内容并明确标记截断', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [
    { id: key('over-limit'), direction: 'other', text: '😀'.repeat(150001), timestamp: stamp('2026-09-02T10:00:00+08:00') },
  ] });
  let calls = 0, sent; provider.complete = async (_config, _system, input) => { calls++; sent = input; return { report: '截断范围分析' }; };
  const report = (await a.analyze({ request: '', contacts: [contact] })).reports[0];
  assert.equal(report.status, 'complete'); assert.equal(calls, 1);
  assert.equal(sent.coverage.totalChars, 150001); assert.equal(sent.coverage.analyzedChars, 150000);
  assert.equal(report.truncated, true); assert.equal(report.scope, 'truncated'); assert.equal(report.partialMessages, 1);
  assert.equal(Object.hasOwn(report, 'sampledCount'), false); assert.equal(a.publicState().analysis.history.length, 1);
});
test('底层读取截断仍只发一次请求并明确标记不完整范围', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, truncated: true, truncatedReasons: ['output_bytes'], messages: [
    { id: key('partial-read'), direction: 'other', text: '读取到的片段', timestamp: stamp('2026-09-02T10:00:00+08:00') },
  ] });
  let calls = 0; provider.complete = async () => { calls++; return { report: '已读取部分的分析' }; };
  const report = (await a.analyze({ request: '', contacts: [contact] })).reports[0];
  assert.equal(report.status, 'complete'); assert.equal(report.scope, 'truncated');
  assert.ok(report.truncatedReasons.includes('output_bytes'));
  assert.equal(calls, 1); assert.equal(a.publicState().analysis.history.length, 1);
});
test('100000 条以上短消息遇到读取数量截断时不冒充完整范围', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  const timestamp = stamp('2026-09-02T10:00:00+08:00');
  const messages = Array.from({ length: 100001 }, (_, index) => ({ id: `short-${index}`, direction: 'other', text: '好', timestamp }));
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages, truncated: true, truncatedReasons: ['message_limit'] });
  let calls = 0; provider.complete = async (_config, _system, input) => { calls++; assert.equal(input.messages.length, 100001); return { report: '已读取部分分析' }; };
  const report = (await a.analyze({ request: '', contacts: [contact] })).reports[0];
  assert.equal(report.status, 'complete'); assert.equal(report.count, 100001); assert.equal(report.truncated, true);
  assert.ok(report.truncatedReasons.includes('message_limit'));
  assert.equal(calls, 1); assert.equal(a.publicState().analysis.history.length, 1);
});
test('模型一次返回空报告时保留明确错误且不写历史或伪造正文', async t => {
  const { bridge, provider, a } = await fixture(t), id = bridge.contacts[0].id;
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key(`missing-${args.contact}`), direction: 'self', text: 'fixture', timestamp: stamp('2026-09-02T10:00:00+08:00') }] });
  let calls = 0;
  provider.complete = async () => { calls++; return { report: '' }; };
  const rows = (await a.analyze({ request: '总结', contacts: [id] })).reports;
  assert.equal(calls, 1, 'an empty report must not trigger another model request');
  assert.equal(rows[0].status, 'error'); assert.match(rows[0].error, /没有返回有效报告正文/);
  assert.equal(Object.hasOwn(rows[0], 'report'), false);
  assert.equal(a.publicState().analysis.history.length, 0);
});
test('同一联系人每次生成独立历史；空数据和模型失败不伪造历史', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  let mode = 'ok';
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: mode === 'empty' ? [] : [{ id: key('history-message'), direction: 'other', text: '可验证的聊天片段', timestamp: stamp('2026-09-02T10:00:00+08:00') }] });
  provider.complete = async (_config, _system, input) => { provider.calls.push({ input }); if (mode === 'fail') throw new Error('model unavailable'); return batchReport(input, `第${a.publicState().analysis.history.length + 1}份报告`, false); };
  const one = await a.analyze({ request: '第一次要求', contacts: [contact] });
  const two = await a.analyze({ request: '第二次要求', contacts: [contact] });
  assert.notEqual(one.reports[0].historyId, two.reports[0].historyId);
  assert.equal(a.publicState().analysis.history.length, 2);
  assert.equal(Object.hasOwn(a.analysisReport(two.reports[0].historyId), 'excerpts'), false, '新报告不保存聊天片段');
  mode = 'empty'; const empty = await a.analyze({ request: '空数据', contacts: [contact] });
  assert.equal(empty.reports[0].status, 'empty'); assert.equal(a.publicState().analysis.history.length, 2);
  mode = 'fail'; const failed = await a.analyze({ request: '模型失败', contacts: [contact] });
  assert.equal(failed.reports[0].status, 'error'); assert.equal(a.publicState().analysis.history.length, 2);
});

test('历史按微信账号隔离，删除需服务端成功且失败保留条目', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key('delete-message'), direction: 'self', text: '仅用于测试删除闭环', timestamp: stamp('2026-09-04T12:00:00+08:00') }] });
  provider.complete = async (_c, _s, input) => batchReport(input, '可删除的测试报告', false);
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
  provider.complete = async (_c, _s, input) => batchReport(input, '并发报告', false);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), originalSave = a.save.bind(a); let saves = 0;
  a.save = async () => { if (++saves === 1) { entered.resolve(); await release.promise; return; } return originalSave(); };
  const account = a.data.account, pending = a.saveAnalysisReport({ contact, label: '测试对象', count: 1, skipped: 0, metrics: { total: 1 }, excerpts: [], actualRange: { from: '2026-09-05', to: '2026-09-05' }, report: '并发报告' }, { account, request: '', requestedRange: { from: null, to: null } });
  const rejected = assert.rejects(pending, /账号.*变化/);
  await entered.promise; a.data.account = key('account-raced'); release.resolve();
  await rejected;
  assert.equal(a.analysisHistory().length, 0); assert.equal(a.data.analysisReports.some(report => report.account === key('account-raced')), false);
  a.save = originalSave;
});

test('底层读取截断原因随报告保存且不冒充完整范围', async t => {
  const { bridge, provider, a, contact } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, truncated: true, truncatedReasons: ['message_length'], messages: [{ id: key('truncate-message'), direction: 'other', text: '保留的片段', timestamp: stamp('2026-09-06T08:00:00+08:00') }] });
  let calls = 0; provider.complete = async () => { calls++; return { report: '读取到的聊天片段分析' }; };
  const result = await a.analyze({ request: '', contacts: [contact] });
  assert.equal(result.reports[0].status, 'complete'); assert.equal(result.reports[0].truncated, true);
  assert.ok(result.reports[0].truncatedReasons.includes('message_length'));
  assert.equal(calls, 1); assert.equal(a.publicState().analysis.history.length, 1);
});
