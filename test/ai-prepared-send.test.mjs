import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { preparedSend } from '../server/ai-prepared-send.mjs';
import { NativeChatBridge } from '../server/ai-native.mjs';

function fixture() {
  const input = [], cleanup = [], controller = new AbortController(), memory = { fd: 55, closed: 0, async close() { this.closed++; } };
  const context = { pid: 123, signal: controller.signal, delivery: { started: false } };
  const bridge = {
    runtime: { runtimeRoot: '/runtime', appRoot: '/app', desktopEnv: {} },
    async handover() {}, check(context) { context.signal.throwIfAborted(); },
    async openMemory(file, flags) { assert.equal(file, '/proc/123/mem'); assert.equal(flags, 'r'); return memory; },
    _manualInputBlocked: false,
    noteDraftResult(result, context) { cleanup.push(result); NativeChatBridge.prototype.noteDraftResult.call(this, result, context); },
    spawnProcess(binary, args, options) {
      assert.equal(args.at(-1), '--prepare'); assert.equal(options.stdio[2], 'ignore'); assert.equal(options.stdio[3], memory.fd);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { assert.equal(memory.closed, 0); queueMicrotask(() => child.emit('close', 0)); return true; };
      child.stdin.on('data', chunk => {
        const request = JSON.parse(chunk.toString()); input.push(request);
        if (request.action === 'prepare-send') queueMicrotask(() => child.stdout.write(JSON.stringify({ stage: 'prepared', account: 'a', contact: 'b', revision: 'r' }) + '\n'));
        else queueMicrotask(() => { child.stdout.write(JSON.stringify({ status: request.action === 'commit' ? 'submitted' : 'stale', draftCleanup: 'not-needed' }) + '\n'); child.emit('close', 0); });
      });
      return child;
    },
  };
  return { bridge, context, controller, input, cleanup, memory };
}

function controlledFixture({ onPrepare, onCommit, onKill } = {}) {
  const value = fixture(), signals = [], spawn = value.bridge.spawnProcess;
  value.signals = signals;
  value.bridge.spawnProcess = (...args) => {
    const child = spawn(...args); value.child = child;
    child.stdin.removeAllListeners('data');
    child.stdin.on('data', chunk => {
      const request = JSON.parse(chunk.toString()); value.input.push(request);
      if (request.action === 'prepare-send') {
        if (onPrepare) onPrepare(value, request);
        else queueMicrotask(() => child.stdout.write(JSON.stringify({ stage: 'prepared', account: 'a', contact: 'b', revision: 'r' }) + '\n'));
      } else onCommit?.(value, request);
    });
    child.kill = signal => { signals.push(signal); onKill?.(value, signal); return true; };
    return child;
  };
  return value;
}

test('prepared native pipe sends no text until the final database check permits the exact guard', async () => {
  const { bridge, context, input, cleanup, memory } = fixture();
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const work = preparedSend(bridge, { account: 'a', contact: 'b', label: '测试对象' }, '测试内容', context, async result => {
    assert.equal(result.revision, 'r'); entered.resolve(); await gate.promise; return true;
  });
  await entered.promise;
  assert.equal(input.length, 1); assert.equal(input[0].text, undefined); assert.equal(context.delivery.started, false);
  gate.resolve(); assert.equal((await work).status, 'submitted');
  assert.deepEqual(input[1], { action: 'commit', revision: 'r', text: '测试内容' });
  assert.equal(context.delivery.started, true); assert.equal(cleanup.length, 1);
  assert.equal(memory.closed, 1);
});

test('changed data revision cancels without committing or requiring uncertain-send review', async () => {
  const { bridge, context, input, cleanup } = fixture();
  assert.equal((await preparedSend(bridge, { account: 'a', contact: 'b' }, '测试内容', context, async () => false)).status, 'stale');
  assert.deepEqual(input[1], { action: 'cancel' }); assert.equal(context.delivery.started, false); assert.equal(cleanup.length, 0);
});

test('account changes and cancellation during preparation never send text', async () => {
  for (const failure of ['account', 'cancel']) {
    const { bridge, context, input, controller, memory } = fixture();
    const work = preparedSend(bridge, { account: 'a', contact: 'b' }, '测试内容', context, async () => {
      if (failure === 'account') throw Object.assign(new Error(), { code: 'ai_account_changed' });
      controller.abort(); return true;
    });
    if (failure === 'account') await assert.rejects(work, { code: 'ai_account_changed' });
    else assert.equal((await work).status, 'stale');
    assert.equal(input.length, 1); assert.equal(context.delivery.started, false);
    assert.equal(memory.closed, 1);
  }
});

test('prepared helper startup failures close read-only memory without sending text', async () => {
  for (const startup of ['throw', 'error-event']) {
    const { bridge, context, input, memory } = fixture(), spawn = bridge.spawnProcess;
    bridge.spawnProcess = (...args) => {
      if (startup === 'throw') throw new Error('spawn unavailable');
      const child = spawn(...args); child.stdin.removeAllListeners('data');
      queueMicrotask(() => child.emit('error', new Error('spawn unavailable')));
      return child;
    };
    const work = preparedSend(bridge, { account: 'a', contact: 'b' }, '测试内容', context, async () => assert.fail('No prepared guard'));
    if (startup === 'throw') await assert.rejects(work, /spawn unavailable/);
    else assert.equal((await work).status, 'not-sent');
    assert.equal(input.length, 0); assert.equal(context.delivery.started, false); assert.equal(memory.closed, 1);
  }
});

test('cancellation while opening memory never starts a helper and waits for descriptor cleanup', async () => {
  const { bridge, context, controller, input, memory } = fixture(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const open = bridge.openMemory;
  bridge.openMemory = async (...args) => { entered.resolve(); await gate.promise; return open(...args); };
  bridge.spawnProcess = () => assert.fail('Cancelled startup must not spawn');
  const work = preparedSend(bridge, { account: 'a', contact: 'b' }, '测试内容', context, async () => true);
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await entered.promise; controller.abort(); gate.resolve(); await rejected;
  assert.equal(input.length, 0); assert.equal(memory.closed, 1); assert.equal(context.delivery.started, false);
});

test('helper exit during the final database check cannot commit to a dead session', async () => {
  const { bridge, context, input, memory } = fixture(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const spawn = bridge.spawnProcess; let child;
  bridge.spawnProcess = (...args) => (child = spawn(...args));
  const work = preparedSend(bridge, { account: 'a', contact: 'b' }, '测试内容', context, async () => {
    entered.resolve(); await gate.promise; return true;
  });
  await entered.promise; child.emit('close', 0); gate.resolve();
  assert.equal((await work).status, 'not-sent');
  assert.equal(input.length, 1); assert.equal(memory.closed, 1); assert.equal(context.delivery.started, false);
});

test('SIGTERM preserves the unique complete cleanup report without treating cancellation as a successful send', async () => {
  for (const draftCleanup of ['not-needed', 'cleared']) {
    const value = controlledFixture({
      onCommit: value => value.controller.abort(),
      onKill: ({ child }) => queueMicrotask(() => {
        const output = JSON.stringify({ status: 'submitted', draftCleanup }) + '\n';
        child.stdout.write(output.slice(0, 19)); child.stdout.write(output.slice(19)); child.emit('close', 0);
      }),
    });
    let verified = 0;
    assert.deepEqual(await preparedSend(value.bridge, { account: 'a', contact: 'b' }, '测试内容', value.context, async () => { verified++; return true; }), { status: 'uncertain' });
    assert.equal(verified, 1); assert.deepEqual(value.input.map(request => request.action), ['prepare-send', 'commit']);
    assert.deepEqual(value.signals, ['SIGTERM']); assert.equal(value.context.draftSafe, true);
    assert.equal(value.bridge._manualInputBlocked, false); assert.equal(value.cleanup[0].draftCleanup, draftCleanup);
    assert.equal(value.memory.closed, 1);
  }
});

test('a late prepared message after cancellation never starts verification or sends commit', async () => {
  const value = controlledFixture({
    onPrepare: value => value.controller.abort(),
    onKill: ({ child }) => queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ stage: 'prepared', account: 'a', contact: 'b', revision: 'r' }) + '\n');
      child.stdout.write(JSON.stringify({ status: 'stale', draftCleanup: 'not-needed' }) + '\n');
      child.emit('close', 0);
    }),
  });
  assert.deepEqual(await preparedSend(value.bridge, { account: 'a', contact: 'b' }, '测试内容', value.context,
    async () => assert.fail('Cancelled preparation must not verify')), { status: 'stale' });
  assert.equal(value.input.length, 1); assert.equal(value.context.delivery.started, false);
  assert.equal(value.cleanup.length, 0); assert.equal(value.memory.closed, 1);
});

test('invalid, excessive or duplicate output cannot retain an earlier safe cleanup report', async () => {
  const safe = JSON.stringify({ status: 'uncertain', draftCleanup: 'not-needed' }) + '\n';
  for (const output of [safe + 'bad-json\n', safe + safe, safe + 'x'.repeat(400001), safe + '{',
    JSON.stringify({ stage: 'unknown', status: 'uncertain', draftCleanup: 'not-needed' }) + '\n',
    JSON.stringify({ draftCleanup: 'not-needed' }) + '\n', '']) {
    const value = controlledFixture({
      onCommit: value => value.controller.abort(),
      onKill: ({ child }) => queueMicrotask(() => { child.stdout.write(output); child.emit('close', 0); }),
    });
    assert.equal((await preparedSend(value.bridge, { account: 'a', contact: 'b' }, '测试内容', value.context, async () => true)).status, 'uncertain');
    assert.equal(value.context.draftSafe, false); assert.equal(value.bridge._manualInputBlocked, true);
    assert.deepEqual(value.cleanup, [undefined]); assert.equal(value.memory.closed, 1);
    assert.deepEqual(value.input.map(request => request.action), ['prepare-send', 'commit']);
  }
});

test('protocol corruption before cancellation also revokes an already parsed cleanup report', async () => {
  const safe = JSON.stringify({ status: 'submitted', draftCleanup: 'not-needed' }) + '\n';
  for (const bad of ['not-json\n', safe, 'x'.repeat(400001)]) {
    const value = controlledFixture({
      onCommit: ({ child }) => queueMicrotask(() => child.stdout.write(safe + bad)),
      onKill: ({ child }) => queueMicrotask(() => child.emit('close', 0)),
    });
    assert.equal((await preparedSend(value.bridge, { account: 'a', contact: 'b' }, '测试内容', value.context, async () => true)).status, 'uncertain');
    assert.equal(value.bridge._manualInputBlocked, true); assert.deepEqual(value.cleanup, [undefined]);
    assert.equal(value.memory.closed, 1);
  }
});

test('SIGKILL escalation cannot use a cleanup report emitted before process termination', async () => {
  const value = controlledFixture({
    onCommit: value => value.controller.abort(),
    onKill: ({ child }, signal) => {
      if (signal === 'SIGTERM') child.stdout.write(JSON.stringify({ status: 'uncertain', draftCleanup: 'not-needed' }) + '\n');
      else queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    },
  });
  assert.equal((await preparedSend(value.bridge, { account: 'a', contact: 'b' }, '测试内容', value.context, async () => true)).status, 'uncertain');
  assert.deepEqual(value.signals, ['SIGTERM', 'SIGKILL']); assert.equal(value.bridge._manualInputBlocked, true);
  assert.deepEqual(value.cleanup, [undefined]); assert.equal(value.memory.closed, 1);
});
