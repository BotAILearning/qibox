import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { displayReady, relocateXvfb, prepareXvfb } from '../server/x11.mjs';

const child = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdio: [null, null, null, new PassThrough()] });
test('X11 readiness uses the selected display and releases listeners', async () => {
  const process = child(), ready = displayReady(process);
  process.stdio[3].write('12'); process.stdio[3].write('3\n');
  assert.equal(await ready, ':123');
  assert.equal(process.listenerCount('exit'), 0);
  assert.equal(process.stdio[3].listenerCount('data'), 0);
});
test('X11 rejects malformed readiness, crashes and silent startup', async () => {
  for (const reply of ['-1\n', '65536\n', '1\n2\n', 'x', '12345678901234567']) {
    const process = child(), ready = displayReady(process); process.stdio[3].write(reply);
    await assert.rejects(ready, /Invalid/);
  }
  const process = child(), crashed = displayReady(process); process.emit('exit', null, 'SIGSEGV');
  await assert.rejects(crashed, /SIGSEGV/);
  await assert.rejects(displayReady(child(), 5), /timed out/);
});
test('Xvfb relocation rejects changed executables and verifies the complete output', () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const original = Buffer.from('binary /tmp/ resource'), final = Buffer.from('binary ./\0\0\0 resource');
  const recipe = { sourceSha256: hash(original), sha256: hash(final), patches: [{ offset: 7, before: Buffer.from('/tmp/').toString('hex'), after: Buffer.from('./\0\0\0').toString('hex') }] };
  assert.deepEqual(relocateXvfb(original, recipe), final);
  assert.deepEqual(relocateXvfb(final, recipe), final);
  assert.throws(() => relocateXvfb(Buffer.from('changed executable'), recipe), /Unrecognized/);
  assert.throws(() => relocateXvfb(original, { ...recipe, sha256: hash('wrong output') }), /verification/);
  assert.equal(original.toString(), 'binary /tmp/ resource');
});
test('concurrent instance preparation publishes one complete Xvfb without temporary leftovers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qibox-x11-'));
  try {
    const original = Buffer.from('binary /tmp/ resource'), final = Buffer.from('binary ./\0\0\0 resource');
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const recipe = { sourceSha256: hash(original), sha256: hash(final), patches: [{ offset: 7, before: Buffer.from('/tmp/').toString('hex'), after: Buffer.from('./\0\0\0').toString('hex') }] };
    await mkdir(path.join(root, 'config')); await mkdir(path.join(root, 'usr/bin'), { recursive: true });
    await writeFile(path.join(root, 'config/xvfb-relocations.json'), JSON.stringify({ [process.arch]: recipe }));
    await writeFile(path.join(root, 'usr/bin/Xvfb'), original);
    const results = await Promise.all(Array.from({ length: 8 }, () => prepareXvfb(root, root)));
    assert.equal(new Set(results).size, 1);
    assert.deepEqual(await readFile(results[0]), final);
    assert.deepEqual(await readFile(path.join(root, 'usr/bin/Xvfb')), original);
    assert.deepEqual((await readdir(path.join(root, 'usr/bin'))).sort(), ['Xvfb', 'Xvfb-qibox']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
