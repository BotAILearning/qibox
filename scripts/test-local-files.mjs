import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { FileChooser } from '../server/file-chooser.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const responses = [];
let chooser;
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher,
  runtimeFactory: (...args) => {
    const runtime = runtimeFactory(...args);
    const files = new FileChooser({ dataRoot: args[1].dataRoot, send: response => responses.push(response) });
    chooser = files;
    return { ...runtime, port: peer.port, fileChooser: files,
      async prepare() { await runtime.prepare(); await files.init(); this.status = 'stopped'; },
      async stop() { await files.close(); this.status = 'stopped'; } };
  } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
const report = { note: 'Real Edge, noVNC, authenticated upload APIs and local chooser. A simulated native portal request follows the remote mouse event; this does not verify the official WeChat portal selection on a NAS.', checks: [] };
let browser, trigger, page;
const fileRequests = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/files')) fileRequests.push(request.postData()); });
  await page.goto(`${base}/?dev=${app.devKey}`);
  await page.locator('input[name=consent]').check(); await page.getByRole('button', { name: '开始使用' }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); await page.locator('#download').click();
  await page.locator('#add-instance').click(); await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); await page.locator('[data-action=open]').first().click();
  await page.waitForFunction(() => !document.querySelector('#desktop-status').hidden === false && !!document.querySelector('#remote-canvas canvas'));
  assert.equal(await page.locator('.desktop-bar button').count(), 3);
  const box = await page.locator('#remote-canvas canvas').boundingBox();
  await page.evaluate(() => {
    window.fileTestEvents = [];
    for (const type of ['pointerup', 'mouseup', 'click']) document.querySelector('#desktop-screen').addEventListener(type, event => window.fileTestEvents.push({ type, trusted: event.isTrusted, button: event.button, tag: event.target.tagName }), true);
  });
  const count = peer.pointers.length, requestId = randomUUID();
  trigger = setInterval(() => {
    if (peer.pointers.slice(count).some(event => event.mask === 1)) {
      clearInterval(trigger); trigger = null;
      chooser.receive({ type: 'request', id: requestId, multiple: true });
    }
  }, 10);
  const pickerPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const picker = await pickerPromise;
  assert.equal(picker.isMultiple(), true);
  const bytes = Buffer.from('栖盒本机选文件校验\n');
  const beforeKeys = peer.keys.length;
  await picker.setFiles([{ name: '资料 #1.txt', mimeType: 'text/plain', buffer: bytes }]);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('文件已准备好'));
  assert.equal(responses.length, 1); assert.equal(responses[0].response, 0);
  assert.deepEqual(await readFile(fileURLToPath(responses[0].uris[0])), bytes);
  assert.equal(peer.keys.length, beforeKeys, 'Returning a file never presses Enter or sends a chat');
  report.checks.push('One remote canvas click opens the local browser picker without an added toolbar button', 'Unicode filename and exact local bytes arrive through the authenticated per-instance upload', 'Only a selected-file URI is returned; no keyboard send action occurs');
  // A pending picker can also be cancelled, without returning any file URI.
  chooser.receive({ type: 'request', id: randomUUID(), multiple: false });
  await page.getByRole('button', { name: '全屏', exact: true }).focus();
  await page.waitForTimeout(300);
  const nextPicker = page.waitForEvent('filechooser', { timeout: 10000 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await nextPicker;
  await page.locator('#chat-file').dispatchEvent('cancel');
  await page.locator('#file-transfer').waitFor({ state: 'hidden' });
  assert.equal(responses.at(-1).response, 1);
  assert.equal(responses.at(-1).uris, undefined);
  // A cancelled old upload must not hide a new connection's file dialog.
  let oldPlan;
  await page.route('**/files', route => {
    if (route.request().postDataJSON()?.action === 'plan') { oldPlan = route; return; }
    return route.continue();
  });
  report.staleResponseHidPicker = {};
  for (const interrupt of ['reconnect','cancel']) {
    oldPlan=null; chooser.receive({ type: 'request', id: randomUUID(), multiple: false });
    const oldPicker = page.waitForEvent('filechooser'); await page.mouse.click(box.x + 50, box.y + 50);
    await (await oldPicker).setFiles([{ name:'old.txt',mimeType:'text/plain',buffer:Buffer.from('old') }]);
    for (let i=0;i<100&&!oldPlan;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(oldPlan);
    if (interrupt==='reconnect') {
      peer.disconnect(); await page.getByRole('button',{name:'连接微信',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#desktop-status').hidden);
    } else await page.locator('[data-file-cancel]').click();
    for (let i=0;i<100&&chooser.pending;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(chooser.pending,null);
    chooser.receive({ type:'request',id:randomUUID(),multiple:false });
    const freshPicker=page.waitForEvent('filechooser'); await page.mouse.click(box.x+50,box.y+50); await freshPicker;
    await page.locator('#file-transfer').waitFor({state:'visible'});
    await oldPlan.abort(); await new Promise(resolve=>setTimeout(resolve,200));
    report.staleResponseHidPicker[interrupt]=await page.locator('#file-transfer').isHidden();
    if (!process.argv.includes('--race-baseline')) assert.equal(report.staleResponseHidPicker[interrupt],false,`${interrupt}: an old response hid or cancelled the new chooser`);
    await page.locator('#chat-file').dispatchEvent('cancel');
    for (let i=0;i<100&&chooser.pending;i++) await new Promise(resolve=>setTimeout(resolve,20));
  }
  await page.unroute('**/files');
  report.checks.push('An old upload response after reconnect cannot hide or block the new file chooser');
  assert.deepEqual(errors, []);
  report.checks.push('Cancelling local selection cancels the native request and leaves the chat unchanged');
  await mkdir(path.join(root, 'reports/screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'reports/screenshots/local-files-test.png') });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; report.requests = fileRequests.slice(-12); report.nativePending = chooser?.state(); report.browser = await page?.evaluate(() => ({ panelHidden: document.querySelector('#file-transfer')?.hidden, status: document.querySelector('[data-file-status]')?.textContent, focus: document.hasFocus(), activation: navigator.userActivation.isActive, events: window.fileTestEvents })); process.exitCode = 1; }
finally {
  clearInterval(trigger); await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
  await writeFile(path.join(root, 'reports/local-files-tests.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
