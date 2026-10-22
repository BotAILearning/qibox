import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { withAccountRequestScope } from '../server/ai-account-scope.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

// Production service and atomicJson run against disposable files. The provider
// and WeChat bridge are fixtures; no case calls a real model or sends WeChat.
async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const options = { dataRoot: root, bridge, provider, now: () => 1792548000000 };
  const a = new AIAssistant(options); await a.init();
  clearInterval(a.timer); clearInterval(a.warmupTimer); await a.scan();
  const save = a.save;
  t.after(async () => { a.save = save; await a.close(); await cleanup(root); });
  return { root, bridge, provider, options, a, save };
}

const reportInput = (contact, report) => ({ contact, label: '合成报告对象', count: 1, metrics: { total: 1 }, report });
const reportOptions = a => ({ account: a.data.account, request: '隔离持久化验证', requestedRange: { from: null, to: null } });
const reportProjection = data => data.analysisReports.map(row => ({ id: row.id, account: row.account, report: row.report }));
const fileError = error => ['EISDIR', 'EPERM', 'EACCES', 'ENOTDIR', 'EEXIST'].includes(error.code);

async function saveReport(f, body) {
  return f.a.saveAnalysisReport(reportInput(f.bridge.contacts[0].id, body), reportOptions(f.a));
}

// Hold only the next production save, then give that save a real directory as
// its rename destination. Concurrent ordinary saves use the untouched original
// file. This is an I/O scheduling seam, not a fake storage exception.
async function heldFilesystemFailure(f, { fail = true } = {}) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const file = f.a.file, blocked = path.join(f.root, 'post013-write-destination-is-directory');
  await mkdir(blocked); let first = true;
  f.a.save = function (...args) {
    if (!first) return f.save.apply(this, args);
    first = false; entered.resolve();
    return released.promise.then(async () => {
      if (fail) this.file = blocked;
      try { return await f.save.apply(this, args); }
      finally { this.file = file; }
    });
  };
  return { entered: entered.promise, release: () => released.resolve(), file };
}

async function reopen(f) {
  const a = new AIAssistant(f.options); await a.init();
  clearInterval(a.timer); clearInterval(a.warmupTimer);
  try { return { reports: reportProjection(a.data), config: structuredClone(a.config), assignments: structuredClone(a.assignments) }; }
  finally { await a.close(); }
}

test('failed analysis save cannot be published by an overlapping ordinary save or survive restart', async t => {
  const f = await fixture(t); await saveReport(f, '已提交原报告');
  const before = reportProjection(f.a.data), gate = await heldFilesystemFailure(f);
  const operation = saveReport(f, '未提交新增报告'), rejected = assert.rejects(operation, fileError);
  await gate.entered;
  f.a.data.post013IndependentProgress = 'background-progress-survives';
  const background = f.a.save();
  await new Promise(resolve => setImmediate(resolve));
  gate.release(); await rejected; await background;
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  t.diagnostic(JSON.stringify({ scenario: 'analysis-create-failure-overlap', before, memory: reportProjection(f.a.data), disk: reportProjection(disk), restarted: restarted.reports, backgroundProgress: disk.post013IndependentProgress, simulatedProviderCalls: f.provider.calls.length, wechatSends: f.bridge.sent.length }));
  assert.deepEqual(reportProjection(f.a.data), before, 'Rejected report is removed from memory');
  assert.deepEqual(reportProjection(disk), before, 'An ordinary save must not publish the rejected report');
  assert.deepEqual(restarted.reports, before, 'Restart must agree with the rejected create');
  assert.equal(disk.post013IndependentProgress, 'background-progress-survives');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('failed analysis delete retains exactly the original reports across accounts and restart despite ordinary save', async t => {
  const f = await fixture(t), accountA = f.bridge.account;
  const removed = await saveReport(f, 'A账号待删除报告'); await saveReport(f, 'A账号保留报告');
  f.bridge.account = key('post013-account-B'); await f.a.scan(); await saveReport(f, 'B账号保留报告');
  f.bridge.account = accountA; await f.a.scan();
  const before = reportProjection(f.a.data), gate = await heldFilesystemFailure(f);
  const operation = f.a.deleteAnalysisReport(removed.id), rejected = assert.rejects(operation, fileError);
  await gate.entered;
  f.a.data.post013IndependentProgress = 'background-progress-survives';
  const background = f.a.save();
  await new Promise(resolve => setImmediate(resolve));
  gate.release(); await rejected; await background;
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  t.diagnostic(JSON.stringify({ scenario: 'analysis-delete-failure-overlap', before, memory: reportProjection(f.a.data), disk: reportProjection(disk), restarted: restarted.reports, backgroundProgress: disk.post013IndependentProgress, simulatedProviderCalls: f.provider.calls.length, wechatSends: f.bridge.sent.length }));
  assert.deepEqual(reportProjection(f.a.data), before, 'Delete failure restores the removed current-account record');
  assert.deepEqual(reportProjection(disk), before, 'A later snapshot must not commit a rejected deletion');
  assert.deepEqual(restarted.reports, before, 'Restart retains both A reports and the unrelated B report');
  assert.equal(disk.post013IndependentProgress, 'background-progress-survives');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('failed model transaction preserves saved models while an independent report commit and ordinary progress survive restart', async t => {
  const f = await fixture(t);
  const originalModel = { ...modelConfig, id: 'post013-model', label: '已提交模型' };
  await f.a.saveModels({ models: [originalModel], assignments: { chat: originalModel.id, learningAnalysis: originalModel.id } });
  const beforeConfig = structuredClone(f.a.config), beforeAssignments = structuredClone(f.a.assignments);
  const beforeModelList = structuredClone(f.a.data.modelList), gate = await heldFilesystemFailure(f);
  const operation = f.a.saveModels({ models: [{ ...originalModel, model: 'uncommitted-model', apiKey: 'uncommitted-fixture-key' }], assignments: beforeAssignments });
  const rejected = assert.rejects(operation, fileError); await gate.entered;
  f.a.data.post013IndependentProgress = 'background-progress-survives';
  const report = saveReport(f, '模型保存失败时仍应正常保存的独立报告'), background = f.a.save();
  await new Promise(resolve => setImmediate(resolve));
  gate.release(); await rejected; const saved = await report; await background;
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  t.diagnostic(JSON.stringify({ scenario: 'model-failure-independent-report', oldModel: beforeConfig.model, runtimeModel: f.a.config.model, restartedModel: restarted.config.model, savedReportId: saved.id, memoryReportIds: f.a.data.analysisReports.map(row => row.id), diskReportIds: disk.analysisReports.map(row => row.id), restartedReportIds: restarted.reports.map(row => row.id), simulatedProviderCalls: f.provider.calls.length, wechatSends: f.bridge.sent.length }));
  assert.deepEqual(f.a.config, beforeConfig); assert.deepEqual(restarted.config, beforeConfig);
  assert.deepEqual(f.a.assignments, beforeAssignments); assert.deepEqual(restarted.assignments, beforeAssignments);
  assert.deepEqual(disk.modelList, beforeModelList, 'Rejected model/key ciphertext never replaces committed configuration');
  assert.deepEqual(disk.analysisReports.map(row => row.id), [saved.id]);
  assert.deepEqual(restarted.reports.map(row => row.id), [saved.id]);
  assert.equal(disk.post013IndependentProgress, 'background-progress-survives');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('failed report create cannot erase a concurrent successful deletion of an existing report', async t => {
  const f = await fixture(t), removed = await saveReport(f, '随后成功删除的原报告');
  const kept = await saveReport(f, '独立保留的原报告'), gate = await heldFilesystemFailure(f);
  const creation = saveReport(f, '保存失败的新报告'), rejected = assert.rejects(creation, fileError);
  await gate.entered;
  const deletion = f.a.deleteAnalysisReport(removed.id);
  f.a.data.post013IndependentProgress = 'parallel-delete'; const background = f.a.save();
  await new Promise(resolve => setImmediate(resolve)); gate.release();
  await rejected; await deletion; await background;
  const expected = [{ id: kept.id, account: kept.account, report: kept.report }];
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  assert.deepEqual(reportProjection(f.a.data), expected); assert.deepEqual(reportProjection(disk), expected); assert.deepEqual(restarted.reports, expected);
  assert.equal(disk.post013IndependentProgress, 'parallel-delete');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('failed report delete does not undo a concurrent different deletion or a successful new report', async t => {
  const f = await fixture(t), accountA = f.bridge.account;
  const restored = await saveReport(f, '删除失败应保留'), removed = await saveReport(f, '并发删除成功应移除');
  f.bridge.account = key('post013-parallel-account-B'); await f.a.scan(); const otherAccount = await saveReport(f, '另一账号保持原样');
  f.bridge.account = accountA; await f.a.scan();
  const gate = await heldFilesystemFailure(f), deletion = f.a.deleteAnalysisReport(restored.id), rejected = assert.rejects(deletion, fileError);
  await gate.entered;
  const secondDeletion = f.a.deleteAnalysisReport(removed.id), creation = saveReport(f, '并发保存成功的新报告');
  f.a.data.post013IndependentProgress = 'parallel-create-delete'; const background = f.a.save();
  await new Promise(resolve => setImmediate(resolve)); gate.release();
  await rejected; await secondDeletion; const saved = await creation; await background;
  const expected = [restored, otherAccount, saved].map(({ id, account, report }) => ({ id, account, report }));
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  assert.deepEqual(reportProjection(f.a.data), expected); assert.deepEqual(reportProjection(disk), expected); assert.deepEqual(restarted.reports, expected);
  assert.equal(disk.post013IndependentProgress, 'parallel-create-delete');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('account replacement during a held successful report write cancels only that report and persists the replacement account', async t => {
  const f = await fixture(t), accountA = f.bridge.account, original = await saveReport(f, '原账号已提交报告');
  const gate = await heldFilesystemFailure(f, { fail: false }), creation = saveReport(f, '账号变化后的迟到报告');
  const rejected = assert.rejects(creation, /分析已取消或微信账号已变化/); await gate.entered;
  const accountB = key('post013-replacement-account-B'); f.bridge.account = accountB;
  const scan = f.a.scan();
  for (let attempt = 0; attempt < 100 && f.a.data.account !== accountB; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.a.data.account, accountB, 'The actual scan reached the replacement identity before releasing storage');
  f.a.data.post013IndependentProgress = 'replacement-account'; const background = f.a.save();
  gate.release(); await rejected; await scan; await background;
  const expected = [{ id: original.id, account: accountA, report: original.report }];
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  assert.deepEqual(reportProjection(f.a.data), expected); assert.deepEqual(reportProjection(disk), expected); assert.deepEqual(restarted.reports, expected);
  assert.equal(disk.account, accountB); assert.equal(f.a.analysisHistory().length, 0, 'The replacement account cannot see the original report');
  assert.equal(disk.post013IndependentProgress, 'replacement-account');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

for (const scanReplacement of [false, true]) test(`scoped report delete rejects a replacement native account ${scanReplacement ? 'after an actual scan' : 'before the cached account refreshes'} without returning replacement history`, async t => {
  const f = await fixture(t), accountA = f.bridge.account, removed = await saveReport(f, 'A待删除报告');
  const kept = await saveReport(f, 'A保留报告'), accountB = key('post013-scoped-delete-account-B');
  f.bridge.account = accountB; await f.a.scan(); const other = await saveReport(f, 'B独有报告摘要');
  f.bridge.account = accountA; await f.a.scan();
  const gate = await heldFilesystemFailure(f, { fail: false });
  const deletion = withAccountRequestScope(f.a, accountA, () => f.a.deleteAnalysisReport(removed.id));
  const outcome = deletion.then(value => ({ value }), error => ({ error })); await gate.entered;
  f.bridge.account = accountB; const scan = scanReplacement ? f.a.scan() : Promise.resolve();
  if (scanReplacement) for (let attempt = 0; attempt < 100 && f.a.data.account !== accountB; attempt++) await new Promise(resolve => setImmediate(resolve));
  const changedBeforePersistCompleted = !scanReplacement || f.a.data.account === accountB;
  f.a.data.post013IndependentProgress = 'scoped-delete-progress'; const background = f.a.save();
  gate.release(); const response = await outcome; await scan; await background;
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  t.diagnostic(JSON.stringify({ scenario: 'scoped-delete-replacement', scanReplacement, changedBeforePersistCompleted, errorStatus: response.error?.status, errorCode: response.error?.code, returnedReportIds: response.value?.history?.map(row => row.id), returnedOtherAccountReport: !!response.value?.history?.some(row => row.id === other.id), memoryReportIds: f.a.data.analysisReports.map(row => row.id), diskReportIds: disk.analysisReports.map(row => row.id) }));
  assert.equal(changedBeforePersistCompleted, true);
  assert.equal(response.error?.status, 409, 'A request cannot complete with history after native identity changes');
  assert.equal(response.value, undefined, 'No replacement-account or stale-account history is returned');
  const expected = [kept, other].map(({ id, account, report }) => ({ id, account, report }));
  assert.deepEqual(reportProjection(f.a.data), expected); assert.deepEqual(reportProjection(disk), expected); assert.deepEqual(restarted.reports, expected);
  assert.equal(disk.post013IndependentProgress, 'scoped-delete-progress');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('full analysis cancelled while its report commit is still queued cannot create a report in memory or on disk', async t => {
  const f = await fixture(t); await f.a.verifyProvider(modelConfig);
  const original = await saveReport(f, '取消前已保存的独立报告');
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key('post013-queued-cancel-message'), direction: 'other', text: '用于取消时序的合成材料', timestamp: Math.floor(f.a.now() / 1000) - 60 }] });
  f.provider.next = async () => ({ report: '取消的排队报告不得保存。' });
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const prior = f.a.exclusive(async () => { entered.resolve(); await released.promise; }); await entered.promise;
  const queued = Promise.withResolvers(), save = f.a.saveAnalysisReport;
  f.a.saveAnalysisReport = function (...args) { queued.resolve(); return save.apply(this, args); };
  const analysis = f.a.analyze({ contacts: [f.bridge.contacts[0].id], request: '隔离取消验证' });
  const outcome = analysis.then(value => ({ value }), error => ({ error }));
  await queued.promise; const revisionBefore = f.a.revision;
  await f.a.cancel(); const revisionAfter = f.a.revision;
  f.a.data.post013IndependentProgress = 'cancel-progress'; const background = f.a.save();
  released.resolve(); await prior; const response = await outcome; await background; await f.a.writes;
  const disk = JSON.parse(await readFile(f.a.file, 'utf8')), restarted = await reopen(f);
  t.diagnostic(JSON.stringify({ scenario: 'full-analysis-cancel-before-report-commit', revisionBefore, revisionAfter, errorName: response.error?.name, memoryReportIds: f.a.data.analysisReports.map(row => row.id), diskReportIds: disk.analysisReports.map(row => row.id), simulatedProviderCalls: f.provider.calls.length, wechatSends: f.bridge.sent.length }));
  assert.ok(revisionAfter > revisionBefore); assert.equal(response.error?.name, 'AbortError');
  const expected = [{ id: original.id, account: original.account, report: original.report }];
  assert.deepEqual(reportProjection(f.a.data), expected, 'Cancellation completed before the report action started');
  assert.deepEqual(reportProjection(disk), expected); assert.deepEqual(restarted.reports, expected);
  assert.equal(disk.post013IndependentProgress, 'cancel-progress');
  assert.equal(f.provider.calls.length, 1, 'Only the original simulated generation occurred; cancellation never regenerates');
  assert.equal(f.bridge.sent.length, 0);
});

for (const nativeIdentity of ['changed', 'unverified']) test(`full scoped analysis rejects a ${nativeIdentity} native identity during report persistence before the cached account refreshes`, async t => {
  const f = await fixture(t); await f.a.verifyProvider(modelConfig);
  const accountA = f.bridge.account, original = await saveReport(f, '原账号已提交报告');
  f.bridge.account = key('post013-native-report-account-B'); await f.a.scan(); const other = await saveReport(f, '另一账号已提交报告');
  f.bridge.account = accountA; await f.a.scan();
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key('post013-native-report-message'), direction: 'other', text: '用于身份完成检查的合成材料', timestamp: Math.floor(f.a.now() / 1000) - 60 }] });
  f.provider.next = async () => ({ report: '账号变化后的迟到分析正文不得返回。' });
  const gate = await heldFilesystemFailure(f, { fail: false });
  const analysis = withAccountRequestScope(f.a, accountA, () => f.a.analyze({ contacts: [f.bridge.contacts[0].id], request: '原生身份完成检查' }));
  const outcome = analysis.then(value => ({ value }), error => ({ error })); await gate.entered;
  if (nativeIdentity === 'changed') f.bridge.account = key('post013-native-report-account-B');
  else f.bridge.currentAccount = async () => { throw new Error('fixture identity unavailable'); };
  assert.equal(f.a.data.account, accountA, 'No scan has updated the cached identity');
  f.a.data.post013IndependentProgress = 'native-report-progress'; const background = f.a.save();
  gate.release(); const response = await outcome; await background;
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await reopen(f);
  t.diagnostic(JSON.stringify({ scenario: 'full-analysis-native-completion-check', nativeIdentity, errorStatus: response.error?.status, errorCode: response.error?.code, returnedReports: response.value?.reports, memoryReportIds: f.a.data.analysisReports.map(row => row.id), diskReportIds: disk.analysisReports.map(row => row.id), simulatedProviderCalls: f.provider.calls.length, wechatSends: f.bridge.sent.length }));
  assert.equal(response.error?.status, 409); assert.equal(response.error?.code, nativeIdentity === 'changed' ? 'AI_SCOPE_CHANGED' : 'AI_ACCOUNT_UNVERIFIED');
  assert.equal(response.value, undefined, 'An old scoped request returns no report body or history ID');
  const expected = [original, other].map(({ id, account, report }) => ({ id, account, report }));
  assert.deepEqual(reportProjection(f.a.data), expected); assert.deepEqual(reportProjection(disk), expected); assert.deepEqual(restarted.reports, expected);
  assert.equal(disk.post013IndependentProgress, 'native-report-progress');
  assert.equal(f.provider.calls.length, 1, 'Only the original mock generation occurs'); assert.equal(f.bridge.sent.length, 0);
});

test('an account-change report cleanup write failure stays explicitly unknown instead of claiming a durable removal', async t => {
  const f = await fixture(t), original = await saveReport(f, '清理故障前已提交的报告'), account = f.a.data.account;
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), file = f.a.file;
  const blocked = path.join(f.root, 'post013-cleanup-destination-is-directory'); await mkdir(blocked); let calls = 0;
  f.a.save = function (...args) {
    const number = ++calls;
    if (number === 1) { entered.resolve(); return released.promise.then(() => f.save.apply(this, args)); }
    if (number !== 2) return f.save.apply(this, args);
    this.file = blocked;
    return f.save.apply(this, args).finally(() => { this.file = file; });
  };
  const operation = withAccountRequestScope(f.a, account, () => saveReport(f, '清理落盘失败后状态未知的新报告'));
  const outcome = operation.then(value => ({ value }), error => ({ error })); await entered.promise;
  f.bridge.account = key('post013-native-cleanup-failure-account-B'); released.resolve();
  const response = await outcome, disk = JSON.parse(await readFile(file, 'utf8'));
  t.diagnostic(JSON.stringify({ scenario: 'native-report-cleanup-io-failure', saveCalls: calls, errorStatus: response.error?.status, errorCode: response.error?.code, message: response.error?.message, memoryReportIds: f.a.data.analysisReports.map(row => row.id), diskReportIds: disk.analysisReports.map(row => row.id), simulatedProviderCalls: f.provider.calls.length, wechatSends: f.bridge.sent.length }));
  assert.equal(response.error?.code, 'AI_ANALYSIS_CLEANUP_UNKNOWN'); assert.equal(response.error?.status, 503);
  assert.match(response.error.message, /清理.*失败.*状态.*确认/); assert.equal(response.value, undefined);
  assert.deepEqual(reportProjection(f.a.data), [{ id: original.id, account: original.account, report: original.report }]);
  assert.equal(disk.analysisReports.some(row => row.id === original.id), true);
  assert.equal(disk.analysisReports.some(row => row.report === '清理落盘失败后状态未知的新报告'), true, 'The fixture proves why durable deletion must remain unknown');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('full scoped analysis propagates cleanup persistence uncertainty without returning the old account report head', async t => {
  const f = await fixture(t); await f.a.verifyProvider(modelConfig);
  const original = await saveReport(f, '完整分析清理故障前已提交的报告'), account = f.a.data.account;
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key('post013-full-cleanup-failure'), direction: 'other', text: '完整分析清理故障的合成材料', timestamp: Math.floor(f.a.now() / 1000) - 60 }] });
  f.provider.next = async () => ({ report: '完整分析清理状态未知的新报告' });
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), file = f.a.file;
  const blocked = path.join(f.root, 'post013-full-cleanup-destination-is-directory'); await mkdir(blocked); let calls = 0;
  f.a.save = function (...args) {
    const number = ++calls;
    if (number === 1) { entered.resolve(); return released.promise.then(() => f.save.apply(this, args)); }
    if (number !== 2) return f.save.apply(this, args);
    this.file = blocked;
    return f.save.apply(this, args).finally(() => { this.file = file; });
  };
  const analysis = withAccountRequestScope(f.a, account, () => f.a.analyze({ contacts: [f.bridge.contacts[0].id], request: '完整分析清理故障' }));
  const outcome = analysis.then(value => ({ value }), error => ({ error })); await entered.promise;
  f.bridge.account = key('post013-full-cleanup-failure-account-B'); released.resolve();
  const response = await outcome, disk = JSON.parse(await readFile(file, 'utf8'));
  t.diagnostic(JSON.stringify({ scenario: 'full-scoped-analysis-cleanup-io-failure', saveCalls: calls, errorStatus: response.error?.status, errorCode: response.error?.code, returnedReports: response.value?.reports, memoryReportIds: f.a.data.analysisReports.map(row => row.id), diskReportIds: disk.analysisReports.map(row => row.id), simulatedProviderCalls: f.provider.calls.length, wechatSends: f.bridge.sent.length }));
  assert.equal(response.error?.status, 503); assert.equal(response.error?.code, 'AI_ANALYSIS_CLEANUP_UNKNOWN');
  assert.equal(response.value, undefined, 'No old account head, body or history ID may escape with a normal analysis response');
  assert.deepEqual(reportProjection(f.a.data), [{ id: original.id, account: original.account, report: original.report }]);
  assert.equal(disk.analysisReports.some(row => row.id === original.id), true);
  assert.equal(disk.analysisReports.some(row => row.report === '完整分析清理状态未知的新报告'), true);
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0);
});
