import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, statfs } from 'node:fs/promises';
export class AppError extends Error { constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; } }
export async function jsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && arguments.length > 1) return fallback; throw e; }
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  finally { await rm(temp, { force: true }); }
}
export async function hashFile(file, onProgress) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; onProgress?.(bytes); }
  return hash.digest('hex');
}
export async function ensureSpace(directory, needed) {
  const fs = await statfs(directory);
  if (Number(fs.bavail) * Number(fs.bsize) < needed + 256 * 1024 ** 2) throw new AppError('存储空间不足，请先释放空间');
}
export function within(base, file) {
  const root = path.resolve(base), target = path.resolve(file);
  if (!target.startsWith(root + path.sep)) throw new Error('Path escapes application directory');
  return target;
}
