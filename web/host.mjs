export const host = typeof __QIBOX_HOST__ === 'undefined' ? 'fnos' : __QIBOX_HOST__;
export const apiPrefix = host === 'ugos' ? '/api/qibox' : location.pathname.replace(/\/$/, '');
let token = null, initialization, pendingToken, refreshAt = 0;
export function invalidateHostToken() { token = null; refreshAt = 0; }
export async function hostHeaders() {
  if (host !== 'ugos') return {};
  if (!initialization) initialization = (async () => {
    const [{ default: core }, { default: cloudWindow }] = await Promise.all([import('@ugreen-nas/core'), import('@ugreen-nas/core/cloudWindow')]);
    await core.init();
    return cloudWindow;
  })().catch(error => { initialization = null; throw error; });
  const cloudWindow = await initialization;
  if (!token || Date.now() >= refreshAt) {
    if (!pendingToken) pendingToken = (async () => {
      try {
        // Use the SDK timeout so failed requests also leave its capacity queue.
        const info = await cloudWindow.useCapacity('getThirdToken', undefined, 10000);
        if (!info?.third_token) throw new Error('请从绿联应用入口打开栖盒');
        token = info.third_token; refreshAt = Date.now() + 60000;
      } catch { throw new Error('请从绿联应用入口重新打开栖盒'); }
      finally { pendingToken = null; }
    })();
    await pendingToken;
  }
  return { 'Ugreen-Ttk': token };
}
