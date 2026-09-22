// Bound transient display backpressure without dropping a healthy input channel.
export function desktopSocket(ws, upstream, { heartbeatMs = 20000 } = {}) {
  let alive = true, closed = false;
  const pong = () => { alive = true; };
  const timer = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false; if (ws.readyState === 1) ws.ping();
  }, heartbeatMs);
  timer.unref?.(); ws.on('pong', pong);
  const data = bytes => {
    if (ws.readyState !== 1 || closed) return;
    if (ws.bufferedAmount > 16 * 1024 ** 2) return ws.close(1009);
    upstream.pause();
    ws.send(bytes, error => { if (error) upstream.destroy(); else if (!closed && ws.readyState === 1) upstream.resume(); });
  };
  upstream.on('data', data);
  const close = () => { closed = true; clearInterval(timer); ws.off('pong', pong); upstream.off('data', data); };
  ws.once('close', close); upstream.once('close', close);
  return close;
}
