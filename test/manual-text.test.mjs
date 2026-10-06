import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pasteManualText } from '../server/manual-text.mjs';

function fixture() {
  const process = { pid: 123 };
  const runtime = { status: 'running', processes: [{ name: 'wechat', process }], runtimeRoot: '/runtime', appRoot: '/app', desktopEnv: { DISPLAY: ':99' } };
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = text => { child.input = text; }; child.kill = () => {};
  const spawnProcess = () => child;
  return { runtime, process, child, spawnProcess };
}

test('native text paste waits for verified completion and sends only the provided text to its private input', async () => {
  const f = fixture(); let complete = false;
  const result = pasteManualText(f.runtime, '中文😀', f).then(value => { complete = true; return value; });
  f.child.stdout.emit('data', '{"ready":true}'); await Promise.resolve();
  assert.equal(complete, false); assert.equal(f.child.input, '中文😀');
  f.child.emit('close', 0); assert.deepEqual(await result, { ready: true, pasteRequired: false });
});

test('a native failure or changed instance cannot report a successful paste', async () => {
  for (const changed of [false, true]) {
    const f = fixture(); const result = pasteManualText(f.runtime, '中文😀', f);
    if (changed) f.runtime.processes = [{ name: 'wechat', process: { pid: 456 } }];
    f.child.stdout.emit('data', changed ? '{"ready":true}' : '{"ready":false}'); f.child.emit('close', changed ? 0 : 1);
    await assert.rejects(result);
  }
});
