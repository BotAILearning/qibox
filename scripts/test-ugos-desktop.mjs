import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { root, playwrightPath } from './tooling.mjs';
import { createApplication } from '../server/index.mjs';
import { runtimeFactory, extractor, fetcher, temp, cleanup } from '../test/fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, host: 'ugos', arch: 'arm64', fetcher, extract: extractor,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port }) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const space = await app.users.get('1000'); await space.setConsent(true); app.library.download(); await app.library.working;
const instance = await space.add('ARM微信'); await space.start(instance.id);
const output = await build({ stdin: { resolveDir: root, contents: `
  import RFB from '@novnc/novnc'; import { HttpDesktop } from './web/http-desktop.mjs';
  const headers = {'Ugreen-Ttk':'test-token'};
  const session = await (await fetch('/api/qibox/api/session', {headers})).json();
  headers['X-CSRF-Token'] = session.csrf;
  const c = await (await fetch('/api/qibox/api/instances/${instance.id}/desktop', {method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).json();
  window.client = new RFB(document.getElementById('screen'),new HttpDesktop({stream:c.path,input:c.input,headers:async()=>headers}),{credentials:{password:c.password}});
  window.client.addEventListener('connect',()=>window.connected=true);
` }, write: false, bundle: true, format: 'esm', platform: 'browser' });
const report = { note: 'Real Edge/noVNC over authenticated fetch streams and a simulated UGOS gateway/RFB peer. Does not test actual UGOS firmware or ARM execution.', status: 'running' };
let browser; const requests = [], errors = [], logs = [], responses = [];
const proxy = http.createServer((req, res) => {
  if (req.url === '/') { res.end('<!doctype html><style>body{margin:0}#screen{width:1280px;height:800px}</style><div id="screen"></div><script type="module" src="/test.js"></script>'); return; }
  if (req.url === '/test.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(output.outputFiles[0].contents); return; }
  if (req.headers['ugreen-ttk'] !== 'test-token') { res.writeHead(401); res.end(); return; }
  requests.push(req.url.split('?')[0]);
  const upstream = http.request({ host: '127.0.0.1', port: app.server.address().port, path: req.url, method: req.method,
    headers: { ...req.headers, 'ugreen-user-id': '1000', 'ugreen-user-type': 'admin' } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  upstream.on('error', () => res.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => logs.push(message.text()));
  page.on('response', response => responses.push([response.url().split('?')[0], response.status()]));
  await page.goto(`http://127.0.0.1:${proxy.address().port}/`);
  await page.waitForFunction(() => window.connected && document.querySelector('canvas')?.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255);
  await page.mouse.click(400, 300); await page.keyboard.type('Ab');
  await page.waitForTimeout(150);
  assert.deepEqual(peer.keys.filter(x => x.down).map(x => x.symbol), [65, 98]);
  assert.ok(peer.pointers.some(x => x.mask === 1)); assert.deepEqual(errors, []); assert.deepEqual(peer.errors, []);
  assert.ok(requests.includes('/api/qibox/desktop/stream')); assert.ok(requests.includes('/api/qibox/desktop/input'));
  await page.screenshot({ path: path.join(root, 'reports/screenshots/ugos-desktop-transport.png') });
  await page.evaluate(() => window.client.disconnect());
  report.status = 'passed'; report.checks = ['UGOS headers on stream and ordered input', 'Full RFB frame rendered', 'Keyboard and pointer arrive once', 'Clean disconnect'];
} catch (error) { report.status = 'failed'; report.error = error.stack; report.diagnostics = { requests, errors, logs, responses, peerErrors: peer.errors }; process.exitCode = 1; }
finally { await browser?.close(); await app.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await peer.close(); await cleanup(dataRoot); await writeFile(path.join(root, 'reports/ugos-desktop-tests.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
