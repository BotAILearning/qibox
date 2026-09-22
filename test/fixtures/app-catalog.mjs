import { APP_CATALOG, applicationDefinition } from '../../server/catalog.mjs';
export const extraApps = [
  { id: 'calculator', name: '计算器', icon: 'application', edition: 'Linux 图形应用', description: '独立运行的 Linux 计算器。', packageFormat: '内置', architecture: 'x86_64 / ARM64', website: 'https://www.x.org/', capabilities: ['multiple-instances', 'desktop'], adapter: 'linux', executable: 'usr/bin/xcalc' },
  { id: 'static-site', name: '静态站点', icon: 'application', edition: 'Docker 应用', description: '在隔离容器中运行静态页面。', packageFormat: 'Docker', architecture: 'x86_64 / ARM64', website: 'https://github.com/nginx/docker-nginx-unprivileged', capabilities: ['multiple-instances', 'web'], adapter: 'docker', initialContent: '<h1>Internal fixture</h1>', image: 'nginxinc/nginx-unprivileged:1.28-alpine' },
];
export const testCatalog = [...APP_CATALOG, ...extraApps];
export const testDefinition = id => applicationDefinition(id, testCatalog);
