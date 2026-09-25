import { styleChoice } from './ai-style-view.mjs';
import { icon } from './ai-icons.mjs';
import { contactName, contactSearch } from './ai-contact-name.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avatar = (contact, index = 0) => `<span class="ai-monogram ai-avatar-${index % 6}" aria-hidden="true">${esc([...contact.label][0])}</span>`;
export function objectList(state, view) {
  const query = view.search.normalize('NFKC').toLocaleLowerCase();
  return state.contacts.filter(c => c.kind === view.kind && (!query || contactSearch(c).includes(query))).map((c, i) => {
    const profile = state.profiles.find(p => p.contact === c.id), style = styleChoice(profile);
    const on = c.kind === 'group' ? !!(profile?.groupOptions?.atMe || profile?.groupOptions?.atAll || profile?.groupOptions?.realtime) : !!(profile?.replyOptions?.enabled ?? (state.settings.replyScope === 'all' || (state.replyTargets || []).includes(profile?.id)));
    const draftStyleId = c.id === view.selected ? view.draft?.styleId : undefined;
    const currentStyleId = draftStyleId !== undefined ? draftStyleId : style.styleId;
    const styleLabel = currentStyleId === 'custom' ? '自定义' : currentStyleId === 'learned' ? '已学习风格' : currentStyleId?.startsWith('preset:') ? '已设置风格' : currentStyleId ? '已设置风格' : '使用默认风格';
    const maxRounds = profile?.replyStrategy?.maxRounds ?? state.replyRoundLimits?.[c.kind] ?? profile?.strategy?.maxRounds ?? state.replyStrategy?.maxRounds ?? state.strategy?.maxRounds ?? 50;
    const limited = (profile?.rounds || 0) >= maxRounds;
    return `<button type="button" class="ai-object-row ${c.id === view.selected ? 'selected' : ''}" data-ai-object="${esc(c.id)}" aria-pressed="${c.id === view.selected}">${avatar(c, i)}<span class="ai-contact-info"><b>${contactName(c)}</b>${on ? `<small>${styleLabel}</small>` : ''}${limited ? `<small class="ai-contact-limit" role="status">已达自动回复上限 ${profile.rounds}/${maxRounds}</small>` : ''}</span>${profile?.paused ? '<span class="ai-contact-status">已暂停</span>' : ''}</button>`;
  }).join('') || '<p class="ai-empty">暂无匹配对象，请刷新列表。</p>';
}
export { objectPage } from './ai-object-page-new.mjs';
