import { dateRangeField } from './ai-date-range.mjs';
import { icon } from './ai-icons.mjs';
import { contactName, contactSearch } from './ai-contact-name.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function analysisContactList(state, selected, query) {
  const persons = state.contacts.filter(c => c.kind === 'person');
  if (!persons.length) return '<p class="ai-help">暂无联系人，请先刷新列表。</p>';
  const q = (query || '').normalize('NFKC').toLocaleLowerCase();
  let visible = 0;
  const rows = persons.map(c => {
    const match = !q || contactSearch(c).includes(q);
    if (match) visible++;
    return `<label ${match ? '' : 'hidden'}><input name="contacts" type="checkbox" value="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''}><span>${contactName(c)}</span></label>`;
  });
  return rows.join('') + (visible ? '' : '<p class="ai-help">未找到匹配的联系人。</p>');
}
// Quick directions for the analysis request. Picking one fills its default
// prompt; once that text is edited the field counts as a custom request.
export const analysisPresets = [
  { id: 'summary', label: '分析报告', prompt: '请基于所选时间范围内的聊天内容，生成一份清晰完整的分析报告，概括主要话题、重要事实、已达成的结论与约定、待跟进事项，并注明信息不足或无法确认的部分。' },
  { id: 'review', label: '近期重点回顾', prompt: '总结这段时间聊过的重点事项、已经确定的结论，以及还没有结果的话题。' },
  { id: 'todo', label: '待办与约定', prompt: '梳理聊天里明确提出过的待办、承诺和约定，指出哪些已经完成，哪些还没有落实。' },
  { id: 'topic', label: '话题与兴趣', prompt: '归纳对方关心的话题、兴趣偏好和在意的事情，并说明判断依据。' },
  { id: 'relation', label: '关系与互动', prompt: '分析双方的关系变化与互动氛围：聊天频率、谁更主动、情绪起伏和亲疏变化。' },
  { id: 'style', label: '沟通风格', prompt: '分析双方的沟通风格：表达方式、回应节奏、用词习惯，以及对方可能留下的印象。' },
  { id: 'friction', label: '分歧与敏感点', prompt: '找出聊天中出现过的分歧、误解或敏感话题，说明各自的立场和后续走向。' },
];
export function presetRequest(id) { return analysisPresets.find(preset => preset.id === id)?.prompt ?? ''; }
export function analysisRequestState(request) {
  const text = String(request ?? '');
  return analysisPresets.find(preset => preset.prompt === text)?.id || (text.trim() ? 'custom' : '');
}
export function presetChips(request) {
  const active = analysisRequestState(request);
  return analysisPresets.map(preset => `<button type="button" data-ai-analysis-preset="${esc(preset.id)}" aria-pressed="${active === preset.id}">${esc(preset.label)}</button>`).join('') +
    (active === 'custom' ? '<span class="ai-preset-custom" title="已修改分析要求">自定义</span>' : '');
}
const reportDate = value => value?.from && value?.to ? `${value.from} 至 ${value.to}` : '全部时间';
function countLabel(report, includeRange = true) {
  const range = includeRange && report.actualRange ? ` · ${reportDate(report.actualRange)}` : '';
  if (Number.isInteger(report.analyzedChars)) {
    const total = Number.isInteger(report.totalChars) ? report.totalChars : report.analyzedChars;
    return `实际分析 ${report.analyzedCount ?? report.count} 条、${report.analyzedChars} 字（所读 ${report.readableCount ?? report.count} 条、${total} 字）${range}`;
  }
  if (Number.isInteger(report.sampledCount) && report.sampledCount < report.count) {
    const sampleRange = report.sampledRange?.from && report.sampledRange?.to ? `，覆盖 ${reportDate(report.sampledRange)}` : '';
    return `范围内共 ${report.rangeCount ?? report.count} 条记录（${report.count} 条可读），按记录顺序均匀抽样 ${report.sampledCount} 条${sampleRange}${range}`;
  }
  return report.rangeCount > report.count + (report.skipped || 0) ? `本次分析 ${report.count} 条（范围内共 ${report.rangeCount} 条）${range}` : `${report.count} 条范围内聊天记录${range}`;
}
export function reportSections(text) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const blocks = source.split(/\n\s*\n+/).map(block => block.trim()).filter(Boolean);
  const sections = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], lines = block.split('\n').map(line => line.trim()).filter(Boolean), first = lines[0] || '';
    const heading = lines.length === 1 && first.length <= 24 && !/[。！？：:，,]$/.test(first) && index + 1 < blocks.length;
    if (heading) { sections.push({ title: first, body: blocks[++index].split('\n').map(line => line.trim()).filter(Boolean).join('\n') }); continue; }
    const inlineHeading = lines.length >= 2 && first.length <= 24 && !/[。！？：:，,]$/.test(first);
    if (inlineHeading) { sections.push({ title: first, body: lines.slice(1).join('\n') }); continue; }
    sections.push({ title: '', body: (heading ? lines.slice(1) : lines).join('\n') });
  }
  return sections;
}
function reportBody(text) {
  return `<div class="ai-report-sections">${reportSections(text).map(section => `${section.title ? `<h4>${esc(section.title)}</h4>` : ''}<p>${esc(section.body)}</p>`).join('')}</div>`;
}
export function analysisRangeLabel(result) {
  const ranges = [...new Set((result?.reports || []).map(report => report.actualRange?.from && report.actualRange?.to ? `${report.actualRange.from} 至 ${report.actualRange.to}` : '').filter(Boolean))];
  return ranges.length ? `实际记录：${ranges.join('、')}` : '所选范围内暂无可分析记录';
}
function metricsView(metrics = {}) {
  const cards = [['total', '消息'], ['self', '你发送'], ['other', '对方发送'], ['activeDays', '活跃天数']].filter(([key]) => Number.isFinite(metrics[key]));
  return cards.length ? `<div class="ai-report-metrics">${cards.map(([key, label]) => `<div><strong>${metrics[key]}</strong><span>${label}</span></div>`).join('')}</div>` : '';
}
function coverageNotices(report) {
  const reasons = new Set(report.truncatedReasons || []), notices = [];
  if (reasons.has('message_limit')) notices.push('微信聊天读取已达到记录数量上限；统计仅覆盖已读取记录，未读取的历史不计入。');
  if (reasons.has('analysis_sample')) notices.push(`受单次请求容量限制，本次按记录顺序均匀抽样 ${report.sampledCount ?? 0} 条；统计覆盖已读取的可读记录。`);
  if (reasons.has('character_limit')) notices.push(`所选范围超过 150000 个 Unicode 字符，本次保留最近内容；报告只描述实际分析的 ${report.analyzedChars ?? 0} 字，不代表未提供的历史。`);
  if (reasons.has('source_read_truncated')) notices.push('微信数据读取本身未覆盖完整范围；报告仅依据成功读取的聊天记录。');
  if (reasons.has('message_length')) notices.push('部分超长消息只保留了可安全读取的文字片段。');
  if (reasons.has('message_output_limit')) notices.push('读取输出达到安全容量，报告只覆盖读取到的部分。');
  if (!notices.length && report.truncated) notices.push('部分记录未完整纳入，统计仅覆盖已读取的可读记录。');
  return notices.map(notice => `<p role="alert" class="ai-help">${esc(notice)}</p>`).join('');
}
function historyView(state, report) {
  return `<section class="ai-analysis-history-detail"><div class="ai-page-heading ai-sticky-back"><button type="button" class="quiet ai-icon-back" data-ai-history-back aria-label="返回历史记录" title="返回历史记录">${icon('arrow-l')}</button><div><h3>分析报告</h3><p>联系人：${esc(report.label || '联系人')} · ${reportDate(report.actualRange)} · 生成于 ${esc(new Date(report.createdAt).toLocaleString('zh-CN', { hour12: false }))}</p></div><div class="ai-actions"><button type="button" class="secondary" data-ai-history-copy>复制全文</button><button type="button" class="quiet danger-link" data-ai-history-delete="${esc(report.id)}">删除报告</button></div></div>${coverageNotices(report)}${Number.isInteger(report.skipped) && report.skipped > 0 ? `<p role="status" class="ai-help">已跳过 ${report.skipped} 条无法解析的记录。</p>` : ''}<p class="ai-help ai-report-coverage">${countLabel(report, false)}</p>${metricsView(report.metrics)}<article class="ai-card ai-report-text">${reportBody(report.report || '')}</article></section>`;
}
function historyList(state) {
  const history = state.analysis?.history || [];
  return `<section class="ai-analysis-history"><div class="ai-page-heading"><div><h3>历史分析报告</h3><p>成功生成的报告会按当前微信账号保存，可随时查看或复制。</p></div></div>${history.length ? `<div class="ai-analysis-history-list">${history.map(item => `<article class="ai-card" data-ai-history-item="${esc(item.id)}"><div><h4>${esc(item.label || '联系人')}</h4><p class="ai-help">${reportDate(item.actualRange)} · ${esc(new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }))}</p><p class="ai-help">${countLabel(item, false)}${item.skipped ? ` · 跳过 ${item.skipped} 条` : ''}${item.truncated ? ' · 部分记录未完整纳入' : ''}</p>${item.summary ? `<p class="ai-history-summary">${esc(item.summary)}</p>` : ''}</div><div class="ai-actions"><button type="button" class="secondary" data-ai-history-open="${esc(item.id)}">查看</button><button type="button" class="quiet danger-link" data-ai-history-delete="${esc(item.id)}">删除</button></div></article>`).join('')}</div>` : '<p class="ai-empty">还没有保存的分析报告。</p>'}</section>`;
}
export function analysisPage(state, draft, result, search = '', report = null) {
  if (report) return historyView(state, report);
  const selected = new Set(draft.contacts || []);
  return `<form id="ai-analysis-form" class="ai-analysis-setup"><section class="ai-analysis-selection"><div class="ai-analysis-section-title"><div><h4>分析对象</h4><p>可选择多位联系人，逐位独立生成报告</p></div><small id="ai-analysis-count">${selected.size}</small></div>${state.contacts.some(c => c.kind === 'person') ? `<label class="ai-analysis-search">${icon('search')}<span class="sr-only">搜索联系人</span><input id="ai-analysis-search" type="search" placeholder="搜索联系人…" value="${esc(search)}"></label>` : ''}<fieldset id="ai-analysis-contacts" class="ai-analysis-contacts"><legend class="sr-only">选择联系人</legend>${analysisContactList(state, selected, search)}</fieldset><button type="button" class="secondary ai-wide" data-ai-action="scan">刷新联系人</button></section>
  <section class="ai-analysis-request"><div class="ai-analysis-section-title"><div><h4>分析要求</h4></div><div class="ai-analysis-time-entry"><div class="ai-date-range" data-range-scope="analysis"><input type="hidden" name="from" value="${esc(draft.from)}"><input type="hidden" name="to" value="${esc(draft.to)}"><button type="button" class="quiet ai-icon-back ai-time-filter" aria-label="时间筛选" title="时间筛选${draft.from ? `：${esc(draft.from)} 至 ${esc(draft.to)}` : ''}" data-ai-date-range="analysis">${icon('clock')}</button></div></div></div><div class="ai-style-pills ai-analysis-presets" role="group" aria-label="分析方向快捷输入">${presetChips(draft.request)}</div><label class="ai-field"><span class="sr-only">分析要求</span><textarea name="request" maxlength="4000" rows="5" placeholder="可留空；例如：总结近期讨论的事项、已达成的约定，以及需要跟进的问题">${esc(draft.request)}</textarea></label><div class="ai-provider-footer"><p class="ai-help">所选范围可读消息一次性分析 · 正文上限 150000 个 Unicode 字符 · 超限保留最近内容并标明截断 · 每位联系人独立生成报告</p><button type="submit" class="primary">开始分析</button></div></section></form>
  ${result ? `<section class="ai-analysis-reports"><div class="ai-analysis-section-heading"><div><h3>分析报告</h3><p>${analysisRangeLabel(result)} · ${result.reports.length} 位联系人</p></div></div><div class="ai-analysis-report-grid">${result.reports.map((r, index) => `<article class="ai-card" data-analysis-report="${index}" data-analysis-status="${esc(r.status)}"><div class="ai-card-heading"><div><h3>${contactName(r)}</h3>${['complete', 'empty'].includes(r.status) ? `<p class="ai-help">${countLabel(r)}</p>` : ''}</div>${r.status === 'complete' || r.status === 'empty' ? `<button type="button" class="secondary" data-ai-copy-report="${index}">复制全文</button>` : ''}</div>${r.status === 'waiting' ? '<p role="status">等待分析</p>' : r.status === 'analyzing' ? '<p role="status" aria-live="polite">正在分析此联系人…</p>' : r.status === 'cancelled' ? '<p role="status">已取消，未发起分析</p>' : r.status === 'error' ? `<p role="alert">${esc(r.error)}</p>` : `${coverageNotices(r)}${metricsView(r.metrics)}<div class="ai-report-text">${reportBody(r.report)}</div>`}</article>`).join('')}</div></section>` : ''}${historyList(state)}`;
}

export async function copyReport(text) {
  if (navigator.clipboard?.writeText && globalThis.isSecureContext) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea'); input.value = text; input.readOnly = true;
  input.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(input);
  const focus = document.activeElement;
  try { input.select(); if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请选中报告正文复制'); }
  finally { input.remove(); focus?.focus(); }
}
