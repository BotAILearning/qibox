import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, rename, open, access, readdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, atomicJson, jsonFile, hashFile, ensureSpace, within } from './files.mjs';
import { TransferProgress, ExtractionOutput } from './progress.mjs';
import { architecture, officialWechatUrl, runtimeLibraries } from './platform.mjs';

export const OFFICIAL_URL = 'https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb';
export const MAX_PACKAGE = 1024 ** 3;
export function supportedVersions(library) {
  return [...new Set(library.importVersions || [])].join('、') || '暂无';
}
// A rebuild moves every RVA, so we cannot fingerprint builds we have never
// seen. What does survive a rebuild is the source-level literal the session
// reader anchors on, unless the class itself was rewritten. Finding it turns
// "unknown build" into "almost certainly drivable", which is what keeps a
// first-time install possible when no adapted copy exists locally yet.
const SESSION_ANCHOR = Buffer.from('normal_key');
export async function countSessionAnchor(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const chunk = Buffer.allocUnsafe(8 * 1024 ** 2);
    const window = Buffer.allocUnsafe(chunk.length + SESSION_ANCHOR.length);
    let position = 0, carry = 0, found = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      chunk.copy(window, carry, 0, bytesRead);
      const total = carry + bytesRead;
      let index = 0;
      while ((index = window.indexOf(SESSION_ANCHOR, index)) >= 0) { found += 1; index += 1; }
      carry = Math.min(SESSION_ANCHOR.length - 1, total);
      window.copy(window, 0, total - carry, total);
      position += bytesRead;
    }
    return found;
  } catch { return 0; } finally { await handle?.close(); }
}
export async function extractDeb(file, destination, appRoot, runtimeRoot, onProgress, signal) {
  if (process.platform !== 'linux') throw new AppError('请在 NAS 中安装微信', 409);
  signal?.throwIfAborted();
  const target = architecture();
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(runtimeRoot, 'usr/bin/python3.11'), [path.join(appRoot, 'server/install-deb.py'), file, destination, target.deb], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONHOME: path.join(runtimeRoot, 'usr'), PYTHONPATH: '', PYTHONNOUSERSITE: '1', LD_LIBRARY_PATH: runtimeLibraries(runtimeRoot) }
    });
    const output = new ExtractionOutput(onProgress);
    let outputError = null, err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', x => {
      if (outputError) return;
      try { output.push(x); } catch (error) { outputError = error; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', x => { err = (err + x).slice(-2000); });
    child.on('error', e => { cleanup(); reject(e); });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) return reject(signal.reason);
      if (outputError) return reject(new AppError('无法识别安装进度，请重试'));
      if (code !== 0) return reject(new AppError(/请选择|安装包|无法识别/.test(err) ? err.trim().slice(0, 160) : '安装未完成，请重新下载后重试'));
      try { resolve(output.finish()); } catch { reject(new AppError('无法识别安装结果，请重试')); }
    });
  });
}

export class PackageLibrary {
  constructor({ dataRoot, appRoot, fetcher = fetch, extract = extractDeb, dev = false, trustedHashes, arch = process.arch }) {
    this.arch = architecture(arch); this.sourceUrl = officialWechatUrl(arch);
    this.root = path.join(dataRoot, 'applications/wechat'); this.appRoot = appRoot; this.runtimeRoot = path.join(dataRoot, 'runtime');
    this.fetcher = fetcher; this.extract = extract; this.dev = dev; this.job = null; this.current = null; this.working = null; this.trustedHashes = trustedHashes;
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Holds deb copies of builds Qibox is known to work with. Installing from
    // here needs no network and can never drift to a build we cannot drive.
    await mkdir(path.join(this.root, 'packages'), { recursive: true, mode: 0o700 });
    const policy = await jsonFile(path.join(this.appRoot, 'config/wechat.json'), { trustedImports: [] });
    const imports = policy.trustedImports.filter(x => (x.arch || 'x64') === this.arch.node);
    this.importVersions = imports.map(x => x.version);
    this.trustedImports = imports;
    this.trustedHashes ??= imports.map(x => x.sha256);
    this.current = await jsonFile(path.join(this.root, 'current.json'), null);
    if (this.current) {
      if ((this.current.arch || 'x64') !== this.arch.node) { this.current = null; this.job = { status: 'error', message: '设备架构已变化，请重新安装微信' }; }
    }
    if (this.current) {
      if (!/^[a-f0-9]{64}$/.test(this.current.sha256) || !/^\d+(?:\.\d+){1,5}$/.test(this.current.version)) throw new Error('Invalid installed package metadata');
      try { await access(path.join(this.root, 'versions', this.current.sha256, 'opt/wechat')); }
      catch { this.current = null; this.job = { status: 'error', message: '微信文件缺失，请重新安装' }; }
    }
    // Recover interrupted downloads/installations only in our disposable work directory.
    const jobs = path.join(this.root, 'jobs');
    await mkdir(jobs, { recursive: true, mode: 0o700 });
    for (const name of await readdir(jobs)) if (/^[a-f0-9-]{36}$/.test(name)) await rm(within(jobs, path.join(jobs, name)), { recursive: true, force: true });
  }
  async pooledPackages() {
    const dir = path.join(this.root, 'packages');
    const pool = [];
    for (const name of await readdir(dir)) {
      if (!name.toLowerCase().endsWith('.deb')) continue;
      const file = path.join(dir, name);
      try {
        const sha256 = await hashFile(file);
        const entry = (this.trustedImports || []).find(x => x.sha256 === sha256);
        pool.push({ name, file, sha256, size: (await stat(file)).size, version: entry?.version || null, adapted: !!entry });
      } catch { /* ignore files we cannot read */ }
    }
    return pool.sort((a, b) => Number(b.adapted) - Number(a.adapted) || a.name.localeCompare(b.name));
  }
  installed() { return this.current ? { ...this.current, directory: path.join(this.root, 'versions', this.current.sha256) } : null; }
  publicState() {
    const job = this.job ? { ...this.job, ...(this.transfer ? this.transfer.snapshot() : {}) } : null;
    const installed = this.current ? { version: this.current.version, installedAt: this.current.installedAt, sha256: this.current.sha256, adapted: (this.trustedHashes || []).includes(this.current.sha256), support: (this.trustedHashes || []).includes(this.current.sha256) ? 'adapted' : this.current.compatible === false ? 'unknown' : 'compatible' } : null;
    return { installed, job, sourceUrl: this.sourceUrl, architecture: this.arch.label, importVersions: this.importVersions, supported: supportedVersions(this), ...(this.unverified ? { runningUnadapted: this.unverified } : {}) };
  }
  uninstall({ clearData } = {}) {
    if (this.working) throw new AppError('正在处理微信，请稍候', 409);
    this.uninstalling = true; this.job = { status: 'uninstalling', message: '正在卸载微信', progress: null };
    this.working = Promise.resolve().then(async () => {
      try {
        // Stop every process before removing shared executables. User homes are
        // stored outside this library and are never part of package removal.
        await this.beforeUninstall?.();
        await clearData?.();
        await atomicJson(path.join(this.root, 'current.json'), null); this.current = null;
        await rm(within(this.root, path.join(this.root, 'versions')), { recursive: true, force: true });
        this.job = null; return this.publicState();
      } catch (error) {
        this.job = { status: 'error', message: '卸载未完成，请重试' };
        throw error instanceof AppError ? error : new AppError('卸载未完成，请重试', 503);
      } finally { this.uninstalling = false; this.working = null; }
    });
    return this.working;
  }
  assertCanInstall() { if (this.dev && this.extract === extractDeb) throw new AppError('请将栖盒安装到 NAS 后下载安装微信', 409); }
  download({ allowUnverified = false } = {}) {
    if (this.current || this.working) return this.publicState();
    this.assertCanInstall();
    // Launch synchronously: callers await this.working and rely on it being set
    // by the time download() returns, and the working guard above must be able
    // to stop a second call. An awaited lookup before launch would defer both.
    this.allowUnverified = allowUnverified === true;
    this.launch('download', async (file, signal) => {
      // Prefer a build Qibox is adapted to. The official URL only ever serves
      // whatever Tencent published last, so installing straight from it can
      // land on a version nothing here knows how to drive.
      const pool = (await this.pooledPackages()).find(item => item.adapted);
      if (pool) {
        await pipeline(createReadStream(pool.file), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
        return;
      }
      const response = await this.fetcher(this.sourceUrl, { redirect: 'error', signal, headers: { 'Accept-Encoding': 'identity' } });
      if (!response.ok || !response.body) throw new AppError('下载失败，请检查 NAS 网络后重试', 503);
      const declaredSize = response.headers.get('content-length');
      if (declaredSize != null && !/^\d+$/.test(declaredSize)) throw new AppError('无法读取下载大小，请重试');
      // Fetch decodes HTTP content encodings. An encoded length is not the
      // length of the decoded bytes, so never use it as a percentage denominator.
      const encoded = response.headers.get('content-encoding');
      const size = encoded && encoded.toLowerCase() !== 'identity' ? 0 : Number(declaredSize || 0);
      if (!Number.isSafeInteger(size) || size > MAX_PACKAGE) throw new AppError('安装包过大，请从官网下载后导入');
      await this.saveStream(Readable.fromWeb(response.body), file, size, signal);
    });
    return this.publicState();
  }
  upload(stream, size) {
    if (this.current) throw new AppError('微信已安装，可以直接添加微信', 409);
    if (this.working) throw new AppError('正在安装，请稍候', 409);
    this.assertCanInstall();
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE) throw new AppError('请选择 1 GB 以内的微信 deb 安装包', 413);
    this.launch('upload', (file, signal) => this.saveStream(stream, file, size, signal));
    return this.working;
  }
  importNas(nas, uid, file) {
    if (this.current) throw new AppError('微信已安装，可以直接添加微信', 409);
    if (this.working) throw new AppError('正在安装，请稍候', 409);
    this.assertCanInstall();
    if (typeof file !== 'string' || !file.toLowerCase().endsWith('.deb')) throw new AppError('请选择微信 deb 安装包');
    this.launch('import', async (destination, signal) => {
      const { handle, info } = await nas.openFile(uid, file);
      try { await this.saveStream(handle.createReadStream({ autoClose: false }), destination, info.size, signal); }
      finally { await handle.close(); }
    });
    return this.publicState();
  }
  async saveStream(stream, file, size, signal) {
    if (size < 0 || size > MAX_PACKAGE) throw new AppError('请选择 1 GB 以内的微信 deb 安装包', 413);
    await ensureSpace(this.root, Math.max(size, 512 * 1024 ** 2) + 3 * 1024 ** 3);
    const transfer = this.transfer = new TransferProgress(size);
    const meter = new Transform({ transform(chunk, _, callback) {
      if (transfer.bytes + chunk.length > MAX_PACKAGE) return callback(new AppError('安装包过大', 413));
      if (size && transfer.bytes + chunk.length > size) return callback(new AppError('安装包大小不符，请重新下载'));
      transfer.receive(chunk.length);
      callback(null, chunk);
    } });
    await pipeline(stream, meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    if (size && transfer.bytes !== size) throw new AppError('安装包不完整，请重新下载');
    const handle = await open(file, 'r'); const magic = Buffer.alloc(8);
    try { await handle.read(magic, 0, 8, 0); } finally { await handle.close(); }
    if (magic.toString() !== '!<arch>\n') throw new AppError('请选择 Linux 微信的 deb 安装包');
  }
  launch(source, obtain) {
    const id = randomUUID();
    this.transfer = null;
    this.job = { id, source, status: source === 'download' ? 'downloading' : 'uploading', progress: null, message: source === 'download' ? '正在下载微信' : '正在导入安装包' };
    this.controller = new AbortController();
    this.working = this.perform(id, obtain, this.controller.signal).catch(error => {
      this.lastError = String(error.stack || error);
      this.transfer = null;
      this.job = { id, status: 'error', progress: 0, message: '安装未完成，请重试' };
      return this.publicState();
    }).finally(() => { this.working = null; this.controller = null; });
    // Errors are recorded in job, never left as unhandled background rejections.
    return this.working;
  }
  async perform(id, obtain, signal) {
    const folder = within(this.root, path.join(this.root, 'jobs', id));
    const timer = setTimeout(() => this.controller?.abort(), 15 * 60 * 1000);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, 'wechat.deb');
      await obtain(file, signal); signal.throwIfAborted();
      const source = this.job.source; this.transfer = null;
      const stage = (name, message) => { this.job = { id, source, status: 'installing', stage: name, progress: null, message }; };
      const measured = (bytes, total) => { this.job.bytes = bytes; this.job.total = total; this.job.progress = total ? Math.floor(bytes / total * 100) : null; };
      stage('preparing', '正在准备安装');
      await this.beforeInstall?.(); signal.throwIfAborted();
      stage('verifying', '正在校验安装包');
      const { size } = await stat(file); measured(0, size);
      const sha256 = await hashFile(file, bytes => measured(bytes, size)), extracted = path.join(folder, 'extracted');
      stage('inspecting', '正在检查安装包');
      await mkdir(extracted, { mode: 0o700 });
      const metadata = await this.extract(file, extracted, this.appRoot, this.runtimeRoot, event => {
        if (this.job.stage !== 'extracting') stage('extracting', '正在解压微信文件');
        measured(event.bytes, event.total);
      }, signal);
      signal.throwIfAborted();
      if (metadata.arch && metadata.arch !== this.arch.deb) throw new AppError('安装包与设备架构不符');
      if (!/^\d+(?:\.\d+){1,5}$/.test(metadata.version)) throw new AppError('无法识别微信版本');
      const adapted = this.trustedHashes.includes(sha256);
      let anchored = 0;
      if (!adapted) {
        // An install the owner asked for must not be blocked merely because the
        // build is newer than our fingerprint file; Tencent only ever serves the
        // newest one, so refusing would strand every fresh install. Only a build
        // that no longer carries the anchor is genuinely unknown, and that is
        // the single case worth stopping on.
        anchored = await countSessionAnchor(path.join(extracted, 'opt/wechat/wechat'));
        if (!anchored && !this.allowUnverified)
          throw new AppError(`微信 ${metadata.version} 与栖盒适配的版本结构差异较大（已适配版本：${supportedVersions(this)}），自动发送、语音转文字、当前会话识别可能无法使用。`, 409);
        this.unverified = { version: metadata.version, sha256, compatible: anchored > 0 };
      }
      stage('finalizing', '正在完成安装');
      const versions = path.join(this.root, 'versions'); await mkdir(versions, { recursive: true, mode: 0o700 });
      const destination = within(versions, path.join(versions, sha256));
      // Only a complete extraction can become current. Failed installs leave users' data untouched.
      try { await access(destination); await rm(destination, { recursive: true, force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await rename(extracted, destination);
      await rename(file, path.join(destination, 'installer.deb'));
      const current = { version: metadata.version, sha256, arch: this.arch.node, installedAt: new Date().toISOString(), ...(adapted ? {} : { compatible: anchored > 0 }) };
      await atomicJson(path.join(this.root, 'current.json'), current); this.current = current;
      this.job = { id, status: 'complete', progress: 100, message: '微信已安装' };
    } catch (error) {
      this.transfer = null;
      this.job = { id, status: 'error', progress: 0, message: error instanceof AppError ? error.message : signal.aborted ? '安装已中断，请重试' : '安装未完成，请检查网络或安装包后重试' };
      this.lastError = String(error.stack || error);
    } finally { clearTimeout(timer); this.allowUnverified = false; await rm(folder, { recursive: true, force: true }); }
    return this.publicState();
  }
  async close() { this.controller?.abort(); await this.working; }
}
