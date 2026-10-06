import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, lstat, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const pending = new Map();
const folders = ['fonts', 'node_modules'];
const owned = (root, name) => {
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Application asset path escaped its root');
  return target;
};
const validPath = name => typeof name === 'string' && /^[A-Za-z0-9@._/-]+$/.test(name) &&
  folders.some(folder => name === folder || name.startsWith(folder + '/')) &&
  !name.split('/').some(part => !part || part === '.' || part === '..');
const fileHash = async file => {
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
};

function validate(manifest) {
  if (manifest?.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      manifest.file !== `${manifest.sha256}-assets.tar.xz` || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) ||
      !Array.isArray(manifest.directories) || new Set(manifest.directories).size !== manifest.directories.length ||
      !folders.every(folder => manifest.directories.includes(folder))) throw new Error('Invalid application asset manifest');
  for (const name of manifest.directories) if (!validPath(name)) throw new Error('Invalid application asset directory');
  const entries = Object.entries(manifest.files);
  if (!entries.length || !folders.every(folder => entries.some(([name]) => name.startsWith(folder + '/')))) throw new Error('Incomplete application assets');
  for (const [name, item] of entries) {
    if (!validPath(name) || manifest.directories.includes(name) || !Number.isSafeInteger(item?.bytes) || item.bytes < 0 ||
        item.mode !== 0o644 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid application asset file');
  }
}

async function matches(root, manifest, hash) {
  const entries = [...manifest.directories.map(name => [name, null]), ...Object.entries(manifest.files)];
  let next = 0, valid = true;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (valid && next < entries.length) {
      const [name, item] = entries[next++], file = owned(root, name), info = await lstat(file).catch(() => null);
      if (!info || info.isSymbolicLink() || (item ? !info.isFile() || info.size !== item.bytes : !info.isDirectory())) { valid = false; return; }
      if (item && hash && await fileHash(file) !== item.sha256) { valid = false; return; }
    }
  }));
  return valid;
}

async function assetLock(root) {
  const lock = owned(root, '.prepare-lock'), deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try { await writeFile(owned(lock, 'owner'), String(process.pid), { mode: 0o600 }); }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return async () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(owned(lock, 'owner'), 'utf8').catch(() => ''));
      let stale = false;
      if (Number.isInteger(pid) && pid > 1) {
        try { process.kill(pid, 0); } catch (error) { stale = error.code === 'ESRCH'; }
      } else {
        const info = await lstat(lock).catch(() => null); stale = info && Date.now() - info.mtimeMs > 60000;
      }
      if (stale) {
        const abandoned = owned(root, '.abandoned-' + randomUUID());
        try { await rename(lock, abandoned); await rm(abandoned, { recursive: true, force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await delay(100);
    }
  }
  throw new Error('Application assets are still being prepared');
}

async function extractTar(archive, staging, manifest) {
  const tar = process.platform === 'win32' ? 'tar.exe' : '/bin/tar';
  const options = { windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 };
  const { stdout: names } = await execute(tar, ['-tf', archive], options);
  const listed = names.trimEnd().split('\n').map(name => name.replace(/\r$/, '').replace(/\/$/, ''));
  const expected = new Set([...manifest.directories, ...Object.keys(manifest.files)]);
  if (listed.length !== expected.size || new Set(listed).size !== listed.length || listed.some(name => !expected.has(name))) throw new Error('Application asset archive entries differ');
  const { stdout: types } = await execute(tar, ['-tvf', archive], options);
  if (types.trimEnd().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw new Error('Application asset archive cannot contain links');
  await execute(tar, ['-xf', archive, '-C', staging, '--no-same-owner', '--same-permissions'], options);
}

async function prepare(appRoot, { extract = extractTar, move = rename } = {}) {
  appRoot = path.resolve(appRoot);
  const manifestFile = owned(appRoot, 'config/app-assets.json');
  const encoded = await readFile(manifestFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (encoded === null) return { packed: false, reused: true };
  const manifest = JSON.parse(encoded); validate(manifest);
  const fingerprint = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const assetRoot = owned(appRoot, 'assets'), marker = owned(assetRoot, 'ready.json');
  const ready = await readFile(marker, 'utf8').catch(() => '');
  if (ready === fingerprint && await matches(appRoot, manifest, false)) return { packed: true, reused: true, files: Object.keys(manifest.files).length };
  await mkdir(assetRoot, { recursive: true });
  const release = await assetLock(assetRoot);
  try {
  if (await matches(appRoot, manifest, true)) {
    await mkdir(assetRoot, { recursive: true }); await writeFile(marker, fingerprint, { mode: 0o600 });
    return { packed: true, reused: true, files: Object.keys(manifest.files).length };
  }
  const archive = owned(assetRoot, manifest.file), info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes || await fileHash(archive) !== manifest.sha256) throw new Error('Application asset archive checksum differs');
  const staging = await mkdtemp(owned(assetRoot, '.prepare-'));
  const published = [], backups = []; let clean = true;
  try {
    await extract(archive, staging, manifest);
    if (!await matches(staging, manifest, true)) throw new Error('Restored application asset bytes differ');
    for (const folder of folders) {
      const target = owned(appRoot, folder), backup = owned(staging, `.previous-${folder}`);
      if (await lstat(target).catch(() => null)) { await move(target, backup); backups.push([target, backup]); }
      await move(owned(staging, folder), target); published.push(target);
    }
    await writeFile(owned(staging, 'ready.json'), fingerprint, { mode: 0o600 });
    await move(owned(staging, 'ready.json'), marker);
    return { packed: true, reused: false, files: Object.keys(manifest.files).length };
  } catch (error) {
    try {
      for (const target of published.reverse()) await rm(owned(appRoot, path.relative(appRoot, target)), { recursive: true, force: true });
      for (const [target, backup] of backups.reverse()) await rename(backup, target);
    } catch (rollback) { clean = false; throw new AggregateError([error, rollback], 'Application asset publication failed; previous files retained for recovery'); }
    throw error;
  } finally {
    if (clean) await rm(owned(assetRoot, path.relative(assetRoot, staging)), { recursive: true, force: true });
  }
  } finally { await release(); }
}

export function prepareAppAssets(appRoot, options) {
  const key = path.resolve(appRoot);
  if (!pending.has(key)) pending.set(key, prepare(key, options).finally(() => pending.delete(key)));
  return pending.get(key);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareAppAssets(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')); }
  catch (error) { console.error('应用资源准备失败：' + error.message); process.exitCode = 1; }
}
