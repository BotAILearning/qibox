import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { attachRuntimeLog } from '../server/runtime-log.mjs';
import { Runtime } from '../server/runtime.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('a child keeps draining and exits when its log directory becomes unavailable', async () => {
  const directory = await temp(); let child;
  try {
    const runtime = new Runtime({ appRoot: directory, dataRoot: directory, dev: true, store: {} });
    child = runtime.child(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(2 * 1024 * 1024)); process.stderr.write(Buffer.alloc(2 * 1024 * 1024));'],
      { ...process.env, HOME: directory }, 'wechat', directory);
    const [code] = await once(child, 'close', { signal: AbortSignal.timeout(5000) });
    assert.equal(code, 0);
    assert.equal(runtime.lastError, 'wechat: runtime log unavailable (ENOENT)');
  } finally { child?.kill(); await cleanup(directory); }
});

test('a full log volume reports only its error and retains no child output', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const disk = new Writable({ write(bytes, encoding, callback) { callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' })); } });
  const errors = [];
  attachRuntimeLog(child, disk, error => errors.push(error.code));
  const closed = new Promise(resolve => disk.once('close', resolve));
  child.stdout.write('private child diagnostic');
  await closed;
  let drained = 0; child.stdout.on('data', bytes => { drained += bytes.length; }); child.stderr.on('data', bytes => { drained += bytes.length; });
  child.stdout.end(Buffer.alloc(1024)); child.stderr.end(Buffer.alloc(1024));
  assert.deepEqual(errors, ['ENOSPC']); assert.equal(drained, 2048);
  child.emit('close', 0);
});

test('healthy child logging still saves both output streams and closes the file', async () => {
  const directory = await temp(); let child;
  try {
    const file = path.join(directory, 'wechat.log'), stream = createWriteStream(file, { mode: 0o600 });
    child = spawn(process.execPath, ['-e', 'process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n");'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(stream, 'close'), errors = [];
    attachRuntimeLog(child, stream, error => errors.push(error));
    const [code] = await once(child, 'close', { signal: AbortSignal.timeout(5000) }); await closed;
    assert.equal(code, 0); assert.deepEqual(errors, []);
    const log = await readFile(file, 'utf8'); assert.ok(log.includes('stdout\n')); assert.ok(log.includes('stderr\n'));
  } finally { child?.kill(); await cleanup(directory); }
});
