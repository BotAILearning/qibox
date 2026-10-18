import path from 'node:path';
import { open, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicJson } from './files.mjs';

const maxBytes = 16 * 1024 * 1024, maxAge = 24 * 60 * 60 * 1000;
const owned = info => info.isFile() && (process.platform === 'win32' || info.uid === process.getuid() && (info.mode & 0o077) === 0);
async function privateBytes(file, maximum) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const info = await handle.stat(); if (!owned(info) || info.size > maximum) throw Error('Invalid verification cache'); return await handle.readFile(); }
  finally { await handle.close(); }
}
export async function verificationCacheKey(directory) {
  try {
    if (await realpath(directory) !== path.join(await realpath(path.dirname(directory)), path.basename(directory))) return null;
    const file = path.join(directory, 'verification.key');
    try { await writeFile(file, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const key = await privateBytes(file, 32); return key.length === 32 ? key : null;
  } catch { return null; }
}
const mac = (key, body) => createHmac('sha256', key).update(JSON.stringify(body)).digest();
export async function loadVerificationCache(directory, key, identity, arch) {
  const empty = { hashes: [], resolved: [] };
  if (!key) return empty;
  try {
    const file = path.join(directory, 'verification.json');
    const value = JSON.parse((await privateBytes(file, maxBytes)).toString('utf8')), body = value.body;
    const tag = Buffer.from(value.mac || '', 'hex');
    if (tag.length !== 32 || !timingSafeEqual(tag, mac(key, body))) return empty;
    if (body.format !== 1 || body.identity !== identity || body.arch !== arch || !Number.isSafeInteger(body.at) || body.at > Date.now() || Date.now() - body.at > maxAge) return empty;
    const absolute = value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096;
    const rowsValid = (rows, check) => Array.isArray(rows) && rows.length <= 50000 && rows.every(row => Array.isArray(row) && row.length === 2 && absolute(row[0]) && /^\d+:\d+:\d+:\d+:\d+:\d+:\d+$/.test(row[1]?.signature || '') && check(row[1]));
    if (!rowsValid(body.hashes, value => /^[a-f0-9]{64}$/.test(value.sha256 || '')) || !rowsValid(body.resolved, value => absolute(value.canonical))) return empty;
    return { hashes: body.hashes, resolved: body.resolved };
  } catch { return empty; }
}
export async function saveVerificationCache(directory, key, identity, arch, hashes, resolved) {
  if (!key || hashes.size > 50000 || resolved.size > 50000) return;
  const body = { format: 1, identity, arch, at: Date.now(), hashes: [...hashes], resolved: [...resolved] };
  const value = { body, mac: mac(key, body).toString('hex') };
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) + 1 <= maxBytes) await atomicJson(path.join(directory, 'verification.json'), value);
}
