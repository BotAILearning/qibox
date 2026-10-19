import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, rename, open, access, readdir, stat, readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, atomicJson, jsonFile, hashFile, ensureSpace, within } from './files.mjs';
import { TransferProgress, ExtractionOutput } from './progress.mjs';
import { architecture, officialWechatUrl, runtimeLibraries } from './platform.mjs';
import { DurableDownload, resourcePaths } from './durable-download.mjs';

export const OFFICIAL_URL = 'https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb';
export const MAX_PACKAGE = 1024 ** 3;
export function supportedVersions(library) {
  return [...new Set(library.importVersions || [])].join('、') || '暂无';
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
  constructor({ dataRoot, appRoot, fetcher = fetch, extract = extractDeb, dev = false, trustedHashes, arch = process.arch, downloadSource, downloadAllowHttp = false, deferResume = false }) {
    this.arch = architecture(arch); this.sourceUrl = officialWechatUrl(arch);
    this.root = path.join(dataRoot, 'applications/wechat'); this.appRoot = appRoot; this.runtimeRoot = path.join(dataRoot, 'runtime');
    this.fetcher = fetcher; this.extract = extract; this.dev = dev; this.job = null; this.current = null; this.working = null;
    this.suppliedTrustedHashes = trustedHashes; this.downloadSourceOverride = downloadSource; this.downloadAllowHttp = downloadAllowHttp; this.deferResume = deferResume;
    this.downloadRoot = path.join(this.root, 'downloads'); this.downloadStateFile = path.join(this.root, 'download.json'); this.downloadPersistQueue = Promise.resolve();
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
    this.adaptedHashes = this.suppliedTrustedHashes ? [...this.suppliedTrustedHashes] : imports.map(x => x.sha256);
    this.downloadSource = this.downloadSourceOverride || policy.downloads?.[this.arch.node] || null;
    this.trustedHashes = [...new Set([...this.adaptedHashes, ...(this.downloadSource?.sha256 ? [this.downloadSource.sha256] : [])])];
    await mkdir(this.downloadRoot, { recursive: true, mode: 0o700 });
    const savedDownload = await jsonFile(this.downloadStateFile, null);
    this.current = await jsonFile(path.join(this.root, 'current.json'), null);
    if (this.current) {
      if ((this.current.arch || 'x64') !== this.arch.node) { this.current = null; this.job = { status: 'error', message: '设备架构已变化，请重新安装微信' }; }
    }
    if (this.current) {
      if (!/^[a-f0-9]{64}$/.test(this.current.sha256) || !/^\d+(?:\.\d+){1,5}$/.test(this.current.version)) throw new Error('Invalid installed package metadata');
      try { await access(path.join(this.root, 'versions', this.current.sha256, 'opt/wechat')); }
      catch { this.current = null; this.job = { status: 'error', message: '微信文件缺失，请重新安装' }; }
    }
    this.downloadReusableBytes = this.current ? 0 : null;
    this.pooledCacheAvailable = (await this.pooledPackages()).some(item => item.adapted);
    if (!this.current && this.pooledCacheAvailable) this.downloadReusableBytes = 0;
    // Recover interrupted downloads/installations only in our disposable work directory.
    const jobs = path.join(this.root, 'jobs');
    await mkdir(jobs, { recursive: true, mode: 0o700 });
    for (const name of await readdir(jobs)) if (/^[a-f0-9-]{36}$/.test(name)) await rm(within(jobs, path.join(jobs, name)), { recursive: true, force: true });
    if (this.current) {
      await rm(this.downloadStateFile, { force: true });
    } else if (savedDownload?.job?.source === 'download' && savedDownload.resource && ['downloading', 'verifying', 'paused', 'complete'].includes(savedDownload.state)) {
      const resource = savedDownload.resource;
      const remotePinned = this.downloadSource && resource.sha256 === this.downloadSource.sha256 && resource.size === this.downloadSource.size && resource.version === this.downloadSource.version && resource.url === this.downloadSource.url;
      const poolPinned = savedDownload.mode === 'pool' && this.adaptedHashes.includes(resource.sha256);
      if (this.trustedHashes.includes(resource.sha256) && (remotePinned || poolPinned)) {
        this.downloadResource = resource; this.downloadMode = savedDownload.mode === 'pool' ? 'pool' : 'remote';
        this.job = { ...savedDownload.job, status: savedDownload.state === 'paused' ? 'paused' : 'downloading' };
        this.pendingDownloadRestore = savedDownload;
        await this.inspectCachedDownload(resource);
        if (!this.deferResume) await this.resumePendingDownload();
      } else {
        this.job = { ...savedDownload.job, status: 'error', message: '微信固定下载版本已变化，请检查配置或离线导入' };
        await rm(this.downloadStateFile, { force: true });
      }
    }
    if (!this.current && !this.downloadResource && this.downloadSource?.sha256) {
      const source = this.downloadSource;
      await this.inspectCachedDownload({ id: `wechat-${this.arch.node}-${source.version}`, version: source.version, url: source.url, size: source.size, sha256: source.sha256 });
    }
    if (this.downloadSource && this.downloadReusableBytes === null) this.downloadReusableBytes = this.downloadSource.size;
  }
  async inspectCachedDownload(resource) {
    if (this.current) { this.downloadReusableBytes = 0; return 0; }
    const pin = this.downloadSource;
    const samePin = pin && pin.sha256 === resource.sha256 && pin.size === resource.size && pin.version === resource.version && pin.url === resource.url;
    if (!samePin) { this.downloadReusableBytes = this.pooledCacheAvailable ? 0 : null; return this.downloadReusableBytes; }
    const paths = resourcePaths(resource);
    const cache = path.join(this.downloadRoot, paths.cache);
    const cached = await stat(cache).catch(() => null);
    if (cached?.isFile() && cached.size === resource.size && await hashFile(cache) === resource.sha256) {
      this.downloadReusableBytes = 0; this.downloadCacheAvailable = true; return 0;
    }
    const [saved, part] = await Promise.all([
      readFile(path.join(this.downloadRoot, paths.state), 'utf8').then(JSON.parse).catch(() => null),
      stat(path.join(this.downloadRoot, paths.part)).catch(() => null),
    ]);
    const checkpoint = saved?.resource?.id === resource.id && saved.resource?.version === resource.version && saved.resource?.url === resource.url && saved.resource?.size === resource.size && saved.resource?.sha256 === resource.sha256 && Number.isSafeInteger(saved.meta?.checkpoint) && part?.isFile() && part.size >= saved.meta.checkpoint && saved.meta.checkpoint <= resource.size ? saved.meta.checkpoint : 0;
    this.downloadReusableBytes = resource.size - checkpoint;
    return this.downloadReusableBytes;
  }
  resumePendingDownload() {
    if (!this.pendingDownloadRestore || this.current) return Promise.resolve(this.publicState());
    const saved = this.pendingDownloadRestore; this.pendingDownloadRestore = null;
    this.transfer = this.makeDownloader(this.downloadResource);
    const init = this.transfer.init(this.downloadResource).then(() => {
      if (saved.state !== 'paused') this.resumeDownload();
      else this.job = { ...this.job, status: 'paused', message: '下载已暂停，可继续下载' };
      return this.publicState();
    }).catch(error => {
      this.job = { ...this.job, status: 'error', message: `下载恢复失败：${error.message}` };
      return this.publicState();
    });
    this.pendingResume = init;
    return init;
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
    const transfer = this.transfer?.snapshot();
    const meter = this.downloadMeter?.snapshot();
    const job = this.job ? { ...this.job, ...(transfer ? { bytes: transfer.bytes, total: transfer.total,
      progress: transfer.total ? Math.floor(transfer.bytes / transfer.total * 100) : null,
      ...(transfer.status ? { status: transfer.status === 'verifying' ? 'downloading' : transfer.status } : {}), ...(meter ? { bytesPerSecond: meter.bytesPerSecond } : {}) } : {}) } : null;
    const installed = this.current ? { version: this.current.version, installedAt: this.current.installedAt, sha256: this.current.sha256, adapted: (this.adaptedHashes || []).includes(this.current.sha256) } : null;
    const remainingDownloadSize = this.current ? 0 : transfer ? Math.max(0, transfer.total - transfer.bytes) : this.downloadReusableBytes ?? (this.pooledCacheAvailable ? 0 : this.downloadSource?.size ?? null);
    return { installed, job, sourceUrl: this.sourceUrl, downloadSize: this.downloadSource?.size ?? null, remainingDownloadSize, architecture: this.arch.label, importVersions: this.importVersions, supported: supportedVersions(this) };
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
  download(_options = {}) {
    if (this.current || this.working) return this.publicState();
    if (this.transfer && this.downloadResource) return this.resumeDownload();
    this.assertCanInstall();
    // Launch synchronously: callers await this.working and rely on it being set
    // by the time download() returns, and the working guard above must be able
    // to stop a second call. An awaited lookup before launch would defer both.
    this.launch('download', (file, signal) => this.obtainDownload(file, signal));
    return this.publicState();
  }
  makeDownloader(resource) {
    this.downloadMeter = new TransferProgress(resource.size);
    return new DurableDownload({ directory: this.downloadRoot, fetcher: this.fetcher, allowHttp: this.downloadAllowHttp,
      onChange: state => this.persistDownloadState(state) });
  }
  async persistDownloadState(state = this.transfer?.snapshot()) {
    if (!this.downloadResource || !this.job || this.job.source !== 'download' || !state) return;
    this.downloadReusableBytes = Math.max(0, state.total - state.bytes);
    if (!this.downloadMeter || state.bytes < this.downloadMeter.bytes) this.downloadMeter = new TransferProgress(state.total || this.downloadResource.size);
    if (state.bytes > this.downloadMeter.bytes) this.downloadMeter.receive(state.bytes - this.downloadMeter.bytes);
    const saved = { job: { id: this.job.id, source: this.job.source, message: this.job.message }, mode: this.downloadMode, resource: this.downloadResource, state: state.status };
    this.downloadPersistQueue = this.downloadPersistQueue.catch(() => {}).then(() => atomicJson(this.downloadStateFile, saved));
    await this.downloadPersistQueue;
  }
  async obtainDownload(destination, signal) {
    let pool = null;
    if (!this.downloadResource) {
      pool = (await this.pooledPackages()).find(item => item.adapted);
      if (pool) {
        const trusted = this.trustedImports.find(item => item.sha256 === pool.sha256);
        this.downloadResource = { id: `wechat-${this.arch.node}-${pool.sha256}`, version: pool.version || trusted?.version || 'trusted-import',
          url: trusted?.source || this.sourceUrl, size: pool.size, sha256: pool.sha256 };
        this.downloadMode = 'pool';
      } else {
        const source = this.downloadSource;
        if (!source || !Number.isSafeInteger(source.size) || source.size <= 0 || source.size > MAX_PACKAGE || !/^[a-f0-9]{64}$/.test(source.sha256 || '') || !source.version || !source.url)
          throw new AppError('没有可校验的微信固定版本，请从官网下载后离线导入', 409);
        if (!this.trustedHashes.includes(source.sha256)) throw new AppError('微信固定下载版本不在可信列表中，请从官网下载后离线导入', 409);
        this.downloadResource = { id: `wechat-${this.arch.node}-${source.version}`, version: source.version, url: source.url, size: source.size, sha256: source.sha256 };
        this.downloadMode = 'remote';
      }
    } else if (this.downloadMode === 'pool') {
      pool = (await this.pooledPackages()).find(item => item.sha256 === this.downloadResource.sha256 && item.adapted);
      if (!pool && this.transfer?.snapshot().status !== 'complete') throw new AppError('受信任的本地微信安装包已不存在，请重新导入', 409);
    }
    if (!this.trustedHashes.includes(this.downloadResource.sha256)) throw new AppError('微信固定下载版本不在可信列表中，请从官网下载后离线导入', 409);
    await this.inspectCachedDownload(this.downloadResource);
    await ensureSpace(this.root, Math.max(this.downloadResource.size, 512 * 1024 ** 2) + 3 * 1024 ** 3);
    this.transfer ||= this.makeDownloader(this.downloadResource);
    if (!this.transfer.resource) await this.transfer.init(this.downloadResource);
    if (this.downloadMode === 'pool' && this.transfer.snapshot().status !== 'complete') await this.transfer.importFile(pool.file);
    while (this.transfer.snapshot().status !== 'complete') {
      signal.throwIfAborted();
      let state = this.transfer.snapshot();
      if (state.status === 'error') {
        this.transfer.start(); await this.transfer.working;
        state = this.transfer.snapshot();
        if (state.status === 'error') throw new AppError(`微信固定版本下载未通过校验（${state.error || '来源不可用'}），请从官网下载后离线导入`, 409);
      }
      if (state.status === 'paused') await new Promise(resolve => { this.downloadResumeWaiter = resolve; });
      else { this.transfer.start(); await this.transfer.working; }
    }
    signal.throwIfAborted();
    await pipeline(createReadStream(this.transfer.file), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
    this.transfer = null;
  }
  async pauseDownload() {
    if (!this.transfer || this.job?.source !== 'download' || !['downloading', 'verifying'].includes(this.transfer.snapshot().status)) return this.publicState();
    const state = await this.transfer.pause();
    if (this.job) { this.job = { ...this.job, status: 'paused', message: '下载已暂停，可继续下载' }; await this.persistDownloadState(state); }
    return this.publicState();
  }
  resumeDownload() {
    if (!this.transfer || !this.downloadResource || this.job?.source !== 'download') return this.publicState();
    if (this.transfer.snapshot().status === 'paused') {
      this.job = { ...this.job, status: 'downloading', message: '正在下载微信' };
      this.transfer.start(); this.downloadResumeWaiter?.(); this.downloadResumeWaiter = null;
      void this.persistDownloadState();
    }
    if (!this.working) this.launch('download', (file, signal) => this.obtainDownload(file, signal));
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
    if (source !== 'download') this.transfer = null;
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
    let timer = null;
    let source = this.job?.source;
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, 'wechat.deb');
      await obtain(file, signal); signal.throwIfAborted();
      timer = setTimeout(() => this.controller?.abort(new Error('安装超时')), 180000);
      source = this.job.source; this.transfer = null;
      const stage = (name, message) => { this.job = { id, source, status: 'installing', stage: name, progress: null, message }; };
      const measured = (bytes, total) => { this.job.bytes = bytes; this.job.total = total; this.job.progress = total ? Math.floor(bytes / total * 100) : null; };
      stage('verifying', '正在校验安装包');
      const { size } = await stat(file); measured(0, size);
      const sha256 = await hashFile(file, bytes => measured(bytes, size)), extracted = path.join(folder, 'extracted');
      if (source === 'download' && (!this.trustedHashes.includes(sha256) || sha256 !== this.downloadResource?.sha256))
        throw new AppError('微信下载包未通过固定版本校验，请从官网下载后离线导入', 409);
      stage('preparing', '正在准备安装');
      await this.beforeInstall?.(); signal.throwIfAborted();
      stage('inspecting', '正在检查安装包');
      await mkdir(extracted, { mode: 0o700 });
      const metadata = await this.extract(file, extracted, this.appRoot, this.runtimeRoot, event => {
        if (this.job.stage !== 'extracting') stage('extracting', '正在解压微信文件');
        measured(event.bytes, event.total);
      }, signal);
      signal.throwIfAborted();
      if (metadata.arch && metadata.arch !== this.arch.deb) throw new AppError('安装包与设备架构不符');
      if (!/^\d+(?:\.\d+){1,5}$/.test(metadata.version)) throw new AppError('无法识别微信版本');
      stage('finalizing', '正在完成安装');
      const versions = path.join(this.root, 'versions'); await mkdir(versions, { recursive: true, mode: 0o700 });
      const destination = within(versions, path.join(versions, sha256));
      // Only a complete extraction can become current. Failed installs leave users' data untouched.
      try { await access(destination); await rm(destination, { recursive: true, force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await rename(extracted, destination);
      await rename(file, path.join(destination, 'installer.deb'));
      // Package integrity, architecture and version metadata are the install
      // boundary. Runtime capabilities are detected by their own readers; a
      // new build must not be rejected or warned about because its hash or a
      // private implementation literal is absent from an old allow-list.
      const current = { version: metadata.version, sha256, arch: this.arch.node, installedAt: new Date().toISOString() };
      await atomicJson(path.join(this.root, 'current.json'), current); this.current = current;
      this.job = { id, status: 'complete', progress: 100, message: '微信已安装' };
      if (source === 'download') { await this.downloadPersistQueue; await rm(this.downloadStateFile, { force: true }); }
    } catch (error) {
      if (this.closing && this.job?.source === 'download') {
        this.job = { ...this.job, id, source: 'download', status: 'downloading', message: '下载已保留，服务重启后继续' };
        await this.persistDownloadState();
      } else {
        this.transfer = null;
        this.job = { id, source, status: 'error', progress: 0, message: error instanceof AppError ? error.message : signal.aborted ? '安装已中断，请重试' : '安装未完成，请检查网络或安装包后重试' };
      }
      this.lastError = String(error.stack || error);
    } finally { if (timer) clearTimeout(timer); await rm(folder, { recursive: true, force: true }); }
    return this.publicState();
  }
  async close() {
    this.closing = true;
    if (this.transfer instanceof DurableDownload) await this.transfer.close();
    this.downloadResumeWaiter?.(); this.downloadResumeWaiter = null;
    this.controller?.abort();
    await this.working;
    this.closing = false;
  }
}
