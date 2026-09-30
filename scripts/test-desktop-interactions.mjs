import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createApplication } from '../server/index.mjs';
import { FileChooser } from '../server/file-chooser.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), home = path.join(dataRoot, 'profile');
await mkdir(home);
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
let chooser, runtime, browser, page;
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher,
  runtimeFactory: (...args) => {
    const base = runtimeFactory(...args);
    chooser = new FileChooser({ dataRoot: args[1].dataRoot, home, send: () => {} });
    return runtime = { ...base, port: peer.port, fileChooser: chooser,
      async prepare() { await base.prepare(); await chooser.init(); this.status = 'stopped'; },
      async stop() { await chooser.close(); this.status = 'stopped'; } };
  } });
app.library.trustedHashes.push(packageSha256);
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
const report = { layer: 'Edge browser + noVNC + real file APIs, synthetic remote desktop and copy events', checks: [] };
const errors = [], downloads = [];
const wait = async predicate => { for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out waiting for operation'); };
const gesture = async () => { await page.locator('#remote-canvas canvas').click({ position: { x: 5, y: 5 } }); };
const copied = (value) => chooser.receive({ type: 'request', operation: 'copy', id: randomUUID(), ...value });
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('download', d => downloads.push(d));
  await page.goto(`${base}/?dev=${app.devKey}`);
  await page.locator('input[name=consent]').check(); await page.getByRole('button', { name: '开始使用' }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); await page.locator('#download').click();
  await page.locator('#add-instance').click(); await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); await page.locator('[data-action=open]').first().click();
  await page.waitForFunction(() => document.querySelector('#desktop-status').hidden && !!document.querySelector('#remote-canvas canvas')?.width);
  await page.evaluate(async () => {
    window.realWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.realCopyCommand = document.execCommand.bind(document);
    window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined;
    window.clipboardSaved = await Promise.all((await navigator.clipboard.read()).map(async item => {
      const values = {}; for (const type of item.types) values[type] = await item.getType(type); return values;
    })).catch(() => []);
  });
  const text = 'QIBOX-clipboard 中文🙂\r\n第二行 é';
  await gesture(); await page.keyboard.press('Control+c'); copied({ clipboardType: 'text', text });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('文字已复制到本机'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
  assert.equal(downloads.length, 0); assert.equal(await page.locator('#file-transfer').isHidden(), true);
  report.checks.push('Ctrl+C copies exact Unicode, emoji and multiple lines to local clipboard without downloading');

  await page.evaluate(() => {
    window.realWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.realCopyCommand = document.execCommand.bind(document);
    navigator.clipboard.writeText = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
    document.execCommand = () => false;
  });
  await gesture(); copied({ clipboardType: 'text', text: 'QIBOX-clipboard retry' });
  await page.locator('[data-file-copy]').waitFor({ state: 'visible' });
  const pendingId = chooser.exports.pending.id;
  assert.equal(chooser.exports.pending.clipboardType, 'text');
  await page.evaluate(() => { navigator.clipboard.writeText = window.realWriteText; document.execCommand = window.realCopyCommand; });
  await page.locator('[data-file-copy]').click();
  await wait(() => chooser.exports.pending === null);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'QIBOX-clipboard retry');
  report.checks.push('Denied clipboard permission retains the same request and explicit retry succeeds');

  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('API unavailable'); }; });
  await gesture(); copied({ clipboardType: 'text', text: 'QIBOX-clipboard HTTP fallback' });
  await wait(() => chooser.exports.pending === null);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'QIBOX-clipboard HTTP fallback');
  await page.evaluate(() => { navigator.clipboard.writeText = window.realWriteText; });
  report.checks.push('Text copies through user-initiated browser copy when async Clipboard API is unavailable');

  const image = path.join(home, '复制图片.png');
  await writeFile(image, await sharp({ create: { width: 3, height: 2, channels: 4, background: '#168b61' } }).png().toBuffer());
  await gesture(); copied({ uris: [pathToFileURL(image).href] });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('图片已复制'));
  assert.deepEqual(await page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0], image = await createImageBitmap(await item.getType('image/png'));
    try { return [image.width, image.height]; } finally { image.close(); }
  }), [3, 2]);
  assert.equal(downloads.length, 0);
  report.checks.push('A copied image becomes an actual local PNG clipboard item without a save dialog');

  const file = path.join(home, '资料.txt'); await writeFile(file, 'QIBOX-file-copy');
  await gesture(); copied({ uris: [pathToFileURL(file).href] });
  await page.locator('#file-transfer').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-file-copy]').isHidden(), true);
  assert.equal(downloads.length, 0);
  await page.locator('[data-file-choose]').click();
  await wait(() => downloads.length === 1 && chooser.exports.pending === null);
  assert.equal(downloads[0].suggestedFilename(), '资料.txt');
  report.checks.push('An ordinary file offers an explicit save destination and is never decoded as an image');

  await gesture();
  // Real paste uses the granted browser clipboard and the actual input bridge.
  await page.evaluate(() => navigator.clipboard.writeText('QIBOX-clipboard 本机粘贴🙂'));
  await page.keyboard.press('Control+v');
  await wait(() => runtime.lastClipboard === 'QIBOX-clipboard 本机粘贴🙂');
  await page.keyboard.type('A'); await page.keyboard.press('Backspace');
  await wait(() => peer.keys.some(k => k.symbol === 0xff08));
  assert.equal(peer.keys.filter(k => k.down && k.symbol === 0xff0d).length, 0);
  report.checks.push('Local Unicode paste and following English/backspace work without pressing Send');

  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('Denied'); }; document.execCommand = () => false; });
  await gesture(); copied({ clipboardType: 'text', text: 'QIBOX-clipboard cancel' });
  await page.locator('[data-file-copy]').waitFor({ state: 'visible' });
  await page.locator('[data-file-cancel]').click(); await wait(() => chooser.exports.pending === null);
  await gesture(); copied({ clipboardType: 'text', text: 'QIBOX-clipboard disconnect' });
  await page.locator('[data-file-copy]').waitFor({ state: 'visible' });
  await page.locator('#desktop-back').click(); await wait(() => chooser.exports.pending === null);
  report.checks.push('Cancel and disconnect invalidate the clipboard request');
  assert.deepEqual(errors, []); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; report.errors = errors; process.exitCode = 1;
} finally {
  if (page) await page.evaluate(async () => {
    if (!window.realWriteText) return;
    navigator.clipboard.writeText = window.realWriteText; document.execCommand = window.realCopyCommand;
    const value = await navigator.clipboard.readText().catch(() => '');
    if (value.startsWith('QIBOX-clipboard') && window.clipboardSaved?.length) await navigator.clipboard.write(window.clipboardSaved.map(item => new ClipboardItem(item))).catch(() => {});
  }).catch(() => {});
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
  await mkdir(path.join(root, 'reports'), { recursive: true });
  await writeFile(path.join(root, 'reports/desktop-interactions-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
