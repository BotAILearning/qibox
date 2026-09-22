// Resolve the same capture module bundled by RFB (noVNC exports only RFB).
import { releaseCapture } from '../node_modules/@novnc/novnc/core/util/events.js';

// noVNC's document-wide mouse proxy otherwise survives a lost mouseup or
// disconnect. Release both the remote button and our own capture on interruption.
export function desktopPointer(canvas) {
  let point = { x: 0, y: 0 }, releasing = false;
  const release = () => {
    if (releasing || document.captureElement !== canvas) return;
    releasing = true;
    try { for (const button of [0, 1, 2]) canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button, buttons: 0, clientX: point.x, clientY: point.y })); }
    finally { releaseCapture(); releasing = false; }
  };
  const moved = event => {
    if (document.captureElement !== canvas && event.target !== canvas) return;
    point = { x: event.clientX, y: event.clientY };
    if (event.type === 'mousemove' && event.buttons === 0) release();
  };
  const hidden = () => { if (document.hidden) release(); };
  // Let noVNC handle the original release first, then clear any stranded proxy.
  const released = event => { if (event.buttons === 0 && !releasing) queueMicrotask(release); };
  window.addEventListener('mousedown', moved, true);
  window.addEventListener('mousemove', moved, true);
  window.addEventListener('blur', release);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('pointerup', released, true);
  window.addEventListener('mouseup', released, true);
  document.addEventListener('visibilitychange', hidden);
  document.addEventListener('fullscreenchange', release);
  return { release, dispose() {
    release();
    window.removeEventListener('mousedown', moved, true); window.removeEventListener('mousemove', moved, true);
    window.removeEventListener('blur', release); window.removeEventListener('pointercancel', release, true);
    window.removeEventListener('pointerup', released, true); window.removeEventListener('mouseup', released, true);
    document.removeEventListener('visibilitychange', hidden); document.removeEventListener('fullscreenchange', release);
  } };
}
