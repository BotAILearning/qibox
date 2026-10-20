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
    await writeFile(path.join(appRoot, 'public/legal-page.css'), '.qibox-legal-page h2 { font-size: 16px; }');
    await mkdir(path.join(appRoot, 'public/vendor/qiapp-ui'), { recursive: true });
    for (const name of ['settings', 'composition', 'workspace']) await writeFile(path.join(appRoot, `public/vendor/qiapp-ui/${name}.css`), `/* reviewed ${name} */`);
    await mkdir(path.join(appRoot, 'public/chunks'));
    await writeFile(path.join(appRoot, 'public/chunks/desktop-runtime-ABC.js'), source);
    await writeFile(path.join(appRoot, 'public/chunks/not-registered.js'), source);
    await writeFile(path.join(appRoot, 'public/web-chunks.json'), JSON.stringify(['chunks/desktop-runtime-ABC.js']));
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
    assert.equal((await request('/chunks/desktop-runtime-ABC.js')).status, 200);
    const legalStyle = await request('/legal-page.css');
    assert.equal(legalStyle.status, 200);
    assert.match(legalStyle.headers['content-type'], /text\/css/);
    assert.equal(legalStyle.bytes.toString(), '.qibox-legal-page h2 { font-size: 16px; }');
    assert.equal((await request('/legal-page.css', { authenticated: false })).status, 401);
    for (const name of ['settings', 'composition', 'workspace']) {
      const route = `/vendor/qiapp-ui/${name}.css`, response = await request(route);
      assert.equal(response.status, 200); assert.match(response.headers['content-type'], /text\/css/);
      assert.equal(response.bytes.toString(), `/* reviewed ${name} */`);
      assert.equal((await request(route, { authenticated: false })).status, 401);
    }
    assert.equal((await request('/chunks/desktop-runtime-ABC.js', {authenticated:false})).status, 401);
    assert.equal((await request('/chunks/not-registered.js')).status, 404);
    assert.equal((await request('/web-chunks.json')).status, 404);
  } finally { await app?.close(); await cleanup(dataRoot); await cleanup(appRoot); }
});
