import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { architecture, officialWechatUrl, runtimeLibraries, runtimePayload, runtimeArchive, platformConfig, gatewayIdentity } from '../server/platform.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { PackageLibrary } from '../server/packages.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, fetcher, extractor, packageBytes, packageSha256 } from './fixtures.mjs';
import { Readable } from 'node:stream';
test('runtime loader supports original archives and verifies content-addressed shared paths', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(runtimeArchive('/app','/payload',{ file: 'lib-data.tar.xz', sha256: digest }), { filename: path.join('/payload','lib-data.tar.xz'), sha256: digest });
  assert.deepEqual(runtimeArchive('/app','/payload',{ file: 'source.tar.xz', sha256: 'b'.repeat(64), payloadFile: digest+'-data.tar.xz', payloadSha256: digest }), { filename: path.join('/app','payload/shared',digest+'-data.tar.xz'), sha256: digest });
  for (const payloadFile of ['../evil','source.tar.xz']) assert.throws(() => runtimeArchive('/app','/payload',{ payloadFile, payloadSha256:digest }));
});

test('one FPK selects only the current architecture, with flat payload compatibility for UPK', async () => {
  const appRoot = await temp();
  try {
    assert.equal(await runtimePayload(appRoot, 'arm64'), path.join(appRoot, 'payload'));
    for (const arch of ['x64', 'arm64']) {
      const directory = path.join(appRoot, 'payload', arch); await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'runtime-lock.json'), '{}');
    }
    assert.equal(await runtimePayload(appRoot, 'x64'), path.join(appRoot, 'payload/x64'));
    assert.equal(await runtimePayload(appRoot, 'arm64'), path.join(appRoot, 'payload/arm64'));
    await assert.rejects(runtimePayload(appRoot, 'arm'), /ARM64/);
  } finally { await cleanup(appRoot); }
});

test('target architecture selects executable format, runtime libraries and official WeChat source together', () => {
  assert.equal(architecture('arm64').deb, 'arm64'); assert.equal(architecture('arm64').fnos, 'arm');
  assert.equal(architecture('arm64').elf, 183); assert.equal(architecture('x64').elf, 62);
  assert.match(officialWechatUrl('arm64'), /WeChatLinux_arm64\.deb$/);
  assert.match(runtimeLibraries('/runtime', 'arm64'), /aarch64-linux-gnu/);
  assert.doesNotMatch(runtimeLibraries('/runtime', 'arm64'), /x86_64/);
  assert.match(runtimeLibraries('/runtime', 'arm64'), /aarch64-linux-gnu\/pulseaudio/);
  assert.throws(() => architecture('arm'), /ARM64/);
});

test('UGOS uses its own directories and only accepts locally proxied, authenticated user headers', () => {
  const config = platformConfig({ UGAPP_INSTALL_DIR: '/app', UGAPP_DATA_DIR: '/data', TRIM_PKGVAR: '/wrong' });
  assert.equal(config.dataRoot, '/data'); assert.equal(config.host, 'ugos'); assert.equal(config.prefix, '/api/qibox');
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'ugreen-user-id': '1000', 'ugreen-user-type': 'admin' } };
  assert.equal(gatewayIdentity(req, 'ugos').isAdmin, true);
  assert.equal(gatewayIdentity({ ...req, headers: { ...req.headers, 'ugreen-user-type': 'users' } }, 'ugos').isAdmin, false);
  assert.throws(() => gatewayIdentity({ ...req, socket: { remoteAddress: '192.168.3.22' } }, 'ugos'), /应用入口/);
  assert.throws(() => gatewayIdentity({ ...req, headers: { 'x-trim-userid': '1000', 'x-trim-isadmin': 'true' } }, 'ugos'), error => error.code === 'UGOS_USER_ID_MISSING');
  assert.throws(() => gatewayIdentity(req, 'fnos'), /飞牛应用入口/);
});

test('ARM installation filters trusted imports and never reuses a stored x64 executable after migration', async () => {
  const dataRoot = await temp(); let url;
  const options = { appRoot: root, dataRoot, extract: extractor, fetcher: async source => { url = source; return fetcher(); } };
  let library = new PackageLibrary({ ...options, arch: 'x64', trustedHashes: [packageSha256] });
  try {
    await library.init(); library.download(); await library.working; assert.ok(library.installed()); await library.close();
    library = new PackageLibrary({ ...options, arch: 'arm64' }); await library.init();
    assert.equal(library.installed(), null); assert.match(library.publicState().job.message, /架构/);
    assert.deepEqual(library.trustedHashes, ['a6d115d24dfe3ed1b7e7de16cf6cc02acef8df5668150f702ac8d8c5256405fa']);
    await library.upload(Readable.from([packageBytes]), packageBytes.length); assert.equal(library.installed(), null);
    library.download({ allowUnverified: true }); await library.working; assert.match(url, /arm64\.deb$/); assert.equal(library.current.arch, 'arm64');
  } finally { await library.close(); await cleanup(dataRoot); }
});
