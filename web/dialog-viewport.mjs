// A keyboard may shrink the visual viewport without resizing the layout viewport.
// Keep the measurement local to this dialog and release listeners when it closes.
export function bindDialogViewport(dialog, { viewport = globalThis.visualViewport, win = globalThis } = {}) {
  let closed = false;
  const update = () => {
    if (closed) return;
    const height = Number(viewport?.height) || Number(win.innerHeight);
    if (!Number.isFinite(height) || height <= 0) return;
    const offset = Number(viewport?.offsetTop);
    dialog.style.setProperty('--qbx-dialog-viewport-height', height + 'px');
    dialog.style.setProperty('--qbx-dialog-viewport-top', (Number.isFinite(offset) ? Math.max(0, offset) : 0) + 'px');
    dialog.dataset.compactViewport = String(height < 480);
  };
  const target = viewport || win;
  target.addEventListener?.('resize', update); target.addEventListener?.('scroll', update); update();
  return () => { closed = true; target.removeEventListener?.('resize', update); target.removeEventListener?.('scroll', update); };
}
