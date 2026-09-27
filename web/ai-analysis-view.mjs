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
  { id: 'review', label: '重点回顾', prompt: '总结这段时间聊过的重点事项、已经确定的结论，以及还没有结果的话题。' },
  { id: 'todo', label: '待办约定', prompt: '梳理聊天里明确提出过的待办、承诺和约定，指出哪些已经完成，哪些还没有落实。' },
  { id: 'topic', label: '话题兴趣', prompt: '归纳对方关心的话题、兴趣偏好和在意的事情，并说明判断依据。' },
  { id: 'relation', label: '关系互动', prompt: '分析双方的关系变化与互动氛围：聊天频率、谁更主动、情绪起伏和亲疏变化。' },
  { id: 'style', label: '沟通风格', prompt: '分析双方的沟通风格：表达方式、回应节奏、用词习惯，以及对方可能留下的印象。' },
  { id: 'friction', label: '分歧焦点', prompt: '找出聊天中出现过的分歧、误解或敏感话题，说明各自的立场和后续走向。' },
];
export function presetRequest(id) { return analysisPresets.find(preset => preset.id === id)?.prompt ?? ''; }
export function analysisRequestState(request) {
  const text = String(request ?? '');
  return analysisPresets.find(preset => preset.prompt === text)?.id || (text.trim() ? 'custom' : '');
}
export function presetChips(request) {
  const active = analysisRequestState(request);
  const icons = { summary: 'doc', review: 'file', todo: 'check', topic: 'star', relation: 'users', style: 'chat', friction: 'alert' };
  return analysisPresets.map(preset => `<button type="button" data-ai-analysis-preset="${preset.id}" aria-pressed="${active === preset.id}">${icon(icons[preset.id])}<span>${esc(preset.label)}</span></button>`).join('') +
    `<button type="button" data-ai-analysis-other aria-pressed="${active === 'custom'}"><svg class="ai-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6m-5 3h4M8.4 15.5A7 7 0 1 1 15.6 15.5c-.6.5-1 1-1.2 1.5H9.6c-.2-.5-.6-1-1.2-1.5Z"/></svg><span>自定义</span></button>`;
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
export function reportExportDialog(dialog) {
  if (!dialog) return '';
  const single = dialog.ids.length === 1;
  const summary = single ? `${esc(dialog.label || '联系人')} · ${esc(reportDate(dialog.actualRange))}` : `已选 ${dialog.ids.length} 份报告`;
  return `<dialog id="ai-report-export-dialog" class="ai-report-export-dialog" aria-labelledby="ai-report-export-title"><header><h3 id="ai-report-export-title">导出分析报告</h3><button type="button" class="quiet" data-ai-export-close aria-label="关闭导出弹窗">关闭</button></header><div class="ai-report-export-body"><div class="ai-report-export-summary"><strong>${summary}</strong>${single ? '' : '<span>下载为 ZIP</span>'}</div><fieldset><legend>文件格式</legend><div class="ai-report-export-formats"><label><input type="radio" name="report-export-format" value="pdf" ${dialog.format === 'pdf' ? 'checked' : ''}><span><strong>PDF</strong><small>.pdf</small></span></label><label><input type="radio" name="report-export-format" value="docx" ${dialog.format === 'docx' ? 'checked' : ''}><span><strong>Word</strong><small>.docx</small></span></label></div></fieldset><p id="ai-report-export-error" role="alert" hidden></p></div><footer><small>${single ? '导出当前报告快照' : '每份报告生成独立文件'}</small><div class="ai-actions"><button type="button" class="secondary" data-ai-export-close>取消</button><button type="button" class="primary" data-ai-export-download>${single ? '下载文件' : '下载 ZIP'}</button></div></footer></dialog>`;
}
function historyView(state, report, exportState) {
  return `<section class="ai-analysis-history-detail"><div class="ai-page-heading ai-sticky-back"><button type="button" class="quiet ai-icon-back" data-ai-history-back aria-label="返回历史记录" title="返回历史记录">${icon('arrow-l')}</button><div><h3>分析报告</h3><p>联系人：${esc(report.label || '联系人')} · ${reportDate(report.actualRange)} · 生成于 ${esc(new Date(report.createdAt).toLocaleString('zh-CN', { hour12: false }))}</p></div><div class="ai-actions"><button type="button" class="secondary" data-ai-history-copy>复制全文</button><button type="button" class="secondary" data-ai-export-detail>导出</button><button type="button" class="quiet danger-link" data-ai-history-delete="${esc(report.id)}">删除报告</button></div></div>${coverageNotices(report)}${Number.isInteger(report.skipped) && report.skipped > 0 ? `<p role="status" class="ai-help">已跳过 ${report.skipped} 条无法解析的记录。</p>` : ''}<p class="ai-help ai-report-coverage">${countLabel(report, false)}</p>${metricsView(report.metrics)}<article class="ai-card ai-report-text">${reportBody(report.report || '')}</article></section>${reportExportDialog(exportState.dialog)}`;
}
function historyList(state, exportState) {
  const history = state.analysis?.history || [];
  const selecting = exportState.selecting === true, selected = exportState.selected || new Set();
  return `<section class="ai-analysis-history"><div class="ai-page-heading"><div><h3>历史分析报告</h3><p>成功生成的报告会按当前微信账号保存，可随时查看或复制。</p></div>${history.length ? `<div class="ai-actions">${selecting ? `<button type="button" class="secondary" data-ai-history-export-all>${selected.size === history.length ? '取消全选' : '全选当前列表'}</button>` : '<button type="button" class="secondary" data-ai-history-export-mode>批量导出</button>'}</div>` : ''}</div>${history.length ? `<div class="ai-analysis-history-list">${history.map(item => `<article class="ai-card" data-ai-history-item="${esc(item.id)}">${selecting ? `<label class="ai-history-export-check"><input type="checkbox" data-ai-history-export-check="${esc(item.id)}" ${selected.has(item.id) ? 'checked' : ''}><span class="sr-only">选择 ${esc(item.label || '联系人')} 的报告</span></label>` : ''}<div><h4>${esc(item.label || '联系人')}</h4><p class="ai-help">${reportDate(item.actualRange)} · ${esc(new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }))}</p><p class="ai-help">${countLabel(item, false)}${item.skipped ? ` · 跳过 ${item.skipped} 条` : ''}${item.truncated ? ' · 部分记录未完整纳入' : ''}</p>${item.summary ? `<p class="ai-history-summary">${esc(item.summary)}</p>` : ''}</div>${selecting ? '' : `<div class="ai-actions"><button type="button" class="secondary" data-ai-history-open="${esc(item.id)}">查看</button><button type="button" class="secondary" data-ai-history-export="${esc(item.id)}">导出</button><button type="button" class="quiet danger-link" data-ai-history-delete="${esc(item.id)}">删除</button></div>`}</article>`).join('')}</div>${selecting ? `<div class="ai-history-export-bar"><strong>已选 ${selected.size} 份</strong><div class="ai-actions"><button type="button" class="secondary" data-ai-history-export-cancel>取消</button><button type="button" class="primary" data-ai-history-export-next ${selected.size ? '' : 'disabled'}>继续导出</button></div></div>` : ''}` : '<p class="ai-empty">还没有保存的分析报告。</p>'}</section>`;
}
export function analysisPage(state, draft, result, search = '', report = null, rangeMode = 'all', contactsExpanded = false, exportState = {}) {
  if (report) return historyView(state, report, exportState);
  const selected = new Set(draft.contacts || []);
  const rangeButtons = [['all','全部'],['day','近一天'],['week','近一周'],['month','近一月'],['custom','自定义']].map(([id,label]) => `<button type="button" data-ai-analysis-range="${id}" aria-pressed="${rangeMode === id}">${label}</button>`).join('');
  return `<header class="ai-analysis-mobile-page-title"><span>栖盒 AI</span><h2>分析报告</h2><p>选择联系人和分析方向，生成清晰的聊天回顾。</p></header><form id="ai-analysis-form" class="ai-analysis-setup"><section class="ai-analysis-selection${contactsExpanded ? ' is-open' : ''}"><div class="ai-analysis-mobile-selection"><span class="ai-analysis-mobile-step">01</span><div><strong>分析对象</strong><small id="ai-analysis-mobile-count">${selected.size ? `已选择 ${selected.size} 位联系人` : '选择要分析的联系人'}</small></div><button type="button" data-ai-analysis-contacts-toggle aria-expanded="${contactsExpanded}">${contactsExpanded ? '收起' : selected.size ? '更换' : '选择'}${icon('chev-d')}</button></div><div class="ai-analysis-selection-details"><div class="ai-analysis-section-title"><div><h4>分析对象</h4><p>可选择多位联系人，逐位独立生成报告</p></div><small id="ai-analysis-count">${selected.size}</small></div>${state.contacts.some(c => c.kind === 'person') ? `<label class="ai-analysis-search">${icon('search')}<span class="sr-only">搜索联系人</span><input id="ai-analysis-search" type="search" placeholder="搜索联系人…" value="${esc(search)}"></label>` : ''}<fieldset id="ai-analysis-contacts" class="ai-analysis-contacts"><legend class="sr-only">选择联系人</legend>${analysisContactList(state, selected, search)}</fieldset><div class="ai-analysis-selection-actions"><button type="button" class="secondary ai-wide" data-ai-action="scan">刷新联系人</button><button type="button" class="primary ai-analysis-mobile-done" data-ai-analysis-contacts-done>完成选择</button></div></div></section>
  <section class="ai-analysis-request"><div class="ai-analysis-intro"><span class="ai-analysis-mobile-kicker">02 · 设置分析</span><h4>分析要求</h4><p>选择方向，或直接写下想了解的问题，栖盒 AI 将基于你的数据生成分析报告。</p></div><div class="ai-analysis-directions"><strong>分析方向</strong><div class="ai-analysis-presets" role="group" aria-label="分析方向快捷输入">${presetChips(draft.request)}</div></div><label class="sr-only" for="ai-analysis-request-text">分析要求</label><div class="ai-analysis-composer"><textarea id="ai-analysis-request-text" name="request" maxlength="1000" rows="2" placeholder="请描述你想分析的问题，例如：&#10;帮我总结最近的工作重点、未完成的待办，以及需要跟进的人和事项。">${esc(draft.request)}</textarea><div class="ai-analysis-composer-foot"><span>${icon('edit')}尽量具体，获得更好的分析结果</span><span id="ai-analysis-request-count">${String(draft.request || '').length}/1000</span></div></div><div class="ai-analysis-submit-row"><div class="ai-analysis-time-entry"><strong>时间范围</strong><div class="ai-analysis-time-controls"><div class="ai-reference-analysis-ranges">${rangeButtons}</div><div class="ai-date-range" data-range-scope="analysis"><input type="hidden" name="from" value="${esc(draft.from)}"><input type="hidden" name="to" value="${esc(draft.to)}">${rangeMode === 'custom' ? `<button type="button" class="quiet ai-analysis-custom-date" aria-label="选择自定义日期" data-ai-date-range="analysis">${icon('clock')}<span>${draft.from && draft.to ? `${esc(draft.from)} 至 ${esc(draft.to)}` : '选择日期'}</span></button>` : ''}</div></div></div><button type="submit" class="primary ai-analysis-submit" aria-label="开始分析">${icon('sparkle')}<span>开始分析 · ${selected.size} 位</span></button></div></section></form>
  ${result ? `<section class="ai-analysis-reports"><div class="ai-analysis-section-heading"><div><h3>分析报告</h3><p>${analysisRangeLabel(result)} · ${result.reports.length} 位联系人</p></div>${result.reports.some(r => r.status === 'complete' && r.historyId) ? '<button type="button" class="secondary" data-ai-export-current>批量导出本次报告</button>' : ''}</div><div class="ai-analysis-report-grid">${result.reports.map((r, index) => `<article class="ai-card" data-analysis-report="${index}" data-analysis-status="${esc(r.status)}"><div class="ai-card-heading"><div><h3>${contactName(r)}</h3>${['complete', 'empty'].includes(r.status) ? `<p class="ai-help">${countLabel(r)}</p>` : ''}</div>${r.status === 'complete' || r.status === 'empty' ? `<div class="ai-actions"><button type="button" class="secondary" data-ai-copy-report="${index}">复制全文</button>${r.status === 'complete' && r.historyId ? `<button type="button" class="secondary" data-ai-export-report="${index}">导出</button>` : ''}</div>` : ''}</div>${r.status === 'waiting' ? '<p role="status">等待分析</p>' : r.status === 'analyzing' ? '<p role="status" aria-live="polite">正在分析此联系人…</p>' : r.status === 'cancelled' ? '<p role="status">已取消，未发起分析</p>' : r.status === 'error' ? `<p role="alert">${esc(r.error)}</p>` : `${coverageNotices(r)}${metricsView(r.metrics)}<div class="ai-report-text">${reportBody(r.report)}</div>`}</article>`).join('')}</div></section>` : ''}${historyList(state, exportState)}${reportExportDialog(exportState.dialog)}`;
}

export async function copyReport(text) {
  if (navigator.clipboard?.writeText && globalThis.isSecureContext) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea'); input.value = text; input.readOnly = true;
  input.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(input);
  const focus = document.activeElement;
  try { input.select(); if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请选中报告正文复制'); }
  finally { input.remove(); focus?.focus(); }
}
