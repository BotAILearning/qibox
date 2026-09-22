import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatWindowVisible, restoreWechatWindow, DesktopWindowState } from '../server/desktop.mjs';
test('only the requested WeChat main window determines visibility and restoration', async () => {
  let state = 1; const mapped = [];
  const options = { root: '/runtime', env: {}, pid: 100, command: async (bin, args) => {
    if (bin.endsWith('x11vnc')) { mapped.push(args[1]); return ''; }
    if (args[0] === '--root') return '_NET_CLIENT_LIST(WINDOW) = 0x123, 222, 333, 444\n';
    return `WM_CLASS(STRING) = "${args[1] === '444' ? 'other' : 'wechat'}", "wechat"\nWM_STATE(WM_STATE) = ${state}, 0\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_${args[1] === '222' ? 'DIALOG' : 'NORMAL'}\n_NET_WM_PID(CARDINAL) = ${args[1] === '333' ? 200 : 100}\n`;
  } };
  assert.equal(await wechatWindowVisible(options), true);
  assert.equal(await restoreWechatWindow(options), false);
  state = 3; assert.equal(await wechatWindowVisible(options), false);
  assert.equal(await restoreWechatWindow(options), true);
  assert.deepEqual(mapped, ['id_cmd:win=0x123:map']);
});
test('window observation is throttled, expires and rejects results from an old session', async () => {
  let time = 100, visible = true, resolve;
  const state = new DesktopWindowState({ now: () => time, probe: async () => visible });
  await state.refresh(); assert.equal(state.state(true), true);
  visible = false; await state.refresh(); assert.equal(state.state(true), true);
  time += 1600; await state.refresh(); assert.equal(state.state(true), false);
  visible = null; time += 6000; await state.refresh(); assert.equal(state.state(true), null);
  state.probe = () => new Promise(r => { resolve = r; });
  const pending = state.refresh(true); await Promise.resolve(); state.reset(); resolve(true); await pending;
  assert.equal(state.state(true), null); assert.equal(state.state(false), false);
});
