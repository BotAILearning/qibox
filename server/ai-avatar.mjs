const hosts = new Set(['wx.qlogo.cn', 'mmhead.c2c.wechat.com', 'mmhead.hk.wechat.com']);
const maxBytes = 1024 * 1024;

export function safeAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.hostname) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return null;
    url.protocol = 'https:';
    url.port = '';
    url.hash = '';
    return url.href;
  } catch { return null; }
}

// Images are streamed into a bounded response buffer and never written to disk.
export async function readWechatAvatar(value, { fetcher = fetch, signal } = {}) {
  let url = safeAvatarUrl(value);
  if (!url) return null;
  const deadline = AbortSignal.timeout(10000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await fetcher(url, { signal: requestSignal, redirect: 'manual', cache: 'no-store' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = safeAvatarUrl(new URL(response.headers.get('location') || '', url).href);
      if (!url) return null;
      continue;
    }
    if (!response.ok) return null;
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || Number(response.headers.get('content-length') || 0) > maxBytes || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > maxBytes) { await reader.cancel(); return null; }
        chunks.push(Buffer.from(chunk));
      }
    } finally { reader.releaseLock(); }
    if (!size) return null;
    const bytes = Buffer.concat(chunks, size);
    const realMime = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg'
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    return realMime === mime ? { mime, bytes } : null;
  }
  return null;
}
