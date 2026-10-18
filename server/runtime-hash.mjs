import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Two bounded CPU workers keep full SHA256 verification off the UI/API loop.
// Idle workers do not keep an application or test process alive.
const slots = [null, null], waiting = [];
function drain() {
  for (let index = 0; index < slots.length && waiting.length; index++) {
    let slot = slots[index];
    if (!slot) {
      const worker = new Worker(new URL('./runtime-hash.mjs', import.meta.url));
      slot = slots[index] = { worker, task: null };
      const failed = error => {
        if (slots[index] !== slot) return;
        slots[index] = null; slot.task?.reject(error); slot.task = null;
        void worker.terminate(); drain();
      };
      worker.on('error', failed);
      worker.on('exit', code => failed(Error(`Runtime hash worker exited (${code})`)));
      worker.on('message', result => {
        const task = slot.task; if (!task) return;
        slot.task = null; worker.unref();
        if (/^[a-f0-9]{64}$/.test(result.sha256 || '')) task.resolve(result.sha256);
        else task.reject(Error(result.error || 'Runtime hash failed'));
        drain();
      });
      worker.unref();
    }
    if (slot.task) continue;
    slot.task = waiting.shift(); slot.worker.ref();
    slot.worker.postMessage({ file: slot.task.file });
  }
}
export function hashRuntimeFile(file) {
  return new Promise((resolve, reject) => { waiting.push({ file, resolve, reject }); drain(); });
}
if (!isMainThread) parentPort.on('message', ({ file }) => {
  let fd;
  try {
    fd = openSync(file, 'r'); const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(512 * 1024);
    let bytes; while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    parentPort.postMessage({ sha256: hash.digest('hex') });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { if (fd !== undefined) closeSync(fd); }
});
