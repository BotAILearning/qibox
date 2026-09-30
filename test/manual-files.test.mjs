import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { prepareManualFiles } from '../server/manual-files.mjs';

function fixture({ ready = true, changed = false, reason } = {}) {
  const done = Promise.withResolvers(), child = new EventEmitter();
  done.promise.catch(() => {});
  child.stdout = new PassThrough(); child.kill = () => {};
  let closed = 0, armed = 0, cancelled = false;
  const process = { pid: 1234 };
  const runtime = { status: 'running', processes: [{ name: 'wechat', process }], runtimeRoot: '/private/runtime', appRoot: '/private/app', desktopEnv: { DISPLAY: ':47' },
    fileChooser: { armLocalFiles(files, { signal }) {
      armed++; signal.addEventListener('abort', () => { cancelled = true; });
      return { done: done.promise, close: async () => { closed++; } };
    } } };
  const spawnProcess = (executable, args, options) => {
    assert.equal(args.at(-1), '1234'); assert.equal(options.env.DISPLAY, ':47');
    queueMicrotask(() => {
      if (changed) runtime.processes = [{ name: 'wechat', process: { pid: 1234 } }];
      child.stdout.write(JSON.stringify({ ready, reason })); child.emit('close', 0);
      if (ready) done.resolve();
    }); return child;
  };
  return { runtime, spawnProcess, state: () => ({ closed, armed, cancelled }) };
}
const files = [{ name: '资料.txt', type: 'text/plain', data: Buffer.from('exact bytes').toString('base64') }];

test('manual paste prepares a native file picker and never requests another clipboard paste', async () => {
  const { runtime, spawnProcess, state } = fixture();
  assert.deepEqual(await prepareManualFiles(runtime, files, { spawnProcess }), { ready: true, pasteRequired: false });
  assert.deepEqual(state(), { closed: 1, armed: 1, cancelled: true });
});
test('focus rejection and runtime replacement release the owned lease without acknowledging a paste', async () => {
  for (const options of [{ ready: false }, { changed: true }]) {
    const { runtime, spawnProcess, state } = fixture(options);
    await assert.rejects(prepareManualFiles(runtime, files, { spawnProcess }), /输入框|断开/);
    assert.deepEqual(state(), { closed: 1, armed: 1, cancelled: true });
  }
});
test('invalid files fail before a native picker can be armed or opened', async () => {
  const { runtime, spawnProcess, state } = fixture();
  await assert.rejects(prepareManualFiles(runtime, [{ ...files[0], name: '../other' }], { spawnProcess }), /文件名称/);
  assert.equal(state().armed, 0);
});

test('a successful upload without a native attachment is reported as an unconfirmed paste', async () => {
  const { runtime, spawnProcess, state } = fixture({ ready: false, reason: 'preview' });
  await assert.rejects(prepareManualFiles(runtime, files, { spawnProcess }), /没有全部进入微信/);
  assert.deepEqual(state(), { closed: 1, armed: 1, cancelled: true });
});
