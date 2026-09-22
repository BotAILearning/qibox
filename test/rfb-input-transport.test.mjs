import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';

const version = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
const refresh = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
const down = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]);
const up = Buffer.from([4, 0, 0, 0, 0, 0, 0, 97]);
const heldPointer = Buffer.from([5, 1, 0, 0, 0, 0]);

for (const host of ['fnos', 'ugos']) test(`${host} desktop proxy waits for AI handover before native input and releases held state on close`, { timeout: 15000 }, async () => {
  const dataRoot = await temp(), sockets = new Set(), received = [], waiters = [];
  let count = 0, app, ws, stream, release;
  const seen = length => count >= length ? Promise.resolve() : new Promise(resolve => waiters.push({ length, resolve }));
  const peer = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    socket.on('data', bytes => {
      received.push(Buffer.from(bytes)); count += bytes.length;
      for (let i = waiters.length - 1; i >= 0; i--) if (count >= waiters[i].length) waiters.splice(i, 1)[0].resolve();
    });
  });
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  try {
    app = await createApplication({ appRoot: root, dataRoot, dev: true, host, runtimeFactory, extract: extractor, fetcher, trustedHashes: [packageSha256] });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`, cookie = `qibox_dev=${app.devKey}`;
    let csrf;
    const call = async (route, value) => {
      const result = await fetch(`${origin}${app.prefix}/api${route}`, { method: value === undefined ? 'GET' : 'POST', headers: {
        cookie, ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, body: value === undefined ? undefined : JSON.stringify(value) });
      assert.equal(result.status, route === '/install/download' ? 202 : route === '/instances' ? 201 : 200);
      return result.json();
    };
    csrf = (await call('/session')).csrf;
    await call('/consent', { accepted: true }); await call('/install/download', {}); await app.library.working;
    const info = await call('/instances', { name: '桌面输入屏障' });
    await call(`/instances/${info.id}/start`, {});
    const item = (await app.users.get('development')).get(info.id);
    item.runtime.port = peer.address().port;
    const events = [], entered = Promise.withResolvers(), disconnected = Promise.withResolvers();
    release = Promise.withResolvers();
    item.ai.manualInput = async event => {
      events.push(event);
      if (event.type === 'key' && event.down) { entered.resolve(); await release.promise; }
      if (event.type === 'disconnect') disconnected.resolve();
    };
    const connection = await call(`/instances/${info.id}/desktop`, {});
    let send, close;
    if (host === 'fnos') {
      ws = new WebSocket(`${origin.replace('http:', 'ws:')}${connection.path}`, { headers: { cookie } });
      ws.on('error', () => {}); await once(ws, 'open');
      send = bytes => new Promise((resolve, reject) => ws.send(bytes, error => error ? reject(error) : resolve()));
      close = async () => { const closed = once(ws, 'close'); ws.close(); await closed; };
    } else {
      stream = await fetch(`${origin}${connection.path}`, { headers: { cookie } });
      assert.equal(stream.status, 200);
      send = async bytes => {
        const result = await fetch(`${origin}${connection.input}`, { method: 'POST', headers: { cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: bytes });
        assert.equal(result.status, 204);
      };
      close = () => stream.body.cancel();
    }
    await send(Buffer.concat([version, refresh])); await seen(version.length + refresh.length);
    assert.deepEqual(events, []);
    const baseline = count, input = Buffer.concat([down, up, refresh]);
    const pending = send(input); await entered.promise;
    assert.equal(count, baseline, 'A key reached the native peer before the AI handover completed');
    release.resolve(); await pending; await seen(baseline + input.length);
    assert.deepEqual(Buffer.concat(received), Buffer.concat([version, refresh, input]));
    assert.deepEqual(events.map(event => [event.type, event.held]), [['key', true], ['key', false]]);
    await send(heldPointer); await seen(baseline + input.length + heldPointer.length);
    assert.equal(events.at(-1).held, true);
    await close(); await disconnected.promise;
    assert.equal(events.at(-1).held, false);
    assert.equal(events.at(-1).source, events[0].source);

    // The separate clipboard API uses the same runtime callback and barrier.
    const clipboardEntered = Promise.withResolvers(); release = Promise.withResolvers();
    item.ai.manualInput = async event => { events.push(event); clipboardEntered.resolve(); await release.promise; };
    const paste = call(`/instances/${info.id}/clipboard`, { text: 'clipboard fixture' });
    await clipboardEntered.promise;
    assert.equal(item.runtime.lastClipboard, undefined);
    release.resolve(); await paste;
    assert.equal(item.runtime.lastClipboard, 'clipboard fixture');
    assert.deepEqual(events.at(-1), { source: 'clipboard-api', type: 'clipboard', held: false });
  } finally {
    release?.resolve(); ws?.terminate(); await stream?.body?.cancel().catch(() => {});
    await app?.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => peer.close(resolve)); await cleanup(dataRoot);
  }
});
