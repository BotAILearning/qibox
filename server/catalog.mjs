import { AppError } from './files.mjs';
import { bundledLibrary } from './app-adapters.mjs';

// Only list applications with an installed provider. New providers supply their
// package library, runtime and settings policy; desktop entries retain appId.
export const APP_CATALOG = Object.freeze([
  Object.freeze({ id: 'wechat', name: '微信', icon: 'wechat', edition: 'Linux 版',
    description: '接收的聊天记录，保存在自己的 NAS。',
    packageFormat: '.deb', architecture: 'x86_64', website: 'https://linux.weixin.qq.com/',
    adapter: 'linux', capabilities: ['multiple-instances', 'startup-settings', 'desktop', 'wechat', 'audio', 'files', 'ai'] }),
]);

export function applicationDefinition(id = 'wechat', catalog = APP_CATALOG) {
  const app = catalog.find(item => item.id === id);
  if (!app) throw new AppError('应用暂未上架', 404);
  return app;
}

export function marketState(libraries) {
  return APP_CATALOG.map(app => { const library = (libraries[app.id] || bundledLibrary(app)).publicState(); return { ...app, architecture: library.architecture, library }; });
}
