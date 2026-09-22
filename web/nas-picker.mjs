import { TrimApp } from '@trimjs/web-app';
import { cleanPickerStorage, requestKey } from './picker-storage.mjs';
const sdk = new TrimApp();
const prefix = location.pathname.replace(/\/$/, '');
export function nasPicker({ receive, notify }) {
  const key = requestKey;
  async function consume(result) {
    const pending = cleanPickerStorage(sessionStorage, localStorage);
    if (!pending || pending.expires < Date.now() || result.state !== pending.state || result.appName !== 'qibox' || result.method !== 'pickUserFile') return;
    sessionStorage.removeItem(key); localStorage.removeItem(`qibox:file-result:${result.state}`);
    if (result.status === 'cancel') return;
    if (result.status !== 'success' || !Array.isArray(result.path) || !result.path[0]) { notify('未选择文件，请重试'); return; }
    await receive(pending.purpose, pending.purpose === 'chat' ? result.path : result.path[0], pending.account);
  }
  window.addEventListener('message', event => { if (event.origin === location.origin && event.data?.type === 'qibox:auth-result') consume(event.data.result).catch(e => notify(e.message)); });
  async function refresh() {
    const pending = cleanPickerStorage(sessionStorage, localStorage);
    if (!pending) return;
    const text = localStorage.getItem(`qibox:file-result:${pending.state}`); if (text) await consume(JSON.parse(text));
  }
  window.addEventListener('focus', () => refresh().catch(e => notify(e.message)));
  return {
    refresh,
    async openFolder(path) {
      const result = await sdk.openFileManager(path);
      if (result?.code !== undefined && result.code !== 0) throw new Error(`NAS 文件管理器无法打开此位置：${path}`);
    },
    async pick(purpose, account) {
      const params = { directory: purpose === 'chat-export', multiple: purpose === 'chat', ...(['chat', 'chat-export'].includes(purpose) ? {} : { accept: ['.deb'] }), sidebarGroup: ['myFiles', 'otherShare', 'favorites'] };
      if (!sdk.isStandaloneWeb) {
        const result = await sdk.pickUserFile(params);
        if (result?.code === 0 && result.data?.[0]) await receive(purpose, purpose === 'chat' ? result.data : result.data[0], account);
        else if (result && result.code !== 0) throw new Error('无法选择 NAS 文件，请检查应用授权');
        return;
      }
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const state = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem(key, JSON.stringify({ state, account, purpose, expires: Date.now() + 10 * 60 * 1000 }));
      await sdk.openAppAuth('pickUserFile', { ...params, appName: 'qibox', redirectUri: `${prefix}/auth-callback.html`, state }, { target: ['chat', 'chat-export'].includes(purpose) ? '_blank' : '_self' });
    },
  };
}
