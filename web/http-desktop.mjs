// WebSocket-compatible byte channel for noVNC, authenticated through normal
// same-origin UGOS API requests. Input is batched and serialized in byte order.
export class HttpDesktop {
  constructor({ stream, input, headers, fetcher = fetch }) {
    this.url = stream; this.input = input; this.headers = headers; this.fetcher = (...args) => fetcher(...args);
    this.readyState = 0; this.binaryType = 'arraybuffer'; this.protocol = ''; this.bufferedAmount = 0;
    this.onopen = this.onclose = this.onerror = this.onmessage = null;
    this.controller = new AbortController(); this.queue = []; this.sending = false;
    queueMicrotask(() => this.connect());
  }
  async connect() {
    try {
      const response = await this.fetcher(this.url, { credentials: 'same-origin', headers: await this.headers(), signal: this.controller.signal });
      if (!response.ok || !response.body) throw new Error('Desktop connection failed');
      if (this.readyState === 3) return;
      this.readyState = 1; this.onopen?.({});
      const reader = response.body.getReader();
      while (this.readyState === 1) {
        const { done, value } = await reader.read(); if (done) break;
        this.onmessage?.({ data: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) });
      }
      this.close();
    } catch { if (this.readyState !== 3) { this.onerror?.({}); this.close(); } }
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('Desktop disconnected');
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    if (this.bufferedAmount + bytes.length > 2 * 1024 ** 2) { this.onerror?.({}); this.close(); return; }
    this.queue.push(bytes); this.bufferedAmount += bytes.length;
    if (!this.sending) { this.sending = true; queueMicrotask(() => this.flush()); }
  }
  async flush() {
    try {
      while (this.queue.length && this.readyState === 1) {
        const parts = []; let size = 0;
        while (this.queue.length && size + this.queue[0].length <= 1024 ** 2) { const part = this.queue.shift(); parts.push(part); size += part.length; }
        if (!size) throw new Error('Input too large');
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        const response = await this.fetcher(this.input, { method: 'POST', credentials: 'same-origin', headers: { ...await this.headers(), 'Content-Type': 'application/octet-stream' }, body: bytes, signal: this.controller.signal });
        if (!response.ok) throw new Error('Desktop input failed');
        this.bufferedAmount -= size;
      }
    } catch { if (this.readyState !== 3) { this.onerror?.({}); this.close(); } }
    finally { this.sending = false; }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3; this.controller.abort(); this.queue = []; this.bufferedAmount = 0;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}
