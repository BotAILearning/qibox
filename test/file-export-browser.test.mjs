import test from 'node:test';
import assert from 'node:assert/strict';
import { fileExporter } from '../web/file-export.mjs';

test('cancel releases a pending save picker and a late result cannot save or block the next request', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const pending = Promise.withResolvers();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: () => pending.promise } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
  let downloads = 0, lateWrites = 0, saved = '', finished = 0;
  const exporter = fileExporter({
    call: async action => { if (action === 'export-finish') finished++; },
    download: async () => { downloads++; return new Response('EXACT_FILE'); },
    show() {}, notify() {},
  });
  const controller = new AbortController();
  const old = exporter.local({ id: 'old', count: 1, operation: 'copy' }, 'old.txt', controller.signal);
  controller.abort();
  await assert.rejects(old, { name: 'AbortError' });
  pending.resolve({ createWritable() { lateWrites++; throw Error('Cancelled picker must not be used'); } });
  await Promise.resolve();
  assert.equal(downloads, 0); assert.equal(lateWrites, 0); assert.equal(finished, 0);
  window.showSaveFilePicker = async () => ({ createWritable: async () => new WritableStream({ write(bytes) { saved += new TextDecoder().decode(bytes); } }) });
  await exporter.local({ id: 'next', count: 1, operation: 'copy' }, 'next.txt', new AbortController().signal);
  assert.equal(saved, 'EXACT_FILE'); assert.equal(downloads, 1); assert.equal(finished, 1);
});
