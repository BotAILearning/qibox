import { personReplyEnabled } from './ai-reply-state.mjs';
import { contactPickerMatches, contactPickerRow } from './ai-contact-picker.mjs';
import { nicknameOf } from './ai-contact-name.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const OBJECT_ROW_HEIGHT = 80;
export function objectWindow(total, scrollTop = 0, height = 600) {
  const visible = Math.max(1, Math.ceil(Math.max(1, height) / OBJECT_ROW_HEIGHT));
  const start = Math.max(0, Math.min(total - visible, Math.floor(Math.max(0, scrollTop) / OBJECT_ROW_HEIGHT)) - 6);
  return { start, end: Math.min(total, start + visible + 12) };
}
export function objectList(state, view) {
  const profiles = new Map(state.profiles.map(p => [p.contact, p]));
  const replyModes = contact => {
    const profile = profiles.get(contact.id);
    return contact.kind === 'group'
      ? [['realtime', '实时回复'], ['atMe', '@我'], ['atAll', '@所有人']].filter(([key]) => profile?.groupOptions?.[key] === true)
      : personReplyEnabled(state, profile) ? [['enabled', '自动回复已开启']] : [];
  };
  const priority = contact => {
    const key = replyModes(contact)[0]?.[0];
    return key === 'realtime' || key === 'enabled' ? 0 : key === 'atMe' ? 1 : key === 'atAll' ? 2 : 3;
  };
  // Sort saved settings before windowing; ties retain the address-book order.
  const contacts = contactPickerMatches(state.contacts, view.kind, view.search).sort((a, b) => priority(a) - priority(b));
  const { start, end } = objectWindow(contacts.length, view.scrollTop, view.height);
  const rows = contacts.slice(start, end).map((c, index) => {
    const i = start + index;
    const profile = profiles.get(c.id), modes = replyModes(c), on = modes.length > 0;
    const replyLabel = on ? modes.map(([, label]) => label).join(' · ') : '自动回复未开启';
    const maxRounds = profile?.replyStrategy?.maxRounds ?? state.replyRoundLimits?.[c.kind] ?? profile?.strategy?.maxRounds ?? state.replyStrategy?.maxRounds ?? state.strategy?.maxRounds ?? 50;
    const rounds = profile?.rounds || 0;
    const limited = on && state.settings?.enabled !== false && state.settings?.reply !== false && !profile?.manualWait && maxRounds !== 'unlimited' && rounds >= maxRounds;
    const nickname = nicknameOf(c), plainName = String(c.label || c.name || '') + (nickname ? `（${nickname}）` : '');
    return contactPickerRow(c, { index: i, selected: c.id === view.selected, button: `data-ai-object="${esc(c.id)}" data-ai-object-index="${i}" aria-label="${esc(plainName)}，${esc(replyLabel)}${profile?.paused ? '，已暂停' : ''}，第 ${i + 1} 项，共 ${contacts.length} 项"`, detail: `<small class="ai-contact-reply ${on ? 'on' : 'off'}">${replyLabel}</small>${limited ? `<small class="ai-contact-limit" role="status">已达回复次数上限 ${rounds}/${maxRounds}</small>` : ''}`, trailing: profile?.paused ? '<span class="ai-contact-status">已暂停</span>' : '' });
  }).join('');
  return rows ? `<div data-object-window="${start}:${end}" class="ai-object-spacer" style="height:${start * OBJECT_ROW_HEIGHT}px" aria-hidden="true"></div>${rows}<div class="ai-object-spacer" style="height:${(contacts.length - end) * OBJECT_ROW_HEIGHT}px" aria-hidden="true"></div>` : '<p class="ai-empty">暂无匹配对象，请刷新列表。</p>';
}
export { objectPage, objectExecutionStatus } from './ai-object-page-new.mjs';
