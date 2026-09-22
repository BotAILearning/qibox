import { randomUUID } from 'node:crypto';
import { AppError } from './files.mjs';

const MAX_MESSAGE = 1024 * 1024;
const MAX_PENDING = 2 * MAX_MESSAGE;
const MAX_QUEUED_CHUNKS = 1024;
const versions = ['RFB 003.007\n', 'RFB 003.008\n'].map(value => Buffer.from(value));
const protocolError = () => new AppError('桌面连接不受支持，请重新打开', 409, 'rfb_input_protocol');
const closedError = () => new AppError('桌面连接已结束，请重新打开', 409, 'rfb_input_closed');
const limitError = () => new AppError('桌面连接繁忙，请重新打开', 413, 'rfb_input_limit');

// RFB 3.7/3.8 client stream framing for the bundled noVNC + local x11vnc.
// Pixels are never inspected. Clipboard/authentication bodies pass through as
// bounded opaque bytes; key identity is an in-memory opaque token, never text.
export class RfbInputGate {
  #beforeInput;
  #write;
  #source = randomUUID();
  #stage = 'version';
  #buffer = Buffer.alloc(0);
  #pending = 0;
  #queuedChunks = 0;
  #tail = Promise.resolve();
  #closed = false;
  #closing;
  #keys = new Set();
  #buttons = 0;

  constructor({ beforeInput = () => {}, write }) {
    if (typeof beforeInput !== 'function' || typeof write !== 'function') throw new TypeError('RFB callbacks are required');
    this.#beforeInput = beforeInput;
    this.#write = write;
  }

  feed(data) {
    if (this.#closed) return Promise.reject(closedError());
    if (!(data instanceof Uint8Array)) return this.#reject(protocolError());
    if (!data.byteLength) return Promise.resolve();
    if (this.#pending + data.byteLength > MAX_PENDING || this.#queuedChunks >= MAX_QUEUED_CHUNKS) return this.#reject(limitError());
    const bytes = Buffer.from(data);
    this.#pending += bytes.length;
    this.#queuedChunks++;
    const work = this.#tail.then(async () => {
      if (this.#closed) throw closedError();
      this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, bytes]) : bytes;
      while (this.#buffer.length && !this.#closed) {
        const frame = this.#frame();
        if (!frame || this.#buffer.length < frame.length) break;
        const message = this.#buffer.subarray(0, frame.length);
        this.#buffer = this.#buffer.length === frame.length ? Buffer.alloc(0) : this.#buffer.subarray(frame.length);
        if (frame.next) this.#stage = frame.next;
        const event = frame.input ? this.#event(frame.input, message) : null;
        let blocked = false;
        if (event) {
          try { await this.#beforeInput(event); }
          catch (error) {
            // A draft guard blocks input, not the read-only desktop. Keeping
            // the RFB session alive lets the owner inspect and take over.
            if (error instanceof AppError && ['ai_draft_check', 'ai_input_pending'].includes(error.code)) blocked = true;
            else throw error;
          }
        }
        if (this.#closed) throw closedError();
        if (!blocked) await this.#write(message);
        this.#pending = Math.max(0, this.#pending - frame.length);
      }
    }).catch(async error => {
      await this.close().catch(() => {});
      throw error instanceof AppError ? error : closedError();
    }).finally(() => { this.#queuedChunks--; });
    this.#tail = work.catch(() => {});
    return work;
  }

  #reject(error) {
    void this.close().catch(() => {});
    return Promise.reject(error);
  }

  #frame() {
    const bytes = this.#buffer;
    if (this.#stage === 'version') {
      if (bytes.length < 12) return null;
      if (!versions.some(version => version.equals(bytes.subarray(0, 12)))) throw protocolError();
      return { length: 12, next: 'security' };
    }
    if (this.#stage === 'security') {
      if (bytes[0] !== 1 && bytes[0] !== 2) throw protocolError();
      return { length: 1, next: bytes[0] === 2 ? 'authentication' : 'init' };
    }
    if (this.#stage === 'authentication') return { length: 16, next: 'init' };
    if (this.#stage === 'init') {
      if (bytes[0] > 1) throw protocolError();
      return { length: 1, next: 'messages' };
    }

    const type = bytes[0];
    const header = { 0: 20, 2: 4, 3: 10, 4: 8, 5: 2, 6: 8, 150: 10, 248: 9, 250: 4, 251: 8, 255: 12 }[type];
    if (!header) throw protocolError();
    if (bytes.length < header) return null;
    let length = header, input;
    if (type === 2) length += bytes.readUInt16BE(2) * 4;
    else if (type === 4) {
      if (bytes[1] > 1) throw protocolError();
      input = 'key';
    } else if (type === 5) {
      length = bytes[1] & 0x80 ? 7 : 6;
      input = 'pointer';
    } else if (type === 6) {
      const size = bytes.readInt32BE(4);
      length += Math.abs(size);
      if (size < 0) {
        if (size > -4) throw protocolError();
        if (bytes.length >= 12) {
          const flags = bytes.readUInt32BE(8);
          // Capability/notify/request traffic is automatic negotiation. Only
          // an actual clipboard payload requires a manual-input barrier.
          if (!(flags & 0x01000000) && flags & 0x10000000) input = 'clipboard';
        }
      } else input = 'clipboard';
    } else if (type === 248) {
      if (bytes[8] > 64) throw protocolError();
      length += bytes[8];
    } else if (type === 251) length += bytes[6] * 16;
    else if (type === 255) {
      if (bytes[1] !== 0 || bytes.readUInt16BE(2) > 1) throw protocolError();
      input = 'extended-key';
    }
    if (length > MAX_MESSAGE) throw limitError();
    return { length, input };
  }

  #event(type, bytes) {
    let details;
    if (type === 'key' || type === 'extended-key') {
      const extended = type === 'extended-key', down = extended ? !!bytes.readUInt16BE(2) : !!bytes[1];
      const offset = extended ? 8 : 4;
      const token = `${extended ? 'q' : 'k'}:${bytes.subarray(offset, offset + 4).toString('hex')}`;
      if (down) this.#keys.add(token); else this.#keys.delete(token);
      if (this.#keys.size > 256) throw limitError();
      details = { type: 'key', down, submitKey: [0xff0d, 0xff8d].includes(bytes.readUInt32BE(4)) };
    } else if (type === 'pointer') {
      if (bytes.length === 7 && bytes[6] & 0xfc) throw protocolError();
      this.#buttons = (bytes[1] & 0x7f) | (bytes.length === 7 ? bytes[6] << 7 : 0);
      details = { type, buttons: this.#buttons, x: bytes.readUInt16BE(2), y: bytes.readUInt16BE(4) };
    } else details = { type };
    return { source: this.#source, ...details, held: this.#buttons !== 0 || this.#keys.size !== 0 };
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#pending = 0;
    this.#keys.clear(); this.#buttons = 0;
    // Release this connection's lease immediately, including when a preceding
    // input is still waiting for an AI child to exit. Never forward after close.
    this.#closing = Promise.resolve().then(() => this.#beforeInput({ source: this.#source, type: 'disconnect', held: false }));
    return this.#closing;
  }
}
