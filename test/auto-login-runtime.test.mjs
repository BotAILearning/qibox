import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../server/runtime.mjs';

test('successful stop clears the old foreground grace and late viewer releases cannot affect a new session', async () => {
  const runtime = Object.create(Runtime.prototype);
  Object.assign(runtime, { dev: true, status: 'running', processes: [], desktopViewers: 0, foregroundUntil: 0,
    loginState: {reset(){}}, windowState: {reset(){}}, loginVerifier: {async stopped(){}, async clear(){}} });
  const oldRelease = runtime.desktopConnected();
  await runtime.stop();
  assert.equal(runtime.foregroundUntil, 0); assert.equal(runtime.desktopViewers, 0);
  const newRelease = runtime.desktopConnected(); oldRelease();
  assert.equal(runtime.desktopViewers, 1); assert.equal(runtime.foregroundUntil, 0);
  newRelease(); assert.equal(runtime.desktopViewers, 0); assert.ok(runtime.foregroundUntil > Date.now());
});

test('requested detection runs immediately after leaving desktop but never navigates another viewer', async () => {
  const runtime = Object.create(Runtime.prototype), calls = [];
  Object.assign(runtime, { dev: false, status: 'running', desktopViewers: 0, foregroundUntil: Date.now() + 60000,
    loginVerifier: { inspect: async options => { calls.push(options); return { status: 'ready' }; } } });
  await runtime.inspectAutoLogin();
  await runtime.inspectAutoLogin({ requested: true });
  runtime.desktopViewers = 1;
  await runtime.inspectAutoLogin({ requested: true });
  assert.deepEqual(calls.map(call => call.navigate), [false, true, false]);
  assert.deepEqual(calls.map(call => call.requested), [false, true, true]);
});

test('requested detection is not swallowed by a passive observation already in flight', async () => {
  const runtime = Object.create(Runtime.prototype), calls = [], pending = Promise.withResolvers();
  Object.assign(runtime, { dev: false, status: 'running', desktopViewers: 0, foregroundUntil: 0,
    loginVerifier: { inspect: async options => { calls.push(options); return calls.length === 1 ? pending.promise : { status: 'ready' }; } } });
  const passive = runtime.inspectAutoLogin();
  const requested = runtime.inspectAutoLogin({ requested: true });
  pending.resolve({ status: 'unknown' });
  assert.equal((await passive).status, 'unknown');
  assert.equal((await requested).status, 'ready');
  assert.deepEqual(calls.map(call => call.requested), [false, true]);
});
