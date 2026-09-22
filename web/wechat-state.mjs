export function loginLabel(runtime) {
  if (runtime.status !== 'running') return '未登录';
  if (runtime.loginStatus === 'logged-in') return '已登录';
  if (['logged-out', 'relogin-required'].includes(runtime.loginStatus)) return '未登录';
  return runtime.loginCheckTimedOut ? '暂时无法确认状态' : '检测中…';
}
export function desktopAction(runtime, connected) {
  if (runtime?.status === 'running' && (['logged-out', 'relogin-required'].includes(runtime.loginStatus) || runtime.loginStatus === 'unknown' && ['logged-out', 'relogin-required'].includes(runtime.lastLoginStatus))) return { label: '重新登录', login: true };
  if (runtime?.status === 'running' && connected) return runtime.windowVisible === false ? { label: '显示微信', login: false } : null;
  return { label: '连接微信', login: false };
}
export function desktopStatus(runtime, connected, waiting) {
  if (waiting) return '正在连接微信…';
  if (runtime?.status === 'error') return runtime.message || '微信启动或运行失败，请重试并查看诊断信息';
  if (runtime?.status !== 'running') return '微信尚未运行，点击连接微信打开';
  if (desktopAction(runtime, connected)?.login) return '微信未登录，点击重新登录打开登录页面';
  if (!connected) return runtime.loginStatus === 'logged-in' ? '微信仍已登录，桌面连接已断开，请重新连接' : '桌面连接已断开，请重新连接后查看微信状态';
  return '';
}
export function aiAvailable(runtime, connected) {
  return connected === true && runtime?.status === 'running' &&
    !['logged-out', 'relogin-required'].includes(runtime.loginStatus) &&
    (runtime.loginStatus === 'logged-in' || runtime.aiEntryAvailable === true);
}
