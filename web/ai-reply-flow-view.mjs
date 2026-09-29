const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stages = [
  ['waiting', '等待汇总'],
  ['summarizing', '汇总上下文'],
  ['requesting', 'AI 请求中'],
  ['sending', '发送中'],
  ['sent', '已发送'],
];
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
  const retry = live?.reason === '发送失败，等待重试';
  const waiting = live?.phase === 'waiting' && !retry;
  const flow = waiting
    ? { phase: 'waiting', steps: { waiting: live?.startedAt || Date.now() } }
    : profile?.replyFlow || (live?.phase === 'waiting' ? { phase: 'waiting', steps: {} } : null);
  if (!flow && !live) return '';
  const phase = retry ? 'failed' : live?.phase === 'generating' ? 'requesting' : live?.phase && live.phase !== 'waiting' ? live.phase : flow?.phase || 'waiting';
  const steps = flow?.steps || {};
  const current = stages.findIndex(([key]) => key === phase);
  const terminal = ['failed', 'skipped', 'partial', 'cancelled'].includes(phase);
  const completedAt = phase === 'sent' ? stages.length : terminal ? stages.findIndex(([key]) => !steps[key]) : Math.max(0, current);
  const items = stages.map(([key, title], index) => {
    const done = index < completedAt || phase === 'sent';
    const active = key === phase;
    return `<li class="${done ? 'done' : active ? 'current' : ''}"><span>${esc(title)}</span></li>`;
  }).join('');
  const dueAt = live?.phase === 'waiting' && Number.isFinite(live.dueAt) ? live.dueAt : null;
  const countdown = dueAt !== null ? `<span class="ai-reply-countdown" data-ai-countdown="${dueAt}">${countdownText(dueAt)}</span>` : '';
  const detail = retry ? '消息尚未发送，稍后自动重试' : live?.reason || flow?.detail || (phase === 'sent' ? '微信已确认发送' : '正在处理本轮回复');
  const skip = allowSkip && waiting && skippable.has(live.reason) && profile?.id
    ? `<button type="button" class="secondary" data-ai-skip-reply-wait="${esc(profile.id)}">跳过倒计时</button>` : '';
  const result = terminal ? `<strong class="ai-reply-flow-result ${esc(phase)}">${esc(({ failed: '本轮未发送', skipped: '本轮不回复', partial: '部分已发送', cancelled: '本轮已取消' })[phase])}</strong>` : '';
  return `<div class="ai-reply-flow" data-phase="${esc(phase)}"><ol aria-label="自动回复执行流程">${items}</ol><div class="ai-reply-flow-detail"><span>${esc(detail)}</span>${countdown}${result}${skip}</div></div>`;
}
