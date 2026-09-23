// WeChat contacts are labelled with the remark, and several people can share
// one remark. The interface shows the WeChat nickname next to the label in a
// muted colour so those rows stay distinguishable. Rows that only carry a
// stored snapshot (records, profiles) can pass the matching address book entry
// as `contact` to borrow its nickname.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const nicknameOf = (item, contact) => {
  const label = String(item?.label ?? contact?.label ?? '').trim();
  const nickname = String(item?.nickname ?? contact?.nickname ?? '').trim();
  return nickname && nickname !== label ? nickname : '';
};
export const contactName = (item, contact) => {
  const label = String(item?.label ?? contact?.label ?? '');
  const nickname = nicknameOf(item, contact);
  return nickname ? `${esc(label)}<span class="ai-contact-nick">（${esc(nickname)}）</span>` : esc(label);
};
export const contactBook = state => new Map((state?.contacts || []).map(contact => [contact.id, contact]));
export const contactSearch = (item, contact) => `${item?.label || contact?.label || ''} ${item?.nickname || ''} ${contact?.nickname || ''}`.normalize('NFKC').toLocaleLowerCase();
export { esc };
