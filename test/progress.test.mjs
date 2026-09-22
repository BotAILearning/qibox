import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { TransferProgress, ExtractionOutput } from '../server/progress.mjs';
import { PackageLibrary } from '../server/packages.mjs';
import { temp, cleanup, extractor, packageBytes, packageSha256, delay } from './fixtures.mjs';

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Progress did not arrive'); await delay(10); }
}

test('download percentage is the received byte fraction; recent speed drops to zero during a stall', () => {
  let at = 0; const meter = new TransferProgress(4000, () => at);
  at = 1000; meter.receive(1000);
  assert.deepEqual(meter.snapshot(), { bytes: 1000, total: 4000, progress: 25, bytesPerSecond: 1000 });
  at = 2000; meter.receive(1000);
  assert.equal(meter.snapshot().progress, 50); assert.equal(meter.snapshot().bytesPerSecond, 1000);
  at = 5100; assert.equal(meter.snapshot().bytesPerSecond, 0); assert.equal(meter.snapshot().progress, 50);
  at = 5200; meter.receive(2000); assert.equal(meter.snapshot().progress, 100);
  assert.equal(meter.snapshot().bytesPerSecond, 667);
});

test('unknown sizes stay indeterminate and rate sampling is bounded for many small chunks', () => {
  let at = 0; const meter = new TransferProgress(null, () => at);
  for (at = 1; at <= 10000; at++) meter.receive(1);
  assert.equal(meter.snapshot().bytes, 10000); assert.equal(meter.snapshot().total, null); assert.equal(meter.snapshot().progress, null);
  assert.ok(meter.buckets.length <= 31); assert.ok(meter.snapshot().bytesPerSecond > 0);
});

test('extractor progress supports split JSON lines and long jobs without treating progress as completion', () => {
  const events = [], output = new ExtractionOutput(event => events.push(event));
  const lines = Array.from({ length: 500 }, (_, bytes) => JSON.stringify({ type: 'progress', stage: 'extracting', bytes, total: 499 }) + '\n').join('');
  for (let i = 0; i < lines.length; i += 17) output.push(lines.slice(i, i + 17));
  assert.equal(events.length, 500); assert.throws(() => output.finish(), /Missing/);
  output.push('{"version":"4.1.13.9","binary":"opt/wechat/wechat"}\n');
  assert.equal(output.finish().version, '4.1.13.9');
  for (const invalid of ['{"type":"progress","stage":"extracting","bytes":9,"total":8}\n', '{"version":"x"}\n', 'x'.repeat(16385)]) {
    assert.throws(() => new ExtractionOutput().push(invalid));
  }
});

test('real HTTP bytes drive progress; install preparation and unpacking have separate honest progress', async () => {
  const dataRoot = await temp(), payload = Buffer.alloc(128 * 1024); packageBytes.copy(payload);
  const payloadSha256 = createHash('sha256').update(payload).digest('hex');
  let response, releasePrepare, reportProgress, releaseExtract;
  const preparation = new Promise(resolve => { releasePrepare = resolve; });
  const extraction = new Promise(resolve => { releaseExtract = resolve; });
  const server = createServer((req, res) => {
    assert.equal(req.headers['accept-encoding'], 'identity'); response = res;
    res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, payload.length / 2));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, trustedHashes: [payloadSha256],
    fetcher: (_, options) => fetch(`http://127.0.0.1:${server.address().port}`, options),
    extract: async (file, destination, appRoot, runtimeRoot, progress) => {
      reportProgress = progress; progress({ stage: 'extracting', bytes: 0, total: 200 });
      await extraction; return extractor(file, destination);
    }
  });
  library.beforeInstall = () => preparation;
  try {
    await library.init(); assert.equal(library.download().job.progress, null);
    await until(() => library.publicState().job.bytes === payload.length / 2);
    await delay(120);
    const halfway = library.publicState().job;
    assert.equal(halfway.progress, 50); assert.ok(halfway.bytesPerSecond > 0);
    await delay(3100); assert.equal(library.publicState().job.bytesPerSecond, 0);
    response.end(payload.subarray(payload.length / 2));
    await until(() => library.job.stage === 'preparing');
    assert.equal(library.job.progress, null); assert.equal(library.publicState().job.bytesPerSecond, undefined);
    assert.equal(library.installed(), null);
    releasePrepare(); await until(() => !!reportProgress);
    reportProgress({ stage: 'extracting', bytes: 80, total: 200 });
    assert.equal(library.publicState().job.progress, 40);
    reportProgress({ stage: 'extracting', bytes: 200, total: 200 });
    assert.equal(library.publicState().job.progress, 100); assert.equal(library.installed(), null);
    assert.equal(halfway.progress, 50, 'previous snapshots do not change');
    releaseExtract(); await library.working;
    assert.equal(library.publicState().job.status, 'complete'); assert.ok(library.installed());
  } finally {
    releasePrepare(); releaseExtract(); response?.destroy(); await library.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanup(dataRoot);
  }
});

test('missing or encoded content lengths never produce a false percentage, and errors clear transfer speed', async () => {
  for (const headers of [{}, { 'content-length': '8', 'content-encoding': 'gzip' }]) {
    const dataRoot = await temp(); let stream;
    const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, extract: extractor,
      fetcher: () => new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(packageBytes); } }), { headers }) });
    try {
      await library.init(); library.download(); await until(() => library.publicState().job.bytes === packageBytes.length);
      assert.equal(library.publicState().job.progress, null); assert.equal(library.publicState().job.total, null);
      stream.error(new Error('connection lost')); await library.working;
      assert.equal(library.job.status, 'error'); assert.equal(library.publicState().job.bytesPerSecond, undefined);
    } finally { await library.close(); await cleanup(dataRoot); }
  }
});

test('a body larger than its declared size fails instead of showing more than 100 percent', async () => {
  const dataRoot = await temp();
  const library = new PackageLibrary({ dataRoot, appRoot: dataRoot, extract: extractor,
    fetcher: () => new Response(packageBytes, { headers: { 'content-length': '8' } }) });
  try { await library.init(); library.download(); await library.working; assert.equal(library.job.status, 'error'); assert.match(library.job.message, /大小不符/); assert.equal(library.installed(), null); }
  finally { await library.close(); await cleanup(dataRoot); }
});
