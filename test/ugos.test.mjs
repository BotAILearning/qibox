import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createApplication } from '../server/index.mjs';
import { temp, cleanup, extractor, fetcher, runtimeFactory, packageSha256 } from './fixtures.mjs';
import { root } from '../scripts/tooling.mjs';

test('UGOS gateway accounts, CSRF and one-use desktop streams preserve per-user authorization', async () => {
  const version = Buffer.from('RFB 003.008\n'), refresh = Buffer.from([3, 1, 0, 0, 0, 0, 0, 1, 0, 1]);
  const init = Buffer.alloc(24); init.writeUInt16BE(1, 0); init.writeUInt16BE(1, 2); init[4] = 32; init[5] = 24; init[7] = 1;
  init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[15] = 8; init[16] = 16;
  const peerErrors = [];
  const dataRoot = await temp(), echo = net.createServer(socket => {
    socket.on('error', () => {}); socket.write(version);
    let stage = 0, pending = Buffer.alloc(0);
    const requests = [version, Buffer.from([1]), Buffer.from([1]), refresh];
    const responses = [Buffer.from([1, 1]), Buffer.alloc(4), init, Buffer.alloc(4)];
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      while (stage < requests.length && pending.length >= requests[stage].length) {
        const expected = requests[stage];
        if (!pending.subarray(0, expected.length).equals(expected)) { peerErrors.push('Unexpected RFB client frame'); socket.destroy(); return; }
        pending = pending.subarray(expected.length); socket.write(responses[stage++]);
      }
    });
  });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const app = await createApplication({ appRoot: root, dataRoot, host: 'ugos', arch: 'arm64', fetcher, extract: extractor, trustedHashes: [packageSha256],
    runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: echo.address().port }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
  const headers = uid => ({ 'ugreen-user-id': uid, 'ugreen-user-type': uid === '1000' ? 'admin' : 'users' });
  let stream; const controller = new AbortController();
  try {
    assert.equal((await fetch(`${base}/api/session`)).status, 401);
    const session = await (await fetch(`${base}/api/session`, { headers: headers('1000') })).json();
    assert.equal(session.host, 'ugos'); assert.equal(session.capabilities.nasPicker, false);
    const call = (route, data, uid = '1000', csrf = session.csrf) => fetch(`${base}/api${route}`, { method: 'POST', headers: { ...headers(uid), 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    await call('/consent', { accepted: true }); await call('/apps/wechat/install/download', {}); await app.library.working;
    const item = await (await call('/instances', { name: 'ARM微信' })).json();
    await call(`/instances/${item.id}/start`, {});
    assert.equal((await call(`/instances/${item.id}/desktop`, {}, '1001')).status, 403);
    const connection = await (await call(`/instances/${item.id}/desktop`, {})).json();
    assert.equal(connection.transport, 'http');
    const origin = new URL(base).origin;
    assert.equal((await fetch(origin + connection.path, { headers: headers('1001') })).status, 403);
    stream = await fetch(origin + connection.path, { headers: headers('1000'), signal: controller.signal });
    assert.equal(stream.status, 200); assert.equal(stream.headers.get('x-accel-buffering'), 'no');
    assert.equal((await fetch(origin + connection.path, { headers: headers('1000') })).status, 403);
    const reader = stream.body.getReader(); assert.equal(Buffer.from((await reader.read()).value).toString(), 'RFB 003.008\n');
    const send = (uid, csrf, bytes = version) => fetch(origin + connection.input, { method: 'POST', headers: { ...headers(uid), 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: bytes });
    assert.equal((await send('1000', 'forged')).status, 403);
    const other = await (await fetch(`${base}/api/session`, { headers: headers('1001') })).json();
    await call('/consent', { accepted: true }, '1001', other.csrf);
    assert.equal((await send('1001', other.csrf)).status, 404);
    for (const [request, expected] of [[version, Buffer.from([1, 1])], [Buffer.from([1]), Buffer.alloc(4)], [Buffer.from([1]), init], [refresh, Buffer.alloc(4)]]) {
      assert.equal((await send('1000', session.csrf, request)).status, 204);
      const chunks = []; let size = 0;
      while (size < expected.length) { const next = await reader.read(); assert.equal(next.done, false); chunks.push(next.value); size += next.value.length; }
      assert.deepEqual(Buffer.concat(chunks), expected);
    }
    assert.deepEqual(peerErrors, []);
    await reader.cancel();
    assert.equal((await call('/apps/wechat/install/nas', { path: '/some/file.deb' })).status, 409);
    assert.equal((await call('/apps/wechat/install/uninstall', { deleteData: false }, '1001', other.csrf)).status, 403);
  } finally { controller.abort(); await app.close(); await new Promise(resolve => echo.close(resolve)); await cleanup(dataRoot); }
});
