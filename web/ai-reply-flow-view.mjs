const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const skippable = new Set(['手动回复后的接续等待', '群聊合并等待', '等待合并回复']);

export function countdownText(dueAt, now = Date.now()) {
  const seconds = Math.ceil((dueAt - now) / 1000);
  return seconds > 0 ? `剩余 ${seconds} 秒` : '即将进入下一步';
}

export function refreshReplyCountdowns(root = document) {
  for (const element of root.querySelectorAll('[data-ai-countdown]')) {
    const dueAt = Number(element.dataset.aiCountdown);
    if (Number.isFinite(dueAt)) element.textContent = countdownText(dueAt);
  }
}

export function replyFlowMarkup(profile, live, { allowSkip = false } = {}) {
  if (!live) return '';
  const phase = live.phase === 'generating' ? 'requesting' : live.phase;
  const labels = { waiting: '等待汇总', summarizing: '汇总上下文', requesting: 'AI 请求中', sending: '发送中', sent: '已发送', failed: '等待重试', partial: '部分已发送', skipped: '本轮不回复', cancelled: '已取消' };
  const detail = live.reason || labels[phase] || '等待新消息';
  const countdown = Number.isFinite(live.dueAt) && live.dueAt > Date.now() ? `<span class="ai-reply-countdown" data-ai-countdown="${live.dueAt}">${countdownText(live.dueAt)}</span>` : '';
  const canSkip = allowSkip && (live.canSkipWait === true || live.canSkipWait === undefined && phase === 'waiting' && skippable.has(live.reason));
  const skip = canSkip && profile?.id ? `<button type="button" class="secondary" data-ai-skip-reply-wait="${esc(profile.id)}">${live.canRetry ? '直接重试' : '跳过等待'}</button>` : '';
  const label = phase === 'waiting' && live.canRetry ? '等待重试' : phase === 'waiting' && live.reason === '等待补充信息' ? '等待补充信息' : labels[phase] || '正在处理';
  return `<div class="ai-reply-flow" data-phase="${esc(phase)}"><div class="ai-reply-flow-detail"><strong>${esc(label)}</strong><span>${esc(detail)}</span>${countdown}${skip}</div></div>`;
}
