import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, truncate } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const CHUNK_SIZE = 1024 * 1024;
const MAX_SIZE = 2 * 1024 * 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;
const hashPattern = /^[a-f\d]{64}$/i;
const md5Pattern = /^[a-f\d]{32}$/i;
const checksum = resource => resource.sha256 || resource.md5;

function digest(data) { return createHash('sha256').update(data).digest('hex'); }
function safeSize(value) { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SIZE; }
function header(response, name) { return response.headers?.get?.(name) ?? null; }
export function resourcePaths(resource) {
  if (!resource || typeof resource.id !== 'string' || typeof resource.version !== 'string' || !(hashPattern.test(resource.sha256 || '') || md5Pattern.test(resource.md5 || ''))) throw new TypeError('resource id/version/checksum invalid');
  const key = digest(`${resource.id}\0${resource.version}\0${checksum(resource).toLowerCase()}`);
  return { cache: `${checksum(resource).toLowerCase()}.cache`, part: `${key}.part`, chunk: `${key}.chunk`, state: `${key}.state.json` };
}

async function syncFile(path) {
  const handle = await open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function streamBounded(response, destination, limit, signal, onProgress) {
  const out = createWriteStream(destination, { flags: 'w' });
  const completed = new Promise((resolveEnd, reject) => { out.once('finish', resolveEnd); out.once('error', reject); });
  completed.catch(() => {});
  let bytes = 0;
  try {
    for await (const part of response.body) {
      if (signal.aborted) throw signal.reason ?? new Error('下载已停止');
      bytes += part.length;
      if (bytes > limit) throw new Error('下载内容超过预期长度');
      onProgress?.(bytes);
      if (!out.write(part)) await Promise.race([new Promise(resolveWrite => out.once('drain', resolveWrite)), completed]);
    }
    out.end();
    await completed;
  } catch (error) {
    out.destroy();
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    response.__durableCleanup?.();
  }
  return bytes;
}

export class DurableDownload {
  constructor({ directory, fetcher = fetch, allowHttp = false, onChange, autoResume = true } = {}) {
    if (!directory) throw new TypeError('directory is required');
    this.directory = resolve(directory);
    this.fetcher = fetcher;
    this.allowHttp = allowHttp;
    this.onChange = onChange;
    this.autoResume = autoResume;
    this.resource = null;
    this.state = { status: 'idle', bytes: 0, total: 0, error: null };
    this.working = null;
    this.abortController = null;
    this.closed = false;
    this.persistQueue = Promise.resolve();
  }

  snapshot() { return { ...this.state }; }
  get path() { return this.cachePath ?? null; }
  get file() { return this.getFile(); }
  getFile() {
    if (this.state.status !== 'complete' || !this.cachePath) throw new Error('下载尚未完成');
    return this.cachePath;
  }

  validate(resource) {
    if (!resource || typeof resource !== 'object') throw new TypeError('resource is required');
    const { id, version, url, size, sha256, md5 } = resource;
    if (typeof id !== 'string' || !id.trim() || id.length > 512 || typeof version !== 'string' || !version.trim() || version.length > 256) throw new TypeError('resource id/version invalid');
    if (!safeSize(size) || size === 0) throw new TypeError('resource size invalid');
    if (!(hashPattern.test(sha256 || '') || !sha256 && md5Pattern.test(md5 || ''))) throw new TypeError('resource checksum invalid');
    let parsed;
    try { parsed = new URL(url); } catch { throw new TypeError('resource URL invalid'); }
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
    if (parsed.protocol !== 'https:' && !(this.allowHttp && parsed.protocol === 'http:' && localhost)) throw new TypeError('下载地址必须使用 HTTPS');
    if (parsed.username || parsed.password) throw new TypeError('下载 URL 不能包含凭据');
    return { id, version, url: parsed.href, size, ...(sha256 ? { sha256: sha256.toLowerCase() } : { md5: md5.toLowerCase() }) };
  }

  async init(resource) {
    await mkdir(this.directory, { recursive: true });
    this.resource = this.validate(resource);
    const paths = resourcePaths(this.resource);
    this.cachePath = join(this.directory, paths.cache);
    this.partPath = join(this.directory, paths.part);
    this.chunkPath = join(this.directory, paths.chunk);
    this.statePath = join(this.directory, paths.state);
    this.meta = { checkpoint: 0, etag: null, lastModified: null };
    const cache = await stat(this.cachePath).catch(() => null);
    if (cache?.isFile() && cache.size === this.resource.size && await this.hashFile(this.cachePath) === checksum(this.resource)) {
      await rm(this.partPath, { force: true });
      this.meta.checkpoint = this.resource.size;
      await this.setState('complete', this.resource.size, null, false);
      await this.persist();
      return this.snapshot();
    }
    if (cache) await rm(this.cachePath, { force: true });
    const saved = await readFile(this.statePath, 'utf8').then(JSON.parse).catch(() => null);
    if (saved && saved.resource?.id === this.resource.id && saved.resource?.version === this.resource.version &&
      saved.resource?.url === this.resource.url && saved.resource?.size === this.resource.size && checksum(saved.resource) === checksum(this.resource)) {
      this.meta = {
        checkpoint: Number.isSafeInteger(saved.meta?.checkpoint) ? saved.meta.checkpoint : 0,
        etag: typeof saved.meta?.etag === 'string' ? saved.meta.etag : null,
        lastModified: typeof saved.meta?.lastModified === 'string' ? saved.meta.lastModified : null,
      };
      const status = ['downloading', 'verifying', 'paused', 'error'].includes(saved.state?.status) ? saved.state.status : 'idle';
      const actual = await stat(this.partPath).catch(() => null);
      if (!actual?.isFile() || actual.size < this.meta.checkpoint || this.meta.checkpoint > this.resource.size) {
        await rm(this.partPath, { force: true }); this.meta.checkpoint = 0; this.meta.etag = null; this.meta.lastModified = null;
      } else if (actual.size > this.meta.checkpoint) await truncate(this.partPath, this.meta.checkpoint);
      this.state = { status, bytes: this.meta.checkpoint, total: this.resource.size, error: status === 'error' ? String(saved.state?.error ?? '下载失败') : null };
      await this.notify();
      if (this.autoResume && (status === 'downloading' || status === 'verifying')) this.start();
    } else {
      await rm(this.partPath, { force: true });
      await this.setState('idle', 0, null);
    }
    return this.snapshot();
  }

  async setState(status, bytes = this.state.bytes, error = null, persist = true) {
    this.state = { status, bytes, total: this.resource?.size ?? this.state.total, error };
    await this.notify();
    if (persist) await this.persist();
  }

  async notify() { try { await this.onChange?.(this.snapshot()); } catch { /* observers cannot break the transfer */ } }

  persist() {
    if (!this.statePath || !this.resource) return Promise.resolve();
    const record = JSON.stringify({ resource: this.resource, state: this.snapshot(), meta: { ...this.meta } });
    this.persistQueue = this.persistQueue.catch(() => {}).then(async () => {
      const temp = `${this.statePath}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(record); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.statePath);
    });
    return this.persistQueue;
  }

  start() {
    if (!this.resource) throw new Error('请先调用 init(resource)');
    if (this.closed) throw new Error('下载器已关闭');
    if (this.state.status === 'complete' || this.working) return this.snapshot();
    const controller = this.abortController = new AbortController();
    void this.setState('downloading', this.meta.checkpoint, null).catch(error => { this.lastError = error.message; });
    const work = this.run(controller.signal).catch(async error => {
      if (controller.signal.aborted) {
        if (!this.closed && this.state.status !== 'paused') await this.setState('paused', this.meta.checkpoint, null);
        else if (this.closed) await this.persist();
      } else {
        await rm(this.chunkPath, { force: true }).catch(() => {});
        await this.setState('error', this.meta.checkpoint, error?.message || '下载失败');
      }
    }).finally(async () => {
      // An abort after a fully received chunk can end run() normally instead
      // of throwing. Publish pause before resolving working, so an enclosing
      // installer cannot observe downloading and start another transfer.
      if (controller.signal.aborted && !this.closed && this.state.status !== 'complete')
        await this.setState('paused', this.meta.checkpoint, null);
      if (this.working === work) this.working = null;
    });
    this.working = work;
    return this.snapshot();
  }

  async pause() {
    if (this.state.status === 'downloading' || this.state.status === 'verifying') {
      this.abortController?.abort(new Error('下载已暂停'));
      await this.working;
      if (!this.closed && this.state.status !== 'complete') await this.setState('paused', this.meta.checkpoint, null);
    }
    return this.snapshot();
  }

  async close() {
    this.closed = true;
    if (this.state.status === 'downloading' || this.state.status === 'verifying') {
      this.abortController?.abort(new Error('下载器关闭'));
      await this.working;
      this.state = { ...this.state, status: 'downloading', error: null, bytes: this.meta.checkpoint };
      await this.notify(); await this.persist();
    }
    await this.working;
    await this.persistQueue;
    return this.snapshot();
  }

  async request(start, end, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('下载请求超时')), REQUEST_TIMEOUT);
    const abort = () => controller.abort(signal.reason ?? new Error('下载已停止'));
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    try {
      const headers = { 'accept-encoding': 'identity' };
      if (start > 0 || end < this.resource.size - 1) headers.range = `bytes=${start}-${end}`;
      if (this.meta.etag) headers['if-range'] = this.meta.etag;
      else if (this.meta.lastModified) headers['if-range'] = this.meta.lastModified;
      let target = this.resource.url;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await this.fetcher(target, { headers, signal: controller.signal, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          response.__durableSignal = controller.signal;
          response.__durableCleanup = cleanup;
          return response;
        }
        const location = header(response, 'location');
        await response.body?.cancel();
        if (!location || redirects === 5) throw new Error('下载重定向无效或超过限制');
        const next = new URL(location, target);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(next.hostname.toLowerCase());
        if (next.username || next.password || (next.protocol !== 'https:' && !(this.allowHttp && next.protocol === 'http:' && local))) throw new Error('下载重定向必须使用 HTTPS');
        target = next.href;
      }
      throw new Error('下载重定向无效');
    } catch (error) { cleanup(); throw error; }
  }

  async run(signal) {
    let sourceResetCount = 0;
    while (!signal.aborted) {
      if (this.meta.checkpoint >= this.resource.size) break;
      const start = this.meta.checkpoint;
      const end = Math.min(this.resource.size - 1, start + CHUNK_SIZE - 1);
      const response = await this.request(start, end, signal);
      const cancelResponse = async () => { try { await response.body?.cancel(); } finally { response.__durableCleanup?.(); } };
      const transferSignal = response.__durableSignal ?? signal;
      const encoding = header(response, 'content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') { await cancelResponse(); throw new Error('来源返回了压缩内容'); }
      const gotEtag = header(response, 'etag');
      const gotModified = header(response, 'last-modified');
      const changed = (this.meta.etag && gotEtag && this.meta.etag !== gotEtag) || (this.meta.lastModified && gotModified && this.meta.lastModified !== gotModified);
      if (changed) {
        await cancelResponse(); await rm(this.partPath, { force: true }); this.meta.checkpoint = 0; this.meta.etag = gotEtag; this.meta.lastModified = gotModified; await this.persist();
        if (++sourceResetCount > 3) throw new Error('下载来源持续变化');
        continue;
      }
      if (gotEtag) this.meta.etag = gotEtag;
      if (gotModified) this.meta.lastModified = gotModified;
      if (response.status === 200) {
        const declared = Number(header(response, 'content-length'));
        if (!Number.isSafeInteger(declared) || declared !== this.resource.size) { await cancelResponse(); throw new Error('完整响应长度与资源不符'); }
        this.meta.checkpoint = 0;
        await rm(this.partPath, { force: true });
        const bytes = await streamBounded(response, this.chunkPath, this.resource.size, transferSignal, received => {
          this.state = { status: 'downloading', bytes: received, total: this.resource.size, error: null }; void this.notify();
        });
        if (bytes !== this.resource.size) { await rm(this.chunkPath, { force: true }); throw new Error('完整响应长度与资源不符'); }
        await syncFile(this.chunkPath); await rename(this.chunkPath, this.partPath); await syncFile(this.partPath);
        this.meta.checkpoint = bytes;
        this.state = { status: 'verifying', bytes, total: this.resource.size, error: null }; await this.notify(); await this.persist();
        break;
      }
      if (response.status !== 206) { await cancelResponse(); throw new Error(`下载请求失败 (${response.status})`); }
      const contentRange = header(response, 'content-range');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange ?? '');
      const expected = end - start + 1;
      const declared = Number(header(response, 'content-length'));
      if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== this.resource.size || !Number.isSafeInteger(declared) || declared !== expected) {
        await cancelResponse(); throw new Error('来源 Range 响应范围或长度无效');
      }
      const bytes = await streamBounded(response, this.chunkPath, expected, transferSignal, received => {
        this.state = { status: 'downloading', bytes: start + received, total: this.resource.size, error: null }; void this.notify();
      });
      if (bytes !== expected) { await rm(this.chunkPath, { force: true }); throw new Error('分块响应长度与声明不符'); }
      await syncFile(this.chunkPath);
      const part = await open(this.partPath, start === 0 ? 'w+' : 'r+', 0o600);
      try {
        const chunk = await readFile(this.chunkPath);
        let written = 0;
        while (written < chunk.length) {
          const result = await part.write(chunk, written, chunk.length - written, start + written);
          if (!result.bytesWritten) throw new Error('无法写入下载分块');
          written += result.bytesWritten;
        }
        await part.sync();
      } finally { await part.close(); }
      await rm(this.chunkPath, { force: true });
      this.meta.checkpoint = start + bytes;
      this.state = { status: 'downloading', bytes: this.meta.checkpoint, total: this.resource.size, error: null };
      await this.notify(); await this.persist();
    }
    if (signal.aborted) return;
    await this.setState('verifying', this.resource.size, null);
    if (await this.hashFile(this.partPath) !== checksum(this.resource)) {
      await rm(this.partPath, { force: true }); this.meta.checkpoint = 0; this.meta.etag = null; this.meta.lastModified = null;
      throw new Error(`下载文件 ${this.resource.sha256 ? 'SHA-256' : 'MD5'} 校验失败`);
    }
    await rename(this.partPath, this.cachePath);
    const dirHandle = await open(dirname(this.cachePath), 'r').catch(() => null);
    if (dirHandle) { await dirHandle.sync().catch(() => {}); await dirHandle.close(); }
    this.meta.checkpoint = this.resource.size;
    await this.setState('complete', this.resource.size, null);
  }

  async hashFile(path) {
    const hash = createHash(this.resource?.sha256 ? 'sha256' : 'md5');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }

  async importFile(file) {
    if (!this.resource) throw new Error('请先调用 init(resource)');
    if (['downloading', 'verifying'].includes(this.state.status)) throw new Error('下载进行中，不能导入文件');
    const source = typeof file === 'string' ? file : file?.path;
    if (!source) throw new TypeError('导入文件路径无效');
    const info = await stat(source);
    if (!info.isFile() || info.size !== this.resource.size) throw new Error('导入文件大小与资源不符');
    const temp = join(this.directory, `${checksum(this.resource)}.${randomUUID()}.import`);
    try {
      await pipeline(createReadStream(source), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      await syncFile(temp);
      if (await this.hashFile(temp) !== checksum(this.resource)) throw new Error(`导入文件 ${this.resource.sha256 ? 'SHA-256' : 'MD5'} 校验失败`);
      const existing = await stat(this.cachePath).catch(() => null);
      if (existing) {
        if (existing.isFile() && existing.size === this.resource.size && await this.hashFile(this.cachePath) === checksum(this.resource)) { await rm(temp, { force: true }); return this.cachePath; }
        throw new Error('目标缓存已存在且内容不匹配');
      }
      await rename(temp, this.cachePath);
      this.meta.checkpoint = this.resource.size;
      await this.setState('complete', this.resource.size, null);
      return this.cachePath;
    } catch (error) { await rm(temp, { force: true }); throw error; }
  }
}
