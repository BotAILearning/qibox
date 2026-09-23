import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisOptions } from '../server/ai-analysis.mjs';
import { historySummary } from '../server/ai-report-history.mjs';
import { analysisPage, analysisRangeLabel, reportSections, presetChips } from '../web/ai-analysis-view.mjs';
import { activityPage } from '../web/ai-activity-view.mjs';

test('分析要求可以留空，仍保留用户自定义要求字段', () => {
  const value = analysisOptions({ request: '', contacts: ['contact'], from: '2026-09-01', to: '2026-09-02' });
  assert.equal(value.request, '');
});

test('快捷分析首项是分析报告，运行记录始终显示联系人或内容搜索框', () => {
  assert.match(presetChips(''), /data-ai-analysis-preset="summary"[^>]*>分析报告/);
  assert.match(activityPage({ contacts: [], activity: [], profiles: [] }), /id="ai-log-search" type="search"/);
});

test('聊天分析重排后仍保留选择、搜索、时间筛选、分析、复制和历史功能', () => {
  const state = { contacts: [{ id: 'contact-1', label: '联系人', kind: 'person' }], analysis: { history: [] } };
  const draft = { contacts: ['contact-1'], request: '', from: '', to: '' };
  const result = { reports: [{ label: '联系人', status: 'complete', count: 2, metrics: { total: 2 }, report: '分析内容', excerpts: [] }] };
  const html = analysisPage(state, draft, result, '联系人');
  for (const token of ['id="ai-analysis-form"', 'id="ai-analysis-search"', 'id="ai-analysis-contacts"', 'name="contacts"', 'data-ai-date-range="analysis"', 'name="request"', '开始分析', 'data-analysis-report="0"', 'data-ai-copy-report="0"', '历史分析报告']) assert.ok(html.includes(token), `missing ${token}`);
  assert.doesNotMatch(html, /聊天分析<br|你的聊天回顾，从这里开始|快捷方向会填入可继续编辑的内容/);
  assert.ok(html.indexOf('</form>') < html.indexOf('class="ai-analysis-reports"'), 'reports span the workspace beneath the setup form');
});

test('队列状态逐联系人可见且联系人选择不限于十位', () => {
  const contacts = Array.from({ length: 12 }, (_, index) => ({ id: `contact-${index}`, label: `联系人${index}`, kind: 'person' }));
  const reports = contacts.map((contact, index) => ({ ...contact, status: index === 0 ? 'complete' : index === 1 ? 'analyzing' : index === 2 ? 'error' : 'waiting', report: '已完成报告', error: '该联系人失败' }));
  const html = analysisPage({ contacts, analysis: { history: [] } }, { contacts: contacts.map(contact => contact.id) }, { reports });
  assert.match(html, /联系人11/);
  assert.match(html, /等待分析/);
  assert.match(html, /正在分析此联系人/);
  assert.match(html, /该联系人失败/);
  assert.doesNotMatch(html, /\/ 10|1–10 位/);
});

test('旧历史报告仍能显示读取截断和抽样范围', () => {
  const report = { id: 'limited', label: '联系人', count: 30000, rangeCount: 30000, sampledCount: 200, truncated: true, truncatedReasons: ['message_limit', 'analysis_sample'], actualRange: { from: '2026-01-01', to: '2026-09-01' }, sampledRange: { from: '2026-01-02', to: '2026-08-30' }, createdAt: Date.now(), report: '范围有限的报告' };
  const html = analysisPage({ contacts: [], analysis: { history: [] } }, { contacts: [] }, null, '', report);
  assert.match(html, /已达到记录数量上限/);
  assert.match(html, /按记录顺序均匀抽样 200 条/);
  assert.match(html, /未读取的历史不计入/);
});

test('历史列表和详情区分完整统计与均匀抽样范围，无法解析消息不冒充截取', () => {
  const report = { id: 'report', label: '33', count: 2409, rangeCount: 24554, sampledCount: 300, sampledRange: { from: '2026-01-01', to: '2026-09-01' }, skipped: 30, report: '测试报告', createdAt: Date.now() };
  const summary = historySummary(report);
  const state = { contacts: [], analysis: { history: [summary] } };
  assert.match(analysisPage(state, { contacts: [] }, null), /范围内共 24554 条记录（2409 条可读），按记录顺序均匀抽样 300 条/);
  assert.match(analysisPage(state, { contacts: [] }, null, '', report), /范围内共 24554 条记录（2409 条可读），按记录顺序均匀抽样 300 条/);
  const unreadableOnly = { ...report, count: 3, rangeCount: 5, skipped: 2 };
  const html = analysisPage(state, { contacts: [] }, null, '', unreadableOnly);
  assert.doesNotMatch(html, /本次分析最近/);
  assert.match(html, /已跳过 2 条无法解析的记录/);
});

test('章节协议安全解析，旧版纯文本仍作为正文展示', () => {
  assert.deepEqual(reportSections('数据开场\n\n这周有 4 条消息。\n\n值得记住\n\n周六见。'), [
    { title: '数据开场', body: '这周有 4 条消息。' },
    { title: '值得记住', body: '周六见。' },
  ]);
  assert.deepEqual(reportSections('旧版完整纯文本，没有章节标题。'), [{ title: '', body: '旧版完整纯文本，没有章节标题。' }]);
  assert.deepEqual(reportSections('数据开场\n这周有 4 条消息。\n\n值得记住\n周六见。'), [
    { title: '数据开场', body: '这周有 4 条消息。' },
    { title: '值得记住', body: '周六见。' },
  ]);
});

test('旧历史报告的聊天片段保留在数据中但详情不再展示', () => {
  const report = { id: 'legacy', label: '联系人', actualRange: { from: '2026-09-01', to: '2026-09-02' }, createdAt: Date.now(), report: '旧报告正文', excerpts: [{ direction: 'other', text: '历史私聊片段不可再展示' }] };
  const html = analysisPage({ contacts: [], analysis: { history: [] } }, { contacts: [] }, null, '', report);
  assert.match(html, /旧报告正文/);
  assert.doesNotMatch(html, /聊天片段|历史私聊片段不可再展示/);
  assert.equal(report.excerpts.length, 1, '兼容展示不得修改旧存量数据');
});

test('全部范围的页首使用实际记录日期，不显示无边界的全部时间', () => {
  const result = { reports: [{ actualRange: { from: '2026-09-01', to: '2026-09-03' } }, { actualRange: { from: '2026-09-01', to: '2026-09-03' } }] };
  assert.equal(analysisRangeLabel(result), '实际记录：2026-09-01 至 2026-09-03');
  const html = analysisPage({ contacts: [], analysis: { history: [] } }, { contacts: [] }, { reports: result.reports }, '');
  assert.match(html, /实际记录：2026-09-01 至 2026-09-03/);
  assert.doesNotMatch(html, /全部时间/);
  const detail = analysisPage({ contacts: [], analysis: { history: [] } }, { contacts: [] }, null, '', { label: '林宝平_Bot', actualRange: { from: '2026-09-01', to: '2026-09-03' }, createdAt: Date.now(), skipped: 2, report: '数据开场\n\n测试正文' });
  assert.match(detail, /<h3>分析报告<\/h3>[\s\S]*联系人：林宝平_Bot/);
  assert.match(detail, /已跳过 2 条无法解析的记录/);
});
