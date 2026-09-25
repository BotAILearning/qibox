import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginState } from '../server/login-state.mjs';
import { loginLabel, desktopAction, aiAvailable } from '../web/wechat-state.mjs';

test('AI entry needs a connected desktop and a confirmed current WeChat login', () => {
  assert.equal(aiAvailable(undefined, true), false);
  for (const loginStatus of ['unknown', 'logged-out', 'relogin-required', undefined]) {
    assert.equal(aiAvailable({ status: 'running', loginStatus }, true), false);
  }
  assert.equal(aiAvailable({ status: 'stopped', loginStatus: 'logged-in' }, true), false);
  assert.equal(aiAvailable({ status: 'running', loginStatus: 'logged-in' }, false), false);
  assert.equal(aiAvailable({ status: 'running', loginStatus: 'logged-in' }, true), true);
});

test('native login observations refresh within one second, expire, detect logout and reset on process restart', async () => {
  let time = 20000, status = 'logged-out', calls = 0;
  const state = new LoginState({ now: () => time, probe: async () => { calls++; return { status }; } });
  await state.refresh(); assert.equal(state.state(true), 'logged-out');
  status = 'logged-in'; time += 999; await state.refresh(); assert.equal(calls, 1);
  time += 1; await state.refresh(); assert.equal(state.state(true), 'logged-in');
  status = 'unknown'; time += 16000; await state.refresh(); assert.equal(state.state(true), 'unknown');
  status = 'logged-out'; await state.refresh(true); assert.equal(state.state(true), 'relogin-required');
  assert.equal(state.state(false), 'logged-out');
  state.reset(); await state.refresh(); assert.equal(state.state(true), 'logged-out');
});
test('old in-flight probes never overwrite a new instance session', async () => {
  let resolve;
  const state = new LoginState({ probe: () => new Promise(r => { resolve = r; }) });
  const first = state.refresh(); await Promise.resolve();
  assert.equal(state.refresh(), first);
  state.reset(); resolve({ status: 'logged-in' }); await first;
  assert.equal(state.state(true), 'unknown');
});
test('AI entry survives inconclusive probes but is revoked on logout and restart', async () => {
  let time = 20000, status = 'unknown';
  const state = new LoginState({ now: () => time, probe: async () => ({ status }) });
  await state.refresh(); assert.equal(state.entryAvailable(true), false);
  status = 'logged-in'; await state.refresh(true);
  assert.equal(state.entryAvailable(true), true);
  status = 'unknown'; time += 60000; await state.refresh(true);
  assert.equal(state.state(true), 'unknown'); // Execution must still revalidate.
  assert.equal(state.entryAvailable(true), true);
  assert.equal(aiAvailable({ status: 'running', loginStatus: 'unknown', aiEntryAvailable: true }, true), true);
  assert.equal(aiAvailable({ status: 'running', loginStatus: 'logged-out', aiEntryAvailable: true }, true), false);
  status = 'logged-out'; await state.refresh(true); assert.equal(state.entryAvailable(true), false);
  status = 'logged-in'; await state.refresh(true); state.reset(); assert.equal(state.entryAvailable(true), false);
  assert.equal(state.entryAvailable(false), false);
});
test('authentication and desktop connection choose independent labels and actions', () => {
  const runtime = { status: 'running', loginStatus: 'logged-out', windowVisible: false };
  assert.equal(loginLabel(runtime), '未登录');
  assert.deepEqual(desktopAction(runtime, false), { label: '重新登录', login: true });
  assert.equal(desktopAction(runtime, true).label, '重新登录');
  runtime.windowVisible = true; assert.equal(desktopAction(runtime, true).login, true);
  runtime.windowVisible = null; assert.equal(desktopAction(runtime, true).login, true);
  runtime.windowVisible = false;
  runtime.loginStatus = 'logged-in'; assert.equal(loginLabel(runtime), '已登录');
  assert.equal(desktopAction(runtime, false).label, '连接微信');
  assert.equal(desktopAction(runtime, true).label, '显示微信');
  runtime.loginStatus = 'relogin-required'; assert.equal(loginLabel(runtime), '未登录');
  assert.deepEqual(desktopAction(runtime, true), { label: '重新登录', login: true });
  runtime.status = 'stopped'; assert.equal(desktopAction(runtime, true).label, '连接微信');
  assert.equal(loginLabel(runtime), '未登录');
});
