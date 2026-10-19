const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const presets = ['20', '50', '100', '200', '500'];
export const replyLimitManualMax = 2000;
// This historical warning is independent of the valid-save boundary.
export const replyLimitWarningThreshold = 100000;

export function replyLimitControl(value, id) {
  const current = String(value ?? 50);
  const choice = presets.includes(current) ? current : 'custom';
  const options = presets.map(item => `<option value="${item}" ${choice === item ? 'selected' : ''}>${item === 'unlimited' ? '不限' : item}</option>`).join('');
  const needsReview = !Number.isSafeInteger(Number(current)) || Number(current) < 1 || Number(current) > replyLimitManualMax;
  return `<span class="ai-reply-limit-control" data-ai-reply-limit><select id="${esc(id)}" data-ai-reply-limit-choice aria-label="回复次数上限">${options}<option value="custom" ${choice === 'custom' ? 'selected' : ''}>自定义</option></select><input type="number" min="1" step="1" inputmode="numeric" data-ai-reply-limit-custom aria-label="手动输入回复次数" placeholder="请输入" value="${choice === 'custom' && current !== 'unlimited' ? esc(current) : ''}" ${choice === 'custom' ? 'required' : 'hidden disabled'}><input type="hidden" name="maxRounds" value="${esc(current)}">${needsReview ? `<span class="qi-error-text" role="alert">旧上限：${current === 'unlimited' ? '不限' : esc(current)}。自动回复已暂缓，请保存 1–2000 的有效上限后恢复。</span>` : ''}</span>`;
}

export function syncReplyLimitControl(target) {
  const control = target?.closest?.('[data-ai-reply-limit]');
  if (!control || !target.matches?.('[data-ai-reply-limit-choice],[data-ai-reply-limit-custom]')) return false;
  const choice = control.querySelector('[data-ai-reply-limit-choice]');
  const custom = control.querySelector('[data-ai-reply-limit-custom]');
  const value = control.querySelector('[name="maxRounds"]');
  const manual = choice.value === 'custom';
  custom.hidden = !manual;
  custom.disabled = !manual;
  custom.required = manual;
  value.value = manual ? custom.value : choice.value;
  if (manual && target === choice) custom.focus();
  return true;
}

export function parseReplyLimit(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > replyLimitManualMax) throw new Error(`回复次数上限须为 1–${replyLimitManualMax} 的整数`);
  return number;
}
