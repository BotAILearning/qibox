import http from 'node:http';
import { AppError } from './files.mjs';

// This owner-scoped endpoint never forwards NAS credentials to a container.
export async function proxyWebApp(runtime, req, res, resource) {
  if (runtime.definition?.adapter !== 'docker' || runtime.status !== 'running' || !Number.isInteger(runtime.webPort) || runtime.webPort < 1 || runtime.webPort > 65535) throw new AppError('请先打开应用', 409);
  if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('请求方式不支持', 405);
  if (!resource.startsWith('/') || resource.includes('\\') || /[\r\n]/.test(resource)) throw new AppError('地址无效');
  return new Promise((resolve, reject) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: runtime.webPort, path: resource, method: req.method, headers: { Accept: '*/*' }, timeout: 15000 }, response => {
      // Container pages execute in a sandboxed frame without same-origin access.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(response.statusCode || 502, { 'Content-Type': response.headers['content-type'] || 'application/octet-stream' });
      response.on('error', () => res.destroy()); response.pipe(res); response.on('end', resolve);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => reject(new AppError('应用暂时无法连接，请重新打开', 502)));
    res.on('close', () => { upstream.destroy(); resolve(); }); upstream.end();
  });
}
