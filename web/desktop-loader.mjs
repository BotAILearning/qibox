export function desktopLoader() {
  let runtime, styling;
  const styles = () => {
    const link = document.querySelector('[data-desktop-style]');
    if (!link || link.sheet) return Promise.resolve();
    if (!styling) styling = new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer); link.removeEventListener('load', loaded); link.removeEventListener('error', failed);
        if (error) { styling = null; link.removeAttribute('href'); reject(error); }
        else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error('页面样式加载失败，请重试打开微信'));
      link.addEventListener('load', loaded, {once:true}); link.addEventListener('error', failed, {once:true});
      timer = setTimeout(failed, 15000);
      link.href = link.dataset.desktopStyle;
    });
    return styling;
  };
  return async () => {
    try { return (await Promise.all([runtime ??= import('./desktop-runtime.mjs'), styles()]))[0]; }
    catch (error) { throw new Error(`微信桌面组件未能加载，请刷新栖盒后重试。${error.message}`); }
  };
}
