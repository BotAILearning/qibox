import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server/index.mjs';
import { FileChooser } from '../server/file-chooser.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';

test('file upload HTTP endpoints enforce CSRF and ownership before accepting local bytes', async () => {
  const dataRoot = await temp(), app = await createApplication({ appRoot: root, dataRoot, runtimeFactory, extract: extractor, fetcher, trustedHashes: [packageSha256] });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-file-test-${randomUUID()}` : path.join(dataRoot, 'file.sock');
  await new Promise(resolve => app.server.listen(socketPath, resolve));
  const call = (route, uid, csrf, data, raw = false, extra = {}) => new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : raw ? data : Buffer.from(JSON.stringify(data));
    const headers = { 'x-trim-userid': uid, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body !== undefined ? { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'content-length': body.length } : {}), ...extra };
    const req = http.request({ socketPath, path: '/app/qibox/api' + route, method: body === undefined ? 'GET' : 'POST', headers }, res => {
      let text = ''; res.on('data', data => text += data); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
  let chooser;
  try {
    const csrf = (await call('/session', '1001')).data.csrf, other = (await call('/session', '1002')).data.csrf;
    await call('/consent', '1001', csrf, { accepted: true }); await call('/consent', '1002', other, { accepted: true });
    app.library.download(); await app.library.working;
    const space = await app.users.get('1001'), meta = await space.add('文件验证'); await space.start(meta.id);
    const replies = [];
    chooser = new FileChooser({ dataRoot: space.get(meta.id).dataRoot, send: value => replies.push(value) });
    await chooser.init(); space.get(meta.id).runtime.fileChooser = chooser;
    const id = randomUUID(), client = randomUUID(); chooser.receive({ type: 'request', id, multiple: true });
    const route = `/instances/${meta.id}/files`;
    assert.equal((await call(route, '1001', undefined, { action: 'state', client })).status, 403);
    assert.equal((await call(route, '1002', other, { action: 'state', client })).status, 404);
    assert.equal((await call(route, '1001', csrf, { action: 'claim', id, client })).status, 200);
    const content = Buffer.from('本机文件内容');
    const plan = await call(route, '1001', csrf, { action: 'plan', id, client, files: [{ name: '资料.txt', size: content.length }] });
    assert.equal(plan.status, 200);
    const upload = `/instances/${meta.id}/file-upload/${id}/${plan.data.files[0].id}`, headers = { 'x-file-client': client };
    assert.equal((await call(upload, '1002', other, content, true, headers)).status, 404);
    assert.equal((await call(upload, '1001', other, content, true, headers)).status, 403);
    assert.equal((await call(upload, '1001', csrf, content, true, { 'x-file-client': randomUUID() })).status, 409);
    assert.equal((await call(upload, '1001', csrf, content, true, headers)).status, 200);
    assert.deepEqual(replies, []);
    assert.equal((await call(route, '1001', csrf, { action: 'complete', id, client })).status, 200);
    assert.deepEqual(await readFile(fileURLToPath(replies[0].uris[0])), content);
    assert.equal((await call(upload, '1001', csrf, content, true, headers)).status, 409);
  } finally { await chooser?.close(); await app.close(); await cleanup(dataRoot); }
});
