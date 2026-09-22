import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { atomicJson, jsonFile } from './files.mjs';

// Native control layout verified on this official package. Unknown releases
// require a new compatibility check; version strings alone are not enough.
export const AUTO_LOGIN_PACKAGE = '096865e050ba0d3c1a23887227e2400bf343037b1d7d658c84c88ff26bfdc17f';
const supportedPackages = new Set([AUTO_LOGIN_PACKAGE, 'a6d115d24dfe3ed1b7e7de16cf6cc02acef8df5668150f702ac8d8c5256405fa']);
const digest = value => createHash('sha256').update(value).digest('hex');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function deviceIdentity() {
  let id; try { id = (await readFile('/etc/machine-id', 'utf8')).trim(); } catch {}
  if (/^[a-f0-9]{32}$/i.test(id || '') && !/^0+$/.test(id)) return digest(`qibox-device\0${id}`);
  // UGOS may hide /etc in its application sandbox. Physical network interfaces
  // remain visible in /sys; never use a random ID copied along with app data.
  const addresses = [];
  for (const name of await readdir('/sys/class/net')) {
    if (!/^(eth|en)[a-zA-Z0-9_.-]*$/.test(name)) continue;
    try {
      await realpath(`/sys/class/net/${name}/device`);
      const mac = (await readFile(`/sys/class/net/${name}/address`, 'utf8')).trim().toLowerCase();
      if (/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac) && mac !== '00:00:00:00:00:00') addresses.push(mac);
    } catch {}
  }
  if (!addresses.length) throw new Error('Device identity unavailable');
  return digest(`qibox-network-device\0${[...new Set(addresses)].sort().join(',')}`);
}

export async function loginFingerprint(home) {
  const base = await realpath(home), files = ['xwechat_files/all_users/config/global_config', 'xwechat_files/all_users/config/global_config.crc'];
  const directories = await readdir(path.join(base, 'xwechat_files'), { withFileTypes: true });
  const accounts = directories.filter(d => d.isDirectory() && /^wxid_[a-zA-Z0-9_]+$/.test(d.name));
  if (!accounts.length || accounts.length > 32) throw new Error('Account configuration unavailable');
  for (const account of accounts) {
    for (const suffix of ['', '.crc']) files.push(`xwechat_files/${account.name}/config/login_configv2${suffix}`);
  }
  const digest = createHash('sha256');
  for (const relative of files.sort()) {
    const file = path.join(base, relative), resolved = await realpath(file);
    if (!resolved.startsWith(base + path.sep)) throw new Error('Configuration outside profile');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 4 || before.size > 512 * 1024) throw new Error('Configuration unavailable');
      const bytes = await handle.readFile(), after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Configuration changing');
      digest.update(relative).update('\0').update(bytes);
    } finally { await handle.close(); }
  }
  return digest.digest('hex');
}

export function readNativeLogin({ appRoot, runtimeRoot, env, pid, navigate, signal, session = false, loginPage = false, scheduledLogin = false }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(path.join(runtimeRoot, 'usr/bin/python3.11'), [path.join(appRoot, 'server/auto-login.py'), String(pid), ...(session ? ['--session', ...(loginPage ? ['--login-page'] : []), ...(scheduledLogin ? ['--scheduled-login'] : [])] : navigate ? ['--navigate'] : [])], {
      env: { ...env, PYTHONHOME: path.join(runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '', aborted = false, killTimer;
    const abort = () => { aborted = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 4200);
    child.stdout.on('data', data => { output += data; if (output.length > 1024) abort(); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (aborted || code !== 0) return reject(new Error('Native inspection unavailable'));
      try {
        const result = JSON.parse(output);
        if (!(session ? ['logged-in', 'logged-out', 'relogin-required', 'unknown'] : ['ready', 'unavailable', 'unknown']).includes(result.status)) throw new Error('Invalid observation');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

export class AutoLoginVerifier {
  constructor({ dataRoot, home, application, probe, device = deviceIdentity, now = Date.now }) {
    this.file = path.join(dataRoot, 'auto-login-evidence.json');
    this.home = home; this.application = application; this.probe = probe; this.device = device; this.now = now;
    this.profileKey = digest(path.resolve(dataRoot));
    this.loaded = false; this.evidence = null; this.lastProbe = 0;
  }
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const saved = await jsonFile(this.file, null);
    // Only an observed, cleanly stopped instance can survive a service restart.
    if (saved?.format === 2 && saved.cleanStop === true && supportedPackages.has(saved.package) &&
      [saved.fingerprint, saved.accountKey, saved.deviceKey].every(isDigest) && saved.profileKey === this.profileKey &&
      Number.isFinite(Date.parse(saved.observedAt))) this.evidence = saved;
  }
  async clear() {
    await this.load();
    if (this.evidence) { this.evidence = null; await atomicJson(this.file, null); }
  }
  async started() {
    await this.clear(); this.lastProbe = 0;
    // A crash must not resurrect the previous clean-stop evidence.
    await atomicJson(this.file, null);
  }
  async stopped() {
    await this.load();
    if (!this.evidence) return;
    try {
      if (this.evidence.deviceKey !== await this.device() || this.evidence.fingerprint !== await loginFingerprint(await this.home())) return await this.clear();
      this.evidence = { ...this.evidence, cleanStop: true };
      await atomicJson(this.file, this.evidence);
    } catch { await this.clear(); }
  }
  async inspect({ running, stopped, navigate, signal, requested = false }) {
    await this.load();
    const packageHash = this.application()?.sha256;
    if (!supportedPackages.has(packageHash)) { await this.clear(); return { status: 'unknown' }; }
    if (this.evidence && this.evidence.package !== packageHash) await this.clear();
    try {
      const deviceKey = await this.device();
      if (!isDigest(deviceKey)) throw new Error('Device identity unavailable');
      const fingerprint = await loginFingerprint(await this.home());
      signal?.throwIfAborted();
      if (this.evidence && (this.evidence.fingerprint !== fingerprint || this.evidence.deviceKey !== deviceKey)) await this.clear();
      if (stopped) return { status: this.evidence?.cleanStop ? 'ready' : 'unknown' };
      if (!running) return { status: 'unknown' };
      // Recheck visible Settings every tick. Background navigation is throttled
      // to five minutes and prohibited whenever a desktop viewer is present.
      const canNavigate = navigate && (requested || this.now() - this.lastProbe >= 300000);
      const result = await this.probe({ navigate: canNavigate, signal });
      if (canNavigate) this.lastProbe = this.now();
      // WeChat may persist window/settings state when our inspection closes its
      // Settings window. Bind a positive native observation to a stable final
      // snapshot, instead of rejecting every legitimate settings write.
      const finalFingerprint = await loginFingerprint(await this.home());
      if (finalFingerprint !== await loginFingerprint(await this.home())) { await this.clear(); return { status: 'unknown' }; }
      if (deviceKey !== await this.device()) { await this.clear(); return { status: 'unknown' }; }
      if (result.status === 'ready' && result.reason === 'native-login-method' && isDigest(result.accountKey)) {
        this.evidence = { format: 2, package: packageHash, profileKey: this.profileKey, deviceKey, accountKey: result.accountKey,
          fingerprint: finalFingerprint, cleanStop: false, observedAt: new Date(this.now()).toISOString() };
        await atomicJson(this.file, this.evidence);
        return { status: 'ready' };
      }
      const age = this.now() - Date.parse(this.evidence?.observedAt);
      if (result.status === 'unknown' && result.reason === 'settings-closed' && this.evidence && fingerprint === finalFingerprint &&
        (!result.accountKey || result.accountKey === this.evidence.accountKey) && age >= 0 && age < 300000) return { status: 'ready' };
      await this.clear();
      return { status: result.status === 'unavailable' ? 'unavailable' : 'unknown' };
    } catch { await this.clear(); return { status: 'unknown' }; }
  }
}
