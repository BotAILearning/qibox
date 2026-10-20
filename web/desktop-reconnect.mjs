export function desktopReconnect({ reconnect, notify, schedule = setTimeout, cancel = clearTimeout, document = globalThis.document, window = globalThis.window }) {
  let timer, stable, attempts = 0, epoch = 0, disconnected = false;
  const available = () => !document?.hidden && window?.navigator?.onLine !== false;
  const stop = () => { epoch++; cancel(timer); cancel(stable); attempts = 0; disconnected = false; };
  const lost = () => {
    disconnected = true;
    cancel(stable); cancel(timer);
    if (!available()) return;
    if (attempts >= 3) { notify('连接已断开，请点击连接微信重试'); return; }
    const current = epoch, wait = [1000, 3000, 8000][attempts++];
    notify('桌面连接中断，正在重新连接…');
    timer = schedule(async () => { if (current !== epoch || !available()) return; try { await reconnect(); } catch { if (current === epoch) lost(); } }, wait);
  };
  const resume = () => {
    if (!disconnected || !available()) return;
    epoch++; attempts = 0; lost();
  };
  document?.addEventListener('visibilitychange', resume);
  for (const event of ['online', 'pageshow']) window?.addEventListener(event, resume);
  return { lost, stop, connected() { disconnected = false; cancel(timer); cancel(stable); stable = schedule(() => { attempts = 0; }, 30000); } };
}
