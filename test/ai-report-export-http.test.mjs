import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';

test('报告下载接口要求当前用户和 CSRF，并只导出当前账号快照', async () => {
  const dataRoot = await temp();
  const app = await createApplication({ appRoot: root, dataRoot, runtimeFactory, extract: extractor, fetcher, trustedHashes: [packageSha256] });
  const socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\qibox-test-export-${process.pid}` : path.join(dataRoot, 'export.sock');
  await new Promise(resolve => app.server.listen(socketPath, resolve));
  const call = (route, uid, data, csrf) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/app/qibox/api' + route, method: data === undefined ? 'GET' : 'POST', headers: {
      'x-trim-userid': uid, ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { 'x-csrf-token': csrf } : {}),
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end(data === undefined ? undefined : JSON.stringify(data));
  });
  try {
    const token = JSON.parse((await call('/session', '1001')).bytes).csrf;
    const other = JSON.parse((await call('/session', '1002')).bytes).csrf;
    await call('/consent', '1001', { accepted: true }, token);
    await call('/consent', '1002', { accepted: true }, other);
    await call('/install/download', '1001', {}, token); await app.library.working;
    const instance = JSON.parse((await call('/instances', '1001', { name: '导出测试' }, token)).bytes);
    const space = await app.users.get('1001'), ai = space.get(instance.id).ai;
    const reportId = '11111111-1111-4111-8111-000000000001';
    ai.data.account = 'account-a';
    ai.data.analysisReports = [{ id: reportId, account: 'account-a', label: '测试联系人', createdAt: Date.now(),
      requestedRange: { from: null, to: null }, actualRange: { from: '2026-09-01', to: '2026-09-02' },
      count: 2, report: '这是一份已保存的分析报告。' }];
    await ai.save();
    const route = `/instances/${instance.id}/ai/reports/export`, request = { ids: [reportId], format: 'docx' };
    assert.equal((await call(route, '1001', request)).status, 403);
    assert.equal((await call(route, '1002', request, other)).status, 404);
    const downloaded = await call(route, '1001', request, token);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers['content-type'], /wordprocessingml/);
    assert.equal(downloaded.headers['cache-control'], 'no-store');
    const xml = strFromU8(unzipSync(downloaded.bytes)['word/document.xml']);
    assert.match(xml, /这是一份已保存的分析报告/);
    ai.data.account = 'account-b';
    const foreign = await call(route, '1001', request, token);
    assert.equal(foreign.status, 404);
    assert.doesNotMatch(foreign.bytes.toString(), /这是一份已保存的分析报告/);
  } finally { await app.close(); await cleanup(dataRoot); }
});
