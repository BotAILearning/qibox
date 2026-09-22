import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisOptions } from '../server/ai-analysis.mjs';
import { reportExcerpts } from '../server/ai-report-history.mjs';
import { analysisPage, analysisRangeLabel, reportSections } from '../web/ai-analysis-view.mjs';

test('分析要求可以留空，仍保留用户自定义要求字段', () => {
  const value = analysisOptions({ request: '', contacts: ['contact'], from: '2026-09-01', to: '2026-09-02' });
  assert.equal(value.request, '');
});

test('章节协议安全解析，旧版纯文本仍作为正文展示', () => {
  assert.deepEqual(reportSections('数据开场\n\n这周有 4 条消息。\n\n值得记住\n\n周六见。'), [
    { title: '数据开场', body: '这周有 4 条消息。' },
    { title: '值得记住', body: '周六见。' },
  ]);
  assert.deepEqual(reportSections('旧版完整纯文本，没有章节标题。'), [{ title: '', body: '旧版完整纯文本，没有章节标题。' }]);
});

test('系统消息不会被摘录或归因给对方', () => {
  const excerpts = reportExcerpts([
    { direction: 'system', text: '系统提示，不属于任何一方' },
    { direction: 'other', text: '对方的真实消息' },
    { direction: 'self', text: '我的真实消息' },
  ]);
  assert.deepEqual(excerpts.map(item => [item.direction, item.text]), [['other', '对方的真实消息'], ['self', '我的真实消息']]);
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
