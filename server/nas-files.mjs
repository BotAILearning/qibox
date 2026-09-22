import http from 'node:http';
import path from 'node:path';
import { realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError } from './files.mjs';

export class NasFiles {
  constructor({ call } = {}) { this.call = call || this.request; }
  request(req, data) {
    const token = process.env.TRIM_API_TOKEN;
    if (!token) throw new AppError('请在飞牛应用中心升级栖盒后，再选择 NAS 文件', 503);
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ reqId: String(Date.now()), req, appName: 'qibox', data });
      const request = http.request({ socketPath: '/var/run/trim_open_gateway_apiscope.socket', path: '/api/v1/trimapp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` }, timeout: 10000 }, response => {
        let text = ''; response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) request.destroy(new Error('Response too large')); });
        response.on('end', () => { try { const result = JSON.parse(text); if (response.statusCode !== 200 || result.code !== 0) throw new Error('Authorization unavailable'); resolve(result.data); } catch { reject(new AppError('无法读取文件授权，请重新选择 NAS 文件或文件夹', 403)); } });
      });
      request.on('timeout', () => request.destroy()); request.on('error', () => reject(new AppError('无法连接飞牛文件服务，请稍后重试', 503))); request.end(body);
    });
  }
  async folders(uid) { return (await this.call('trim.file.getUserAccessibleFolders', { uid: Number(uid) })).paths || []; }
  async check(uid, filename, { directory = false, write = false } = {}) {
    if (!/^\d+$/.test(uid) || typeof filename !== 'string' || !/^\/vol\d+\//.test(filename) || filename.includes('\0') || filename.includes('\\')) throw new AppError('请选择 NAS 文件或文件夹');
    const normalized = path.posix.normalize(filename);
    if (normalized !== filename.replace(/\/$/, '') || normalized.split('/').some(p => p.startsWith('@'))) throw new AppError('请选择用户文件夹中的文件');
    // Resolve before asking fnOS about permissions: a link cannot borrow its parent's grant.
    const resolved = await realpath(normalized).catch(() => { throw new AppError('文件已移动，请重新选择', 404); });
    if (resolved !== normalized) throw new AppError('请选择原始文件或文件夹');
    const rights = await this.call('trim.file.checkUserACL', { uid: Number(uid), path: resolved });
    const acl = Array.isArray(rights) && rights.find(p => p.path === resolved);
    if (!acl?.readable || (write && !acl.writable)) throw new AppError('没有访问这个位置的权限，请重新选择', 403);
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new AppError(directory ? '请选择文件夹' : '请选择普通文件');
    if (directory) {
      const roots = await this.folders(uid);
      if (!roots.some(root => resolved === root || resolved.startsWith(`${root.replace(/\/$/, '')}/`))) throw new AppError('请先授权这个文件夹', 403);
    }
    return { path: resolved, info };
  }
  async openFile(uid, filename) {
    const checked = await this.check(uid, filename);
    const handle = await open(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (await realpath(`/proc/self/fd/${handle.fd}`) !== checked.path) throw new AppError('文件已移动，请重新选择');
      const info = await handle.stat(); if (!info.isFile()) throw new AppError('请选择普通文件');
      return { handle, info };
    } catch (error) { await handle.close(); throw error; }
  }
  async read(uid, filename, limit) {
    const { handle, info } = await this.openFile(uid, filename);
    try {
      if (info.size > limit) throw new AppError('请选择 12 MB 以内的图片');
      let size = 0; const chunks = [];
      for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; if (size > limit) throw new AppError('请选择 12 MB 以内的图片'); chunks.push(chunk); }
      return Buffer.concat(chunks);
    } finally { await handle.close(); }
  }
  async inDirectory(uid, directory, operation) {
    const checked = await this.check(uid, directory, { directory: true, write: true });
    const handle = await open(checked.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (await realpath(`/proc/self/fd/${handle.fd}`) !== checked.path) throw new AppError('文件夹已移动，请重新选择');
      const file = await operation(`/proc/self/fd/${handle.fd}`);
      return path.join(checked.path, path.basename(file));
    } finally { await handle.close(); }
  }
}
