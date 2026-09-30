// Keep browser clipboard restrictions in one place. Text also works on a NAS
// HTTP page through the browser's user-initiated copy command.
export async function writeClipboardText(text, { signal } = {}) {
  signal?.throwIfAborted();
  if (!document.hasFocus()) throw new Error('请回到微信页面，点击“复制到本机”');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    return;
  } catch (error) {
    signal?.throwIfAborted();
    if (!document.hasFocus()) throw new Error('请回到微信页面，点击“复制到本机”');
    const active = document.activeElement;
    const selection = active && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const field = document.createElement('textarea');
    field.value = text; field.setAttribute('aria-label', '待复制文字');
    field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
    document.body.append(field);
    try {
      field.focus({ preventScroll: true }); field.select();
      if (!document.execCommand('copy')) throw new Error('请点击“复制到本机”，或允许浏览器访问剪贴板');
    } finally {
      field.remove(); active?.focus?.({ preventScroll: true });
      if (selection) active.setSelectionRange(...selection);
    }
  }
}
