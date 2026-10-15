const loginMessage = '飞牛登录已失效，请返回飞牛重新登录，再打开栖盒。';
export function sessionError() {
  return Object.assign(new Error(loginMessage), { code: 'HOST_SESSION_EXPIRED' });
}

// The native fnOS gateway can return a successful HTTP status with this plain
// text body after logout. It is not an application JSON response or a file.
export function parseApiResponse(text, status, fallback = '服务响应异常，请刷新页面后重试') {
  if (status === 401 || String(text).trim() === 'invalid token') throw sessionError();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(fallback); }
  if (!value || typeof value !== 'object') throw new Error(fallback);
  if (status < 200 || status >= 300) {
    throw Object.assign(new Error(value.error || '操作未完成，请重试'), { code: value.code });
  }
  return value;
}

export async function readApiResponse(response, fallback) {
  return parseApiResponse(await response.text(), response.status, fallback);
}

export async function requireDownloadResponse(response, fallback) {
  if (response.status === 401) throw sessionError();
  // Every application download supplies an attachment filename. Validate this
  // before consuming its stream, and do not inspect legitimate file contents.
  if (response.ok && /^attachment\s*;/i.test(response.headers.get('Content-Disposition') || '')) return response;
  const text = await response.text();
  if (text.trim() === 'invalid token') throw sessionError();
  let failure; try { failure = JSON.parse(text); } catch {}
  throw new Error(failure?.error || fallback);
}
