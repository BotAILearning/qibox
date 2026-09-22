import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rename, lstat, realpath } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { AppError, ensureSpace, within } from './files.mjs';
import { FileExports } from './file-export.mjs';

export const MAX_CHAT_FILE = 1024 ** 3;
export const MAX_CHAT_BATCH = 2 * 1024 ** 3;
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export function chatFilename(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 240) throw new AppError('文件名无效，请重命名后重试');
  return value;
}

// A chooser belongs to one running instance. Only server-created file paths can
// be returned to its private D-Bus portal; browser-supplied NAS paths are ignored.
export class FileChooser {
  constructor({ dataRoot, home, send, now = () => Date.now() }) {
    this.dataRoot = dataRoot; this.root = path.join(dataRoot, 'file-transfers'); this.send = send; this.now = now;
    this.pending = null; this.operations = new Set(); this.closed = false;
    this.exports = new FileExports({ root: this.root, home, send, now });
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root), resolved = await realpath(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || resolved !== path.join(await realpath(this.dataRoot), 'file-transfers')) throw new Error('Invalid transfer directory');
    this.root = resolved;
  }
  receive(event) {
    if (event.operation || event.type === 'saved' || event.type === 'cancelled' && this.exports.pending?.id === event.id) {
      if (event.operation && (this.closed || this.pending)) { if (event.operation === 'save') this.send({ id: event.id, response: 1 }); return; }
      this.exports.receive(event); return;
    }
    if (event.type === 'cancelled' && this.pending?.id === event.id) { void this.cancelCurrent(false).catch(() => {}); return; }
    if (event.type !== 'request' || !validId(event.id) || typeof event.multiple !== 'boolean') return;
    if (this.closed || this.pending || this.exports.pending) { this.send({ id: event.id, response: 1 }); return; }
    this.pending = { id: event.id, multiple: event.multiple, createdAt: this.now(), client: null, files: null, controller: new AbortController() };
  }
  state(client) {
    const request = this.pending;
    if (!request) return this.exports.state(client);
    if (request.client && request.client !== client) return { request: null };
    return { request: { id: request.id, multiple: request.multiple, maxFileBytes: MAX_CHAT_FILE, maxBatchBytes: MAX_CHAT_BATCH, maxFiles: request.multiple ? 20 : 1 } };
  }
  request(id, client, claim = false) {
    const request = this.pending;
    if (this.closed || !validId(client) || request?.id !== id || request.controller.signal.aborted || (request.client && request.client !== client)) throw new AppError('文件选择已结束，请重新点击微信的发送文件按钮', 409);
    if (claim && !request.client) request.client = client;
    if (request.client !== client) throw new AppError('请重新选择文件', 409);
    return request;
  }
  claim(id, client) { if (this.exports.pending?.id === id) return this.exports.claim(id, client); this.request(id, client, true); return this.state(client); }
  async plan(id, client, files) {
    const request = this.request(id, client);
    if (request.files || !Array.isArray(files) || files.length < 1 || files.length > (request.multiple ? 20 : 1)) throw new AppError('请选择有效的文件数量');
    let total = 0;
    const entries = files.map(file => {
      const name = chatFilename(file?.name), size = file?.size;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CHAT_FILE) throw new AppError('请选择 1 GB 以内的文件');
      total += size;
      return { id: randomUUID(), name, size, status: 'waiting' };
    });
    if (total > MAX_CHAT_BATCH) throw new AppError('每次选择的文件合计不能超过 2 GB');
    // Reserve the request before awaiting disk I/O, so parallel plans cannot win.
    request.files = entries;
    try {
      await ensureSpace(this.root, total);
      this.request(id, client);
      request.folder = within(this.root, path.join(this.root, id));
      await mkdir(request.folder, { mode: 0o700 });
      this.request(id, client);
      return { files: entries.map(({ id, name, size }) => ({ id, name, size })) };
    } catch (error) { await this.cancelCurrent(true, request); throw error; }
  }
  async upload(id, client, fileId, stream, size) {
    const request = this.request(id, client), entry = request.files?.find(file => file.id === fileId);
    if (!entry || entry.status !== 'waiting' || !Number.isSafeInteger(size) || size !== entry.size) throw new AppError('文件大小不符，请重新选择');
    entry.status = 'uploading';
    const operation = (async () => {
      const folder = within(request.folder, path.join(request.folder, entry.id));
      await mkdir(folder, { mode: 0o700 });
      const destination = within(folder, path.join(folder, entry.name)), partial = path.join(folder, '.upload.partial');
      let received = 0;
      const meter = new Transform({ transform(chunk, _, next) {
        received += chunk.length;
        next(received > entry.size ? new AppError('文件大小不符，请重新选择') : null, chunk);
      } });
      try {
        await pipeline(stream, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: request.controller.signal });
        if (received !== entry.size) throw new AppError('文件未传完整，请重新选择');
        this.request(id, client);
        await rename(partial, destination);
        entry.path = destination; entry.status = 'ready';
        return { ready: true };
      } catch (error) { entry.status = 'failed'; await rm(partial, { force: true }); throw error; }
    })();
    this.operations.add(operation);
    try { return await operation; } finally { this.operations.delete(operation); }
  }
  async complete(id, client) {
    const request = this.request(id, client);
    if (!request.files?.length || request.files.some(file => file.status !== 'ready')) throw new AppError('文件尚未传完，请稍候', 409);
    const uris = [];
    for (const file of request.files) {
      const resolved = await realpath(file.path), info = await lstat(file.path);
      if (resolved !== file.path || !resolved.startsWith(this.root + path.sep) || !info.isFile() || info.isSymbolicLink() || info.size !== file.size) throw new AppError('文件已变化，请重新选择');
      uris.push(pathToFileURL(resolved).href);
    }
    this.request(id, client);
    this.send({ id, response: 0, uris }); this.pending = null;
    // WeChat may read these files after its confirmation dialog is accepted.
    // Keep completed transfers with the instance; never delete them on a timer.
    return { ready: true };
  }
  async prepareNas(id, client, paths, nasFiles, uid) {
    const request = this.request(id, client);
    if (!Array.isArray(paths) || !paths.length || paths.length > (request.multiple ? 20 : 1)) throw new AppError('请选择有效的文件数量');
    const opened = [];
    try {
      // The NAS service checks the current user's ACL and pins each inode.
      // Copy on the NAS into the existing per-request staging area so a later
      // source edit cannot change what WeChat's confirmation dialog will send.
      for (const filename of paths) {
        this.request(id, client);
        const file = await nasFiles.openFile(uid, filename);
        opened.push({ ...file, name: chatFilename(path.basename(filename)) });
      }
      const plan = await this.plan(id, client, opened.map(x => ({ name: x.name, size: x.info.size })));
      for (let i = 0; i < opened.length; i++) {
        const file = opened[i];
        await this.upload(id, client, plan.files[i].id, file.handle.createReadStream({ autoClose: false }), file.info.size);
        const after = await file.handle.stat();
        if (after.size !== file.info.size || after.mtimeMs !== file.info.mtimeMs || after.ino !== file.info.ino) throw new AppError('文件已变化，请重新选择');
      }
      return await this.complete(id, client);
    } catch (error) { await this.cancelCurrent(true, request); throw error; }
    finally { await Promise.allSettled(opened.map(x => x.handle.close())); }
  }
  async cancel(id, client) { if (this.exports.pending?.id === id) return this.exports.cancel(id, client); const request = this.request(id, client); await this.cancelCurrent(true, request); return { cancelled: true }; }
  async cancelCurrent(reply, request = this.pending) {
    if (!request) return;
    if (this.pending === request) this.pending = null;
    request.controller.abort();
    if (reply) this.send({ id: request.id, response: 1 });
    await Promise.allSettled([...this.operations]);
    if (request.folder) await rm(within(this.root, request.folder), { recursive: true, force: true });
  }
  async close() { this.closed = true; await this.cancelCurrent(true); await this.exports.close(); }
}

export async function startFileChooser({ appRoot, runtimeRoot, dataRoot, env }) {
  let child;
  const chooser = new FileChooser({ dataRoot, home: env.HOME, send: value => { if (child?.stdin && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); } });
  await chooser.init();
  child = spawn(path.join(runtimeRoot, 'usr/bin/python3.11'), [path.join(appRoot, 'server/file-portal.py')], {
    env: { ...env, PYTHONHOME: path.join(runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
    cwd: env.HOME, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('File chooser startup timed out')), 5000);
      const fail = () => { clearTimeout(timer); reject(new Error(`File chooser unavailable (${child.signalCode || child.exitCode}): ${diagnostic}`)); };
      child.once('error', fail); child.once('exit', fail);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        buffer += data;
        if (buffer.length > 65536) { child.kill(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { const event = JSON.parse(line); if (event.type === 'ready') { clearTimeout(timer); resolve(); } else chooser.receive(event); }
          catch { child.kill(); }
        }
      });
    });
    child.once('close', () => { void chooser.close().catch(() => {}); });
    return { chooser, process: child };
  } catch (error) { child.kill(); await chooser.close(); throw error; }
}
