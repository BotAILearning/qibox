import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { StaticAssets } from '../server/static-assets.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(options = {}) {
  const directory = await temp();
  const source = 'const 栖盒 = "微信桌面与 AI 辅助";\n'.repeat(400);
  await writeFile(path.join(directory, 'app.js'), source);
  let reads = 0;
  const assets = new StaticAssets(directory, { ...options, read: async file => { reads++; return readFile(file); } });
  const server = http.createServer((req, res) => assets.send('app.js', 'text/javascript', req, res).catch(error => {
    res.writeHead(error.status || 500); res.end();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/', headers, method }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  return { directory, source, assets, request, reads: () => reads,
    close: async () => { await new Promise(resolve => server.close(resolve)); await cleanup(directory); } };
}

test('static reload reuses a private representation with zero body, concurrent requests share one disk read', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => f.request()));
    assert.equal(f.reads(), 1);
    for (const result of results) { assert.equal(result.status, 200); assert.equal(result.bytes.toString(), f.source); }
    const first = results[0];
    assert.equal(first.headers['cache-control'], 'private, no-cache');
    assert.equal(first.headers.vary, 'Accept-Encoding');
    const cached = await f.request({ 'if-none-match': `"other", W/${first.headers.etag}` });
    assert.equal(cached.status, 304); assert.equal(cached.bytes.length, 0); assert.equal(f.reads(), 1);
  } finally { await f.close(); }
});

test('gzip reduces transferred bytes, honors explicit rejection and keeps encoded validators separate', async () => {
  const f = await fixture();
  try {
    const plain = await f.request();
    const compressed = await f.request({ 'accept-encoding': 'br, gzip;q=0.8' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(compressed.bytes).toString(), f.source);
    assert.ok(compressed.bytes.length < plain.bytes.length / 2);
    assert.notEqual(compressed.headers.etag, plain.headers.etag);
    assert.equal(Number(compressed.headers['content-length']), compressed.bytes.length);
    assert.equal((await f.request({ 'accept-encoding': 'gzip', 'if-none-match': compressed.headers.etag })).status, 304);
    const crossRepresentation = await f.request({ 'accept-encoding': 'gzip', 'if-none-match': plain.headers.etag });
    assert.equal(crossRepresentation.status, 200);
    for (const value of ['gzip;q=0, *;q=1', '*;q=0', 'gzip;q=wrong']) {
      const rejected = await f.request({ 'accept-encoding': value });
      assert.equal(rejected.headers['content-encoding'], undefined, value); assert.equal(rejected.bytes.toString(), f.source);
    }
    const head = await f.request({ 'accept-encoding': 'gzip' }, 'HEAD');
    assert.equal(head.bytes.length, 0); assert.equal(head.headers.etag, compressed.headers.etag);
    assert.equal(head.headers['content-length'], compressed.headers['content-length']);
  } finally { await f.close(); }
});

test('an upgraded asset invalidates its bytes and validators without restarting the responder', async () => {
  const f = await fixture();
  try {
    const before = await f.request({ 'accept-encoding': 'gzip' });
    const next = f.source + '// 新版本\n'; await writeFile(path.join(f.directory, 'app.js'), next);
    const after = await f.request({ 'accept-encoding': 'gzip', 'if-none-match': before.headers.etag });
    assert.equal(after.status, 200); assert.notEqual(after.headers.etag, before.headers.etag);
    assert.equal(gunzipSync(after.bytes).toString(), next); assert.equal(f.reads(), 2);
  } finally { await f.close(); }
});

test('cache capacity limits retained bytes and files outside the public root are refused', async () => {
  const f = await fixture({ maxBytes: 1, maxEntries: 1 });
  try {
    await f.request(); await f.request();
    assert.equal(f.reads(), 2); assert.equal(f.assets.entries.size, 0);
    await assert.rejects(f.assets.load('../private-account.json'), { status: 404 });
  } finally { await f.close(); }
});
