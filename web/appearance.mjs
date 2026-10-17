const key = 'qibox.appearance';
export function applyAppearance(value, save = false) {
  const theme = ['light','dark','system'].includes(value) ? value : 'system';
  document.documentElement.dataset.qiTheme = theme;
  if (save) try { localStorage.setItem(key,theme); } catch { /* Current-page appearance still applies. */ }
}
export function restoreAppearance() {
  let theme; try { theme = localStorage.getItem(key); } catch { /* Private browsing may deny storage. */ }
  applyAppearance(theme);
}
