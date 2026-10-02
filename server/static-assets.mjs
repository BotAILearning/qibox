import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { AppError } from './files.mjs';

const compress = promisify(gzip);
const encodingQuality = (header, encoding) => {
  const values = String(header || '').toLowerCase().split(',').map(value => {
    const [name, ...parameters] = value.trim().split(';');
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    return { name, quality: quality === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) ? Number(quality.slice(2)) : 0 };
  });
  return values.find(value => value.name === encoding)?.quality ?? values.find(value => value.name === '*')?.quality ?? 0;
};
const matches = (header, etag) => typeof header === 'string' && header.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);

// Only the explicit public-file allowlist in index.mjs calls this responder.
// Account data, API responses and model credentials never enter this cache.
export class StaticAssets {
  constructor(root, { maxBytes = 4 * 1024 ** 2, maxEntries = 24, read = readFile, inspect = stat } = {}) {
    this.root = path.resolve(root); this.maxBytes = maxBytes; this.maxEntries = maxEntries;
    this.read = read; this.inspect = inspect; this.entries = new Map(); this.loading = new Map();
  }
  trim() {
    let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes.length + (entry.gzip?.length || 0), 0);
    while (this.entries.size > this.maxEntries || bytes > this.maxBytes) {
      const key = this.entries.keys().next().value, entry = this.entries.get(key);
      bytes -= entry.bytes.length + (entry.gzip?.length || 0); this.entries.delete(key);
    }
  }
  async load(file) {
    const absolute = path.resolve(this.root, file);
    if (!absolute.startsWith(this.root + path.sep)) throw new AppError('页面不存在', 404);
    const info = await this.inspect(absolute);
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = this.entries.get(file);
    if (cached?.stamp === stamp) {
      this.entries.delete(file); this.entries.set(file, cached); return cached;
    }
    if (this.loading.get(file)?.stamp === stamp) return this.loading.get(file).promise;
    const pending = { stamp };
    pending.promise = (async () => {
      const bytes = await this.read(absolute);
      const entry = { stamp, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
      if (this.loading.get(file) === pending) { this.entries.set(file, entry); this.trim(); }
      return entry;
    })().finally(() => { if (this.loading.get(file) === pending) this.loading.delete(file); });
    this.loading.set(file, pending);
    return pending.promise;
  }
  async send(file, type, req, res) {
    const entry = await this.load(file);
    const encoded = type.startsWith('text/') && entry.bytes.length >= 1024 && encodingQuality(req.headers['accept-encoding'], 'gzip') > 0;
    let bytes = entry.bytes;
    if (encoded) {
      entry.compressing ??= compress(entry.bytes, { level: 6 }).then(value => {
        entry.gzip = value;
        if (this.entries.get(file) === entry) this.trim();
        return value;
      }).catch(error => { entry.compressing = null; throw error; });
      bytes = await entry.compressing;
    }
    const etag = `"${entry.hash}${encoded ? '-gzip' : ''}"`;
    const headers = { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
      'Cache-Control': 'private, no-cache', 'Vary': 'Accept-Encoding', 'ETag': etag,
      ...(encoded ? { 'Content-Encoding': 'gzip' } : {}) };
    if (matches(req.headers['if-none-match'], etag)) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
}
