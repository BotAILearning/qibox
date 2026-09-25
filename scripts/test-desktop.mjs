import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
import { ChatFixture } from '../test/ai-fixtures.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
let runtime;
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher,
  runtimeFactory: (...args) => (runtime = { ...runtimeFactory(...args), port: peer.port, aiBridge: new ChatFixture() }) });
// This test installs a deliberately fake archive to exercise the real UI flow.
// Trust only its exact fixture bytes so package validation does not reject it.
app.library.trustedHashes.push(packageSha256);
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
const report = { startedAt: new Date().toISOString(), note: 'Real Edge + noVNC + application WebSocket proxy connected to an RFB protocol fixture. CDP composition exercises browser IME events; no OS candidate window or real Linux/WeChat process is tested.', checks: [] };
let browser;
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Protocol assertion timed out'); };
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await mkdir(path.join(root, process.env.QIBOX_TEST_OUTPUT || 'reports', 'screenshots'), { recursive: true });
  for (const hasTouch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?dev=${app.devKey}`);
    if (!hasTouch) {
      await page.getByRole('heading', { name: '欢迎使用栖盒' }).waitFor();
      await page.locator('input[name=consent]').check(); await page.getByRole('button', { name: '开始使用' }).click();
      await page.locator('#modal').waitFor({ state: 'hidden' });
      await page.locator('#download').click();
    }
    await page.locator('#package-status').filter({ hasText: '已安装' }).waitFor();
    if (hasTouch) await page.locator('[data-action=open]').first().click();
    else {
      await page.locator('#add-instance').click();
      await page.getByRole('button', { name: '确定', exact: true }).click();
      await page.locator('#modal').waitFor({ state: 'hidden' });
      await page.locator('[data-action=open]').first().focus(); await page.keyboard.press('Enter');
    }
    await page.locator('#native-input').waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#remote-canvas canvas');
      return canvas?.width === 1280 && canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255 && document.querySelector('#desktop-status').hidden;
    });
    const cursor = await page.locator('#remote-canvas canvas').evaluate(canvas => ({ inline: canvas.style.cursor, computed: getComputedStyle(canvas).cursor }));
    assert.equal(cursor.inline, 'none'); assert.equal(cursor.computed, 'default');
    const background = await page.request.get(`${base}/backgrounds/mist.jpg`);
    assert.equal(background.status(), 200); assert.equal(background.headers()['content-type'], 'image/jpeg');
    assert.ok((await background.body()).length > 10000);
    for (const selector of ['#desktop-view', '#desktop-screen', '#remote-canvas']) assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundImage), 'none');
    assert.match(await page.locator('#desktop-status').evaluate(el => getComputedStyle(el).backgroundImage), /backgrounds\/mist\.jpg/);
    assert.equal(await page.locator('.desktop-bar button:not(#desktop-takeover)').count(), 3);
    assert.equal(await page.locator('#desktop-takeover').isVisible(), false);
    report.checks.push(`${hasTouch ? 'Touch-capable PC' : 'PC'}: empty RFB cursor stays visible through the browser cursor; wallpaper loads; no extra desktop buttons or layered wallpaper`);

    const canvas = await page.locator('#remote-canvas canvas').boundingBox();
    await page.mouse.click(canvas.x + canvas.width - 15, canvas.y + canvas.height - 15);
    assert.equal(await page.locator('#native-input').evaluate(el => el === document.activeElement), true);
    const start = peer.keys.length;
    await page.keyboard.type('Ab');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
    await page.locator('#native-input.composing').waitFor();
    const rect = await page.locator('#native-input').boundingBox(), screen = await page.locator('#desktop-screen').boundingBox();
    assert.ok(rect.x >= screen.x && rect.y >= screen.y && rect.x + rect.width <= screen.x + screen.width + 1 && rect.y + rect.height <= screen.y + screen.height + 1);
    assert.equal(await page.locator('#native-input').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: rect.x + 4, y: rect.y + 4 }), 'CANVAS');
    if (!hasTouch) await page.screenshot({ path: path.join(root, process.env.QIBOX_TEST_OUTPUT || 'reports', 'screenshots/desktop-composition.png') });
    await cdp.send('Input.insertText', { text: '你好' });
    await page.keyboard.press('Control+Space');
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    const expected = [65, 98, 0xffe3, 118, 120, 0xff08];
    await until(() => peer.keys.slice(start).filter(key => key.down).length >= expected.length);
    assert.deepEqual(peer.keys.slice(start).filter(key => key.down).map(key => key.symbol), expected);
    assert.equal(runtime.lastClipboard, '你好');
    assert.equal(await page.locator('#native-input').inputValue(), '');
    assert.equal(await page.locator('#native-input').evaluate(el => el.classList.contains('composing')), false);
    const pointerStart = peer.pointers.length;
    await page.mouse.click(rect.x + 4, rect.y + 4);
    await until(() => peer.pointers.slice(pointerStart).some(event => event.mask === 1));
    report.checks.push(`${hasTouch ? 'Touch-capable PC' : 'PC'}: CDP Chinese composition commits once; subsequent English/backspace work; Ctrl+Space stays local; candidate anchor stays within edges and permits clicks`);

    const beforeReconnect = peer.frames;
    runtime.windowVisible = false;
    await page.getByRole('button', { name: '重新登录', exact: true }).waitFor();
    const shown = runtime.logins;
    await page.locator('#desktop-reconnect').click(); await until(() => runtime.logins > shown);
    assert.equal(peer.frames, beforeReconnect, 'Showing the window keeps the existing connection');
    assert.equal(await page.locator('#ai-rail').isVisible(), false);
    runtime.loginStatus = 'logged-in';
    await page.locator('.instance-card .status').filter({ hasText: '已登录' }).waitFor({ state: 'attached' });
    await page.locator('#ai-rail').waitFor({ state: 'visible' });
    await page.locator('#ai-open').click();
    await page.locator('#ai-panel').waitFor({ state: 'visible' });
    await page.locator('.ai-main-tabs [data-ai-nav=settings]').click();
    await page.locator('.ai-settings-entry[data-ai-nav=provider]').click();
    await page.locator('[data-ai-action=model-add]').click();
    await page.locator('#ai-model-form [name=model]').fill('unsaved-model-draft');
    runtime.loginStatus = 'unknown'; runtime.aiEntryAvailable = true;
    await page.waitForResponse(response => response.url().endsWith('/state'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#ai-rail').getAttribute('hidden'), null);
    assert.equal(await page.locator('#ai-panel').isVisible(), true);
    let interruptedState = false;
    await page.route('**/state', async route => { interruptedState = true; await route.abort('failed'); });
    await until(() => interruptedState);
    await page.locator('#connection-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#ai-panel').isVisible(), true);
    assert.equal(await page.locator('#ai-model-form [name=model]').inputValue(), 'unsaved-model-draft');
    report.checks.push('AI entry and open model draft survive unknown login observations and failed state requests');
    await page.unroute('**/state');
    runtime.aiEntryAvailable = false;
    runtime.loginStatus = 'relogin-required';
    await page.getByRole('button', { name: '重新登录', exact: true }).waitFor();
    await page.locator('#ai-rail').waitFor({ state: 'hidden' });
    await page.locator('#desktop-reconnect').click(); await until(() => runtime.logins > 0);
    await page.waitForFunction(() => document.querySelector('#desktop-status').hidden && !document.querySelector('#desktop-reconnect').disabled);
    await page.locator('.instance-card .status').filter({ hasText: '未登录' }).waitFor({ state: 'attached' });
    peer.disconnect(); runtime.loginStatus = 'relogin-required';
    await page.getByRole('button', { name: '重新登录', exact: true }).waitFor();
    const logins = runtime.logins;
    await page.locator('#desktop-reconnect').click();
    await until(() => runtime.logins > logins && peer.frames > beforeReconnect);
    await page.waitForFunction(() => document.querySelector('#desktop-status').hidden);
    const resumedFrames = peer.frames;
    peer.disconnect();
    await page.getByRole('button', { name: '重新登录', exact: true }).waitFor();
    await page.locator('#desktop-reconnect').click();
    await until(() => peer.frames > resumedFrames);
    await page.waitForFunction(() => !document.querySelector('#native-input').hidden && document.querySelector('#desktop-status').hidden);
    await page.mouse.click(500, 400);
    const restart = peer.keys.length;
    await page.keyboard.type('Z'); await until(() => peer.keys.length > restart);
    assert.deepEqual(peer.keys.slice(restart).filter(key => key.down).map(key => key.symbol), [90]);
    assert.deepEqual(errors, []);
    report.checks.push(`${hasTouch ? 'Touch-capable PC' : 'PC'}: reconnect has one input bridge and no script errors`);
    report.checks.push('Login labels update independently; show preserves RFB; relogin opens login action; disconnected desktop reconnects');
    await context.close();
  }
  assert.deepEqual(peer.errors, []); assert.equal(peer.frames, 6); report.status = 'passed'; report.frames = peer.frames;
} catch (error) { report.status = 'failed'; report.error = error.stack; report.protocolErrors = peer.errors; process.exitCode = 1; }
finally {
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, process.env.QIBOX_TEST_OUTPUT || 'reports'), { recursive: true });
  await writeFile(path.join(root, process.env.QIBOX_TEST_OUTPUT || 'reports', 'desktop-tests.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
