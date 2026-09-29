import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { root, playwrightPath } from './tooling.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();
const html = `<!doctype html><meta charset="utf-8"><div id="screen" style="width:400px;height:250px">微信画面</div>
<input id="file" type="file"><section id="panel" hidden><span data-file-status></span><button data-file-choose>选择</button><button data-file-nas>NAS</button><button data-file-cancel>取消</button><input data-file-name><span data-file-destination-help></span><progress hidden></progress></section>
<script type="module">
import { localFiles } from '/web/local-files.mjs';
const png = Uint8Array.from(atob('${image.toString('base64')}'), c => c.charCodeAt(0));
window.notices = []; window.calls = []; window.remote = null;
window.bridge = localFiles({ screen: document.querySelector('#screen'), input: document.querySelector('#file'), panel: document.querySelector('#panel'),
  api: async value => { calls.push(value.action); if (value.action === 'state') return { available: true, request: remote }; if (value.action === 'claim') return { request: remote }; if (value.action === 'export-finish' || value.action === 'cancel') { remote = null; return {}; } return {}; },
  download: async () => new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } }),
  notify: text => notices.push(text), focus: () => {}, upload: async () => {} });
</script>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
  if (/^\/web\/(local-files|file-export)\.mjs$/.test(req.url)) {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(await readFile(path.join(root, req.url.slice(1)))); return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('Browser error:', error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  let browserDownloads = 0; page.on('download', () => browserDownloads++);
  await page.locator('#screen').click();
  await page.evaluate(() => { window.remote = { id: '11111111-1111-4111-8111-111111111111', operation: 'copy', name: '微信图片.png', count: 1, ready: true }; });
  try { await page.waitForFunction(() => window.notices.includes('图片已复制到当前设备剪贴板'), null, { timeout: 7000 }); }
  catch (error) { console.error(await page.evaluate(() => ({ notices, calls, remote, secure: isSecureContext, clipboard: !!navigator.clipboard, panelHidden: document.querySelector('#panel').hidden }))); throw error; }
  assert.equal(await page.locator('#panel').isHidden(), true);
  assert.equal(browserDownloads, 0);
  assert.equal(await page.evaluate(() => window.remote), null);
  await page.context().grantPermissions(['clipboard-read']);
  assert.deepEqual(await page.evaluate(async () => {
    const items = await navigator.clipboard.read(), blob = await items[0].getType('image/png');
    const bitmap = await createImageBitmap(blob);
    try { return [bitmap.width, bitmap.height, blob.type]; } finally { bitmap.close(); }
  }), [1, 1, 'image/png']);
  console.log(JSON.stringify({ browser: 'Edge', imageClipboard: true, downloadDialog: false, browserDownload: false }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
