import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { streamAudio } from '../server/audio.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('audio stream carries exact PCM and closes the private monitor when the browser disconnects', async t => {
  const directory = await temp(), socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-audio-${randomUUID()}` : path.join(directory, 'audio.sock');
  const connections = new Set(), payload = Buffer.from([0, 12, 255, 16, 0, 0, 0, 0]);
  const native = net.createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('error', () => {}); socket.write(payload); });
  await new Promise(resolve => native.listen(socketPath, resolve));
  const runtime = { status: 'running', audioEnv:{}, audioProcess:{exitCode:null,signalCode:null}, audioSocket: socketPath };
  const server = http.createServer((req, res) => { streamAudio(runtime, req, res).catch(error => { res.writeHead(error.status || 500); res.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of connections) socket.destroy(); for (const socket of runtime.audioListeners || []) socket.destroy(); server.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => native.close(r))]); await cleanup(directory); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST' });
  assert.equal(response.status, 200); assert.match(response.headers.get('x-audio-format'), /48000/);
  const reader = response.body.getReader(); assert.deepEqual(Buffer.from((await reader.read()).value), payload);
  assert.equal(runtime.audioListeners.size, 1); await reader.cancel();
  for (let i = 0; i < 50 && runtime.audioListeners.size; i++) await delay(10);
  assert.equal(runtime.audioListeners.size, 0);
});

test('audio refuses unavailable and excess connections and releases a failed socket', async () => {
  await assert.rejects(streamAudio({ status: 'stopped' }, {}, {}), { status: 409 });
  await assert.rejects(streamAudio({ status: 'running', audioEnv:{}, audioProcess:{exitCode:null,signalCode:null}, audioSocket: 'unused', audioListeners: new Set([1, 2, 3, 4]) }, {}, {}), { status: 429 });
  const runtime = { status: 'running', audioEnv:{}, audioProcess:{exitCode:null,signalCode:null}, audioSocket: process.platform === 'win32' ? `\\\\.\\pipe\\missing-${randomUUID()}` : `/tmp/missing-${randomUUID()}.sock` };
  await assert.rejects(streamAudio(runtime, {}, { on() {} })); assert.equal(runtime.audioListeners.size, 0);
});
