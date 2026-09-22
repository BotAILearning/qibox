import test from 'node:test';
import assert from 'node:assert/strict';
import { RfbInputGate } from '../server/rfb-input.mjs';
import { AppError } from '../server/files.mjs';

const handshake = (security = 1, version = '008') => Buffer.concat([Buffer.from(`RFB 003.${version}\n`), Buffer.from([security]), ...(security === 2 ? [Buffer.alloc(16, 0xa5)] : []), Buffer.from([1])]);
const key = (down, token = 0x01000061) => { const bytes = Buffer.alloc(8); bytes[0] = 4; bytes[1] = +down; bytes.writeUInt32BE(token, 4); return bytes; };
const extendedKey = (down, token = 30) => { const bytes = Buffer.alloc(12); bytes[0] = 255; bytes.writeUInt16BE(+down, 2); bytes.writeUInt32BE(token, 8); return bytes; };
const pointer = (mask = 0, extended = 0) => { const bytes = Buffer.alloc(extended ? 7 : 6); bytes[0] = 5; bytes[1] = mask | (extended ? 0x80 : 0); if (extended) bytes[6] = extended; return bytes; };
const refresh = () => { const bytes = Buffer.alloc(10); bytes[0] = 3; bytes[1] = 1; return bytes; };
const clipboard = (body, extended = false) => { const header = Buffer.alloc(8); header[0] = 6; header.writeInt32BE(extended ? -body.length : body.length, 4); return Buffer.concat([header, body]); };
const extendedClipboard = flags => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(flags); return clipboard(bytes, true); };
const setup = overrides => {
  const events = [], writes = [];
  const gate = new RfbInputGate({ beforeInput: async event => { events.push(event); await overrides?.beforeInput?.(event); }, write: async bytes => { await overrides?.write?.(bytes); writes.push(Buffer.from(bytes)); } });
  return { gate, events, writes };
};
const connected = async overrides => { const result = setup(overrides); await result.gate.feed(handshake()); result.writes.length = 0; return result; };
const protocol = { code: 'rfb_input_protocol' }, closed = { code: 'rfb_input_closed' }, limit = { code: 'rfb_input_limit' };
test('draft protection drops input while keeping framebuffer refresh and later takeover alive', async () => {
  let blocked = true;
  const { gate, writes } = await connected({ beforeInput: () => { if (blocked) throw new AppError('draft', 409, 'ai_draft_check'); } });
  await gate.feed(Buffer.concat([pointer(1), pointer(), key(true), key(false), refresh()]));
  assert.deepEqual(writes, [refresh()]);
  blocked = false;
  await gate.feed(pointer(1)); await gate.feed(pointer());
  assert.deepEqual(writes, [refresh(), pointer(1), pointer()]);
  await gate.close();
});

test('None and VNC authentication handshakes survive byte fragmentation without user activity', async () => {
  for (const security of [1, 2]) for (const version of ['007', '008']) {
    const { gate, writes, events } = setup(), bytes = handshake(security, version);
    for (const byte of bytes) await gate.feed(Buffer.from([byte]));
    assert.deepEqual(Buffer.concat(writes), bytes);
    assert.deepEqual(events, []);
    await gate.close();
  }
});

test('coalesced negotiation, framebuffer refreshes and clipboard capabilities never pause AI', async () => {
  const { gate, writes, events } = setup();
  const encodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x11]);
  const continuous = Buffer.alloc(10); continuous[0] = 150;
  const fence = Buffer.alloc(12); fence[0] = 248; fence[8] = 3;
  const resize = Buffer.alloc(24); resize[0] = 251; resize[6] = 1;
  const xvp = Buffer.from([250, 0, 1, 2]);
  const bytes = Buffer.concat([handshake(), Buffer.alloc(20), encodings, refresh(), continuous, fence, resize, xvp,
    extendedClipboard(0x1f000001), extendedClipboard(0x08000001), extendedClipboard(0x02000001)]);
  await gate.feed(bytes);
  assert.deepEqual(Buffer.concat(writes), bytes);
  assert.deepEqual(events, []);
  await gate.close();
});

test('split and merged input frames are forwarded intact without exposing opaque key identity', async () => {
  const { gate, writes, events } = await connected();
  const bytes = Buffer.concat([refresh(), key(true), key(false), pointer(8), pointer(), refresh()]);
  for (let offset = 0; offset < bytes.length; offset += 3) await gate.feed(bytes.subarray(offset, offset + 3));
  assert.deepEqual(Buffer.concat(writes), bytes);
  assert.deepEqual(events.map(({ type, held }) => [type, held]), [['key', true], ['key', false], ['pointer', true], ['pointer', false]]);
  assert.ok(events.every(event => !('token' in event) && !('keysym' in event) && !('text' in event)));
  assert.equal(new Set(events.map(event => event.source)).size, 1);
  await gate.close();
});

test('held keys survive pointer motion and other key releases; repeats do not create stuck keys', async () => {
  const { gate, events } = await connected();
  await gate.feed(Buffer.concat([key(true, 1), key(true, 1), key(true, 2), key(false, 2), pointer(), key(false, 1)]));
  assert.deepEqual(events.map(event => event.held), [true, true, true, true, true, false]);
  await gate.feed(Buffer.concat([pointer(1), key(true, 3), key(false, 3), pointer(1), pointer()]));
  assert.deepEqual(events.slice(-5).map(event => event.held), [true, true, true, true, false]);
  await gate.close();
});

test('QEMU keys and extended pointer buttons retain a combined held state until released', async () => {
  const { gate, events } = await connected();
  await gate.feed(Buffer.concat([extendedKey(true), extendedKey(true), pointer(0, 2), extendedKey(false), pointer()]));
  assert.deepEqual(events.map(event => event.held), [true, true, true, true, false]);
  assert.equal(events[2].buttons, 256);
  assert.deepEqual(events.filter(event => event.type === 'key').map(event => event.down), [true, true, false]);
  await gate.close();
});

test('the first input and every later frame wait until native cancellation has completed', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { gate, writes } = await connected({ beforeInput: event => { if (event.type === 'key' && event.down) { entered.resolve(); return release.promise; } } });
  const first = gate.feed(key(true));
  await entered.promise;
  const second = gate.feed(Buffer.concat([refresh(), key(false)]));
  await Promise.resolve();
  assert.equal(writes.length, 0);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [key(true), refresh(), key(false)]);
  await gate.close();
});

test('a partial input frame never reaches x11vnc or changes held state', async () => {
  const { gate, writes, events } = await connected();
  await gate.feed(key(true).subarray(0, 7));
  assert.deepEqual(writes, []); assert.deepEqual(events, []);
  await gate.feed(key(true).subarray(7));
  assert.deepEqual(writes, [key(true)]); assert.equal(events[0].held, true);
  await gate.close();
});

test('clipboard bodies are opaque even when their bytes resemble input frame headers', async () => {
  const { gate, events, writes } = await connected();
  const message = clipboard(Buffer.concat([key(true), pointer(1), Buffer.from('PRIVATE_PROTOCOL_FIXTURE')]));
  const provide = extendedClipboard(0x10000001);
  for (const part of [message.subarray(0, 8), message.subarray(8), provide]) await gate.feed(part);
  assert.deepEqual(writes, [message, provide]);
  assert.deepEqual(events.map(event => event.type), ['clipboard', 'clipboard']);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_PROTOCOL_FIXTURE'));
  await gate.close();
});

test('disconnect immediately releases only its own lease and prevents a waiting write', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { gate, events, writes } = await connected({ beforeInput: event => { if (event.type === 'key') { entered.resolve(); return release.promise; } } });
  const pending = gate.feed(key(true));
  await entered.promise;
  await gate.close(); await gate.close();
  assert.equal(events.filter(event => event.type === 'disconnect').length, 1);
  assert.equal(events.at(-1).held, false);
  assert.equal(events.at(-1).source, events[0].source);
  release.resolve();
  await assert.rejects(pending, closed);
  assert.deepEqual(writes, []);
  await assert.rejects(gate.feed(key(false)), closed);
});

test('failed handover closes the gate without forwarding input or leaking its error body', async () => {
  const { gate, writes, events } = await connected({ beforeInput: event => { if (event.type === 'key') throw new Error('PRIVATE_FAILURE_BODY'); } });
  await assert.rejects(gate.feed(key(true)), error => error.code === 'rfb_input_closed' && !error.message.includes('PRIVATE_FAILURE_BODY'));
  assert.deepEqual(writes, []);
  assert.equal(events.at(-1).type, 'disconnect');
});

test('unsupported handshakes and unknown or malformed messages close without guessing', async () => {
  for (const bytes of [Buffer.from('RFB 003.003\n'), Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([16])])]) {
    const { gate } = setup(); await assert.rejects(gate.feed(bytes), protocol); await assert.rejects(gate.feed(handshake()), closed);
  }
  const badKey = key(true); badKey[1] = 2;
  const badExtendedKey = extendedKey(true); badExtendedKey[1] = 1;
  const badPointer = pointer(0, 1); badPointer[6] = 4;
  const badFence = Buffer.alloc(9); badFence[0] = 248; badFence[8] = 65;
  const badClipboard = Buffer.alloc(8); badClipboard[0] = 6; badClipboard.writeInt32BE(-3, 4);
  for (const bytes of [Buffer.from([42]), badKey, badExtendedKey, badPointer, badFence, badClipboard]) {
    const { gate, writes } = await connected();
    await assert.rejects(gate.feed(Buffer.concat([bytes, refresh()])), protocol);
    assert.deepEqual(writes, []);
  }
});

test('message size, queued bytes and held-key capacity are bounded and release leases on failure', async () => {
  const oversized = Buffer.alloc(8); oversized[0] = 6; oversized.writeInt32BE(1024 * 1024, 4);
  const one = await connected(); await assert.rejects(one.gate.feed(oversized), limit); assert.deepEqual(one.writes, []);
  const two = await connected(); await assert.rejects(two.gate.feed(Buffer.alloc(2 * 1024 * 1024 + 1)), limit); await two.gate.close();
  const three = await connected();
  await assert.rejects(three.gate.feed(Buffer.concat(Array.from({ length: 257 }, (_, index) => key(true, index)))), limit);
  assert.equal(three.writes.length, 256);
  assert.equal(three.events.at(-1).type, 'disconnect'); assert.equal(three.events.at(-1).held, false);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const four = await connected({ beforeInput: event => { if (event.type === 'key') { entered.resolve(); return release.promise; } } });
  const pending = four.gate.feed(key(true)); await entered.promise;
  await assert.rejects(four.gate.feed(Buffer.alloc(2 * 1024 * 1024)), limit);
  release.resolve(); await assert.rejects(pending, closed); assert.deepEqual(four.writes, []);
});

test('separate viewers carry separate source IDs, including their release events', async () => {
  const a = await connected(), b = await connected();
  await a.gate.feed(pointer(1)); await b.gate.feed(key(true));
  assert.notEqual(a.events[0].source, b.events[0].source);
  await a.gate.close();
  assert.equal(b.events.at(-1).held, true);
  await b.gate.close();
});

test('many tiny queued chunks cannot bypass the pending-work limit', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { gate } = await connected({ beforeInput: event => { if (event.type === 'key') { entered.resolve(); return release.promise; } } });
  const first = gate.feed(key(true)); await entered.promise;
  const pending = Array.from({ length: 1023 }, () => gate.feed(Buffer.from([0])));
  const outcomes = Promise.allSettled([first, ...pending]);
  await assert.rejects(gate.feed(Buffer.from([0])), limit);
  release.resolve();
  assert.ok((await outcomes).every(result => result.status === 'rejected'));
});
