import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createApplication } from '../server/index.mjs';
import { temp, cleanup, runtimeFactory } from './fixtures.mjs';

test('static cache stays behind gateway identity and never caches or compresses private API/error responses', async () => {
  const appRoot = await temp(), dataRoot = await temp(); let app;
  try {
    await mkdir(path.join(appRoot, 'config')); await mkdir(path.join(appRoot, 'public'));
    await writeFile(path.join(appRoot, 'config/product.json'), JSON.stringify({ gatewayPrefix: '/app/qibox' }));
    const source = '// 微信桌面与 AI 辅助\n'.repeat(200);
    await writeFile(path.join(appRoot, 'public/app.js'), source);
    app = await createApplication({ appRoot, dataRoot, dev: true, runtimeFactory });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const request = (route, { authenticated = true, etag, method = 'GET' } = {}) => new Promise((resolve, reject) => {
      const headers = { 'accept-encoding': 'gzip', ...(authenticated ? { cookie: `qibox_dev=${app.devKey}` } : {}), ...(etag ? { 'if-none-match': etag } : {}) };
      const req = http.request({ hostname: '127.0.0.1', port: app.server.address().port, path: '/app/qibox' + route, headers, method }, res => {
        const chunks = []; res.on('data', bytes => chunks.push(bytes));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      });
      req.on('error', reject); req.end();
    });
    const first = await request('/app.js');
    assert.equal(first.status, 200); assert.equal(first.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(first.bytes).toString(), source);
    const cached = await request('/app.js', { etag: first.headers.etag });
    assert.equal(cached.status, 304); assert.equal(cached.bytes.length, 0);
    const denied = await request('/app.js', { authenticated: false, etag: first.headers.etag });
    assert.equal(denied.status, 401); assert.equal(denied.headers.etag, undefined);
    assert.equal(denied.headers['content-encoding'], undefined); assert.equal(denied.headers['cache-control'], 'no-store');
    const state = await request('/api/session');
    assert.equal(state.status, 200); assert.equal(state.headers.etag, undefined);
    assert.equal(state.headers['content-encoding'], undefined); assert.equal(state.headers['cache-control'], 'no-store');
    const invalid = await request('/app.js', { method: 'POST' });
    assert.equal(invalid.status, 405); assert.equal(invalid.headers.etag, undefined); assert.equal(invalid.headers['content-encoding'], undefined);
  } finally { await app?.close(); await cleanup(dataRoot); await cleanup(appRoot); }
});
