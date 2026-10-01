import { styleChoice } from './ai-style-view.mjs';
import { icon } from './ai-icons.mjs';
import { personReplyEnabled } from './ai-reply-state.mjs';
import { contactPickerMatches, contactPickerRow } from './ai-contact-picker.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const OBJECT_ROW_HEIGHT = 80;
export function objectWindow(total, scrollTop = 0, height = 600) {
  const visible = Math.max(1, Math.ceil(Math.max(1, height) / OBJECT_ROW_HEIGHT));
  const start = Math.max(0, Math.min(total - visible, Math.floor(Math.max(0, scrollTop) / OBJECT_ROW_HEIGHT)) - 6);
  return { start, end: Math.min(total, start + visible + 12) };
}
export function objectList(state, view) {
  const contacts = contactPickerMatches(state.contacts, view.kind, view.search);
  const { start, end } = objectWindow(contacts.length, view.scrollTop, view.height);
  const profiles = new Map(state.profiles.map(p => [p.contact, p]));
  const rows = contacts.slice(start, end).map((c, index) => {
    const i = start + index;
    const profile = profiles.get(c.id), style = styleChoice(profile);
    const on = c.kind === 'group' ? !!(profile?.groupOptions?.atMe || profile?.groupOptions?.atAll || profile?.groupOptions?.realtime) : personReplyEnabled(state, profile);
    const draftStyleId = c.id === view.selected ? view.draft?.styleId : undefined;
    const currentStyleId = draftStyleId !== undefined ? draftStyleId : style.styleId;
    const styleLabel = currentStyleId === 'custom' ? '自定义' : currentStyleId === 'learned' ? '已学习风格' : currentStyleId?.startsWith('preset:') ? '已设置风格' : currentStyleId ? '已设置风格' : '使用默认风格';
    const maxRounds = profile?.replyStrategy?.maxRounds ?? state.replyRoundLimits?.[c.kind] ?? profile?.strategy?.maxRounds ?? state.replyStrategy?.maxRounds ?? state.strategy?.maxRounds ?? 50;
    const rounds = profile?.rounds || 0;
    const limited = maxRounds !== 'unlimited' && rounds >= maxRounds;
    return contactPickerRow(c, { index: i, selected: c.id === view.selected, button: `data-ai-object="${esc(c.id)}" data-ai-object-index="${i}" aria-label="${esc(c.label || c.name || '')}，第 ${i + 1} 项，共 ${contacts.length} 项"`, detail: `${on ? `<small>${styleLabel}</small>` : ''}${limited ? `<small class="ai-contact-limit" role="status">已达回复次数上限 ${rounds}/${maxRounds}</small>` : ''}`, trailing: profile?.paused ? '<span class="ai-contact-status">已暂停</span>' : '' });
  }).join('');
  return rows ? `<div data-object-window="${start}:${end}" class="ai-object-spacer" style="height:${start * OBJECT_ROW_HEIGHT}px" aria-hidden="true"></div>${rows}<div class="ai-object-spacer" style="height:${(contacts.length - end) * OBJECT_ROW_HEIGHT}px" aria-hidden="true"></div>` : '<p class="ai-empty">暂无匹配对象，请刷新列表。</p>';
}
export { objectPage, objectExecutionStatus } from './ai-object-page-new.mjs';
