import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, readdir } from 'node:fs/promises';
import { prepareAppAssets } from '../server/app-assets.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qibox-assets-'));
  await mkdir(path.join(root, 'config')); await mkdir(path.join(root, 'assets'));
  const data = { 'fonts/Noto.otf': Buffer.from('EXACT_FONT_BYTES'), 'node_modules/fixture/index.mjs': Buffer.from('export default "runtime";') };
  const archive = Buffer.from('ARCHIVE_CHECKSUM_FIXTURE');
  const manifest = { format: 1, file: `${hash(archive)}-assets.tar.xz`, sha256: hash(archive), bytes: archive.length,
    files: Object.fromEntries(Object.entries(data).map(([name, value]) => [name, { bytes: value.length, sha256: hash(value), mode: 0o644 }])),
    directories: ['fonts', 'node_modules', 'node_modules/fixture'] };
  const save = () => writeFile(path.join(root, 'config/app-assets.json'), JSON.stringify(manifest)); await save();
  await writeFile(path.join(root, 'assets', manifest.file), archive);
  const extract = async (_, staging) => {
    for (const folder of manifest.directories) await mkdir(path.join(staging, folder), { recursive: true });
    for (const [name, value] of Object.entries(data)) await writeFile(path.join(staging, name), value);
  };
  return { root, data, archive, manifest, save, extract };
}
async function run(body) { const f = await fixture(); try { await body(f); } finally { await rm(f.root, { recursive: true, force: true }); } }

test('fonts and importable dependencies restore exactly, and repeated preparation reuses them', () => run(async f => {
  let calls = 0;
  const options = { extract: async (...args) => { calls++; await f.extract(...args); } };
  assert.equal((await prepareAppAssets(f.root, options)).reused, false);
  for (const [name, value] of Object.entries(f.data)) assert.deepEqual(await readFile(path.join(f.root, name)), value);
  assert.equal((await import(pathToFileURL(path.join(f.root, 'node_modules/fixture/index.mjs')).href)).default, 'runtime');
  assert.equal((await prepareAppAssets(f.root, options)).reused, true);
  assert.equal(calls, 1);
}));

test('corrupt archive fails before extraction and preserves installed files', () => run(async f => {
  await f.extract(null, f.root); await writeFile(path.join(f.root, 'fonts/Noto.otf'), 'OLD');
  await writeFile(path.join(f.root, 'assets', f.manifest.file), Buffer.alloc(f.archive.length));
  await assert.rejects(prepareAppAssets(f.root, { extract: () => assert.fail('must not extract') }), /checksum/);
  assert.equal(await readFile(path.join(f.root, 'fonts/Noto.otf'), 'utf8'), 'OLD');
}));

test('wrong restored font bytes fail before replacing the active assets', () => run(async f => {
  await f.extract(null, f.root); await writeFile(path.join(f.root, 'fonts/Noto.otf'), 'PREVIOUS');
  const extract = async (...args) => { await f.extract(...args); await writeFile(path.join(args[1], 'fonts/Noto.otf'), 'WRONG'); };
  await assert.rejects(prepareAppAssets(f.root, { extract }), /Restored.*bytes/);
  assert.equal(await readFile(path.join(f.root, 'fonts/Noto.otf'), 'utf8'), 'PREVIOUS');
  assert.deepEqual((await readdir(path.join(f.root, 'assets'))).filter(x => x.startsWith('.prepare-')), []);
}));

test('failed publication restores both previous folders and does not publish a ready marker', () => run(async f => {
  await f.extract(null, f.root); await writeFile(path.join(f.root, 'fonts/Noto.otf'), 'OLD_FONT');
  await writeFile(path.join(f.root, 'node_modules/fixture/index.mjs'), 'OLD_MODULE');
  const move = async (source, target) => {
    if (source.endsWith(path.sep + 'node_modules')) throw new Error('publication failed');
    await rename(source, target);
  };
  await assert.rejects(prepareAppAssets(f.root, { extract: f.extract, move }), /publication failed/);
  assert.equal(await readFile(path.join(f.root, 'fonts/Noto.otf'), 'utf8'), 'OLD_FONT');
  assert.equal(await readFile(path.join(f.root, 'node_modules/fixture/index.mjs'), 'utf8'), 'OLD_MODULE');
  await assert.rejects(readFile(path.join(f.root, 'assets/ready.json')), { code: 'ENOENT' });
}));

test('a missing file in a ready cache is repaired; simultaneous callers perform one restore', () => run(async f => {
  let calls = 0; const extract = async (...args) => { calls++; await f.extract(...args); };
  await Promise.all([prepareAppAssets(f.root, { extract }), prepareAppAssets(f.root, { extract })]);
  assert.equal(calls, 1);
  await rm(path.join(f.root, 'fonts/Noto.otf'));
  await prepareAppAssets(f.root, { extract }); assert.equal(calls, 2);
  assert.deepEqual(await readFile(path.join(f.root, 'fonts/Noto.otf')), f.data['fonts/Noto.otf']);
}));

test('an unsafe manifest cannot write outside the application root', () => run(async f => {
  f.manifest.files['fonts/../../escaped'] = Object.values(f.manifest.files)[0]; await f.save();
  await assert.rejects(prepareAppAssets(f.root, { extract: () => assert.fail('must not extract') }), /Invalid.*file/);
}));

test('older unpacked applications work without a compressed asset manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qibox-assets-legacy-'));
  try { assert.deepEqual(await prepareAppAssets(root), { packed: false, reused: true }); }
  finally { await rm(root, { recursive: true, force: true }); }
});
