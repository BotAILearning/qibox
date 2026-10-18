import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, link, stat, rename, realpath, symlink, chmod } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { RuntimeResources, validateRuntimeManifest } from '../server/runtime-resources.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { failure = false, corrupt = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qibox-resource-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appRoot = path.join(dir, 'app'), dataRoot = path.join(dir, 'data');
  await mkdir(path.join(appRoot, 'payload/x64'), { recursive: true });
  await mkdir(path.join(appRoot, 'payload/resources'), { recursive: true });
  await mkdir(path.join(dataRoot, 'runtime'), { recursive: true });
  await writeFile(path.join(dataRoot, 'runtime/old'), 'known-good');
  const archive = Buffer.from('pinned-test-archive'), content = Buffer.from('complete new executable');
  const identity = 'a'.repeat(64), hash = sha(archive);
  const manifest = { format: 1, arch: 'x64', identity, files: { 'tool': { sha256: sha(content), size: content.length, resource: hash, mode: 0o755 } }, host: {}, unpackedBytes: content.length,
    resources: [{ id: hash, sha256: hash, version: identity, size: archive.length, file: `${hash}.tar.xz`, kind: 'private' }] };
  await writeFile(path.join(appRoot, 'payload/x64/runtime-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(appRoot, 'payload/x64/runtime-lock.json'), JSON.stringify({ platform: 'linux-x64' }));
  await writeFile(path.join(appRoot, 'payload/resources', `${hash}.tar.xz`), corrupt ? 'wrong-archive' : archive);
  let tested = false;
  const manager = new RuntimeResources({ appRoot, dataRoot, arch: 'x64',
    command: async (_, args) => {
      if (!args.includes('-C')) throw Error('Fixture exercises the tar fallback');
      const tool = path.join(args[args.indexOf('-C') + 1], 'tool');
      await writeFile(tool, content); await chmod(tool, 0o755);
    },
    selftest: async root => { tested = true; assert.equal(await readFile(path.join(root, 'tool'), 'utf8'), content.toString()); if (failure) throw Error('injected selftest failure'); } });
  await manager.init();
  return { manager, manifest, appRoot, dataRoot, tested: () => tested };
}
test('a staged verified environment switches only after selftest and retains previous runtime', async t => {
  const f = await fixture(t); f.manager.start(); f.manager.start(); await f.manager.working;
  assert.equal(f.manager.snapshot().status, 'ready'); assert.equal(f.tested(), true);
  assert.equal(await readFile(path.join(f.dataRoot, 'runtime.previous/old'), 'utf8'), 'known-good');
  assert.equal(await f.manager.currentValid(), true);
  await writeFile(path.join(f.dataRoot, 'runtime/tool'), 'tampered');
  assert.equal(await f.manager.currentValid(), false);
  await f.manager.inspect(); assert.notEqual(f.manager.snapshot().status, 'ready');
});
test('failed selftest never switches or erases the known-good runtime', async t => {
  const f = await fixture(t, { failure: true }); f.manager.start(); await f.manager.working;
  assert.equal(f.manager.snapshot().status, 'error');
  assert.match(f.manager.snapshot().error, /injected/);
  assert.equal(await readFile(path.join(f.dataRoot, 'runtime/old'), 'utf8'), 'known-good');
});

test('a symbolic link cannot impersonate a private hard-link alias', async t => {
  const f = await fixture(t);
  f.manager.manifest.inventory = { alias: ['1', 0o644, 0, 0, 'tool', 0, null] };
  f.manager.start(); await f.manager.working;
  assert.equal(await f.manager.currentValid(), true);
  const alias = path.join(f.manager.root, 'alias');
  await rm(alias);
  try { await symlink(path.join(f.manager.root, 'tool'), alias); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows file-symlink privilege unavailable; run on Linux'); return; } throw error; }
  assert.equal(await f.manager.currentValid(), false);
});

test('a partial resource retains verified existing files while repairing a missing file', async t => {
  const f = await fixture(t), kept = path.join(f.manager.root, 'kept');
  const raw = Buffer.from('verified existing component');
  await writeFile(kept, raw);
  f.manager.manifest.files.kept = { sha256: sha(raw), size: raw.length, mode: 0o644, resource: f.manifest.resources[0].id };
  const original = f.manager.command;
  f.manager.command = async (bin, args) => {
    if (args.includes('-C')) assert.deepEqual(await readFile(path.join(args[args.indexOf('-C') + 1], 'kept')), raw);
    return original(bin, args);
  };
  f.manager.start(); await f.manager.working;
  assert.equal(f.manager.snapshot().status, 'ready', f.manager.snapshot().error);
  assert.equal(f.manager.existingFiles.has('kept'), true);
  assert.equal(f.manager.existingResources.size, 0, 'one valid file cannot claim the complete archive');
  assert.deepEqual(await readFile(path.join(f.manager.root, 'kept')), raw);
});
test('missing or corrupted archives cannot enable a fake ready environment', async t => {
  const f = await fixture(t, { corrupt: true }); f.manager.start(); await f.manager.working;
  assert.equal(f.manager.snapshot().status, 'error'); assert.equal(f.tested(), false);
  assert.match(f.manager.snapshot().error, /离线/);
});
test('manifest rejects cross-architecture resources, unverified ARM reuse and traversal', async t => {
  const { manifest } = await fixture(t);
  assert.throws(() => validateRuntimeManifest(manifest, 'arm64'));
  assert.throws(() => validateRuntimeManifest({ ...manifest, files: { '../escape': manifest.files.tool } }, 'x64'));
  assert.throws(() => validateRuntimeManifest({ ...manifest, arch: 'arm64', host: { tool: { path: '/tool', sha256: 'b'.repeat(64), kind: 'tested-profile' } } }, 'arm64'));
});

test('adopting identical legacy runtime content refreshes the current lock fingerprint', async t => {
  const f = await fixture(t), root = path.join(f.dataRoot, 'runtime');
  await writeFile(path.join(root, 'tool'), 'complete new executable');
  await chmod(path.join(root, 'tool'), 0o755);
  const oldLock = { platform: 'linux-x64', sourceRevision: 'old' }, nextLock = { platform: 'linux-x64', sourceRevision: 'new' };
  await writeFile(path.join(f.appRoot, 'payload/x64/runtime-lock.json'), JSON.stringify(nextLock));
  await writeFile(path.join(root, 'ready.json'), JSON.stringify({ fingerprint: sha(Buffer.from(JSON.stringify(oldLock))), legacy: true }));
  const manager = new RuntimeResources({ appRoot: f.appRoot, dataRoot: f.dataRoot, arch: 'x64', command: f.manager.command, selftest: f.manager.selftest });
  await manager.init();
  const ready = JSON.parse(await readFile(path.join(root, 'ready.json'), 'utf8'));
  assert.equal(ready.resourceIdentity, f.manifest.identity);
  assert.equal(ready.fingerprint, sha(Buffer.from(JSON.stringify(nextLock))));
  assert.equal(manager.snapshot().status, 'ready');
});

test('hard-link targets use their fallback before the private archive is expanded', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qibox-hardlink-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const appRoot = path.join(dir, 'app'), dataRoot = path.join(dir, 'data'), payload = path.join(appRoot, 'payload/x64'), sharedResources = path.join(appRoot, 'payload/resources');
  await mkdir(sharedResources, { recursive: true }); await mkdir(payload, { recursive: true });
  const content = Buffer.from('hard-link target'), fallback = Buffer.from('fallback archive'), base = Buffer.from('private archive');
  const identity = 'b'.repeat(64), fallbackHash = sha(fallback), baseHash = sha(base);
  const target = 'usr/lib/example/tool';
  const manifest = { format: 1, arch: 'x64', identity, files: { [target]: { sha256: sha(content), size: content.length, resource: fallbackHash, mode: 0o644 } },
    host: { [target]: { path: `/${target}`, sha256: sha(content), kind: 'identical' } },
    inventory: { [target]: ['0', 0o644, 0, 0, '', content.length, sha(content)], 'usr/lib/example/tool-alias': ['1', 0o644, 0, 0, `./${target}`, 0, null] },
    unpackedBytes: content.length,
    resources: [
      { id: baseHash, sha256: baseHash, version: identity, size: base.length, file: `${baseHash}.tar.xz`, kind: 'private' },
      { id: fallbackHash, sha256: fallbackHash, version: identity, size: fallback.length, file: `${fallbackHash}.tar.xz`, kind: 'fallback' },
    ] };
  await writeFile(path.join(payload, 'runtime-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(payload, 'runtime-lock.json'), JSON.stringify({ platform: 'linux-x64' }));
  await writeFile(path.join(sharedResources, `${fallbackHash}.tar.xz`), fallback);
  await writeFile(path.join(sharedResources, `${baseHash}.tar.xz`), base);
  const commandOrder = [];
  const manager = new RuntimeResources({ appRoot, dataRoot, arch: 'x64',
    command: async (_bin, args) => {
      if (!args.includes('-C')) throw Error('Fixture exercises the tar fallback');
      const staging = args[args.indexOf('-C') + 1], archive = args[1]; commandOrder.push(path.basename(archive));
      if (archive.endsWith(`${fallbackHash}.tar.xz`)) { await mkdir(path.dirname(path.join(staging, target)), { recursive: true }); await writeFile(path.join(staging, target), content); }
      else await link(path.join(staging, target), path.join(staging, 'usr/lib/example/tool-alias'));
    },
    selftest: async root => assert.equal((await readFile(path.join(root, 'usr/lib/example/tool-alias'))).toString(), content.toString()) });
  await manager.init();
  assert.equal(await manager.hostMatches(target), false);
  manager.start(); await manager.working;
  assert.equal(manager.snapshot().status, 'ready', manager.snapshot().error);
  assert.deepEqual(commandOrder, [`${fallbackHash}.tar.xz`, `${baseHash}.tar.xz`]);
  const [targetInfo, aliasInfo] = await Promise.all([stat(path.join(dataRoot, 'runtime', target)), stat(path.join(dataRoot, 'runtime/usr/lib/example/tool-alias'))]);
  assert.equal(targetInfo.ino, aliasInfo.ino);
});

test('startup removes orphan import files and close aborts an in-flight import', async t => {
  const f = await fixture(t), cache = path.join(f.dataRoot, 'runtime-cache');
  const resource = f.manifest.resources[0];
  await writeFile(path.join(cache, `${resource.sha256}.import`), 'orphan');
  await writeFile(path.join(cache, 'offline.import'), 'orphan');
  const manager = new RuntimeResources({ appRoot: f.appRoot, dataRoot: f.dataRoot, arch: 'x64', command: f.manager.command, selftest: f.manager.selftest });
  await manager.init();
  await assert.rejects(access(path.join(cache, `${resource.sha256}.import`)));
  await assert.rejects(access(path.join(cache, 'offline.import')));
  let sent = false;
  const hanging = new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.from('x')); } } });
  const importing = manager.importResource(hanging, resource.size, resource.id);
  await manager.close();
  await assert.rejects(importing);
  await assert.rejects(access(path.join(cache, `${resource.id}.import`)));
  assert.equal(manager.importing, false);
});

test('restart restores previous runtime after interruption between the two commit renames', async t => {
  const f = await fixture(t), root = path.join(f.dataRoot, 'runtime'), previous = `${root}.previous`;
  await rm(root, { recursive: true, force: true });
  await mkdir(previous, { recursive: true });
  await writeFile(path.join(previous, 'tool'), 'complete new executable');
  await writeFile(path.join(previous, 'ready.json'), JSON.stringify({ resourceIdentity: 'c'.repeat(64), arch: 'x64', fingerprint: 'old' }));
  const reboot = new RuntimeResources({ appRoot: f.appRoot, dataRoot: f.dataRoot, arch: 'x64', command: f.manager.command, selftest: f.manager.selftest });
  await reboot.init();
  assert.equal(await readFile(path.join(root, 'tool'), 'utf8'), 'complete new executable');
  assert.equal((await readFile(path.join(root, 'ready.json'), 'utf8')).includes('"resourceIdentity":"' + 'c'.repeat(64) + '"'), true);
  assert.equal(await reboot.currentValid(), false, 'restored previous tree must not be labeled ready for the new manifest');
  assert.equal(reboot.snapshot().status, 'idle');
  await assert.rejects(access(previous));
});

async function legacySupplementFixture(t, { corruptOld = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qibox-legacy-supplement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appRoot = path.join(dir, 'app'), dataRoot = path.join(dir, 'data');
  const payload = path.join(appRoot, 'payload/x64'), bundled = path.join(appRoot, 'payload/resources'), root = path.join(dataRoot, 'runtime');
  await mkdir(payload, { recursive: true }); await mkdir(bundled, { recursive: true }); await mkdir(root, { recursive: true });

  const baseContent = Buffer.from('verified legacy base executable');
  const newContent = Buffer.from('tiny newly bundled helper');
  const baseArchive = Buffer.from('base archive deliberately not shipped');
  const tinyArchive = Buffer.from('small supplemental archive');
  const baseHash = sha(baseArchive), tinyHash = sha(tinyArchive), identity = 'd'.repeat(64);
  const manifest = {
    format: 1, arch: 'x64', identity,
    files: {
      'usr/bin/base-tool': { sha256: sha(baseContent), size: baseContent.length, resource: baseHash, mode: 0o755 },
      'usr/bin/new-helper': { sha256: sha(newContent), size: newContent.length, resource: tinyHash, mode: 0o755 },
    },
    host: {}, unpackedBytes: baseContent.length + newContent.length,
    resources: [
      { id: baseHash, sha256: baseHash, version: identity, size: baseArchive.length, file: `${baseHash}.tar.xz`, kind: 'private' },
      { id: tinyHash, sha256: tinyHash, version: identity, size: tinyArchive.length, file: `${tinyHash}.tar.xz`, kind: 'private' },
    ],
  };
  await writeFile(path.join(payload, 'runtime-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(payload, 'runtime-lock.json'), JSON.stringify({ platform: 'linux-x64', revision: 'new' }));
  await writeFile(path.join(bundled, `${tinyHash}.tar.xz`), tinyArchive);
  // This is an already installed legacy runtime: its original complete component
  // is present, but the new manifest's small supplement is not yet materialized.
  await mkdir(path.join(root, 'usr/bin'), { recursive: true });
  await writeFile(path.join(root, 'usr/bin/base-tool'), corruptOld ? Buffer.from('modified legacy file') : baseContent);
  await chmod(path.join(root, 'usr/bin/base-tool'), 0o755);
  await writeFile(path.join(root, 'ready.json'), JSON.stringify({ legacy: true, fingerprint: 'old-lock' }));

  const extracted = [];
  const manager = new RuntimeResources({ appRoot, dataRoot, arch: 'x64',
    command: async (_bin, args) => {
      if (!args.includes('-C')) throw Error('Fixture exercises the tar fallback');
      const archive = path.basename(args[1]), staging = args[args.indexOf('-C') + 1];
      extracted.push(archive);
      assert.equal(archive, `${tinyHash}.tar.xz`, 'only the newly bundled supplement should be extracted');
      const output = path.join(staging, 'usr/bin/new-helper');
      await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, newContent); await chmod(output, 0o755);
    },
    selftest: async stage => {
      assert.deepEqual(await readFile(path.join(stage, 'usr/bin/base-tool')), baseContent);
      assert.deepEqual(await readFile(path.join(stage, 'usr/bin/new-helper')), newContent);
    },
  });
  await manager.init();
  return { manager, manifest, dataRoot, extracted, baseHash, tinyHash, baseArchive, tinyArchive };
}

test('rebuilds from a verified legacy base plus one bundled supplement without downloading the base', async t => {
  const f = await legacySupplementFixture(t);
  assert.equal(f.manager.snapshot().details.missingResources, 1);
  assert.equal(f.manager.snapshot().total, f.tinyArchive.length);
  assert.equal(f.manager.snapshot().remaining, 0);
  f.manager.start(); await f.manager.working;
  assert.equal(f.manager.snapshot().status, 'ready', f.manager.snapshot().error);
  assert.equal(f.manager.snapshot().total, f.tinyArchive.length, 'the reusable base must not inflate preparation total');
  assert.deepEqual(f.extracted, [`${f.tinyHash}.tar.xz`]);
  assert.equal(await readFile(path.join(f.dataRoot, 'runtime/usr/bin/base-tool')).then(sha), sha(Buffer.from('verified legacy base executable')));
  assert.equal(await readFile(path.join(f.dataRoot, 'runtime/usr/bin/new-helper')).then(sha), sha(Buffer.from('tiny newly bundled helper')));
  assert.equal(JSON.parse(await readFile(path.join(f.dataRoot, 'runtime/ready.json'), 'utf8')).resourceIdentity, f.manifest.identity);
  assert.equal(await readFile(path.join(f.dataRoot, 'runtime.previous/ready.json'), 'utf8').then(text => text.includes('"legacy":true')), true);
  assert.equal(await readFile(path.join(f.dataRoot, 'runtime.previous/usr/bin/base-tool'), 'utf8'), 'verified legacy base executable');
});

test('a legacy file with the wrong hash is not reused as a cached resource', async t => {
  const f = await legacySupplementFixture(t, { corruptOld: true });
  assert.equal(f.manager.snapshot().details.missingResources, 2);
  assert.equal(f.manager.snapshot().remaining, f.baseArchive.length);
  assert.equal(f.manager.snapshot().total, f.baseArchive.length + f.tinyArchive.length);
  f.manager.start(); await f.manager.working;
  assert.equal(f.manager.snapshot().status, 'error');
  assert.match(f.manager.snapshot().error, /尚未配置|离线资源/);
  assert.deepEqual(f.extracted, [], 'preparation must stop before expanding the supplement when the base is invalid and unavailable');
  assert.equal(await readFile(path.join(f.dataRoot, 'runtime/usr/bin/base-tool'), 'utf8'), 'modified legacy file');
});

test('same-length in-place edits invalidate the verified hash cache', async t => {
  const f = await fixture(t); f.manager.start(); await f.manager.working;
  const tool = path.join(f.dataRoot, 'runtime/tool');
  assert.equal(await f.manager.currentValid(), true);
  const original = await readFile(tool);
  const replacement = Buffer.alloc(original.length, 0x58);
  await writeFile(tool, replacement);
  assert.equal((await stat(tool)).size, original.length);
  assert.equal(await f.manager.currentValid(), false, 'same-length content changes must be rehashed and rejected');
  await f.manager.inspect();
  assert.notEqual(f.manager.snapshot().status, 'ready', 'inspection must not preserve ready after detecting the changed content');
});

test('replacing a file inode forces a fresh hash even when its bytes are unchanged', async t => {
  const f = await fixture(t), tool = path.join(f.dataRoot, 'runtime-cache', 'cache-target');
  await mkdir(path.dirname(tool), { recursive: true });
  await writeFile(tool, 'unchanged bytes');
  let hashes = 0;
  f.manager.hash = async file => { hashes++; return sha(await readFile(file)); };
  const expected = await f.manager.verifiedHash(tool);
  const replacement = `${tool}.replacement`;
  await writeFile(replacement, 'unchanged bytes');
  await rm(tool);
  await rename(replacement, tool);
  assert.equal(await f.manager.verifiedHash(tool), expected);
  assert.equal(hashes, 2, 'a new inode must not reuse the previous canonical-path cache entry');
});

test('concurrent checks share one hash but reject a file changed during that hash', async t => {
  const f = await fixture(t); f.manager.start(); await f.manager.working;
  const tool = path.join(f.dataRoot, 'runtime/tool');
  f.manager.verifiedHashes.clear();
  let release;
  let signalStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  let hashes = 0;
  f.manager.hash = async file => {
    if (path.resolve(file) === tool) { hashes++; signalStarted(); await gate; }
    return sha(await readFile(file));
  };

  const first = f.manager.currentValid();
  await started;
  const second = f.manager.currentValid();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hashes, 1, 'overlapping checks should reuse the in-flight hash');
  const original = await readFile(tool);
  await writeFile(tool, Buffer.alloc(original.length, 0x59));
  release();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(hashes, 2, 'the unstable first read is discarded and the changed file is hashed again');
  const canonical = await realpath(tool);
  assert.equal(f.manager.verifiedHashes.get(canonical)?.sha256, sha(await readFile(tool)), 'only the stable replacement bytes may be cached');
  assert.notEqual(await f.manager.verifiedHash(tool), f.manifest.files.tool.sha256, 'the changed bytes never satisfy the manifest');
  assert.equal(hashes, 2, 'later checks may reuse only the newly verified signature');
});

test('complete runtime validation overlaps bounded reads and settles all work before rejecting corruption', async t => {
  const f = await fixture(t); f.manager.start(); await f.manager.working;
  for (let i = 0; i < 40; i++) {
    const name = `parallel-${i}`, bytes = Buffer.from(`required component ${i}`);
    await writeFile(path.join(f.dataRoot, 'runtime', name), bytes);
    f.manifest.files[name] = { size: bytes.length, sha256: sha(bytes), mode: 0o644 };
  }
  f.manager.manifest.files = f.manifest.files;
  let active = 0, peak = 0;
  f.manager.hash = async file => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 5)); return sha(await readFile(file)); }
    finally { active--; }
  };
  f.manager.verifiedHashes.clear();
  assert.equal(await f.manager.currentValid(), true);
  assert.ok(peak > 1 && peak <= 16, `bounded overlapping reads required, observed ${peak}`);
  assert.equal(active, 0);
  await writeFile(path.join(f.dataRoot, 'runtime/parallel-23'), 'required component XX');
  f.manager.verifiedHashes.clear();
  assert.equal(await f.manager.currentValid(), false, 'a later component must still be checked');
  assert.equal(active, 0, 'no validation worker may remain after returning failure');
});

test('cached canonical names cannot substitute replacement bytes for a surviving original inode', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t); f.manager.start(); await f.manager.working;
  const tool = path.join(f.dataRoot, 'runtime/tool'), held = path.join(f.dataRoot, 'held-runtime'), input = path.join(f.dataRoot, 'input');
  const original = await readFile(tool);
  await symlink(tool, input);
  assert.equal(await f.manager.verifiedHash(input), sha(original));
  await rename(path.dirname(tool), held);
  await rm(input); await symlink(path.join(held, 'tool'), input);
  await mkdir(path.dirname(tool)); await writeFile(tool, 'unrelated replacement canonical path');
  f.manager.verifiedHashes.clear();
  assert.equal(await f.manager.verifiedHash(input), sha(original));
  assert.notEqual(await f.manager.verifiedHash(tool), sha(original));
});

test('a saved host reference must match the pinned host hash as well as the symlink', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t); f.manager.start(); await f.manager.working;
  const target = '/etc/hosts', bytes = await readFile(target), hash = sha(bytes), tool = path.join(f.dataRoot, 'runtime/tool');
  f.manager.manifest.host.tool = { path: target, sha256: hash };
  f.manager.manifest.files.tool = { ...f.manager.manifest.files.tool, sha256: hash, size: bytes.length, mode: 0o644 };
  await rm(tool); await symlink(target, tool);
  const readyPath = path.join(f.dataRoot, 'runtime/ready.json'), ready = JSON.parse(await readFile(readyPath));
  ready.host = { tool: { sha256: hash } }; await writeFile(readyPath, JSON.stringify(ready));
  assert.equal(await f.manager.currentValid(), true);
  ready.host.tool.sha256 = '0'.repeat(64); await writeFile(readyPath, JSON.stringify(ready));
  assert.equal(await f.manager.currentValid(), false);
});
