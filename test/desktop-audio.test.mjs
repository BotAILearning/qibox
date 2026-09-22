import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopAudio } from '../web/desktop-audio.mjs';

test('ordinary desktop interaction unlocks default audio; repeated gestures share one stream; dispose removes listeners and aborts', async () => {
  const handlers = new Map(), played = [], signals = [];
  const surface = { addEventListener(e, fn) { handlers.set(e, fn); }, removeEventListener(e) { handlers.delete(e); } };
  const c = { state: 'suspended', currentTime: 0, destination: {}, async resume() {}, async close() { this.state = 'closed'; },
    createBuffer(channels, size, rate) { return { duration: size / rate, getChannelData() { return new Float32Array(size); } }; },
    createBufferSource() { return { connect(dest) { assert.equal(dest, c.destination); }, start(at) { played.push(at); } }; } };
  let calls = 0, stream;
  const player = desktopAudio({ surface, endpoint: '/private/audio', headers: async () => ({ 'X-CSRF-Token': 'fixture' }), notify() {}, contextFactory: () => c,
    request: async (url, init) => { calls++; signals.push(init.signal); assert.equal(url, '/private/audio'); assert.equal(init.method, 'POST');
      stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0, 0, 1, 0])); init.signal.addEventListener('abort', () => controller.close()); } });
      return { ok: true, body: stream };
    } });
  await new Promise(r => setImmediate(r)); assert.equal(calls, 0);
  c.state = 'running'; handlers.get('pointerdown')(); handlers.get('keydown')();
  await new Promise(r => setImmediate(r)); assert.equal(calls, 1); assert.equal(played.length, 1);
  player.dispose(); await new Promise(r => setImmediate(r)); assert.equal(signals[0].aborted, true); assert.equal(handlers.size, 0); assert.equal(c.state, 'closed');
});
