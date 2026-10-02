import { beijingTime } from './ai-proactive-view.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function errorRecordList(errors, expanded = []) {
  const open = new Set(expanded);
  return `<div class="ai-error-record-list">${errors.map(error => {
    const context = error.context || {}, knownName = context.label || '对象未记录';
    const labelSuffix = context.labelBasis === 'current' ? '（当前名称）' : context.labelBasis === 'saved-profile' ? '（已保存的对象名称）' : '';
    const meta = [['对象', context.label ? `${context.label}${context.labelBasis === 'current' ? '（当前名称）' : ''}` : '未保存对象信息'], ['任务', context.taskName], ['操作', context.sourceLabel], ['处理阶段', context.stageLabel || '历史记录未保存阶段'], ['阶段依据', context.stageBasis === 'saved-reason' && context.stage !== 'unknown' ? '根据已保存的异常原因判断' : null], ['异常类型', context.type || '操作未完成'], ['错误码', context.errorCode], ['异常记录 ID', error.id], ['发送操作 ID', context.operationId], [context.evidenceScope === 'chat-context' ? '聊天片段消息 ID' : '待处理来信 ID', context.incomingIds?.length ? context.incomingIds.join('、') : null], ['处理结果', error.resolution === 'sent' ? `已确认送达 · ${beijingTime(error.resolvedAt)}` : null]];
    const messages = (context.messages || []).map(message => `<li><strong>${esc(message.senderName || (context.kind === 'person' ? context.label : '') || (message.senderId ? `群成员（${String(message.senderId).slice(0, 8)}）` : '发送者未记录'))}</strong>${message.timestamp ? `<time>${esc(beijingTime(message.timestamp * 1000))}</time>` : ''}<p class="ap-record-text">${esc(message.text || ({ image: '[图片]', voice: '[语音]', video: '[视频]', file: '[文件]', sticker: '[表情]' })[message.type] || '当时未保存可展示正文')}</p><code class="ai-error-message-id">消息 ID：${esc(message.id)}</code>${message.truncated ? '<small>此处仅展示原消息的部分内容。</small>' : ''}</li>`).join('');
    return `<article class="ai-error-record" data-ai-error-record="${esc(error.id)}"><details class="ai-error-detail" data-ai-error-detail="${esc(error.id)}"${open.has(error.id) ? ' open' : ''}><summary class="ai-error-summary"><time class="ai-error-time">${esc(beijingTime(error.at))}</time><span class="ai-error-summary-copy"><strong class="ai-error-object">${esc(knownName)}${context.labelBasis === 'current' ? '（当前名称）' : ''}${context.taskName ? ` · ${esc(context.taskName)}` : ''}</strong><strong class="ai-error-message">${esc(error.message || 'AI 操作未完成')}</strong><span class="ai-error-chips"><span class="ai-error-chip">${esc(context.type || '操作未完成')}</span><span class="ai-error-chip">${esc(context.stageLabel || '阶段未记录')}</span>${error.resolution === 'sent' ? '<span class="ai-error-chip">已确认送达</span>' : ''}</span></span></summary><div class="ai-error-detail-body"><dl class="ai-error-meta">${meta.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join('')}</dl><section class="ai-error-evidence"><h5>当时的消息证据</h5><p class="ai-error-context-note">${esc(context.evidenceNote || '这条历史异常未保存当时消息，无法确认是哪条来信。')}</p>${messages ? `<ol class="ai-error-message-list">${messages}</ol>` : ''}</section>${error.objectTarget || error.relatedRecord ? `<div class="ai-error-actions">${error.objectTarget ? `<button type="button" class="secondary" data-ai-error-object="${esc(error.id)}">查看对象设置</button>` : ''}${error.relatedRecord ? `<button type="button" class="secondary" data-ai-error-record-target="${esc(error.id)}">定位关联${error.relatedRecord.source === 'proactive' ? '主动聊天' : '未回复'}记录</button>` : ''}</div>` : ''}</div></details></article>`;
  }).join('') || '<p class="ap-empty">暂无异常记录</p>'}</div>`;
}
export function errorDisclosureKeys(host, previous = []) {
  const expanded = new Set(previous);
  for (const details of host?.querySelectorAll('details[data-ai-error-detail]') || []) {
    const id = details.getAttribute('data-ai-error-detail');
    if (details.open) expanded.add(id); else expanded.delete(id);
  }
  return [...expanded];
}
export function errorDisclosureState(host, previous = {}) {
  const outer = host?.querySelector('.ap-record-errors');
  return { errorsOpen: outer ? outer.open : !!previous.errorsOpen, errorExpanded: errorDisclosureKeys(host, previous.errorExpanded) };
}
export function revealErrorRecord(row, boundary) {
  if (!row || !boundary?.contains(row)) return false;
  for (let parent = row.parentElement; parent && parent !== boundary; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  for (const details of row.querySelectorAll('details[data-ai-skip-messages]')) details.open = true;
  row.tabIndex = -1; row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true });
  return true;
}
// Error refreshes have their own identity space. Preserve a disclosure or action
// by error ID, never by object/name, which can recur in many failures.
export function refreshErrors(host, render) {
  if (!host) return false;
  const active = host.ownerDocument.activeElement, inside = host.contains(active);
  const recordId = inside && active.closest('[data-ai-error-record]')?.getAttribute('data-ai-error-record');
  const attribute = inside && ['data-ai-error-object', 'data-ai-error-record-target', 'data-ai-error-more', 'data-ai-clear-errors'].find(key => active.hasAttribute(key));
  const summary = inside && active.tagName === 'SUMMARY';
  const template = host.ownerDocument.createElement('template'); template.innerHTML = render();
  if (host.innerHTML === template.innerHTML) return false;
  host.innerHTML = template.innerHTML;
  let target;
  if (recordId) {
    const record = [...host.querySelectorAll('[data-ai-error-record]')].find(row => row.getAttribute('data-ai-error-record') === recordId);
    target = attribute ? record?.querySelector(`[${attribute}]`) : summary ? record?.querySelector('summary') : null;
  } else if (attribute) target = host.querySelector(`[${attribute}]`);
  else if (summary) target = host.querySelector('.ap-record-errors > summary');
  if (target && !target.disabled) target.focus({ preventScroll: true });
  return true;
}
