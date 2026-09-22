export const requestKey = 'qibox:file-request';
const resultPrefix = 'qibox:file-result:';
export function cleanPickerStorage(session, local, now = Date.now()) {
  let pending;
  try { pending = JSON.parse(session.getItem(requestKey)); } catch {}
  if (!pending || !Number.isFinite(pending.expires) || pending.expires <= now || !/^[a-f0-9]{48}$/.test(pending.state || '')) { session.removeItem(requestKey); pending = null; }
  for (const key of Object.keys(local).filter(key => key.startsWith(resultPrefix))) {
    let result; try { result = JSON.parse(local.getItem(key)); } catch {}
    if (!result || !Number.isFinite(result.expires) || result.expires <= now) local.removeItem(key);
  }
  return pending;
}
