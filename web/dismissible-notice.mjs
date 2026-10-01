// Dismissal affects the notice only; callers retain their drafts and error state.
export function dismissibleNotice(node, { fallbackFocus } = {}) {
  const document = node.ownerDocument || globalThis.document;
  const text = document.createElement('span');
  text.className = 'qbx-notice-message';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button qbx-notice-close';
  node.classList.toggle('qbx-notice', true);
  node.setAttribute('aria-atomic', 'true');
  node.replaceChildren(text, close);
  let current = '', dismissed = '', returnFocus;

  function dismiss() {
    const focused = node.contains?.(document.activeElement);
    dismissed = current;
    node.hidden = true;
    if (focused) {
      const available = element => element?.isConnected && !element.disabled && !element.closest?.('[hidden], [inert]') && !node.contains(element);
      const target = available(returnFocus) ? returnFocus : fallbackFocus?.();
      if (available(target)) target.focus();
    }
  }
  close.addEventListener('click', dismiss);
  node.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });

  function show(value, error = false, { repeat = true } = {}) {
    const message = String(value ?? '');
    current = message ? `${error ? 'error' : 'status'}:${message}` : '';
    if (!current) dismissed = '';
    const visible = !!current && (repeat || current !== dismissed);
    if (visible && !node.contains?.(document.activeElement)) returnFocus = document.activeElement;
    text.textContent = message;
    node.classList.toggle('error', error);
    node.setAttribute('role', error ? 'alert' : 'status');
    const label = error ? '关闭错误提示' : '关闭提示';
    close.setAttribute('aria-label', label);
    close.title = label;
    node.hidden = !visible;
  }
  show('');
  return { show, dismiss };
}
