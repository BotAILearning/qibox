const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function productDialog({ title = '请确认', message = '', confirm = '确认', input, danger = false } = {}) {
  return new Promise(resolve => {
    const origin = document.activeElement, dialog = document.createElement('dialog');
    dialog.className = 'ai-confirm-dialog qbx-product-dialog';
    dialog.innerHTML = `<button type="button" class="icon-button qbx-dialog-close" aria-label="关闭">×</button><h3>${escape(title)}</h3><p>${escape(message)}</p><form method="dialog">${input === undefined ? '' : `<label class="ai-field">名称<input name="answer" maxlength="40" required value="${escape(input)}"></label>`}<div class="ai-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="${danger ? 'danger' : 'primary'}">${escape(confirm)}</button></div></form>`;
    let answer = null;
    const cancel = () => dialog.close();
    dialog.querySelector('[data-cancel]').addEventListener('click', cancel);
    dialog.querySelector('.qbx-dialog-close').addEventListener('click', cancel);
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); answer = input === undefined ? true : dialog.querySelector('input').value.trim();
      if (input !== undefined && !answer) return;
      dialog.close();
    });
    dialog.addEventListener('close', () => { dialog.remove(); if (origin?.isConnected) origin.focus({ preventScroll: true }); resolve(answer); }, { once: true });
    document.body.append(dialog); dialog.showModal();
    (input === undefined ? dialog.querySelector('[data-cancel]') : dialog.querySelector('input')).focus();
  });
}
export const confirmDialog = message => productDialog({ message });
