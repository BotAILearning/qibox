import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DataChatBridge } from '../server/ai-data.mjs';
import { DataWorker } from '../server/ai-data-worker.mjs';
import { key } from './ai-fixtures.mjs';

const account = key('account'), contact = key('contact');
function fixture() {
  const runtime = { status: 'running', desktopEnv: { HOME: '/private/profile' }, runtimeRoot: '/runtime', appRoot: '/app', processes: [{ name: 'wechat', process: { pid: 123 } }] };
  const root = '/private/profile/xwechat_files/wxid_first_abcd/db_storage';
  const children = [], requests = [], descriptors = [];
  const options = {
    resolveAccountRoot: async () => root,
    async openMemory(file, flags) {
      assert.equal(flags, 'r');
      const descriptor = { fd: 55, file, closed: false, async close() { this.closed = true; } }; descriptors.push(descriptor); return descriptor;
    },
    spawnProcess(bin, args, options) {
      assert.equal(options.stdio[3], 55); assert.equal(options.stdio[2], 'ignore');
      assert.equal(options.env.QIBOX_ACCOUNT_ROOT, root);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
      child.stdin.on('data', chunk => {
        const request = JSON.parse(chunk.toString()); requests.push(request);
        const result = request.action === 'contacts' ? { available: true, account, contacts: [{ id: contact, label: '对象', kind: 'person', native: { account, contact } }] }
          : { account, contact, revision: key('revision'), messages: [], label: '对象', native: { account, contact } };
        queueMicrotask(() => child.stdout.write(JSON.stringify(result) + '\n'));
      });
      children.push(child); return child;
    },
  };
  return { runtime, options, children, requests, descriptors };
}

test('reuses the owned reader across requests and rescans, closes it on context clearing or shutdown', async () => {
  const { runtime, options, children, descriptors } = fixture(), bridge = new DataChatBridge(runtime, options);
  await bridge.scan(); await bridge.read({ account, contact }); await bridge.scan(); await bridge.read({ account, contact });
  assert.equal(children.length, 1); assert.equal(descriptors[0].closed, false);
  bridge.clearContext(); await bridge.scan(); assert.equal(children.length, 2);
  assert.equal(descriptors[0].closed, true);
  await bridge.close(); assert.equal(descriptors[1].closed, true);
});

test('a new process object even with the same PID never inherits the old worker', async () => {
  const { runtime, options, children, descriptors } = fixture(), bridge = new DataChatBridge(runtime, options);
  await bridge.scan(); runtime.processes[0].process = { pid: 123 }; await bridge.scan();
  assert.equal(children.length, 2); assert.equal(descriptors[0].closed, true);
  await bridge.close();
});

test('a second login in the same process cannot reuse the previous account worker', async () => {
  const { runtime, options, children, requests } = fixture();
  let current = '/private/profile/xwechat_files/wxid_first_abcd/db_storage';
  options.resolveAccountRoot = async () => current;
  const bridge = new DataChatBridge(runtime, options);
  await bridge.scan();
  current = '/private/profile/xwechat_files/wxid_second_abcd/db_storage';
  await assert.rejects(bridge.read({ account, contact }), { code: 'ai_account_changed' });
  assert.equal(requests.filter(x => x.action === 'read').length, 0);
  assert.equal(children.length, 1);
  await bridge.close();
});

test('abort while opening memory prevents process launch and waits for descriptor cleanup', async () => {
  const { runtime, options, children, descriptors } = fixture();
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), open = options.openMemory;
  options.openMemory = async (...args) => { entered.resolve(); await gate.promise; return open(...args); };
  const worker = new DataWorker(runtime, { pid: 123 }, options), controller = new AbortController();
  const rejected = assert.rejects(worker.request({ action: 'contacts' }, controller.signal), { name: 'AbortError' });
  await entered.promise; controller.abort(); gate.resolve(); await rejected;
  assert.equal(children.length, 0); assert.equal(descriptors[0].closed, true);
});

// Answers only when the test asks for one, and aborts like the real worker does
// for SIGUSR1: the cancelled request still reports back and the process stays.
function gated() {
  const base = fixture(), spawn = base.options.spawnProcess;
  base.options.spawnProcess = (bin, args, options) => {
    const child = spawn(bin, args, options);
    child.stdin.removeAllListeners('data');
    child.stdin.on('data', chunk => base.requests.push(JSON.parse(chunk.toString())));
    child.kill = signal => {
      if (signal === 'SIGUSR1') { queueMicrotask(() => child.stdout.write(JSON.stringify({ error: 'data-unavailable', stage: 'timeout' }) + '\n')); return true; }
      queueMicrotask(() => child.emit('close', 0)); return true;
    };
    return child;
  };
  const reply = value => queueMicrotask(() => base.children.at(-1).stdout.write(JSON.stringify(value) + '\n'));
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  return { ...base, reply, tick };
}

test('an account switch while reading discards the old account result', async () => {
  const { runtime, options, requests, reply, tick } = gated();
  let current = '/private/profile/xwechat_files/wxid_first_abcd/db_storage';
  options.resolveAccountRoot = async () => current;
  const bridge = new DataChatBridge(runtime, options);
  const scanned = bridge.scan(); await tick();
  reply({ available: true, account, contacts: [{ id: contact, label: '对象', kind: 'person', native: { account, contact } }] });
  await scanned;
  const reading = bridge.read({ account, contact }); await tick();
  assert.equal(requests.filter(x => x.action === 'read').length, 1);
  current = '/private/profile/xwechat_files/wxid_second_abcd/db_storage';
  reply({ account, contact, revision: key('revision'), messages: [], label: '对象', native: { account, contact } });
  await assert.rejects(reading, { code: 'ai_account_changed' });
  await bridge.close();
});

test('malformed or extra output kills a worker before any response can be reused', async () => {
  for (const output of ['not-json\n', '{}\n{}\n']) {
    const { runtime, options, children, descriptors } = fixture();
    const spawn = options.spawnProcess;
    options.spawnProcess = (...args) => { const child = spawn(...args); child.stdin.removeAllListeners('data'); child.stdin.on('data', () => queueMicrotask(() => child.stdout.write(output))); return child; };
    const worker = new DataWorker(runtime, { pid: 123 }, options);
    await assert.rejects(worker.request({ action: 'contacts' }), { code: 'ai_data_unavailable' });
    assert.equal(children.length, 1); assert.equal(descriptors[0].closed, true);
  }
});

test('cancelling a request keeps the worker and its caches for the read that replaces it', async () => {
  const { runtime, options, children, requests, reply, tick } = gated(), bridge = new DataChatBridge(runtime, options);
  const scanned = bridge.scan(); await tick();
  reply({ available: true, account, contacts: [{ id: contact, label: '对象', kind: 'person', native: { account, contact } }] });
  await scanned;
  const controller = new AbortController();
  const cancelled = bridge.read({ account, contact, signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  // Same worker, no restart: the next read answers from the warm key/session.
  const next = bridge.read({ account, contact });
  await tick(); await tick();
  reply({ account, contact, revision: key('revision'), messages: [], label: '对象', native: { account, contact } });
  assert.deepEqual(await next, { account, contact, revision: key('revision'), messages: [] });
  assert.equal(children.length, 1); assert.equal(requests.filter(x => x.action === 'read').length, 2);
  await bridge.close();
});

test('a second cancellation while the worker is still flushing does not restart it', async () => {
  const { runtime, options, children, reply, tick } = gated(), bridge = new DataChatBridge(runtime, options);
  const scanned = bridge.scan(); await tick();
  reply({ available: true, account, contacts: [{ id: contact, label: '对象', kind: 'person', native: { account, contact } }] });
  await scanned;
  const controller = new AbortController(), second = new AbortController();
  const held = bridge.read({ account, contact, signal: controller.signal });
  await tick(); await tick();
  const queued = bridge.read({ account, contact, signal: second.signal });
  await tick(); await tick();
  controller.abort();
  await assert.rejects(held, { name: 'AbortError' });
  second.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(children.length, 1);
  await bridge.close();
});
