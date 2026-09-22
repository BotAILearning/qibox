import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { deviceIdentity } from './auto-login.mjs';

// UGOS exposes only selected read-only system paths. Supply application-owned
// configuration inside a child namespace, retaining the original UID and all
// outer filesystem restrictions. The helper has no setuid bit or capabilities.
export async function prepareNativeEnvironment({ cacheRoot, dataRoot, uid, gid, identity = deviceIdentity, systemRoot = '/' }) {
  if (![cacheRoot, dataRoot].every(p => path.isAbsolute(p) && !/[\r\n:]/.test(p))) throw new Error('Invalid native application paths');
  if (![uid, gid].every(n => Number.isSafeInteger(n) && n >= 0) || uid === 0) throw new Error('Native application requires an unprivileged user');
  const directory = await mkdtemp(path.join(cacheRoot, 'native-'));
  try {
    const etc = path.join(directory, 'etc'), usr = path.join(directory, 'usr');
    await mkdir(path.join(etc, 'ssl/certs'), { recursive: true });
    await mkdir(path.join(usr, 'share/X11'), { recursive: true });
    const id = await identity();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid device identity');
    await writeFile(path.join(etc, 'machine-id'), id.slice(0, 32) + '\n');
    await writeFile(path.join(etc, 'passwd'), `qibox:x:${uid}:${gid}::${dataRoot}:/bin/false\n`);
    await writeFile(path.join(etc, 'group'), `qibox:x:${gid}:\n`);
    for (const name of ['resolv.conf', 'localtime', 'timezone']) {
      try { await copyFile(path.join(systemRoot, 'etc', name), path.join(etc, name)); }
      catch (error) { if (error.code !== 'ENOENT' || name === 'resolv.conf') throw error; }
    }
    for (const name of ['bin', 'sbin', 'lib']) await symlink('/' + name, path.join(usr, name));
    await symlink(path.join(dataRoot, 'runtime/usr/share/X11/xkb'), path.join(usr, 'share/X11/xkb'));
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function startNativeEntry(env = process.env) {
  if (process.platform !== 'linux') throw new Error('UGOS native entry requires Linux');
  const appRoot = env.UGAPP_INSTALL_DIR;
  if (!appRoot || !path.isAbsolute(appRoot)) throw new Error('UGOS installation directory is required');
  const directory = await prepareNativeEnvironment({ cacheRoot: env.UGAPP_CACHE_DIR, dataRoot: env.UGAPP_DATA_DIR, uid: process.getuid(), gid: process.getgid() });
  let child;
  const stop = signal => child?.kill(signal);
  const terminate = () => stop('SIGTERM'), interrupt = () => stop('SIGINT');
  process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
  try {
    child = spawn(path.join(appRoot, 'bin/qibox-native'), [directory, path.join(appRoot, 'bin/node'), path.join(appRoot, 'server/index.mjs'), '--ugos-entry'], { env, stdio: 'inherit' });
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally {
    process.off('SIGTERM', terminate); process.off('SIGINT', interrupt);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await startNativeEntry(); }
  catch (error) { console.error('Native application startup:', error.message); process.exitCode = 1; }
}
