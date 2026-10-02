import { icon } from './ai-icons.mjs';
import { contactName, contactSearch, nicknameOf, esc } from './ai-contact-name.mjs';

let avatarInstance = null;
const failedAvatars = new Set();
const avatarPrefix = () => globalThis.location?.pathname?.replace(/\/$/, '') || '';
export function setContactAvatarInstance(id) {
  if (avatarInstance !== id) failedAvatars.clear();
  avatarInstance = id;
}
export function resetContactAvatarFailures() { failedAvatars.clear(); }
export function noteContactAvatarFailure(image) {
  if (!image?.dataset?.aiAvatar) return false;
  failedAvatars.add(image.dataset.aiAvatar);
  image.remove();
  return true;
}

// The automatic-reply sidebar is the base for every contact selection surface.
// Callers own selection state and actions; this module owns the shared anatomy.
export function contactPickerTabs(contacts, kind, attribute) {
  return `<div class="ai-object-types ai-contact-picker-types" role="group" aria-label="对象类型">${[['person', '联系人', 'user'], ['group', '群聊', 'users']].map(([id, label, symbol]) => `<button type="button" ${attribute}="${id}" class="${kind === id ? 'selected' : ''}" aria-pressed="${kind === id}">${icon(symbol)}${label}<em>${contacts.filter(c => c.kind === id).length}</em></button>`).join('')}</div>`;
}

export function contactPickerSearch({ id, value = '', label = '搜索联系人', placeholder = '搜索名称', className = '' }) {
  return `<label class="ai-object-search ai-contact-picker-search ${className}">${icon('search')}<span class="sr-only">${esc(label)}</span><input id="${esc(id)}" type="search" aria-label="${esc(label)}" placeholder="${esc(placeholder)}" value="${esc(value)}"></label>`;
}

export function contactPickerAvatar(contact, index = 0, className = 'ai-monogram') {
  const key = `${avatarInstance}:${contact?.id}`;
  const src = avatarInstance && /^[a-f0-9-]{36}$/.test(avatarInstance) && /^[a-f0-9]{64}$/.test(contact?.id || '') && contact?.avatar && !failedAvatars.has(key)
    ? `${avatarPrefix()}/api/instances/${avatarInstance}/ai/avatar/${contact.id}` : null;
  const fallback = '<svg viewBox="0 0 40 40" focusable="false" aria-hidden="true"><rect width="40" height="40" fill="#dedede"/><circle cx="20" cy="15" r="7" fill="#fff"/><path d="M6 40c0-9 6-15 14-15s14 6 14 15" fill="#fff"/></svg>';
  return `<span class="${esc(className)} ai-avatar-${index % 6} ai-wechat-avatar" aria-hidden="true">${fallback}${src ? `<img src="${esc(src)}" data-ai-avatar="${esc(key)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</span>`;
}

export function contactPickerRow(contact, { index = 0, selected = false, multiple = false, input = '', button = '', detail = '', trailing = '', className = '', disabled = false, hidden = false } = {}) {
  const nickname = nicknameOf(contact);
  const plainName = String(contact?.label || '') + (nickname ? `（${nickname}）` : '');
  const body = `${contactPickerAvatar(contact, index)}<span class="ai-contact-info"><b title="${esc(plainName)}">${contactName(contact)}</b>${detail}</span>${trailing}`;
  if (multiple) return `<label class="ai-object-row ai-contact-picker-row ai-contact-picker-multiple ${selected ? 'selected ' : ''}${className}" ${hidden ? 'hidden' : ''}><input type="checkbox" ${input} ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${body}</label>`;
  return `<button type="button" class="ai-object-row ai-contact-picker-row ${selected ? 'selected ' : ''}${className}" ${button} aria-pressed="${selected}">${body}</button>`;
}

export function contactPickerMatches(contacts, kind, query) {
  const q = String(query || '').trim().normalize('NFKC').toLocaleLowerCase();
  return contacts.filter(c => (!kind || c.kind === kind) && (!q || contactSearch(c).includes(q)));
}

// One modal for all flows that choose contacts. The caller supplies the current
// address book and owns the committed selection; closing the modal discards edits.
export function openContactPickerDialog({ parent, getContacts, selected = [], kinds = ['person'], title = '选择联系人', description = '', onConfirm, onRefresh, onClose = () => {}, detail = () => '', maxSelected = Infinity }) {
  const allowed = new Set(kinds), retained = new Map(selected.filter(c => allowed.has(c.kind || 'person')).map(c => [c.id, c]));
  const ids = new Set(retained.keys());
  let kind = kinds[0], query = '', closed = false;
  const focusBefore = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'ai-proactive-dialog ai-contact-picker-dialog';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<header><div><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div><button type="button" data-picker-cancel aria-label="关闭">×</button></header><div class="ap-picker-tools">${contactPickerSearch({ id: 'ai-modal-contact-search', label: '搜索联系人或群聊', placeholder: '搜索联系人或群聊' })}${onRefresh ? '<button type="button" data-picker-refresh>刷新</button>' : ''}</div><div class="ap-picker-types"></div><div class="ap-picker-summary"><span>按名称或微信名搜索</span><span><button type="button" data-picker-all>全选当前结果</button><button type="button" data-picker-clear>清空</button></span></div><div class="ap-picker-list ai-contact-picker-list" aria-label="联系人列表"></div><p class="ap-picker-error" role="alert"></p><footer><b data-picker-count></b><button type="button" class="secondary" data-picker-cancel>取消</button><button type="button" class="primary" data-picker-confirm>确认选择</button></footer>`;
  const list = dialog.querySelector('.ap-picker-list');
  let available = [];
  const matching = () => contactPickerMatches(available, kinds.length > 1 ? kind : null, query);
  const draw = () => {
    if (closed) return;
    available = getContacts([...retained.values()]) || [];
    for (const contact of available) retained.set(contact.id, contact);
    dialog.querySelector('.ap-picker-types').innerHTML = kinds.length > 1 ? contactPickerTabs(available.filter(c => allowed.has(c.kind)), kind, 'data-picker-kind') : '';
    const scroll = list.scrollTop;
    list.innerHTML = matching().map((contact, index) => contactPickerRow(contact, { index, multiple: true, selected: ids.has(contact.id), input: `data-picker-id="${esc(contact.id)}"`, detail: detail(contact) })).join('') || '<p class="ap-empty">没有匹配的联系人，请尝试其他名称或刷新列表。</p>';
    list.scrollTop = scroll;
    dialog.querySelector('[data-picker-count]').textContent = `已选 ${ids.size} 位`;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (focusBefore?.isConnected) focusBefore.focus();
    onClose();
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('input', event => { event.stopPropagation(); if (event.target.id === 'ai-modal-contact-search') { query = event.target.value; draw(); } });
  dialog.addEventListener('change', event => {
    event.stopPropagation();
    const id = event.target.dataset.pickerId;
    if (!id) return;
    if (event.target.checked && ids.size >= maxSelected) { event.target.checked = false; dialog.querySelector('.ap-picker-error').textContent = `最多选择 ${maxSelected} 位联系人`; return; }
    if (event.target.checked) ids.add(id); else ids.delete(id);
    dialog.querySelector('.ap-picker-error').textContent = '';
    draw();
  });
  dialog.addEventListener('click', async event => {
    event.stopPropagation();
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-picker-cancel')) { close(); return; }
    if (button.dataset.pickerKind) { kind = button.dataset.pickerKind; list.scrollTop = 0; draw(); return; }
    if (button.hasAttribute('data-picker-all')) {
      for (const contact of matching()) {
        if (!ids.has(contact.id) && ids.size >= maxSelected) break;
        ids.add(contact.id);
      }
      draw(); return;
    }
    if (button.hasAttribute('data-picker-clear')) { ids.clear(); draw(); return; }
    if (button.hasAttribute('data-picker-refresh')) {
      button.disabled = true;
      try { await onRefresh(); if (!closed) { dialog.querySelector('.ap-picker-error').textContent = ''; draw(); } }
      catch (error) { if (!closed) dialog.querySelector('.ap-picker-error').textContent = error.message || '刷新失败'; }
      finally { if (!closed) button.disabled = false; }
      return;
    }
    if (button.hasAttribute('data-picker-confirm')) {
      const chosen = [...retained.values()].filter(contact => ids.has(contact.id));
      close(); onConfirm(chosen);
    }
  });
  parent.append(dialog); dialog.showModal(); draw(); dialog.querySelector('input[type=search]').focus();
  return { close, draw, dialog };
}
