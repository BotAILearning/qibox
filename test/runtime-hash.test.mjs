import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { hashRuntimeFile } from '../server/runtime-hash.mjs';

test('bounded runtime hashing handles concurrent files, a failed read and subsequent work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qibox-runtime-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0xa7), expected = createHash('sha256').update(bytes).digest('hex');
  const files = Array.from({ length: 5 }, (_, i) => path.join(root, `${i}.bin`));
  await Promise.all(files.map(file => writeFile(file, bytes)));
  assert.deepEqual(await Promise.all(files.map(hashRuntimeFile)), files.map(() => expected));
  await assert.rejects(hashRuntimeFile(path.join(root, 'missing')));
  assert.equal(await hashRuntimeFile(files[0]), expected);
});
