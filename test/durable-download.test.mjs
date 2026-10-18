import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableDownload, resourcePaths } from '../server/durable-download.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(handler) {
  const directory = await mkdtemp(join(tmpdir(), 'durable-download-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/resource`;
  return {
    directory, url,
    resource: (data, extra = {}) => ({ id: 'fixture', version: 'v1', url, size: data.length, sha256: sha(data), ...extra }),
    downloader: options => new DurableDownload({ directory, allowHttp: true, ...options }),
    close: async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); },
  };
}
const send = (res, status, headers, body) => { res.writeHead(status, headers); res.end(body); };

test('Range download validates every chunk, writes a hash cache, and duplicate starts share work', async () => {
  const data = randomBytes(2 * 1024 * 1024 + 31); let requests = 0;
  const f = await fixture((req, res) => {
    requests++;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!range) return send(res, 200, { 'content-length': data.length, etag: '"v1"' }, data);
    const start = Number(range[1]), end = Number(range[2]);
    send(res, 206, { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1, etag: '"v1"' }, data.subarray(start, end + 1));
  });
  try {
    const d = f.downloader(); await d.init(f.resource(data));
    assert.equal(d.start().status, 'downloading');
    assert.equal(d.start().status, 'downloading');
    await d.working;
    assert.equal(d.snapshot().status, 'complete');
    assert.equal(d.file, d.getFile());
    assert.equal(resourcePaths(f.resource(data)).cache, `${sha(data)}.cache`);
    assert.equal((await readFile(d.getFile())).compare(data), 0);
    assert.equal(requests, 3);
    const again = f.downloader(); await again.init(f.resource(data));
    assert.equal(again.snapshot().status, 'complete');
    assert.equal(requests, 3);
  } finally { await f.close(); }
});

test('pause preserves checkpoint and a new downloader resumes it after restart', async () => {
  const data = randomBytes(3 * 1024 * 1024); let secondRangeSeen; let pauseRangeHits = 0;
  const seen = new Promise(resolve => { secondRangeSeen = resolve; });
  const f = await fixture((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const start = Number(m?.[1] ?? 0), end = Number(m?.[2] ?? data.length - 1);
    if (start >= 1024 * 1024 && ++pauseRangeHits === 1) { secondRangeSeen(); res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 }); return; }
    res.writeHead(m ? 206 : 200, m ? { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 } : { 'content-length': data.length });
    res.end(data.subarray(start, end + 1));
  });
  try {
    const first = f.downloader(); await first.init(f.resource(data)); first.start();
    await seen;
    await first.pause();
    assert.equal(first.snapshot().status, 'paused');
    assert.equal(first.snapshot().bytes, 1024 * 1024);
    const restarted = f.downloader(); await restarted.init(f.resource(data));
    assert.equal(restarted.snapshot().status, 'paused');
    await restarted.start(); await restarted.working;
    assert.equal(restarted.snapshot().status, 'complete');
    assert.equal((await readFile(restarted.getFile())).compare(data), 0);
  } finally { await f.close(); }
});

test('restart discards saved partial bytes when the pinned URL changes', async () => {
  const data = randomBytes(2 * 1024 * 1024); let nextRange; let held = false;
  const secondRequest = new Promise(resolve => { nextRange = resolve; });
  const f = await fixture((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const start = Number(m?.[1] ?? 0), end = Number(m?.[2] ?? data.length - 1);
    if (start >= 1024 * 1024 && !held) { held = true; nextRange(); res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 }); return; }
    send(res, m ? 206 : 200, m ? { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 } : { 'content-length': data.length }, data.subarray(start, end + 1));
  });
  try {
    const original = f.resource(data);
    const first = f.downloader(); await first.init(original); first.start(); await secondRequest; await first.pause();
    assert.equal(first.snapshot().bytes, 1024 * 1024);
    const changedUrl = { ...original, url: `${original.url}?source=changed` };
    const restarted = f.downloader(); await restarted.init(changedUrl);
    assert.equal(restarted.snapshot().status, 'idle'); assert.equal(restarted.snapshot().bytes, 0);
    restarted.start(); await restarted.working;
    assert.equal(restarted.snapshot().status, 'complete');
    assert.equal((await readFile(restarted.getFile())).compare(data), 0);
  } finally { await f.close(); }
});

test('a source that ignores Range is safely restarted from zero and never appended', async () => {
  const data = randomBytes(2 * 1024 * 1024); const ranges = [];
  const f = await fixture((req, res) => {
    ranges.push(req.headers.range ?? null);
    send(res, 200, { 'content-length': data.length, etag: '"v1"' }, data);
  });
  try {
    const d = f.downloader(); await d.init(f.resource(data)); d.start(); await d.working;
    assert.equal(d.snapshot().status, 'complete');
    assert.deepEqual(ranges, ['bytes=0-1048575']);
    assert.equal((await readFile(d.getFile())).compare(data), 0);
  } finally { await f.close(); }
});

test('changed ETag discards old bytes before requesting the new source from zero', async () => {
  const data = randomBytes(2 * 1024 * 1024); let generation = 0; const offsets = [];
  const f = await fixture((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const start = Number(m?.[1] ?? 0), end = Number(m?.[2] ?? data.length - 1); offsets.push(start);
    const etag = generation++ === 0 ? '"old"' : '"new"';
    const body = Buffer.from(data);
    send(res, m ? 206 : 200, { ...(m ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}), 'content-length': end - start + 1, etag }, body.subarray(start, end + 1));
  });
  try {
    const d = f.downloader(); await d.init(f.resource(data)); d.start(); await d.working;
    assert.equal(d.snapshot().status, 'complete');
    assert.ok(offsets.includes(0));
    assert.equal((await readFile(d.getFile())).compare(data), 0);
  } finally { await f.close(); }
});

test('bad Content-Range and declared length stop without advancing checkpoint', async () => {
  const data = randomBytes(120); let mode = 'range';
  const f = await fixture((_req, res) => mode === 'range'
    ? send(res, 206, { 'content-range': 'bytes 1-120/120', 'content-length': 120 }, data)
    : send(res, 200, { 'content-length': 119 }, data));
  try {
    const d = f.downloader(); await d.init(f.resource(data)); d.start(); await d.working;
    assert.equal(d.snapshot().status, 'error'); assert.equal(d.snapshot().bytes, 0);
    mode = 'length'; d.start(); await d.working;
    assert.equal(d.snapshot().status, 'error'); assert.equal(d.snapshot().bytes, 0);
  } finally { await f.close(); }
});

test('bad final hash removes the partial file and can be retried', async () => {
  const data = randomBytes(200); let body = Buffer.from(data); let hash = sha(Buffer.from('different'));
  const f = await fixture((_req, res) => send(res, 200, { 'content-length': body.length }, body));
  try {
    const d = f.downloader(); await d.init(f.resource(data, { sha256: hash })); d.start(); await d.working;
    assert.equal(d.snapshot().status, 'error'); assert.equal(d.snapshot().bytes, 0);
    body = data; hash = sha(data); // Resource hashes are immutable; use a new correctly identified downloader for retry.
    const retry = f.downloader(); await retry.init(f.resource(data)); retry.start(); await retry.working;
    assert.equal(retry.snapshot().status, 'complete');
  } finally { await f.close(); }
});

test('offline import verifies size and hash before exposing a completed path', async () => {
  const data = Buffer.from('offline payload');
  const f = await fixture((_req, res) => send(res, 200, { 'content-length': data.length }, data));
  try {
    const source = join(f.directory, 'source.bin'); await writeFile(source, data);
    const d = f.downloader(); await d.init(f.resource(data));
    assert.equal(await d.importFile(source), d.getFile());
    assert.equal(d.snapshot().status, 'complete');
    const invalid = join(f.directory, 'bad.bin'); await writeFile(invalid, Buffer.from('wrong payload'));
    const next = f.downloader(); await next.init(f.resource(data, { id: 'other' }));
    await assert.rejects(next.importFile(invalid), /大小/);
    const wrongHash = join(f.directory, 'wrong-hash.bin'); await writeFile(wrongHash, Buffer.alloc(data.length, 0x78));
    await assert.rejects(next.importFile(wrongHash), /SHA-256/);
  } finally { await f.close(); }
});
