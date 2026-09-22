import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AutoLoginVerifier, AUTO_LOGIN_PACKAGE, loginFingerprint } from '../server/auto-login.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture() {
  const root = await temp(), home = path.join(root, 'home');
  const files = ['all_users/config/global_config', 'all_users/config/global_config.crc', 'wxid_test_1234/config/login_configv2', 'wxid_test_1234/config/login_configv2.crc'];
  for (const file of files) { const p = path.join(home, 'xwechat_files', file); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, `synthetic opaque bytes ${file}`); }
  let now = 400000, observation = { status: 'ready', reason: 'native-login-method', accountKey: 'a'.repeat(64) }, installed = { sha256: AUTO_LOGIN_PACKAGE }, calls = [];
  const options = { dataRoot: root, device: async () => 'd'.repeat(64), home: async () => home, application: () => installed, now: () => now,
    probe: async value => { calls.push(value); if (observation instanceof Error) throw observation; return observation; } };
  return { root, home, options, get calls() { return calls; }, set observation(v) { observation = v; }, set installed(v) { installed = v; }, advance(ms) { now += ms; },
    change: () => writeFile(path.join(home, 'xwechat_files', files[2]), 'changed synthetic login configuration'),
    verifier: new AutoLoginVerifier(options) };
}
const running = { running: true, stopped: false, navigate: true };

test('qualification belongs to the observed account, device and profile, never all accounts on a NAS', async () => {
  const a = await fixture(), b = await fixture();
  try {
    await a.verifier.inspect(running);
    b.observation = { status: 'unavailable', reason: 'native-login-method', accountKey: 'b'.repeat(64) };
    assert.equal((await b.verifier.inspect(running)).status, 'unavailable');
    assert.equal(a.verifier.evidence.accountKey, 'a'.repeat(64));
    // Switching the current account in the same profile must revoke A's proof,
    // even when a test deliberately leaves every config byte unchanged.
    a.observation = { status: 'unavailable', reason: 'native-login-method', accountKey: 'b'.repeat(64) };
    assert.equal((await a.verifier.inspect(running)).status, 'unavailable');
    assert.equal(a.verifier.evidence, null);
    a.observation = { status: 'ready', reason: 'native-login-method', accountKey: 'b'.repeat(64) };
    assert.equal((await a.verifier.inspect(running)).status, 'ready');
    assert.equal(a.verifier.evidence.accountKey, 'b'.repeat(64));
    assert.equal(b.verifier.evidence, null);
    await a.verifier.stopped();
    const saved = await readFile(a.verifier.file, 'utf8');
    assert.equal((await new AutoLoginVerifier({ ...a.options, device: async () => 'e'.repeat(64) }).inspect({ stopped: true })).status, 'unknown');
    // Copy the exact profile and proof onto another instance on the same NAS.
    await writeFile(b.verifier.file, saved);
    assert.equal((await new AutoLoginVerifier(b.options).inspect({ stopped: true })).status, 'unknown');
    // The same account on the new device needs its own native qualification.
    const migrated = new AutoLoginVerifier({ ...a.options, device: async () => 'e'.repeat(64) });
    assert.equal((await migrated.inspect(running)).status, 'ready');
    assert.equal(migrated.evidence.deviceKey, 'e'.repeat(64));
  } finally { await cleanup(a.root); await cleanup(b.root); }
});

test('seven elapsed days, identity-free reports, old device-wide proof and expired observations do not unlock', async () => {
  const f = await fixture();
  try {
    f.observation = { status: 'unavailable', reason: 'native-login-method', accountKey: 'a'.repeat(64) };
    f.advance(7 * 86400000);
    assert.equal((await f.verifier.inspect(running)).status, 'unavailable');
    f.observation = { status: 'ready', reason: 'native-login-method' };
    assert.equal((await f.verifier.inspect(running)).status, 'unknown');
    await writeFile(f.verifier.file, JSON.stringify({ format: 1, cleanStop: true, package: AUTO_LOGIN_PACKAGE, fingerprint: await loginFingerprint(f.home) }));
    assert.equal((await new AutoLoginVerifier(f.options).inspect({ stopped: true })).status, 'unknown');
    f.observation = { status: 'ready', reason: 'native-login-method', accountKey: 'a'.repeat(64) };
    await f.verifier.inspect(running); f.advance(300001);
    f.observation = { status: 'unknown', reason: 'settings-closed' };
    assert.equal((await f.verifier.inspect({ ...running, navigate: false })).status, 'unknown');
    assert.equal((await new AutoLoginVerifier({ ...f.options, device: async () => { throw new Error(); } }).inspect(running)).status, 'unknown');
  } finally { await cleanup(f.root); }
});

test('native selection proof is package-bound and invalidated by changed account configuration', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.verifier.inspect(running)).status, 'ready');
    assert.equal(f.calls[0].navigate, true);
    f.observation = { status: 'unknown', reason: 'settings-closed' };
    assert.equal((await f.verifier.inspect({ ...running, navigate: false })).status, 'ready');
    assert.equal(f.calls[1].navigate, false);
    await f.change();
    assert.equal((await f.verifier.inspect(running)).status, 'unknown');
    f.observation = { status: 'ready', reason: 'native-login-method', accountKey: 'a'.repeat(64) };
    assert.equal((await f.verifier.inspect(running)).status, 'ready');
    f.installed = { sha256: 'f'.repeat(64) };
    assert.equal((await f.verifier.inspect(running)).status, 'unknown');
  } finally { await cleanup(f.root); }
});

test('only clean stopped evidence survives restart; launch and failures require a new observation', async () => {
  const f = await fixture();
  try {
    await f.verifier.inspect(running);
    assert.equal((await new AutoLoginVerifier(f.options).inspect({ stopped: true })).status, 'unknown');
    await f.verifier.stopped();
    const fresh = new AutoLoginVerifier(f.options);
    assert.equal((await fresh.inspect({ stopped: true })).status, 'ready');
    await fresh.started();
    f.observation = { status: 'unknown', reason: 'settings-closed' };
    assert.equal((await fresh.inspect(running)).status, 'unknown');
    f.observation = { status: 'ready', reason: 'native-login-method', accountKey: 'a'.repeat(64) };
    await fresh.inspect(running);
    f.observation = new Error('probe failed');
    assert.equal((await fresh.inspect(running)).status, 'unknown');
    assert.equal(JSON.parse(await readFile(fresh.file, 'utf8')), null);
  } finally { await cleanup(f.root); }
});

test('disabled native choice, malformed evidence, changed shutdown files and arbitrary ready reports stay closed', async () => {
  const f = await fixture();
  try {
    for (const observation of [{ status: 'ready', reason: 'process-running' }, { status: 'unavailable', reason: 'native-login-method' }, { status: 'unknown', reason: 'inspection-failed' }]) {
      f.observation = observation;
      assert.notEqual((await f.verifier.inspect(running)).status, 'ready');
    }
    f.observation = { status: 'ready', reason: 'native-login-method', accountKey: 'a'.repeat(64) };
    await f.verifier.inspect(running); await f.change(); await f.verifier.stopped();
    assert.equal((await f.verifier.inspect({ stopped: true })).status, 'unknown');
    await writeFile(f.verifier.file, JSON.stringify({ autoLoginReady: true, cleanStop: true }));
    assert.equal((await new AutoLoginVerifier(f.options).inspect({ stopped: true })).status, 'unknown');
    await assert.rejects(loginFingerprint(path.join(f.root, 'missing')));
  } finally { await cleanup(f.root); }
});

test('background settings navigation is throttled, while visible native settings remain observable', async () => {
  const f = await fixture();
  try {
    await f.verifier.inspect(running);
    await f.verifier.inspect(running);
    f.advance(300000);
    await f.verifier.inspect({ ...running, navigate: false });
    await f.verifier.inspect(running);
    assert.deepEqual(f.calls.map(x => x.navigate), [true, false, false, true]);
  } finally { await cleanup(f.root); }
});

test('native inspection binds its result after WeChat persists settings-window changes', async () => {
  const f = await fixture();
  try {
    const verifier = new AutoLoginVerifier({ ...f.options, probe: async () => { await f.change(); return { status: 'ready', reason: 'native-login-method', accountKey: 'a'.repeat(64) }; } });
    assert.equal((await verifier.inspect(running)).status, 'ready');
    assert.equal(verifier.evidence.fingerprint, await loginFingerprint(f.home));
  } finally { await cleanup(f.root); }
});

test('explicit recheck bypasses background throttle but never the desktop navigation guard', async () => {
  const f = await fixture();
  try {
    await f.verifier.inspect(running);
    await f.verifier.inspect(running);
    await f.verifier.inspect({ ...running, requested: true });
    await f.verifier.inspect({ ...running, requested: true, navigate: false });
    assert.deepEqual(f.calls.map(x => x.navigate), [true, false, true, false]);
  } finally { await cleanup(f.root); }
});
