import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeIdentity } from '../server/native-identity.mjs';

test('missing system accounts use only the real app UID and private profile', async () => {
  const session = await mkdtemp(path.join(os.tmpdir(), 'qibox-identity-'));
  try {
    const options = { session, home: '/data/private/home', runtimeRoot: '/runtime', uid: 100000, gid: 1007,
      lookup: () => { throw Object.assign(new Error('unknown account'), { code: 'ERR_SYSTEM_ERROR' }); } };
    const env = await nativeIdentity(options);
    assert.equal(await readFile(env.NSS_WRAPPER_PASSWD, 'utf8'), 'qibox:x:100000:1007::/data/private/home:/bin/false\n');
    assert.equal(await readFile(env.NSS_WRAPPER_GROUP, 'utf8'), 'qibox:x:1007:\n');
    assert.ok(env.LD_PRELOAD.endsWith('libnss_wrapper.so'));
    await assert.rejects(nativeIdentity({ ...options, uid: 0 }), /Invalid/);
    await assert.rejects(nativeIdentity({ ...options, home: '/home/x\nroot:x:0:0:' }), /Invalid/);
    assert.deepEqual(await nativeIdentity({ ...options, lookup: () => ({ username: 'existing' }) }), {});
  } finally { await rm(session, { recursive: true, force: true }); }
});
