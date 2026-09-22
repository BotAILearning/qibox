import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function download(url, dest, expectedHash, { refresh = false } = {}) {
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    const data = await readFile(dest);
    if (!refresh && (!expectedHash || createHash('sha256').update(data).digest('hex') === expectedHash)) return data;
  } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(240000), redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (expectedHash && createHash('sha256').update(data).digest('hex') !== expectedHash) throw new Error(`SHA256 不一致: ${url}`);
  await writeFile(`${dest}.part`, data);
  await rm(dest, { force: true });
  await rename(`${dest}.part`, dest);
  return data;
}

export function arMember(buffer, prefix) {
  if (buffer.subarray(0, 8).toString() !== '!<arch>\n') throw new Error('不是有效的 Debian ar 文件');
  let pos = 8;
  while (pos + 60 <= buffer.length) {
    const name = buffer.subarray(pos, pos + 16).toString().trim().replace(/\/$/, '');
    const size = Number(buffer.subarray(pos + 48, pos + 58).toString().trim());
    if (!Number.isSafeInteger(size) || size < 0 || pos + 60 + size > buffer.length) throw new Error('Debian 文件截断');
    const data = buffer.subarray(pos + 60, pos + 60 + size);
    if (name.startsWith(prefix)) return { name, data };
    pos += 60 + size + (size % 2);
  }
  throw new Error(`缺少 ${prefix}`);
}
