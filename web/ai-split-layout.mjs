// Width preferences contain only local layout values, never account data.
export function bindSplitLayout(panel) {
  const storageKey = 'qibox.ai.column-widths.v1';
  let saved = {}, drag;
  try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch {}
  const widths = { nav: Number.isFinite(saved.nav) ? saved.nav : 144, contacts: Number.isFinite(saved.contacts) ? saved.contacts : 300 };
  const limits = key => key === 'nav' ? [128, Math.min(220, Math.max(128, panel.clientWidth - 720))] : [240, Math.min(420, Math.max(240, panel.clientWidth - widths.nav - 440))];
  function refresh() {
    if (!panel.clientWidth || !panel.style?.setProperty) return;
    for (const key of ['nav', 'contacts']) {
      const [min, max] = limits(key);
      if (panel.clientWidth > 860) widths[key] = Math.min(max, Math.max(min, widths[key]));
      panel.style.setProperty(`--ai-${key}-width`, `${widths[key]}px`);
      const handle = panel.querySelector(`[data-ai-resize="${key}"]`);
      if (handle) { handle.setAttribute('aria-valuemin', min); handle.setAttribute('aria-valuemax', max); handle.setAttribute('aria-valuenow', widths[key]); }
    }
  }
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch {} };
  panel.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-ai-resize]');
    if (!handle || event.button !== 0 || matchMedia('(max-width:860px)').matches) return;
    event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
    drag = { handle, key: handle.dataset.aiResize, pointerId: event.pointerId, x: event.clientX, width: widths[handle.dataset.aiResize] };
    panel.classList.add('ai-resizing');
  });
  panel.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    widths[drag.key] = drag.width + event.clientX - drag.x; refresh();
  });
  const finish = () => { if (!drag) return; drag = null; panel.classList.remove('ai-resizing'); persist(); };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) panel.addEventListener(name, finish);
  panel.addEventListener('keydown', event => {
    const handle = event.target.closest('[data-ai-resize]');
    if (!handle || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const key = handle.dataset.aiResize, [min, max] = limits(key);
    widths[key] = event.key === 'Home' ? min : event.key === 'End' ? max : widths[key] + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 32 : 8);
    refresh(); persist();
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(refresh).observe(panel);
  return { refresh };
}
