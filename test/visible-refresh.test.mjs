import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleRefresh, stateRefreshDelay } from '../web/visible-refresh.mjs';

function fixture(refresh, interval = () => 5000) {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), { navigator: { onLine: true } });
  const timers = new Map(); let id = 0;
  const poll = visibleRefresh({ refresh, interval, document, window,
    schedule(fn, ms) { timers.set(++id, { fn, ms }); return id; }, cancel(key) { timers.delete(key); } });
  const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  return { poll, document, window, timers, settle, async tick() {
    assert.equal(timers.size, 1); const [key, value] = timers.entries().next().value;
    timers.delete(key); await value.fn(); await settle();
  } };
}

test('idle polling drops from every second to every five seconds; busy interval stays fast', async () => {
  let calls = 0, busy = false;
  const f = fixture(async () => { calls++; }, () => busy ? 1000 : 5000);
  f.poll.start(); await f.settle(); assert.equal(calls, 1);
  assert.equal([...f.timers.values()][0].ms, 5000);
  busy = true; await f.tick(); assert.equal([...f.timers.values()][0].ms, 1000);
  f.poll.stop(); assert.equal(f.timers.size, 0);
});

test('a completed installation leaves fast polling while actual startup stays responsive', async () => {
  const state = { ready: true, busy: false, job: { status: 'downloading' }, instances: [] };
  const f = fixture(async () => true, () => stateRefreshDelay(state));
  f.poll.start(); await f.settle(); assert.equal([...f.timers.values()][0].ms, 1000);
  state.job.status = 'complete'; await f.tick(); assert.equal([...f.timers.values()][0].ms, 5000);
  state.instances = [{ runtime: { status: 'starting' } }]; await f.tick(); assert.equal([...f.timers.values()][0].ms, 1000);
  state.instances[0].runtime.status = 'running'; await f.tick(); assert.equal([...f.timers.values()][0].ms, 5000);
  f.poll.stop();
});

test('hidden and offline pages stop traffic; visible and online events refresh immediately', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  f.poll.start(); await f.settle();
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.timers.size, 0); f.poll.wake(); await f.settle(); assert.equal(calls, 1);
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange')); await f.settle(); assert.equal(calls, 2);
  f.window.navigator.onLine = false; f.window.dispatchEvent(new Event('offline')); assert.equal(f.timers.size, 0);
  f.window.navigator.onLine = true; f.window.dispatchEvent(new Event('online')); await f.settle(); assert.equal(calls, 3);
  f.poll.stop(); f.window.dispatchEvent(new Event('online')); await f.settle(); assert.equal(calls, 3);
});

test('repeated resume events never overlap requests and keep only one follow-up', async () => {
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { calls++; if (calls === 1) await blocked; });
  f.poll.start(); f.poll.wake(); f.poll.wake(); assert.equal(calls, 1);
  release(); await f.settle(); assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].ms, 0);
  await f.tick(); assert.equal(calls, 2); assert.equal([...f.timers.values()][0].ms, 5000);
  f.poll.stop();
});

test('failed reads back off, recovery resets delay, and hide during a request leaves no timer', async () => {
  let fail = true; const f = fixture(async () => { if (fail) throw new Error('offline'); return true; });
  f.poll.start(); await f.settle(); assert.equal([...f.timers.values()][0].ms, 10000);
  await f.tick(); assert.equal([...f.timers.values()][0].ms, 20000);
  await f.tick(); assert.equal([...f.timers.values()][0].ms, 30000);
  fail = false; await f.tick(); assert.equal([...f.timers.values()][0].ms, 5000);
  f.poll.stop();
  let release; const pending = new Promise(resolve => { release = resolve; });
  const g = fixture(async () => pending); g.poll.start(); g.document.hidden = true;
  g.document.dispatchEvent(new Event('visibilitychange')); release(); await g.settle(); assert.equal(g.timers.size, 0); g.poll.stop();
});
