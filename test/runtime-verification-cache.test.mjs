import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { verificationCacheKey, loadVerificationCache, saveVerificationCache } from '../server/runtime-verification-cache.mjs';

test('verification proof is bound to resources, architecture, age, complete authentication and private key', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qibox-verification-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await verificationCacheKey(dir), file = path.join(dir, 'component'), value = { signature: '1:2:3:4:5:6:7', sha256: 'a'.repeat(64) };
  const hashes = new Map([[file, value]]), resolved = new Map([[file, { canonical: file, signature: value.signature }]]);
  await saveVerificationCache(dir, key, 'identity', 'x64', hashes, resolved);
  assert.deepEqual((await loadVerificationCache(dir, key, 'identity', 'x64')).hashes, [...hashes]);
  for (const [identity, arch] of [['different', 'x64'], ['identity', 'arm64']]) assert.deepEqual((await loadVerificationCache(dir, key, identity, arch)).hashes, []);
  assert.deepEqual((await loadVerificationCache(dir, Buffer.alloc(32), 'identity', 'x64')).hashes, []);
  const cache = path.join(dir, 'verification.json'), saved = JSON.parse(await readFile(cache));
  saved.body.at = Date.now() - 24 * 60 * 60 * 1000 - 1000;
  saved.mac = createHmac('sha256', key).update(JSON.stringify(saved.body)).digest('hex');
  await writeFile(cache, JSON.stringify(saved), { mode: 0o600 });
  assert.deepEqual((await loadVerificationCache(dir, key, 'identity', 'x64')).hashes, [], 'expired authentic proof requires fresh hashing');
});

test('symlinked verification keys cannot borrow another private key', { skip: process.platform !== 'linux' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qibox-verification-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const elsewhere = path.join(dir, 'unrelated.key'); await writeFile(elsewhere, Buffer.alloc(32), { mode: 0o600 }); await symlink(elsewhere, path.join(dir, 'verification.key'));
  assert.equal(await verificationCacheKey(dir), null);
  assert.deepEqual(await readFile(elsewhere), Buffer.alloc(32));
});
