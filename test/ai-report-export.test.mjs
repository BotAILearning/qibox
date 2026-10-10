import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { exportAnalysisReports } from '../server/ai-report-export.mjs';
import { inflateSync } from 'node:zlib';

const id = suffix => `11111111-1111-4111-8111-${suffix.padStart(12, '0')}`;
const report = (suffix, label = '林宝平_Bot') => ({
  id: id(suffix), account: 'account-a', label, createdAt: Date.parse('2026-09-28T02:30:00Z'),
  requestedRange: { from: '2026-09-01', to: '2026-09-20' }, actualRange: { from: '2026-09-03', to: '2026-09-18' },
  request: '总结工作重点', count: 3, analyzedCount: 2, skipped: 1, truncated: true,
  truncatedReasons: ['source_read_truncated'], metrics: { total: 2, self: 1, other: 1, activeDays: 2 },
  report: '主要话题\n资料交接已经确定。\n\n待跟进事项\n会议地点仍需确认。',
  excerpts: [{ text: '不允许导出的原始聊天' }],
});

function assistant(reports) {
  const values = new Map(reports.map(item => [item.id, item]));
  return { data: { account: 'account-a' }, analysisReport(value) {
    const item = values.get(value);
    if (!item || item.account !== this.data.account) throw new Error('分析报告不存在或不属于当前微信账号');
    return structuredClone(item);
  } };
}

test('单份 Word 保留报告、范围、覆盖提示，排除原始聊天', async () => {
  const item = report('1');
  const file = await exportAnalysisReports(assistant([item]), { ids: [item.id], format: 'docx' });
  assert.match(file.filename, /^分析报告_林宝平_Bot_202609281030_[0-9]+\.docx$/);
  assert.match(file.mime, /wordprocessingml/);
  const entries = unzipSync(file.bytes);
  const body = strFromU8(entries['word/document.xml']);
  assert.match(body, /资料交接已经确定/);
  assert.match(body, /2026-09-01 至 2026-09-20/);
  assert.match(body, /2026-09-03 至 2026-09-18/);
  assert.match(body, /部分聊天未能读取，报告仅依据已读取的记录/);
  assert.doesNotMatch(body, /不允许导出的原始聊天/);
});

test('单份 PDF 可读取并有中文字体；批量 ZIP 每份快照独立', async () => {
  const first = report('1'), second = report('2', '同名/联系人');
  const ai = assistant([first, second]);
  const single = await exportAnalysisReports(ai, { ids: [first.id], format: 'pdf' });
  assert.equal(single.mime, 'application/pdf');
  assert.equal(single.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(single.bytes.toString('latin1').slice(-60), /%%EOF/);
  assert.ok(single.bytes.length < 1024 * 1024, '中文字库应按实际文字嵌入，而非整份字体');
  const batch = await exportAnalysisReports(ai, { ids: [first.id, second.id], format: 'docx' });
  assert.equal(batch.mime, 'application/zip');
  const entries = unzipSync(batch.bytes), names = Object.keys(entries);
  assert.equal(names.length, 2);
  assert.ok(names.every(name => name.endsWith('.docx') && !name.includes('../')));
  assert.ok(names.some(name => name.includes('同名_联系人')));
  for (const bytes of Object.values(entries)) assert.ok(unzipSync(bytes)['word/document.xml']);
  const pdfBatch = await exportAnalysisReports(ai, { ids: [first.id, second.id], format: 'pdf' });
  assert.equal(Object.keys(unzipSync(pdfBatch.bytes)).filter(name => name.endsWith('.pdf')).length, 2);
});

test('导出拒绝重复、缺失、越权快照，账号变化不会返回文件', async () => {
  const first = report('1'), foreign = { ...report('2'), account: 'account-b' };
  const ai = assistant([first, foreign]);
  await assert.rejects(exportAnalysisReports(ai, { ids: [first.id, first.id], format: 'pdf' }), /有效/);
  await assert.rejects(exportAnalysisReports(ai, { ids: [first.id, foreign.id], format: 'docx' }), /不属于当前微信账号/);
  await assert.rejects(exportAnalysisReports(ai, { ids: [first.id], format: 'txt' }), /Word 或 PDF/);
  const switching = assistant([first]);
  const original = switching.analysisReport.bind(switching);
  switching.analysisReport = value => { const result = original(value); switching.data.account = 'account-b'; return result; };
  await assert.rejects(exportAnalysisReports(switching, { ids: [first.id], format: 'docx' }), /账号已变化/);
});

test('PDF embeds fallback glyphs and Unicode mappings for emoji, joined families, flags and math', async () => {
  const item = { ...report('3', 'Bot💊'), report: '中文前🙂后，家庭👨‍👩‍👧‍👦，爱心❤️，旗帜🇨🇳，数学𝕏。\n'.repeat(90) + '末尾内容保留' };
  const file = await exportAnalysisReports(assistant([item]), { ids: [item.id], format: 'pdf' });
  const binary = file.bytes.toString('latin1');
  assert.match(binary, /NotoEmoji-Regular/);
  assert.match(binary, /NotoSansMath-Regular/);
  const maps = [];
  for (const match of binary.matchAll(/\d+ \d+ obj\s*(<<[\s\S]*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!match[1].includes('/FlateDecode')) continue;
    const decoded = inflateSync(Buffer.from(match[2], 'latin1')).toString();
    if (decoded.includes('begincmap')) maps.push(decoded);
  }
  const unicode = maps.join('\n');
  for (const value of ['<d83d de42>', '<d83d dc8a>', '<d83d dc68 200d d83d dc69 200d d83d dc67 200d d83d dc66>', '<2764 fe0f>', '<d83c dde8 d83c ddf3>', '<d835 dd4f>']) assert.ok(unicode.includes(value), `Missing PDF Unicode mapping: ${value}`);
  assert.ok(file.bytes.length < 1024 * 1024, 'fallback fonts should also be embedded as subsets');
});

test('unsupported PDF characters fail explicitly rather than download silent missing-glyph squares', async () => {
  const item = { ...report('4'), report: '不能静默丢字\u{10ffff}' };
  await assert.rejects(exportAnalysisReports(assistant([item]), { ids: [item.id], format: 'pdf' }), error => error.status === 422 && /Word/.test(error.message));
  const word = await exportAnalysisReports(assistant([item]), { ids: [item.id], format: 'docx' });
  assert.ok(strFromU8(unzipSync(word.bytes)['word/document.xml']).includes('\u{10ffff}'));
});
