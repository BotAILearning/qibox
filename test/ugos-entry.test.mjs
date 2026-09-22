import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { prepareNativeEnvironment } from '../server/ugos-entry.mjs';

test('UGOS environment keeps the real nonroot identity and stable device ID', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qibox-native-'));
  try {
    await mkdir(path.join(root, 'etc')); await writeFile(path.join(root, 'etc/resolv.conf'), 'nameserver 127.0.0.53\n');
    const options = { cacheRoot: root, dataRoot: '/application/data', uid: 1234, gid: 6789, identity: async () => 'a'.repeat(64), systemRoot: root };
    const first = await prepareNativeEnvironment(options), second = await prepareNativeEnvironment(options);
    assert.notEqual(first, second);
    assert.equal(await readFile(path.join(first, 'etc/passwd'), 'utf8'), 'qibox:x:1234:6789::/application/data:/bin/false\n');
    assert.equal(await readFile(path.join(first, 'etc/machine-id'), 'utf8'), await readFile(path.join(second, 'etc/machine-id'), 'utf8'));
    assert.equal(await readlink(path.join(first, 'usr/share/X11/xkb')), '/application/data/runtime/usr/share/X11/xkb');
    assert.equal(await readFile(path.join(first, 'etc/resolv.conf'), 'utf8'), 'nameserver 127.0.0.53\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('UGOS bootstrap rejects root and cleans partially prepared environments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qibox-native-'));
  try {
    const options = { cacheRoot: root, dataRoot: root, uid: 0, gid: 0 };
    // Windows paths contain a colon and are never valid target UGOS paths.
    await assert.rejects(prepareNativeEnvironment(options));
    if (process.platform === 'linux') {
      await assert.rejects(prepareNativeEnvironment({ ...options, uid: 1234, identity: async () => { throw new Error('Missing identity'); } }), /Missing identity/);
    }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
