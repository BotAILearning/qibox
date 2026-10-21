import test from 'node:test';
import assert from 'node:assert/strict';
import { withConfigurationCommit } from '../server/ai-configuration-commit.mjs';

const fixture = () => {
  const a = { data: { enabled: false, history: [] }, writes: Promise.resolve(), snapshots: [] };
  a.save = function () { this.snapshots.push(structuredClone(this.data)); return Promise.resolve(); };
  return a;
};

for (const fail of [false, true]) test(`deferred save takes ${fail ? 'rolled-back' : 'committed'} state and keeps unrelated history`, async () => {
  const a = fixture(), started = Promise.withResolvers(), held = Promise.withResolvers();
  const operation = withConfigurationCommit(a, async persist => {
    a.data.enabled = true; started.resolve(); await held.promise;
    try { if (fail) throw Error('fixture save failed'); await persist(); }
    catch (error) { a.data.enabled = false; throw error; }
  });
  await started.promise;
  a.data.history.push('receipt-arrived');
  let completed = false;
  const background = a.save().then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(a.snapshots.length, 0);
  const result = fail ? assert.rejects(operation, /fixture save failed/) : operation;
  held.resolve(); await result; await background;
  assert.equal(a.snapshots.at(-1).enabled, !fail);
  assert.deepEqual(a.snapshots.at(-1).history, ['receipt-arrived']);
});

test('waits for already queued writes before staging configuration', async () => {
  const a = fixture(), queued = Promise.withResolvers(); a.writes = queued.promise;
  let entered = false; const operation = withConfigurationCommit(a, async persist => { entered = true; await persist(); });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(entered, false);
  queued.resolve(); await operation; assert.equal(entered, true);
});

test('drain:false installs the barrier and invalidates synchronously while persist remains behind older writes', async () => {
  const a = fixture(), queued = Promise.withResolvers(); a.writes = queued.promise;
  a.save = function () { const snapshot = structuredClone(this.data); const write = this.writes.then(() => { this.snapshots.push(snapshot); }); this.writes = write; return write; };
  let invalidated = false;
  const operation = withConfigurationCommit(a, async persist => { invalidated = true; a.data.enabled = true; await persist(); }, { drain: false });
  assert.equal(invalidated, true, 'Cancellation/epoch invalidation must happen before returning to the caller');
  let ordinaryCompleted = false; const ordinary = a.save().then(() => { ordinaryCompleted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ordinaryCompleted, false); assert.deepEqual(a.snapshots, []);
  queued.resolve(); await operation; await ordinary;
  assert.deepEqual(a.snapshots.map(row => row.enabled), [true, true]);
});

test('nested commit fails explicitly and restores the ordinary save method', async () => {
  const a = fixture(), original = a.save;
  await assert.rejects(withConfigurationCommit(a, () => withConfigurationCommit(a, () => {})), /cannot be nested/);
  assert.equal(a.save, original); await a.save(); assert.equal(a.snapshots.length, 1);
});

for (const phase of ['validation', 'rollback']) test(`${phase} exception still releases a waiting ordinary save`, async () => {
  const a = fixture(), original = a.save, entered = Promise.withResolvers(), held = Promise.withResolvers();
  const operation = withConfigurationCommit(a, async () => {
    entered.resolve(); await held.promise;
    if (phase === 'validation') throw Error('validation rejected');
    try { throw Error('write failed'); } catch { throw Error('rollback failed'); }
  });
  const rejected = assert.rejects(operation, new RegExp(phase + ' (rejected|failed)'));
  await entered.promise; const background = a.save(); held.resolve(); await rejected; await background;
  assert.equal(a.save, original); assert.equal(a.snapshots.length, 1);
});

test('deferred calls also respect a later commit instead of capturing its pending values', async () => {
  const a = fixture(), first = Promise.withResolvers(), second = Promise.withResolvers(), started = Promise.withResolvers();
  const one = withConfigurationCommit(a, async () => { await first.promise; });
  const background = a.save(); first.resolve(); await one;
  const two = withConfigurationCommit(a, async () => { a.data.enabled = true; started.resolve(); await second.promise; a.data.enabled = false; });
  await started.promise; second.resolve(); await two; await background;
  assert.equal(a.snapshots.at(-1).enabled, false);
});
