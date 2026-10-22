// Restore only the WeChat window in this runtime's private X display.
// Window ids come from X, never from a browser request.
async function wechatWindows({ root, env, command, pid }, { includeModal = false } = {}) {
  const properties = (...args) => command(`${root}/usr/bin/obxprop`, args, env, 5000);
  const clients = await properties('--root', '_NET_CLIENT_LIST');
  const list = clients.match(/^_NET_CLIENT_LIST\(WINDOW\) = (.*)$/m)?.[1];
  if (list === undefined) throw new Error('Desktop window list unavailable');
  const ids = list.split(',').map(id => id.trim()).filter(id => /^(?:\d+|0x[0-9a-f]+)$/i.test(id) && Number(id) > 0).slice(0, 32);
  const windows = [];
  for (const id of ids) {
    const info = await properties('--id', id, 'WM_CLASS', 'WM_STATE', '_NET_WM_WINDOW_TYPE', '_NET_WM_PID', ...(includeModal ? ['WM_TRANSIENT_FOR', '_NET_WM_STATE'] : []));
    if (!/^WM_CLASS\(STRING\) = "wechat", "wechat"$/m.test(info)) continue;
    // Qt utility windows can also advertise NORMAL and share the main PID.
    // They are not the main window and must not make activation ambiguous.
    const auxiliary = /_NET_WM_WINDOW_TYPE_(?:DIALOG|UTILITY|MENU|DROPDOWN_MENU|POPUP_MENU|TOOLTIP|NOTIFICATION)\b/.test(info);
    const modal = includeModal && /_NET_WM_STATE_MODAL\b/.test(info)
      && /_NET_WM_WINDOW_TYPE_(?:DIALOG|UTILITY)\b/.test(info)
      && !/_NET_WM_WINDOW_TYPE_(?:MENU|DROPDOWN_MENU|POPUP_MENU|TOOLTIP|NOTIFICATION)\b/.test(info);
    if (auxiliary && !modal) continue;
    if (pid && Number(info.match(/^_NET_WM_PID\(CARDINAL\) = (\d+)$/m)?.[1]) !== pid) continue;
    const state = Number(info.match(/^WM_STATE\(WM_STATE\) = (\d+),/m)?.[1]);
    if ([1, 3].includes(state)) windows.push({ id, visible: state === 1,
      ...(auxiliary ? { modal: true, parent: info.match(/^WM_TRANSIENT_FOR\(WINDOW\) = ((?:0x[0-9a-f]+|\d+))$/im)?.[1] } : {}) });
  }
  return windows;
}
export async function wechatWindowVisible(options) { return (await wechatWindows(options)).some(window => window.visible); }
export async function restoreWechatWindow(options) {
  const windows = await wechatWindows(options);
  if (windows.some(window => window.visible)) return false;
  for (const window of windows) {
    if (window.visible) continue;
    // Map through the window manager, then activate the same PID-verified
    // window. x11vnc's remote map command does not reliably deiconify Openbox.
    await options.command(`${options.root}/usr/bin/xdotool`, ['windowmap', '--sync', window.id], options.env, 5000);
    await options.command(`${options.root}/usr/bin/xdotool`, ['windowactivate', '--sync', window.id], options.env, 5000);
    if (!(await wechatWindows(options)).some(item => item.id === window.id && item.visible)) throw new Error('WeChat window did not restore');
    return true;
  }
  return false;
}
export async function minimizeWechatWindow(options) {
  const windows = await wechatWindows(options);
  for (const window of windows.filter(item => item.visible)) await options.command(`${options.root}/usr/bin/xdotool`, ['windowminimize', '--sync', window.id], options.env, 5000);
  if ((await wechatWindows(options)).some(item => item.visible)) throw new Error('WeChat window did not minimize');
}
export async function activateWechatWindow(options) {
  const owned = (await wechatWindows(options, { includeModal: true })).filter(window => window.visible);
  const windows = owned.filter(window => !window.modal);
  const tool = `${options.root}/usr/bin/xdotool`;
  // A freshly restarted desktop can have no active X window yet. Select only
  // an independently verified owned window, then require focus verification.
  let active;
  try { active = (await options.command(tool, ['getactivewindow'], options.env, 5000)).trim(); }
  catch (error) {
    if (!/XGetWindowProperty\[_NET_ACTIVE_WINDOW\].*failed|xdo_get_active_window reported an error/.test(error.message)) throw error;
    active = '';
  }
  // Detached chats are owned NORMAL windows too. Reconnecting should preserve
  // the user's current chat instead of rejecting the whole desktop as ambiguous.
  if (windows.some(window => Number(active) === Number(window.id))) return false;
  // WeChat's storage/error prompts can be modal UTILITY windows. Focusing the
  // blocked parent never completes; preserve only its already-active, owned
  // modal so the user can see and resolve it through the desktop.
  if (options.pid && owned.some(window => window.modal && Number(active) === Number(window.id)
    && windows.some(parent => Number(parent.id) === Number(window.parent)))) return false;
  let window = windows.length === 1 ? windows[0] : null;
  if (!window && windows.length > 1) {
    const main = [];
    for (const candidate of windows) {
      const title = await options.command(`${options.root}/usr/bin/obxprop`, ['--id', candidate.id, '_NET_WM_NAME'], options.env, 5000);
      if (/^_NET_WM_NAME\(UTF8_STRING\) = "微信"$/m.test(title)) main.push(candidate);
    }
    if (main.length === 1) [window] = main;
  }
  if (!window) throw new Error('WeChat main window unavailable');
  await options.command(tool, ['windowactivate', '--sync', window.id], options.env, 5000);
  const verified = (await options.command(tool, ['getactivewindow'], options.env, 5000)).trim();
  if (Number(verified) !== Number(window.id)) throw new Error('WeChat main window did not activate');
  return true;
}

export class DesktopWindowState {
  constructor({ probe, now = Date.now }) { this.probe = probe; this.now = now; this.reset(); }
  reset() { this.generation = (this.generation || 0) + 1; this.value = null; this.observedAt = -Infinity; this.attemptedAt = -Infinity; this.pending = null; }
  state(running) { return running ? this.now() - this.observedAt < 5000 ? this.value : null : false; }
  refresh(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.now() - this.attemptedAt < 1500) return Promise.resolve(this.state(true));
    this.attemptedAt = this.now(); const generation = this.generation;
    const task = Promise.resolve().then(this.probe).catch(() => null).then(value => {
      if (generation === this.generation && typeof value === 'boolean') { this.value = value; this.observedAt = this.now(); }
      return this.state(true);
    }).finally(() => { if (this.pending === task) this.pending = null; });
    this.pending = task; return task;
  }
}
