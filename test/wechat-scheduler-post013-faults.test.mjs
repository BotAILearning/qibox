import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename, rmdir, access } from 'node:fs/promises';
import { WechatScheduler } from '../server/scheduler.mjs';
import { temp, cleanup } from './fixtures.mjs';

const schedule = mode => ({ mode, startTime: '02:00', endTime: '02:30' });
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

// Failure is injected into real atomicJson by replacing only an isolated
// destination file with an empty directory. The original file is restored
// before observation/restart. No runtime, model, native process or network runs.
async function fixture(t, { paused = false } = {}) {
  const root = await temp(), schedulers = [];
  let now = new Date('2026-10-22T11:00:00+08:00');
  const create = async ({ initialize = true } = {}) => {
    const calls = { starts: 0, stops: 0 }, runtime = { status: 'stopped' };
    const scheduler = new WechatScheduler({ dataRoot: root, runtime, ready: () => true,
      now: () => now,
      start: async () => { calls.starts++; runtime.status = 'running'; },
      stop: async () => { calls.stops++; runtime.status = 'stopped'; },
      resources: async () => ({ allowed: true }), setPriority: async () => true,
    });
    schedulers.push(scheduler); if (initialize) await scheduler.init(); return { scheduler, runtime, calls };
  };
  const live = await create(); await live.scheduler.save(schedule(paused ? 'continuous' : 'manual'));
  if (paused) await live.scheduler.pause();
  const before = { settings: structuredClone(live.scheduler.settings), state: structuredClone(live.scheduler.state),
    diskSettings: await readJson(live.scheduler.file), diskState: await readJson(live.scheduler.stateFile) };
  t.after(async () => { for (const item of schedulers) await item.close(); await cleanup(root); });
  return { ...live, before, create, advance: ms => { now = new Date(+now + ms); },
    async failDestination(file, action) {
      const backup = `${file}.post013-original`;
      await rename(file, backup); await mkdir(file);
      let error;
      try { await action(); } catch (caught) { error = caught; }
      finally { await rmdir(file); await rename(backup, file); }
      assert.ok(error, 'The real destination fault must reject save');
      const fault = error.code === 'schedule_recovery_required' ? error.cause : error;
      assert.ok(['EPERM', 'EISDIR', 'EACCES', 'ENOTEMPTY', 'EBUSY'].includes(fault?.code), `Unexpected fault classification: ${error.code}`);
      return { code: error.code, ...(error.cause ? { recoveryCause: error.cause.code } : {}) };
    },
  };
}

for (const scenario of [
  { name: 'first settings write failure keeps the old manual plan', destination: 'file', paused: false },
  { name: 'second state write failure cannot enable continuous mode after a rejected save', destination: 'stateFile', paused: false },
  { name: 'second state write failure cannot remove an existing continuous pause', destination: 'stateFile', paused: true },
  { name: 'reverse save from paused continuous to manual preserves its old pair when state write fails', destination: 'stateFile', paused: true, mode: 'manual' },
]) test(`post013 scheduler: ${scenario.name}`, { timeout: 10000 }, async t => {
  const f = await fixture(t, scenario), s = f.scheduler;
  const error = await f.failDestination(s[scenario.destination], () => s.save(schedule(scenario.mode || 'continuous')));
  // Collect every externally observable result before asserting, so a failure
  // in the first comparison cannot hide the on-disk/restart/start behavior.
  const afterRejected = { settings: structuredClone(s.settings), state: structuredClone(s.state),
    diskSettings: await readJson(s.file), diskState: await readJson(s.stateFile) };
  const reboot = await f.create(); const restartedMode = reboot.scheduler.settings.mode;
  const restartedPaused = reboot.scheduler.isPaused(); await reboot.scheduler.tick();
  await s.tick();
  const observed = { afterRejected, restartedMode, restartedPaused,
    liveStarts: f.calls.starts, restartedStarts: reboot.calls.starts };
  const expected = { afterRejected: f.before, restartedMode: f.before.settings.mode,
    restartedPaused: scenario.paused, liveStarts: 0, restartedStarts: 0 };
  t.diagnostic(JSON.stringify({ scenario: scenario.name, injectedError: error, before: f.before, observed,
    realModelRequests: 0, realWeChat: 0, network: 0 }));
  assert.deepEqual(observed, expected, 'A rejected schedule save must preserve both effective and durable prior behavior');
});

for (const scenario of [
  { name: 'after only settings changed', paused: false, stateWritten: false, mode: 'continuous' },
  { name: 'after both new files before commit', paused: false, stateWritten: true, mode: 'continuous' },
  { name: 'reverse save after both new files before commit', paused: true, stateWritten: true, mode: 'manual' },
]) test(`post013 scheduler: constructed interrupted save ${scenario.name} recovers before execution`, { timeout: 10000 }, async t => {
  const f = await fixture(t, scenario), s = f.scheduler;
  const newSettings = { ...f.before.settings, mode: scenario.mode };
  const newState = { paused: null, ownsProcess: false, failures: 0, lastAttempt: null, lastEvent: null };
  // A saved interruption image is deterministic evidence for init recovery,
  // not a claim of physical power loss or an actual killed process.
  await writeFile(s.transactionFile, JSON.stringify({ version: 1, settings: f.before.settings, state: f.before.state }));
  await writeFile(s.file, JSON.stringify(newSettings));
  if (scenario.stateWritten) await writeFile(s.stateFile, JSON.stringify(newState));
  const reboot = await f.create();
  assert.deepEqual(reboot.scheduler.settings, f.before.settings); assert.deepEqual(reboot.scheduler.state, f.before.state);
  assert.deepEqual(await readJson(s.file), f.before.diskSettings); assert.deepEqual(await readJson(s.stateFile), f.before.diskState);
  await assert.rejects(access(s.transactionFile), { code: 'ENOENT' });
  await reboot.scheduler.tick(); assert.equal(reboot.calls.starts, 0);
  t.diagnostic(JSON.stringify({ scenario: scenario.name, evidenceKind: 'constructed interrupted on-disk image', restartedStarts: reboot.calls.starts, recoveredMode: reboot.scheduler.settings.mode, recoveredPaused: reboot.scheduler.isPaused(), realOperations: 0 }));
});

test('post013 scheduler: failed rollback blocks tick, init and later actions until storage recovers, then a new valid plan runs', { timeout: 10000 }, async t => {
  const f = await fixture(t), s = f.scheduler, backup = `${s.stateFile}.post013-still-faulted`;
  await rename(s.stateFile, backup); await mkdir(s.stateFile);
  try {
    await assert.rejects(s.save(schedule('continuous')), { code: 'schedule_recovery_required' });
    assert.deepEqual((await readJson(s.transactionFile)).settings, f.before.settings);
    assert.equal(s.settings.mode, 'manual'); await s.tick(); assert.equal(f.calls.starts, 0);
    await assert.rejects(s.restoreLogin(), { code: 'schedule_recovery_required' }); assert.equal(f.calls.starts, 0);
    const reboot = await f.create({ initialize: false });
    await assert.rejects(reboot.scheduler.init(), { code: 'schedule_recovery_required' }); assert.equal(reboot.calls.starts, 0);
    await access(s.transactionFile);
  } finally { await rmdir(s.stateFile); await rename(backup, s.stateFile); }
  await s.tick(); assert.equal(s.settings.mode, 'manual'); assert.equal(f.calls.starts, 0);
  await assert.rejects(access(s.transactionFile), { code: 'ENOENT' });
  await s.save(schedule('continuous')); await s.tick(); assert.equal(f.calls.starts, 1);
  const reboot = await f.create(); assert.equal(reboot.scheduler.settings.mode, 'continuous');
  t.diagnostic('Persistent real FS rollback failure blocks all tested automatic starts; restored storage recovers old manual plan, then a separately saved continuous plan starts normally; real operations=0');
});

test('post013 scheduler: restore-login intent joins the state queue and does not self-lock', { timeout: 10000 }, async t => {
  const f = await fixture(t), s = f.scheduler, entered = Promise.withResolvers(), release = Promise.withResolvers();
  let confirmations = 0; f.runtime.status = 'running';
  f.runtime.confirmScheduledLogin = async () => { confirmations++; return { status: 'logged-in' }; };
  const blocker = s.exclusive(async () => { entered.resolve(); await release.promise; });
  t.after(() => release.resolve()); await entered.promise;
  const restoring = s.restoreLogin(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmations, 0); assert.equal((await readJson(s.stateFile)).resumeLoginAt, undefined);
  release.resolve(); await blocker; await restoring;
  assert.equal(confirmations, 1); assert.equal((await readJson(s.stateFile)).resumeLoginAt, null);
  assert.equal(f.calls.starts, 0);
});

test('post013 scheduler: a late background login result cannot overwrite a newer saved plan or block manual takeover', { timeout: 10000 }, async t => {
  const f = await fixture(t), s = f.scheduler, entered = Promise.withResolvers(), release = Promise.withResolvers();
  let confirmations = 0; f.runtime.status = 'running';
  f.runtime.confirmScheduledLogin = async () => { confirmations++; entered.resolve(); await release.promise; return { status: 'logged-in' }; };
  t.after(() => release.resolve());
  const restoring = s.restoreLogin(); await entered.promise;
  const joining = s.resumeLogin();
  await s.tick(); await s.interact();
  await s.save(schedule('continuous')); const state = structuredClone(s.state);
  release.resolve(); await restoring; await joining;
  assert.equal(confirmations, 1); assert.deepEqual(s.state, state);
  assert.deepEqual(await readJson(s.stateFile), state); assert.equal(s.settings.mode, 'continuous');
  assert.equal(f.calls.starts, 0);
});

test('post013 scheduler: a malformed recovery record cannot be overwritten by a new plan or permit execution', { timeout: 10000 }, async t => {
  const f = await fixture(t), s = f.scheduler, original = '{broken recovery record';
  await writeFile(s.transactionFile, original);
  await assert.rejects(s.save(schedule('continuous')), { code: 'schedule_recovery_required' });
  await s.tick(); assert.equal(f.calls.starts, 0); assert.equal(s.settings.mode, 'manual');
  assert.equal(await readFile(s.transactionFile, 'utf8'), original);
  const reboot = await f.create({ initialize: false });
  await assert.rejects(reboot.scheduler.init(), { code: 'schedule_recovery_required' }); assert.equal(reboot.calls.starts, 0);
});

for (const action of ['resume', 'interact']) test(`post013 scheduler state action: failed ${action} cannot remove the existing pause or automatically start`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { paused: true }), s = f.scheduler;
  const error = await f.failDestination(s.stateFile, () => s[action]());
  const afterRejected = { state: structuredClone(s.state), diskState: await readJson(s.stateFile), paused: s.isPaused() };
  const reboot = await f.create(); await reboot.scheduler.tick(); await s.tick();
  const observed = { afterRejected, liveStarts: f.calls.starts, restartedStarts: reboot.calls.starts, restartedPaused: reboot.scheduler.isPaused() };
  t.diagnostic(JSON.stringify({ scenario: `failed ${action} while continuous is paused`, injectedError: error, observed, realModelRequests: 0, realWeChat: 0, network: 0 }));
  assert.deepEqual(observed, { afterRejected: { state: f.before.state, diskState: f.before.diskState, paused: true }, liveStarts: 0, restartedStarts: 0, restartedPaused: true });
});

test('post013 scheduler state action: failed restore-login intent cannot call native confirmation on the next tick', { timeout: 10000 }, async t => {
  const f = await fixture(t), s = f.scheduler; let confirmations = 0;
  f.runtime.status = 'running'; f.runtime.confirmScheduledLogin = async () => { confirmations++; return { status: 'logged-in' }; };
  const error = await f.failDestination(s.stateFile, () => s.restoreLogin());
  const afterRejected = { state: structuredClone(s.state), diskState: await readJson(s.stateFile) };
  await s.tick();
  t.diagnostic(JSON.stringify({ scenario: 'failed restore-login state write', injectedError: error, afterRejected, confirmations, realWeChat: 0 }));
  assert.deepEqual(afterRejected, { state: f.before.state, diskState: f.before.diskState });
  assert.equal(confirmations, 0); assert.equal(f.calls.starts, 0);
});

test('post013 scheduler state action: failed pause does not publish an unsaved state', { timeout: 10000 }, async t => {
  const f = await fixture(t), s = f.scheduler;
  await s.save(schedule('continuous'));
  const before = { state: structuredClone(s.state), diskState: await readJson(s.stateFile) };
  const error = await f.failDestination(s.stateFile, () => s.pause());
  const observed = { state: structuredClone(s.state), diskState: await readJson(s.stateFile) };
  t.diagnostic(JSON.stringify({ scenario: 'failed pause state write with stopped runtime', injectedError: error, observed, realOperations: 0 }));
  assert.deepEqual(observed, before); assert.equal(f.calls.stops, 0);
});

test('post013 scheduler state action observation: an owned idle process can already be stopped before a rejected pause save', { timeout: 10000 }, async t => {
  const f = await fixture(t), s = f.scheduler;
  await s.save({ mode: 'idle', startTime: '10:00', endTime: '12:00' }); await s.tick();
  assert.equal(f.runtime.status, 'running'); assert.equal(s.state.ownsProcess, true); assert.equal(f.calls.starts, 1);
  const before = { settings: structuredClone(s.settings), state: structuredClone(s.state),
    diskSettings: await readJson(s.file), diskState: await readJson(s.stateFile) };
  const error = await f.failDestination(s.stateFile, () => s.pause());
  const afterRejected = { settings: structuredClone(s.settings), state: structuredClone(s.state),
    diskSettings: await readJson(s.file), diskState: await readJson(s.stateFile) };
  assert.deepEqual(afterRejected, before, 'Rejected pause must preserve the prior saved plan and state');
  assert.equal(f.calls.stops, 1); assert.equal(f.runtime.status, 'stopped', 'The successful stop callback is an external effect; it is not rolled back');
  t.diagnostic(JSON.stringify({ evidenceKind: 'actual production stop callback applied to simulated runtime; no native operation', error,
    afterRejectedRuntime: f.runtime.status, starts: f.calls.starts, stops: f.calls.stops, priorPlanPreserved: true, pauseSaved: s.isPaused(), realWeChat: 0 }));
  // The rejected pause did not become a saved pause. Its old active idle plan
  // remains effective and can run again after the existing start backoff.
  f.advance(61000); await s.tick(); assert.equal(f.calls.starts, 2); assert.equal(f.runtime.status, 'running');
});
