import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, rename, stat, writeFile, open } from 'node:fs/promises';
import { AppError, atomicJson, jsonFile, ensureSpace, hashFile } from './files.mjs';
import { DurableDownload } from './durable-download.mjs';
import { MAX_PACKAGE } from './packages.mjs';

const compare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
async function durableJson(file, value) {
  await atomicJson(file, value);
  const handle = await open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  if (process.platform !== 'win32') { const dir = await open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
}
// The official HTTPS endpoint supplies its full-object MD5. This is a transfer
// checksum, not an application signature. Structural/ELF and clean-home launch
// verification are separate mandatory boundaries before publication.
export class WechatUpdate {
  constructor({ library, users, dataRoot, validateProgram, fetcher = fetch }) {
    Object.assign(this, { library, users, dataRoot, validateProgram, fetcher });
    this.root = path.join(library.root, 'manual-update'); this.state = null; this.confirmations = new Map();
    library.manualUpdate = () => this.snapshot();
    library.updateHolds = new Set();
    library.releaseUpdateHold = async key => { library.updateHolds.delete(key); await this.save(); };
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const saved = await jsonFile(path.join(this.root, 'state.json'), {});
    this.library.updateHolds = new Set((saved.holds || []).filter(x => typeof x === 'string' && x.startsWith(path.join(this.dataRoot, 'users') + path.sep)));
    this.resource = saved.resource;
    this.state = saved.state ? { ...saved.state, ...(['downloading', 'verifying', 'installing'].includes(saved.state.status) ? { status: 'paused', message: '上次更新已中断，请主动继续；原程序和数据已保留' } : {}) } : null;
    // No network request and no automatic download/install on startup.
    if (this.resource && this.state?.status === 'paused') await this.downloader();
    if (saved.transaction?.previous) this.transaction = saved.transaction;
  }
  snapshot() {
    const transfer = this.transfer?.snapshot();
    return this.state ? { ...this.state, ...(this.state.stage === 'download' && transfer ? { bytes: transfer.bytes, total: transfer.total, progress: transfer.total ? Math.floor(transfer.bytes / transfer.total * 100) : null } : {}) } : null;
  }
  save() {
    const value = { state: this.state, resource: this.resource, holds: [...this.library.updateHolds], transaction: this.transaction };
    this.saves = (this.saves || Promise.resolve()).catch(() => {}).then(() => durableJson(path.join(this.root, 'state.json'), value));
    return this.saves;
  }
  async affected() {
    const result = [];
    for (const uid of this.users.uids) {
      const catalog = await jsonFile(path.join(this.dataRoot, 'users', uid, 'instances.json'), []);
      for (const item of catalog) if (!item.removedAt && (!item.appId || item.appId === 'wechat')) result.push({ key: `${uid}/${item.id}`, name: item.name, running: this.users.spaces.get(uid)?.instances.get(item.id)?.runtime.status === 'running' });
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }
  async preview() {
    if (!this.library.current) throw new AppError('请先安装微信', 409);
    const affected = await this.affected(), token = randomUUID();
    let source = null, sourceError = null;
    try {
      const response = await this.fetcher(this.library.sourceUrl, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`官方来源返回 ${response.status}`);
      const size = Number(response.headers.get('content-length')), md5 = response.headers.get('x-cos-meta-md5');
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE || !/^[a-f0-9]{32}$/i.test(md5 || '')) throw new Error('官方来源未提供可验证的大小和整包校验值，请导入官方 deb 包');
      source = { id: `wechat-manual-${this.library.arch.node}`, version: md5.toLowerCase(), url: this.library.sourceUrl, size, md5: md5.toLowerCase() };
    } catch (error) { sourceError = error.message; }
    const current = this.library.current;
    this.confirmations.set(token, { expires: Date.now() + 15 * 60000, current: current.sha256, keys: affected.map(x => x.key).join(','), source });
    for (const [key, value] of this.confirmations) if (value.expires < Date.now()) this.confirmations.delete(key);
    return { token, current: { version: current.version }, affected: affected.map(({ name, running }) => ({ name, running })), source: source ? { size: source.size, url: source.url, checksumAlgorithm: 'md5' } : null, sourceError,
      warning: '更新会关闭下列所有用户的微信实例，完成后请手动打开。账号、聊天记录与设置保留。旧程序保留；新程序使用过数据后不能直接回退，需兼容的数据备份。' };
  }
  async confirm(token) {
    if (this.working || this.library.working || this.library.updating || this.library.uninstalling || this.reserved) throw new AppError('正在处理微信，请稍候', 409);
    // Reserve before the asynchronous instance scan. A later scan can finish
    // first, but must not steal the first request's update transaction.
    this.reserved = true;
    try {
      const affected = await this.affected(), value = this.confirmations.get(token);
      if (this.working || this.library.working || this.library.updating || this.library.uninstalling) throw new AppError('正在处理微信，请稍候', 409);
      if (!value || value.expires < Date.now() || value.current !== this.library.current?.sha256 || value.keys !== affected.map(x => x.key).join(',')) throw new AppError('更新确认已过期或受影响实例已变化，请重新确认', 409);
      this.confirmations.delete(token); this.library.updating = true; return value;
    } catch (error) { this.reserved = false; throw error; }
  }
  async downloader() {
    if (!this.transfer) {
      this.transfer = new DurableDownload({ directory: path.join(this.root, 'downloads'), fetcher: this.fetcher, autoResume: false, onChange: () => this.save() });
      await this.transfer.init(this.resource);
    }
    return this.transfer;
  }
  async download(token) {
    const value = await this.confirm(token);
    try {
    if (!value.source) throw new AppError('无法校验官方来源，请重新检查或导入官方 deb 包', 409);
    if (this.resource?.md5 !== value.source.md5) { await this.transfer?.close(); this.transfer = null; }
    this.resource = value.source;
    await this.downloader();
    return this.launch('download', async () => {
      this.state.stage = 'download'; await this.save();
      if (this.pauseRequested) return null;
      this.transfer.start(); await this.transfer.working;
      const state = this.transfer.snapshot();
      if (this.pauseRequested || state.status === 'paused') return null;
      if (state.status !== 'complete') throw new Error(state.error || '下载未完成');
      return this.transfer.file;
    });
    } finally { this.reserved = false; if (!this.working) this.library.updating = false; }
  }
  async pause() {
    if (this.state?.stage !== 'download' || !this.transfer) return this.snapshot();
    this.pauseRequested = true;
    await this.transfer.pause(); await this.working;
    if (this.state?.status !== 'complete') { this.state = { ...this.state, status: 'paused', message: '下载已暂停，可主动继续' }; await this.save(); }
    return this.snapshot();
  }
  async upload(token, stream, size) {
    await this.confirm(token);
    try {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE) throw new AppError('请选择 1 GB 以内的微信 deb 安装包', 413);
    const file = path.join(this.root, `${randomUUID()}.deb`);
    this.launch('upload', async () => { await this.library.saveStream(stream, file, size); this.library.transfer = null; return file; }, file);
    await this.working; return this.snapshot();
    } finally { this.reserved = false; if (!this.working) this.library.updating = false; }
  }
  async importNas(token, nas, uid, name) {
    if (typeof name !== 'string' || !name.toLowerCase().endsWith('.deb')) throw new AppError('请选择官方微信 deb 安装包');
    const { handle, info } = await nas.openFile(uid, name);
    try { return await this.upload(token, handle.createReadStream({ autoClose: false }), info.size); }
    finally { await handle.close(); }
  }
  launch(source, obtain, disposable) {
    this.library.updating = true;
    this.pauseRequested = false;
    this.state = { status: source === 'download' ? 'downloading' : 'installing', source, stage: source === 'download' ? 'download' : 'upload', progress: null, message: source === 'download' ? '正在下载官方微信' : '正在导入官方安装包' };
    this.working = (async () => {
      await this.save();
      const file = await obtain();
      if (!file) { this.state = { ...this.state, status: 'paused', message: '下载已暂停，可主动继续' }; return; }
      await this.install(file);
    })().catch(async error => {
      this.state = { ...this.state, status: 'error', error: error.message, message: `更新未完成：${error.message}` };
      await writeFile(path.join(this.root, 'last-error.log'), `${new Date().toISOString()}\n${error.stack || error}\n`, { mode: 0o600 }).catch(logError => { console.error(`微信更新错误日志写入失败：${logError.code || logError.message}`); });
    }).finally(async () => {
      try {
        if (disposable) await rm(disposable, { force: true });
        await this.save();
      } catch (error) {
        this.state = { ...this.state, status: 'error', error: error.message, message: `更新记录或临时文件处理失败：${error.message}；请检查存储，原资料保留` };
        console.error(`微信更新收尾失败：${error.code || error.message}`);
      } finally { if (source !== 'download') this.library.transfer = null; this.library.updating = false; this.working = null; }
    });
    return this.snapshot();
  }
  async install(file) {
    await this.library.beforeInstall?.();
    const sha256 = await hashFile(file), previous = this.library.current;
    if (sha256 === previous.sha256) { this.state = { status: 'complete', progress: 100, message: `已安装相同的微信 ${previous.version}，无需切换` }; return; }
    await ensureSpace(this.root, (await stat(file)).size + 3 * 1024 ** 3);
    const work = path.join(this.root, `stage-${randomUUID()}`); await mkdir(work, { mode: 0o700 });
    let published = false;
    try {
      this.state = { ...this.state, status: 'installing', stage: 'extracting', message: '正在校验和解压新程序', progress: null };
      const extracted = path.join(work, 'program'); await mkdir(extracted);
      const metadata = await this.library.extract(file, extracted, this.library.appRoot, this.library.runtimeRoot, event => {
        this.state = { ...this.state, bytes: event.bytes, total: event.total, progress: event.total ? Math.floor(event.bytes / event.total * 100) : null };
      });
      if (!/^\d+(?:\.\d+){1,5}$/.test(metadata.version) || metadata.arch && metadata.arch !== this.library.arch.deb) throw new AppError('无法确认新程序的版本或设备架构');
      if (compare(metadata.version, previous.version) < 0) throw new AppError('不能直接降级微信：旧程序可能无法读取当前数据。请使用与旧程序匹配的完整数据备份恢复');
      this.state = { ...this.state, stage: 'selftest', message: '正在使用隔离资料验证新程序', progress: null };
      await this.validateProgram(extracted, metadata, work);
      // No user home is opened by the validation above. Holds are persisted
      // before stopping processes, so a crash/restart cannot auto-open old
      // executables against data already touched by the new version.
      for (const item of await this.affected()) this.library.updateHolds.add(path.join(this.dataRoot, 'users', item.key.split('/')[0], 'instances', item.key.split('/')[1]));
      this.transaction = { previous, next: { version: metadata.version, sha256 }, phase: 'stopping' }; await this.save();
      await this.users.stopForUpdate();
      for (const item of await this.affected()) this.library.updateHolds.add(path.join(this.dataRoot, 'users', item.key.split('/')[0], 'instances', item.key.split('/')[1]));
      await this.save();
      const versions = path.join(this.library.root, 'versions'); await mkdir(versions, { recursive: true, mode: 0o700 });
      const destination = path.join(versions, sha256);
      // This exact hash is not current and was just independently re-extracted
      // and validated. It can only be abandoned program output, never a home.
      if (await stat(destination).catch(() => null)) await rm(destination, { recursive: true, force: true });
      await rename(extracted, destination); published = true;
      const { copyFile } = await import('node:fs/promises'); await copyFile(file, path.join(destination, 'installer.deb'));
      const current = { version: metadata.version, sha256, arch: this.library.arch.node, installedAt: new Date().toISOString() };
      this.transaction.phase = 'validated'; await this.save();
      await durableJson(path.join(this.library.root, 'current.json'), current); this.library.current = current;
      this.transaction.phase = 'switched'; await this.save();
      this.state = { status: 'complete', progress: 100, message: `微信已更新至 ${metadata.version}，请手动打开原微信实例` };
    } catch (error) {
      // Never roll the binary back after publication: user data formats can
      // change on first launch. A switch failure retains the prior pointer.
      const pointer = await jsonFile(path.join(this.library.root, 'current.json'), previous);
      this.library.current = pointer;
      if (published && pointer.sha256 === previous.sha256) await rm(path.join(this.library.root, 'versions', sha256), { recursive: true, force: true });
      throw error;
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  async close() { await this.transfer?.pause(); await this.working; await this.save(); }
}
