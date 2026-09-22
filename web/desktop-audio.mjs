// Instance-private PCM; ordinary open/play gestures unlock browser audio.
export function desktopAudio({ surface, endpoint, headers, notify, contextFactory = () => new AudioContext({ sampleRate: 48000 }), request = fetch }) {
  let context, controller, disposed = false, running = false, retry, warned = false;
  function unlock() {
    if (disposed) return;
    try {
      context ||= contextFactory();
      void context.resume().then(() => { if (!disposed && context.state === 'running') void start(); }).catch(() => {});
    } catch { if (!warned) { warned = true; notify('当前浏览器暂时无法播放声音'); } }
  }
  async function start() {
    if (disposed || running || context?.state !== 'running') return;
    clearTimeout(retry); running = true;
    const active = context; controller = new AbortController(); const signal = controller.signal;
    try {
      const authentication = await headers();
      if (disposed || signal.aborted) return;
      const response = await request(endpoint, { method: 'POST', credentials: 'same-origin', headers: { ...authentication, 'Content-Type': 'application/json' }, body: '{}', signal });
      if (disposed || signal.aborted) { await response.body?.cancel(); return; }
      if (!response.ok || !response.body) throw new Error('audio unavailable');
      warned = false;
      const reader = response.body.getReader(); let pending = new Uint8Array(), next = active.currentTime + .08;
      while (!disposed && !signal.aborted) {
        const { value, done } = await reader.read(); if (done) break;
        if (disposed || signal.aborted) { await reader.cancel(); return; }
        const bytes = new Uint8Array(pending.length + value.length); bytes.set(pending); bytes.set(value, pending.length);
        const size = bytes.length - bytes.length % 4; pending = bytes.slice(size);
        if (!size || active.state !== 'running') continue;
        const recent = bytes.subarray(Math.max(0, size - 19200), size);
        const audio = active.createBuffer(2, recent.length / 4, 48000), view = new DataView(recent.buffer, recent.byteOffset, recent.byteLength);
        for (let channel = 0; channel < 2; channel++) { const data = audio.getChannelData(channel); for (let i = 0; i < data.length; i++) data[i] = view.getInt16(i * 4 + channel * 2, true) / 32768; }
        if (next > active.currentTime + .4) continue;
        next = Math.max(next, active.currentTime + .02);
        const source = active.createBufferSource(); source.buffer = audio; source.connect(active.destination); source.start(next); next += audio.duration;
      }
    } catch {
      // Reconnect silently, including the startup race while audio becomes ready.
    } finally {
      controller?.abort(); controller = null; running = false;
      if (!disposed) retry = setTimeout(unlock, 3000);
    }
  }
  for (const event of ['pointerdown', 'keydown', 'touchend']) surface.addEventListener(event, unlock, true);
  unlock();
  return { resume: unlock, dispose() {
    disposed = true; clearTimeout(retry); controller?.abort();
    for (const event of ['pointerdown', 'keydown', 'touchend']) surface.removeEventListener(event, unlock, true);
    void context?.close().catch(() => {});
  } };
}
