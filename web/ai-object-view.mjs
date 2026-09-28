import { styleChoice } from './ai-style-view.mjs';
import { icon } from './ai-icons.mjs';
import { personReplyEnabled } from './ai-reply-state.mjs';
import { contactPickerMatches, contactPickerRow } from './ai-contact-picker.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function objectList(state, view) {
  return contactPickerMatches(state.contacts, view.kind, view.search).map((c, i) => {
    const profile = state.profiles.find(p => p.contact === c.id), style = styleChoice(profile);
    const on = c.kind === 'group' ? !!(profile?.groupOptions?.atMe || profile?.groupOptions?.atAll || profile?.groupOptions?.realtime) : personReplyEnabled(state, profile);
    const draftStyleId = c.id === view.selected ? view.draft?.styleId : undefined;
    const currentStyleId = draftStyleId !== undefined ? draftStyleId : style.styleId;
    const styleLabel = currentStyleId === 'custom' ? '自定义' : currentStyleId === 'learned' ? '已学习风格' : currentStyleId?.startsWith('preset:') ? '已设置风格' : currentStyleId ? '已设置风格' : '使用默认风格';
    const maxRounds = profile?.replyStrategy?.maxRounds ?? state.replyRoundLimits?.[c.kind] ?? profile?.strategy?.maxRounds ?? state.replyStrategy?.maxRounds ?? state.strategy?.maxRounds ?? 50;
    const rounds = c.kind === 'group' ? profile?.mentionRounds || 0 : profile?.rounds || 0;
    const limited = maxRounds !== 'unlimited' && rounds >= maxRounds && (c.kind !== 'group' || profile?.groupOptions?.atMe || profile?.groupOptions?.atAll);
    return contactPickerRow(c, { index: i, selected: c.id === view.selected, button: `data-ai-object="${esc(c.id)}"`, detail: `${on ? `<small>${styleLabel}</small>` : ''}${limited ? `<small class="ai-contact-limit" role="status">${c.kind === 'group' ? '提及回复已达上限' : '已达自动回复上限'} ${rounds}/${maxRounds}</small>` : ''}`, trailing: profile?.paused ? '<span class="ai-contact-status">已暂停</span>' : '' });
  }).join('') || '<p class="ai-empty">暂无匹配对象，请刷新列表。</p>';
}
export { objectPage } from './ai-object-page-new.mjs';
