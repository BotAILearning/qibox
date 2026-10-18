import path from 'node:path';
import { mkdir, stat, readFile, rename, rm, symlink, lstat, readlink, readdir, copyFile, chmod, link, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { architecture, runtimeLibraries } from './platform.mjs';
import { atomicJson, jsonFile, hashFile, AppError, ensureSpace } from './files.mjs';

const exists = async p => !!await stat(p).catch(() => null);
const inside = (root, relative) => {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/') || relative.split('/').includes('..')) throw Error('Unsafe resource path');
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw Error('Unsafe resource destination');
  return result;
};
export function runRuntimeCommand(bin, args, env = process.env, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = b => { output = (output + b).slice(-8000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error(`${path.basename(bin)}: ${output.slice(-1200)}`)); });
  });
}
export function validateRuntimeManifest(manifest, arch) {
  if (manifest?.format !== 1 || manifest.arch !== architecture(arch).node || !/^[a-f0-9]{64}$/.test(manifest.identity) || !Array.isArray(manifest.resources) || !manifest.resources.length) throw Error('Invalid runtime manifest');
  const ids = new Set();
  for (const r of manifest.resources) {
    if (ids.has(r.id) || r.id !== r.sha256 || !/^[a-f0-9]{64}$/.test(r.sha256) || r.file !== `${r.sha256}.tar.xz` || !Number.isSafeInteger(r.size) || r.size <= 0 || r.size > 2 * 1024 ** 3 || r.version !== manifest.identity) throw Error('Invalid pinned runtime resource');
    ids.add(r.id);
  }
  for (const [name, file] of Object.entries(manifest.files || {})) {
    inside('/runtime', name);
    if (!ids.has(file.resource) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw Error('Invalid runtime file');
  }
  for (const [name, host] of Object.entries(manifest.host || {})) {
    if (!manifest.files[name] || host.path !== '/' + name || !/^[a-f0-9]{64}$/.test(host.sha256) || !/^(usr|lib|lib64|bin|sbin|etc|var\/lib)\//.test(name)) throw Error('Invalid host reference');
    if (arch === 'arm64' && (host.kind !== 'identical' || host.sha256 !== manifest.files[name].sha256)) throw Error('Unverified ARM compatibility profile');
  }
  return manifest;
}

export class RuntimeResources {
  constructor({ appRoot, dataRoot, arch = process.arch, selftest, command = runRuntimeCommand, hash = hashFile }) {
    Object.assign(this, { appRoot, dataRoot, arch, command, hash });
    architecture(arch);
    this.root = path.join(dataRoot, 'runtime'); this.cache = path.join(dataRoot, 'runtime-cache');
    this.stateFile = path.join(this.cache, 'preparation.json');
    this.verifiedHashes = new Map(); this.hashesInFlight = new Map();
    this.selftest = selftest || (root => this.checkEnvironment(root));
    this.state = { status: 'idle', stage: 'checking', bytes: 0, total: 0, remaining: 0, message: '检查微信所需环境' };
  }
  async fileSignature(file) {
    const canonical = await realpath(file);
    const info = await stat(canonical, { bigint: true });
    if (!info.isFile()) throw Error('运行组件不是普通文件');
    const signature = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid].map(String).join(':');
    return { canonical, signature, key: `${canonical}\0${signature}` };
  }
  async verifiedHash(file) {
    // Cache only a stable read of the canonical target. Re-resolve the input
    // after hashing so a replaced symlink cannot inherit the old target's hash.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.fileSignature(file);
      const cached = this.verifiedHashes.get(before.canonical);
      if (cached?.signature === before.signature) {
        const current = await this.fileSignature(file);
        if (current.key === before.key) return cached.sha256;
        continue;
      }
      let pending = this.hashesInFlight.get(before.key);
      if (!pending) {
        pending = (async () => {
          const sha256 = await this.hash(before.canonical);
          const after = await this.fileSignature(file);
          if (after.key !== before.key) throw Error('运行组件在校验期间发生变化');
          this.verifiedHashes.set(before.canonical, { signature: before.signature, sha256 });
          return sha256;
        })();
        this.hashesInFlight.set(before.key, pending);
      }
      try {
        const sha256 = await pending;
        const current = await this.fileSignature(file);
        if (current.key === before.key) return sha256;
      } finally {
        if (this.hashesInFlight.get(before.key) === pending) this.hashesInFlight.delete(before.key);
      }
    }
    throw Error('运行组件持续变化，无法完成校验');
  }
  async init() {
    const file = path.join(this.appRoot, 'payload', this.arch, 'runtime-manifest.json');
    const manifest = await jsonFile(file, null);
    if (!manifest) return false; // Older fully bundled installation.
    this.manifest = validateRuntimeManifest(manifest, this.arch);
    this.hardlinkTargets = new Set(Object.values(this.manifest.inventory || {}).filter(row => row[0] === '1').map(row => path.posix.normalize(row[4])));
    this.offline = await jsonFile(path.join(this.appRoot, 'payload', this.arch, 'runtime-offline.json'), null);
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    for (const item of await readdir(this.cache, { withFileTypes: true })) {
      if (item.isFile() && /^(?:offline|[a-f0-9]{64})\.import$/.test(item.name)) await rm(path.join(this.cache, item.name));
    }
    this.state = await jsonFile(this.stateFile, this.state);
    const resume = this.state.status === 'working';
    const previous = this.root + '.previous';
    if (!await exists(this.root) && await exists(path.join(previous, 'ready.json'))) {
      // Recover the interrupted two-rename commit before evaluating the new
      // manifest. Recovery does not mark an old tree ready for a new identity.
      try { await this.selftest(previous); await rename(previous, this.root); }
      catch (error) { await this.save({ status: 'error', error: error.message, message: '上次环境切换未完成，请重新准备；旧环境已保留' }); }
    }
    try { await this.adoptExisting(); } catch (error) { await this.save({ status: 'error', error: error.message, message: '已有运行环境自检未通过，请重新准备' }); }
    await this.inspect();
    if (resume) this.start();
    return true;
  }
  async adoptExisting() {
    const ready = await jsonFile(path.join(this.root, 'ready.json'), null);
    if (!ready || ready.resourceIdentity) return;
    // Existing delivered runtimes are reusable only after checking every file;
    // the old ready flag alone is never enough for a new resource identity.
    for (const [name, file] of Object.entries(this.manifest.files)) {
      try { if (await this.verifiedHash(inside(this.root, name)) !== file.sha256) return; } catch { return; }
    }
    await this.selftest(this.root);
    const lock = await jsonFile(path.join(this.appRoot, 'payload', this.arch, 'runtime-lock.json'), {});
    await atomicJson(path.join(this.root, 'ready.json'), { ...ready, resourceIdentity: this.manifest.identity, arch: this.arch, host: {}, systemIdentity: await this.systemIdentity(), fingerprint: createHash('sha256').update(JSON.stringify(lock)).digest('hex') });
  }
  async systemIdentity() {
    const target = architecture(this.arch), parts = [process.platform, this.arch];
    for (const file of ['/etc/os-release', `/lib/${target.triple}/libc.so.6`, `/lib/${target.triple}/libgcc_s.so.1`, `/lib/${target.triple}/libz.so.1`, `/lib/${target.triple}/libbz2.so.1.0`, `/lib/${target.triple}/liblzma.so.5`, `/lib/${target.triple}/libcrypt.so.1`, `/lib/${target.triple}/libzstd.so.1`]) {
      parts.push(file, await this.verifiedHash(file).catch(() => 'missing'));
    }
    return createHash('sha256').update(parts.join('\0')).digest('hex');
  }
  snapshot() {
    return { ...this.state, architecture: architecture(this.arch).label,
      details: { identity: this.manifest?.identity, reusedFiles: this.reused?.size || 0, missingResources: this.needed?.length || 0, bundled: true, offlineSupported: true } };
  }
  async save(patch) { Object.assign(this.state, patch); await atomicJson(this.stateFile, this.state); }
  async hostMatches(name) {
    // Original hard-link groups must keep their original shared inode/content.
    // A version-different host driver cannot stand in for every alias in a group.
    if (this.hardlinkTargets?.has(name)) return false;
    const row = this.manifest.host[name];
    try {
      // A reference may never resolve into another application's private tree.
      const resolved = await realpath(row.path);
      if (!/^\/(usr|lib|lib64|bin|sbin|etc|var\/lib)\//.test(resolved)) return false;
      if (await this.verifiedHash(row.path) !== row.sha256) return false;
      const confirmed = await realpath(row.path);
      return confirmed === resolved && /^\/(usr|lib|lib64|bin|sbin|etc|var\/lib)\//.test(confirmed);
    } catch { return false; }
  }
  async currentValid(root = this.root, { checkSystem = true } = {}) {
    const ready = await jsonFile(path.join(root, 'ready.json'), null);
    if (ready?.resourceIdentity !== this.manifest.identity || ready.arch !== this.arch) return false;
    if (checkSystem && ready.systemIdentity !== await this.systemIdentity()) return false;
    try {
      for (const [name, file] of Object.entries(this.manifest.files)) {
        const output = inside(root, name), info = await lstat(output);
        const host = ready.host?.[name];
        if (host) {
          if (!info.isSymbolicLink() || await readlink(output) !== this.manifest.host[name]?.path || await this.verifiedHash(output) !== host.sha256 || !await this.hostMatches(name)) return false;
        } else if (!info.isFile() || info.size !== file.size || await this.verifiedHash(output) !== file.sha256) return false;
        if (process.platform !== 'win32' && file.mode & 0o100 && !(info.mode & 0o100)) return false;
      }
      for (const [name, entry] of Object.entries(this.manifest.inventory || {})) {
        if (entry[0] === '2' && await readlink(inside(root, name)) !== entry[4]) return false;
        if (entry[0] === '1') {
          const file = await stat(inside(root, name)), target = await stat(inside(root, entry[4]));
          if (file.ino !== target.ino || file.dev !== target.dev) return false;
        }
      }
      return true;
    } catch { return false; }
  }
  async inspect() {
    if (this.working) return this.snapshot();
    let valid = await this.currentValid();
    // OS/loader changes require selftest again, even when every private file and
    // approved host reference still matches. Reuse that complete tree on success.
    if (!valid && await this.currentValid(this.root, { checkSystem: false })) {
      try {
        await this.selftest(this.root);
        const ready = await jsonFile(path.join(this.root, 'ready.json'));
        await atomicJson(path.join(this.root, 'ready.json'), { ...ready, systemIdentity: await this.systemIdentity() });
        valid = true;
      } catch (error) { await this.save({ status: 'error', error: error.message, message: '系统更新后的运行自检未通过，请重新准备' }); }
    }
    if (valid) { await this.save({ status: 'ready', stage: 'ready', bytes: 0, total: 0, remaining: 0, message: '微信运行环境已就绪', error: null }); return this.snapshot(); }
    this.reused = new Set();
    for (const name of Object.keys(this.manifest.host)) if (!this.state.reuseDisabled && await this.hostMatches(name)) this.reused.add(name);
    const ids = new Set(this.manifest.resources.filter(r => r.kind === 'private').map(r => r.id));
    for (const [name, file] of Object.entries(this.manifest.files)) if (!this.reused.has(name)) ids.add(file.resource);
    await this.selectExisting(ids);
    let remaining = 0, total = 0;
    for (const r of this.needed) {
      total += r.size;
      const file = await this.available(r);
      if (!file) remaining += r.size;
    }
    await this.save({ status: ['paused', 'error'].includes(this.state.status) ? this.state.status : 'idle', stage: 'checking', total, bytes: total - remaining, remaining,
      message: remaining ? '随包资源需修复，请重新安装完整栖盒安装包或导入离线资源' : '运行组件已随包提供，可在本地准备' });
    return this.snapshot();
  }
  async selectExisting(ids) {
    this.existingResources = new Set();
    const filesByResource = new Map();
    for (const [name, file] of Object.entries(this.manifest.files)) {
      if (!ids.has(file.resource)) continue;
      if (!filesByResource.has(file.resource)) filesByResource.set(file.resource, []);
      filesByResource.get(file.resource).push([name, file]);
    }
    for (const [id, files] of filesByResource) {
      let valid = true;
      for (const [name, file] of files) {
        try { if ((await stat(inside(this.root, name))).size !== file.size || await this.verifiedHash(inside(this.root, name)) !== file.sha256) { valid = false; break; } }
        catch { valid = false; break; }
      }
      if (valid) this.existingResources.add(id);
    }
    this.needed = this.manifest.resources.filter(r => ids.has(r.id) && !this.existingResources.has(r.id));
  }
  async materializeExisting(staging) {
    // Only runtime component files are copied; user homes/configuration are
    // outside this tree. Recheck before copying to catch concurrent changes.
    for (const [name, file] of Object.entries(this.manifest.files)) {
      if (!this.existingResources.has(file.resource)) continue;
      if (this.reused.has(name)) continue;
      const source = inside(this.root, name), output = inside(staging, name);
      if (await this.verifiedHash(source) !== file.sha256) throw Error('已有运行组件在准备期间发生变化');
      await mkdir(path.dirname(output), { recursive: true }); await copyFile(source, output); await chmod(output, file.mode & 0o777);
    }
  }
  async materializeLinks(staging) {
    for (const [name, entry] of Object.entries(this.manifest.inventory || {})) {
      if (name === '.' || !['5', '2', '1'].includes(entry[0])) continue;
      const output = inside(staging, name);
      if (await lstat(output).catch(() => null)) continue;
      await mkdir(path.dirname(output), { recursive: true });
      if (entry[0] === '5') await mkdir(output, { recursive: true });
      else if (entry[0] === '2') await symlink(entry[4], output);
      else {
        const target = inside(staging, entry[4]);
        if (!(await lstat(target)).isFile()) throw Error('私有硬链接目标缺失');
        await link(target, output);
      }
    }
  }
  async available(r) {
    for (const file of [path.join(this.cache, r.sha256 + '.cache'), path.join(this.appRoot, 'payload/resources', r.file)]) {
      if ((await stat(file).catch(() => null))?.size === r.size && await hashFile(file) === r.sha256) return file;
    }
    return null;
  }
  start() {
    if (this.importing) throw new AppError('离线资源正在导入，请稍候', 409);
    if (this.working || this.state.status === 'ready') return this.snapshot();
    this.cancelled = false;
    this.working = this.prepare().catch(async error => {
      if (this.cancelled) return;
      await this.save({ status: 'error', error: error.message, message: '准备未完成，已保留原环境，可重试或导入离线资源' });
    }).finally(() => { this.working = null; });
    return this.snapshot();
  }
  async resource(r) {
    const cached = await this.available(r);
    if (cached) return cached;
    throw new AppError('随包运行资源缺失或校验不符，请重新安装完整栖盒安装包或导入离线资源', 409);
  }
  async prepare() {
    await this.save({ status: 'working', error: null, stage: 'checking', message: '正在检查已有环境' });
    if (await this.currentValid()) { await this.save({ status: 'ready', stage: 'ready', message: '微信运行环境已就绪' }); return; }
    // Recompute after every restart/system update; previous observations are not readiness.
    this.workingInspection = true;
    this.reused = new Set();
    for (const name of Object.keys(this.manifest.host)) if (!this.state.reuseDisabled && await this.hostMatches(name)) this.reused.add(name);
    const required = new Set(this.manifest.resources.filter(r => r.kind === 'private').map(r => r.id));
    for (const [name, file] of Object.entries(this.manifest.files)) if (!this.reused.has(name)) required.add(file.resource);
    await this.selectExisting(required);
    const total = this.needed.reduce((n, r) => n + r.size, 0);
    await ensureSpace(this.dataRoot, this.manifest.unpackedBytes + total * 2 + 256 * 1024 ** 2);
    const resources = new Map(); let bytes = 0;
    for (const r of this.needed) {
      if (this.cancelled) return;
      await this.save({ stage: 'verifying', total, bytes, remaining: total - bytes, message: '正在校验随包运行资源，无需下载组件' });
      resources.set(r.id, await this.resource(r)); bytes += r.size;
    }
    if (this.cancelled) return;
    const staging = this.root + '.preparing', old = this.root + '.previous';
    await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true, mode: 0o700 });
    await this.materializeExisting(staging);
    await this.save({ stage: 'extracting', bytes, remaining: 0, message: '正在展开微信所需资源' });
    // Fallback targets precede the base archive's hard links. A compatible
    // bootstrap Python handles thousands of resources in a single process.
    const ordered = [...this.needed].sort((a, b) => Number(a.kind === 'private') - Number(b.kind === 'private'));
    let bootstrap;
    if (process.platform === 'linux') for (const candidate of ['/usr/bin/python3', '/bin/python3']) {
      try { await this.command(candidate, ['-c', 'import tarfile,lzma,hashlib,json; import sys; assert sys.version_info >= (3, 8)']); bootstrap = candidate; break; } catch {}
    }
    if (bootstrap) {
      const request = path.join(this.cache, 'extraction.json');
      await atomicJson(request, { root: staging, manifest: this.manifest, skipFiles: [...this.reused], resources: ordered.map(r => ({ path: resources.get(r.id), sha256: r.sha256 })) });
      await this.command(bootstrap, [path.join(this.appRoot, 'server/extract-runtime-resources.py'), request], process.env, 600000);
    } else {
      // The fully bundled private Python is always recoverable via tar. When
      // bootstrap Python is absent, extract a complete private tree first.
      this.reused.clear();
      await this.materializeExisting(staging);
      for (const r of ordered) await this.command('/bin/tar', ['-xf', resources.get(r.id), '-C', staging, '--no-same-owner', '--no-same-permissions'], process.env, 180000);
    }
    const host = {};
    for (const name of this.reused) {
      if (!await this.hostMatches(name)) throw Error('系统组件在准备期间发生变化，请重试');
      const row = this.manifest.host[name], output = inside(staging, name);
      await mkdir(path.dirname(output), { recursive: true }); await symlink(row.path, output); host[name] = row;
    }
    await this.materializeLinks(staging);
    await this.save({ stage: 'selftest', message: '正在自检微信运行环境' });
    try { await this.selftest(staging); }
    catch (error) {
      if (this.reused.size && !this.state.reuseDisabled) {
        await this.save({ reuseDisabled: true, message: '系统复用自检未通过，改用私有后备环境' });
        return this.prepare();
      }
      throw error;
    }
    const oldLock = await jsonFile(path.join(this.appRoot, 'payload', this.arch, 'runtime-lock.json'), {});
    await atomicJson(path.join(staging, 'ready.json'), { resourceIdentity: this.manifest.identity, arch: this.arch, host, systemIdentity: await this.systemIdentity(),
      fingerprint: createHash('sha256').update(JSON.stringify(oldLock)).digest('hex') });
    // Recheck every private/reference file before committing the new tree.
    const valid = await this.currentValid(staging);
    if (!valid) throw Error('展开文件校验失败，原环境未切换');
    if (this.cancelled) return;
    await rm(old, { recursive: true, force: true });
    const hadOld = await exists(this.root);
    if (hadOld) await rename(this.root, old);
    try { await rename(staging, this.root); } catch (error) { if (hadOld) await rename(old, this.root); throw error; }
    await this.save({ status: 'ready', stage: 'ready', error: null, bytes: total, total, remaining: 0, message: '微信运行环境已就绪' });
  }
  async checkEnvironment(root) {
    if (process.platform !== 'linux' || process.arch !== this.arch) throw Error('运行环境必须在对应架构的 NAS 上自检');
    const glibc = process.report.getReport().header.glibcVersionRuntime;
    if (!glibc || Number(glibc.split('.')[0]) < 2 || Number(glibc.split('.')[0]) === 2 && Number(glibc.split('.')[1]) < 36) throw Error('需要 glibc 2.36 或更高版本');
    const env = { ...process.env, LD_LIBRARY_PATH: runtimeLibraries(root, this.arch), PYTHONHOME: path.join(root, 'usr'), PYTHONPATH: '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
    for (const bin of ['python3.11', 'Xvfb', 'x11vnc', 'fcitx5', 'dbus-daemon', 'openbox', 'ffmpeg', 'ffprobe']) {
      const file = path.join(root, 'usr/bin', bin);
      const handle = await readFile(file);
      if (!handle.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || handle.readUInt16LE(18) !== architecture(this.arch).elf) throw Error(`${bin}: ELF 架构不符`);
      const dependencies = await this.command('/usr/bin/ldd', [file], env);
      if (/not found|undefined symbol/.test(dependencies)) throw Error(`${bin}: 动态依赖缺失`);
    }
    await this.command(path.join(root, 'usr/bin/python3.11'), ['-c', 'import ssl,sqlite3,ctypes,lzma,json,socket; assert sqlite3.connect(":memory:").execute("select 1").fetchone()[0] == 1'], env);
    await this.command(path.join(root, 'usr/bin/ffmpeg'), ['-version'], env);
    await this.command(path.join(root, 'usr/bin/ffprobe'), ['-version'], env);
  }
  async pause() { this.cancelled = true; await this.working; await this.save({ status: 'paused', message: '已暂停，已保留随包资源和原环境' }); return this.snapshot(); }
  async close() { this.cancelled = true; this.importController?.abort(); await this.working; await this.importTask?.catch(() => {}); }
  importResource(stream, size, id) {
    if (this.importTask) throw new AppError('正在导入离线资源，请稍候', 409);
    this.importTask = this.performImport(stream, size, id).finally(() => { this.importTask = null; this.importController = null; });
    return this.importTask;
  }
  async performImport(stream, size, id) {
    const offline = id === 'offline' && this.offline?.arch === this.arch && this.offline?.identity === this.manifest.identity;
    const resource = offline ? this.offline : this.manifest.resources.find(r => r.id === id);
    if (!resource || size !== resource.size || this.working || this.importing) throw new AppError('请选择本版本对应架构的离线资源，准备期间请先暂停', 409);
    this.importing = true;
    this.importController = new AbortController();
    const pending = path.join(this.cache, id + '.import');
    const { pipeline } = await import('node:stream/promises'); const { createWriteStream } = await import('node:fs');
    const { Transform } = await import('node:stream'); let bytes = 0;
    try {
      await pipeline(stream, new Transform({ transform(chunk, _, cb) { bytes += chunk.length; cb(bytes > size ? Error('离线文件超过声明大小') : null, chunk); } }), createWriteStream(pending, { flags: 'wx', mode: 0o600 }), { signal: this.importController.signal });
      if (bytes !== size || await hashFile(pending) !== resource.sha256) throw new AppError('离线资源不完整或校验不符');
      if (offline) {
        // The outer archive is pinned in the installed application. Never
        // extract an untrusted uploaded manifest or unverified archive.
        const stage = path.join(this.cache, 'offline.preparing');
        await rm(stage, { recursive: true, force: true }); await mkdir(stage, { mode: 0o700 });
        await this.command('/bin/tar', ['-xf', pending, '-C', stage, '--no-same-owner', '--no-same-permissions'], process.env, 180000);
        for (const r of this.manifest.resources) {
          const file = path.join(stage, r.file);
          if ((await stat(file)).size !== r.size || await hashFile(file) !== r.sha256) throw Error('离线包内部资源校验失败');
        }
        for (const r of this.manifest.resources) await rename(path.join(stage, r.file), path.join(this.cache, r.sha256 + '.cache'));
        await rm(stage, { recursive: true, force: true });
      } else await rename(pending, path.join(this.cache, resource.sha256 + '.cache'));
    } finally { await rm(pending, { force: true }); this.importing = false; }
    return this.inspect();
  }
}
