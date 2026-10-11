const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let dialogNumber = 0;

export function productDialog({ title = '请确认', message = '', confirm = '确认', input, danger = false, signal } = {}) {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const origin = document.activeElement, dialog = document.createElement('dialog');
    dialog.className = 'ai-confirm-dialog qbx-product-dialog';
    dialog.innerHTML = `<button type="button" class="icon-button qbx-dialog-close" aria-label="关闭">×</button><h3>${escape(title)}</h3><p>${escape(message)}</p><form method="dialog">${input === undefined ? '' : `<label class="ai-field">名称<input name="answer" maxlength="40" required value="${escape(input)}"></label>`}<div class="ai-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="${danger ? 'danger' : 'primary'}">${escape(confirm)}</button></div></form>`;
    const titleId = `qbx-dialog-title-${++dialogNumber}`;
    dialog.querySelector('h3').id = titleId; dialog.setAttribute('aria-labelledby', titleId);
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const controls = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) return;
      if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    });
    let answer = null;
    const cancel = () => dialog.close();
    signal?.addEventListener('abort', cancel, { once: true });
    dialog.querySelector('[data-cancel]').addEventListener('click', cancel);
    dialog.querySelector('.qbx-dialog-close').addEventListener('click', cancel);
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); answer = input === undefined ? true : dialog.querySelector('input').value.trim();
      if (input !== undefined && !answer) return;
      dialog.close();
    });
    dialog.addEventListener('close', () => { signal?.removeEventListener('abort', cancel); dialog.remove(); if (origin?.isConnected) origin.focus({ preventScroll: true }); resolve(answer); }, { once: true });
    document.body.append(dialog); dialog.showModal();
    (input === undefined ? dialog.querySelector('[data-cancel]') : dialog.querySelector('input')).focus();
  });
}
export const confirmDialog = message => productDialog({ message });
