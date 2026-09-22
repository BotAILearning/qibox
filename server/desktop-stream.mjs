import net from 'node:net';
import { AppError } from './files.mjs';
import { RfbInputGate } from './rfb-input.mjs';

// UGOS authenticates API requests with a custom header. Fetch can carry that
// header on both directions; browser WebSocket constructors cannot. Keep the
// existing WebSocket transport for fnOS, and stream the same RFB bytes on UGOS.
export class DesktopStreams {
  constructor() { this.connections = new Map(); }
  async open(key, uid, runtime, req, res) {
    await runtime.foregroundRequested?.();
    if (res.destroyed) return;
    const upstream = net.connect(runtime.port, '127.0.0.1');
    const release = runtime.desktopConnected?.();
    const gate = new RfbInputGate({ beforeInput: event => runtime.manualInput?.(event),
      write: bytes => new Promise((resolve, reject) => upstream.write(bytes, error => error ? reject(error) : resolve())) });
    const entry = { uid, upstream, res, gate, writing: false };
    this.connections.set(key, entry);
    const close = () => { this.connections.delete(key); void gate.close().catch(() => {}); upstream.destroy(); release?.(); };
    res.once('close', close);
    upstream.once('error', () => res.destroy());
    upstream.once('connect', () => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); upstream.pipe(res);
    });
    upstream.once('close', () => res.end());
  }
  async input(key, uid, req) {
    const item = this.connections.get(key);
    if (!item || item.uid !== uid || item.upstream.destroyed) throw new AppError('桌面连接已结束，请重新打开', 404);
    if (req.headers['content-type'] !== 'application/octet-stream') throw new AppError('请求格式错误', 415);
    if (item.writing) throw new AppError('桌面请求顺序错误', 409);
    item.writing = true;
    try {
      let size = 0; const chunks = [];
      for await (const bytes of req) { size += bytes.length; if (size > 1024 ** 2) throw new AppError('请求过大', 413); chunks.push(bytes); }
      if (item.upstream.writableLength + size > 2 * 1024 ** 2) throw new AppError('桌面连接繁忙', 503);
      await item.gate.feed(Buffer.concat(chunks));
    } catch (error) { item.res.destroy(); item.upstream.destroy(); void item.gate.close().catch(() => {}); throw error; }
    finally { item.writing = false; }
  }
  close() { for (const item of this.connections.values()) { void item.gate.close().catch(() => {}); item.res.destroy(); item.upstream.destroy(); } this.connections.clear(); }
}
