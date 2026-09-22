import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, realpath, lstat, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError, within } from './files.mjs';

const validId = x => typeof x === 'string' && /^[a-f0-9-]{36}$/.test(x);
const filename = value => {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 240) throw new AppError('文件名无效，请修改后重试');
  return value;
};

export class FileExports {
  constructor({ root, home, send, now = Date.now }) {
    this.root = path.join(root, 'exports'); this.home = home; this.send = send; this.now = now; this.pending = null; this.closed = false; this.operations = new Set();
    for (const key of ['start', 'copyNas']) {
      const run = this[key].bind(this);
      this[key] = (...args) => { const work = run(...args); this.operations.add(work); return work.finally(() => this.operations.delete(work)); };
    }
  }
  receive(event) {
    if (event.type === 'saved' && this.pending?.id === event.id && this.pending?.kind === 'save') { this.pending.ready = true; return; }
    if (event.type === 'cancelled' && this.pending?.id === event.id) { void this.cancel(this.pending.id, this.pending.client).catch(() => {}); return; }
    if (!validId(event.id) || !['save', 'copy', 'folder'].includes(event.operation)) return;
    if (this.closed || this.pending) { if (event.operation === 'save') this.send({ id: event.id, response: 1 }); return; }
    const uris = event.uris;
    if (event.operation !== 'save' && (!Array.isArray(uris) || !uris.length || uris.length > 20 || uris.some(u => typeof u !== 'string' || !u.startsWith('file:///') || u.includes('\0')))) return;
    let name;
    try { name = filename(event.name || (uris?.length === 1 ? path.basename(fileURLToPath(uris[0])) : '微信文件')); } catch { if (event.operation === 'save') this.send({ id: event.id, response: 1 }); return; }
    this.pending = { id: event.id, kind: event.operation, name, uris, client: null, ready: event.operation !== 'save', created: this.now(), controller: new AbortController() };
  }
  state(client) {
    const r = this.pending;
    if (!r || r.client && r.client !== client) return { request: null };
    return { request: { id: r.id, operation: r.kind, name: r.name, count: r.uris?.length || 1, ready: r.ready, started: !!r.started, multiple: false } };
  }
  request(id, client, claim = false) {
    const r = this.pending;
    if (this.closed || !r || id !== r.id || !validId(client) || r.client && r.client !== client || r.controller.signal.aborted) throw new AppError('文件操作已结束，请从微信重新操作', 409);
    if (claim) r.client ||= client;
    if (r.client !== client) throw new AppError('文件操作未认领', 409);
    return r;
  }
  claim(id, client) { this.request(id, client, true); return this.state(client); }
  async source(uri, directory = false) {
    const requested = fileURLToPath(uri), base = await realpath(this.home), resolved = await realpath(requested);
    // Only this instance's own profile files may enter a native export request.
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new AppError('文件不属于当前微信实例', 403);
    const info = await lstat(resolved);
    if (directory ? !info.isDirectory() : !info.isFile() || info.size > 1024 ** 3) throw new AppError(directory ? '文件夹不可用' : '请选择 1 GB 以内的普通文件');
    return { path: resolved, info };
  }
  async start(id, client, name) {
    const r = this.request(id, client);
    if (r.kind !== 'save') return { ready: r.ready };
    if (r.started) return { ready: r.ready };
    r.name = filename(name || r.name);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    r.folder = within(this.root, path.join(this.root, r.id));
    await mkdir(r.folder, { mode: 0o700 }); this.request(id, client);
    r.file = path.join(r.folder, r.name); r.started = true;
    // The portal watches CLOSE_WRITE/MOVED_TO before returning the URI to Qt.
    this.send({ id, response: 0, uris: [pathToFileURL(r.file).href], watch: r.file });
    return { ready: false };
  }
  async sources(r) {
    if (!r.ready) throw new AppError('微信正在保存文件，请稍候', 409);
    if (r.kind === 'save') {
      const resolved = await realpath(r.file), info = await lstat(r.file);
      if (resolved !== r.file || !info.isFile() || info.size > 1024 ** 3) throw new AppError('保存文件无效或超过 1 GB');
      return [{ path: resolved, info }];
    }
    return Promise.all(r.uris.map(uri => this.source(uri)));
  }
  async opened(file) {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== file.info.ino || info.size !== file.info.size || info.mtimeMs !== file.info.mtimeMs) { await handle.close(); throw new AppError('文件发生变化，请重新操作'); }
    return handle;
  }
  async copyNas(id, client, directory, nasFiles, uid, name) {
    const r = this.request(id, client); if (r.kind === 'folder') throw new AppError('请选择保存或复制文件');
    if (r.working) throw new AppError('文件正在处理，请稍候', 409);
    r.working = true;
    try {
      const sources = await this.sources(r);
      const names = sources.map(file => filename(sources.length === 1 && name ? name : path.basename(file.path)));
      const first = await nasFiles.inDirectory(uid, directory, async base => {
        const owned = [];
        try {
          for (let i = 0; i < sources.length; i++) {
            this.request(id, client);
            const file = sources[i], handle = await this.opened(file);
            try {
              const target = path.join(base, names[i]), dest = await open(target, 'wx', 0o600); owned.push(target);
              try {
                const buffer = Buffer.alloc(256 * 1024); let total = 0;
                for (;;) {
                  r.controller.signal.throwIfAborted();
                  const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                  if (!bytesRead) break;
                  total += bytesRead;
                  if (total > file.info.size) throw new AppError('源文件发生变化，请重新复制');
                  let offset = 0;
                  while (offset < bytesRead) offset += (await dest.write(buffer, offset, bytesRead - offset)).bytesWritten;
                }
                const after = await handle.stat();
                if (total !== file.info.size || after.size !== file.info.size || after.mtimeMs !== file.info.mtimeMs) throw new AppError('源文件发生变化，请重新复制');
                await dest.sync();
              } finally { await dest.close(); }
            } finally { await handle.close(); }
          }
          this.request(id, client); return owned[0];
        } catch (error) {
          await Promise.all(owned.map(file => rm(file, { force: true })));
          if (error.code === 'EEXIST') throw new AppError('目标位置存在同名文件，请修改名称或选择其他文件夹', 409);
          throw error;
        }
      });
      r.working = false;
      await this.finish(id, client);
      return { saved: sources.map((file, i) => ({ name: names[i], path: path.join(path.dirname(first), names[i]), bytes: file.info.size })) };
    } finally { r.working = false; }
  }
  async download(id, client, index = 0) {
    const r = this.request(id, client), sources = await this.sources(r), file = sources[index];
    if (!Number.isInteger(index) || !file) throw new AppError('文件不存在', 404);
    const handle = await this.opened(file);
    return { handle, size: file.info.size, name: path.basename(file.path), signal: r.controller.signal };
  }
  async folder(id, client) {
    const r = this.request(id, client);
    if (r.kind !== 'folder' || r.uris.length !== 1) throw new AppError('无法确定文件所在目录');
    const uri = r.uris[0], requested = fileURLToPath(uri), info = await lstat(requested);
    const checked = await this.source(pathToFileURL(info.isDirectory() ? requested : path.dirname(requested)).href, true);
    return { path: checked.path };
  }
  async finish(id, client) {
    const r = this.request(id, client);
    if (r.working) throw new AppError('文件正在处理，请稍候', 409);
    this.pending = null; this.send({ id, cancelWatch: true });
    if (r.folder) await rm(within(this.root, r.folder), { recursive: true, force: true });
    return { complete: true };
  }
  async cancel(id, client) {
    const r = this.pending;
    if (!r || r.id !== id || r.client && r.client !== client) return { cancelled: true };
    r.controller.abort(); this.pending = null; this.send({ id, cancelWatch: true });
    if (r.kind === 'save' && !r.started) this.send({ id, response: 1 });
    await Promise.allSettled([...this.operations]);
    if (r.folder) await rm(within(this.root, r.folder), { recursive: true, force: true });
    return { cancelled: true };
  }
  async close() { this.closed = true; if (this.pending) await this.cancel(this.pending.id, this.pending.client); }
}
