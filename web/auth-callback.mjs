import { TrimApp } from '@trimjs/web-app';
import { cleanPickerStorage } from './picker-storage.mjs';
cleanPickerStorage(sessionStorage, localStorage);
const sdk = new TrimApp(), result = sdk.parseAppAuthCallback(location.href);
if (/^[a-f0-9]{48}$/.test(result.state || '') && result.appName === 'qibox' && result.method === 'pickUserFile') {
  localStorage.setItem(`qibox:file-result:${result.state}`, JSON.stringify({ ...result, expires: Date.now() + 10 * 60 * 1000 }));
  window.opener?.postMessage({ type: 'qibox:auth-result', result }, location.origin);
  document.querySelector('p').textContent = result.status === 'success' ? '已选择完成，请返回栖盒。' : '已取消选择，请返回栖盒。';
  if (sessionStorage.getItem('qibox:file-request')) location.replace('./');
  else if (window.opener) window.close();
}
history.replaceState(null, '', location.pathname);
