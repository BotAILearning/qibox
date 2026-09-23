import path from 'node:path';
import { AppError } from './files.mjs';

const unavailable = () => new AppError('暂时无法读取微信数据，请稍后重试', 409, 'ai_data_unavailable');

// Keep the worker alive well past the old 60s idle timeout so its in-memory
// SessionCache (SQLCipher keys, session manager hint, recent read snapshots)
// survives between user-triggered reads. A cold start rescans the whole WeChat
// process memory twice (session manager + key discovery), which is what makes
// the "核对" popup take tens of seconds even when the conversation has few
// messages. Reuse is safe: every request still re-validates account root, DB/WAL
// versions and process identity, and any change clears the cache and restarts.
const IDLE_KEEP_ALIVE_MS = 15 * 60 * 1000;

// Cancelling a request must not cost the worker. Python is asked to abort the
// request in flight and then goes back to serving, so the next read still hits
// the warm key/session caches. Only an unresponsive worker is restarted.
const CANCEL_GRACE_MS = 2500;

// One private pipe per owned WeChat process. No keys or chat bodies are logged
// or written to disk. Aborting waits for process exit and descriptor cleanup.
export class DataWorker {
  constructor(runtime, context, { spawnProcess, openMemory }) {
    this.runtime = runtime; this.context = context; this.spawnProcess = spawnProcess; this.openMemory = openMemory;
    this.closed = Promise.withResolvers(); this.output = ''; this.stopping = false;
    this.drained = Promise.resolve();
    this.started = this.start();
  }
  async start() {
    try {
      const pid = this.context.dataPid || this.context.pid;
      this.memory = await this.openMemory(`/proc/${pid}/mem`, 'r');
      if (this.stopping) return this.finish();
      const runtime = this.runtime;
      this.child = this.spawnProcess(path.join(runtime.runtimeRoot, 'usr/bin/python3.11'),
        [path.join(runtime.appRoot, 'server/wechat-data.py'), String(pid), '--worker'], {
          env: { ...runtime.desktopEnv, PYTHONHOME: path.join(runtime.runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
          windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', this.memory.fd],
        });
      this.child.stdin.on('error', () => this.stop());
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => this.receive(chunk));
      this.child.once('error', () => { this.stopping = true; void this.finish(); });
      this.child.once('close', () => { this.stopping = true; void this.finish(); });
    } catch { this.stopping = true; await this.finish(); }
  }
  async finish() {
    if (this.finishing) return;
    this.finishing = true; this.stopping = true;
    clearTimeout(this.idleTimer); clearTimeout(this.killTimer); clearTimeout(this.drainTimer);
    this.draining = false;
    try { await this.memory?.close(); } catch {}
    this.memory = null; this.output = '';
    if (this.pending) this.settle(this.pending.signal?.aborted ? this.pending.signal.reason : unavailable());
    this.drainSettled?.resolve(); this.drainSettled = null;
    this.closed.resolve();
  }
  stop() {
    if (this.stopping) return this.closed.promise;
    this.stopping = true; clearTimeout(this.idleTimer); clearTimeout(this.drainTimer); this.draining = false;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000); this.killTimer.unref();
    }
    return this.closed.promise;
  }
  settle(error, result) {
    const pending = this.pending; if (!pending) return;
    this.pending = null; clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abort);
    if (error) pending.reject(error); else pending.resolve(result);
    if (!this.stopping) { clearTimeout(this.idleTimer); this.idleTimer = setTimeout(() => this.stop(), IDLE_KEEP_ALIVE_MS); this.idleTimer.unref(); }
  }
  // Abort the current request but keep the worker: the node-side callers rely on
  // a warm process, and a restart repeats the cold scan before any answer.
  softCancel(signal) {
    if (this.stopping || this.draining) return;
    this.draining = true;
    this.drainSettled = Promise.withResolvers();
    this.drained = this.drainSettled.promise;
    const pending = this.pending; this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort);
      pending.reject(signal?.aborted ? signal.reason : unavailable());
    }
    try { this.child?.kill('SIGUSR1'); } catch {}
    clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => this.stop(), CANCEL_GRACE_MS); this.drainTimer.unref();
  }
  // The cancelled request has been flushed: this worker is usable again.
  finishDrain() {
    if (!this.draining) return;
    this.draining = false; clearTimeout(this.drainTimer); this.drainTimer = null;
    this.output = '';
    this.drainSettled?.resolve(); this.drainSettled = null;
    if (this.stopping) { this.stop(); return; }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_KEEP_ALIVE_MS); this.idleTimer.unref();
  }
  receive(chunk) {
    if (this.stopping) return;
    this.output += chunk;
    // While draining, the only thing python can produce is the discarded answer
    // to the request we just cancelled. Anything else stays a hard failure.
    const acceptable = this.pending || this.draining;
    if (!acceptable || Buffer.byteLength(this.output) > 50 * 1024 * 1024) { this.output = ''; this.stop(); return; }
    const end = this.output.indexOf('\n'); if (end < 0) return;
    const line = this.output.slice(0, end), extra = this.output.slice(end + 1); this.output = '';
    if (extra.trim()) { this.stop(); return; }
    try {
      const result = JSON.parse(line);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable();
      if (this.pending) this.settle(null, result);
      else this.finishDrain();
    } catch { this.stop(); }
  }
  async request(value, signal) {
    const abortStartup = () => this.stop();
    signal?.addEventListener('abort', abortStartup, { once: true });
    if (signal?.aborted) this.stop();
    await this.started; signal?.removeEventListener('abort', abortStartup);
    if (this.stopping || signal?.aborted) {
      await this.stop();
      if (signal?.aborted) throw signal.reason;
      throw unavailable();
    }
    // Wait for a cancellation to finish first: writing into a pipe that python
    // is still flushing would pair the next request with the previous reply.
    while (this.draining && !this.stopping) await Promise.race([this.drained, this.closed.promise]);
    if (this.stopping || signal?.aborted) {
      await this.stop();
      if (signal?.aborted) throw signal.reason;
      throw unavailable();
    }
    if (this.pending) throw unavailable(); // Caller serializes requests.
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const abort = () => this.softCancel(signal), timer = setTimeout(abort, 43000);
      this.pending = { resolve, reject, signal, abort, timer };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else this.child.stdin.write(JSON.stringify(value) + '\n');
    });
  }
}
