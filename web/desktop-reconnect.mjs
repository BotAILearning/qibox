export function desktopReconnect({ reconnect, notify, schedule = setTimeout, cancel = clearTimeout }) {
  let timer, stable, attempts = 0, epoch = 0;
  const stop = () => { epoch++; cancel(timer); cancel(stable); attempts = 0; };
  const lost = () => {
    cancel(stable); cancel(timer);
    if (attempts >= 3) { notify('连接已断开，请点击连接微信重试'); return; }
    const current = epoch, wait = [1000, 3000, 8000][attempts++];
    notify('桌面连接中断，正在重新连接…');
    timer = schedule(async () => { if (current !== epoch) return; try { await reconnect(); } catch { if (current === epoch) lost(); } }, wait);
  };
  return { lost, stop, connected() { cancel(timer); cancel(stable); stable = schedule(() => { attempts = 0; }, 30000); } };
}
