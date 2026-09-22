import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const baseline = process.argv.includes('--baseline');
const dataRoot = await temp(), peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
let runtime, browser;
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher,
  runtimeFactory: (...args) => (runtime = { ...runtimeFactory(...args), port: peer.port, loginStatus: 'logged-in' }) });
const report = { baseline, observations: {}, note: 'Real Edge and noVNC with an isolated RFB/runtime fixture; no user desktop or chat is controlled.' };
const check = (name, actual, expected) => { report.observations[name] = actual; if (!baseline) assert.deepEqual(actual, expected, name); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
  await space.add('微信');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?dev=${app.devKey}`); await page.locator('[data-action=open]').click();
  await page.waitForFunction(() => document.querySelector('#desktop-status').hidden && !!document.querySelector('#remote-canvas canvas'));
  runtime.windowVisible = true; await wait(1400);
  check('showButtonWhileVisible', await page.locator('#desktop-reconnect').isVisible(), false);
  await page.locator('#desktop-fullscreen').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  if (!baseline) await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  check('fullscreenButton', await page.locator('#desktop-fullscreen').textContent(), '退出全屏');
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  if (!baseline) await page.getByRole('button', { name: '全屏', exact: true }).waitFor();
  check('fullscreenButtonAfterBrowserExit', await page.locator('#desktop-fullscreen').textContent(), '全屏');
  // A transient old runtime response must never leave a permanent input-blocking overlay.
  runtime.status = 'starting'; await page.locator('#desktop-status').waitFor({ state: 'visible' });
  runtime.status = 'running'; await wait(1500);
  check('overlayAfterRecovery', await page.locator('#desktop-status').isVisible(), false);
  // Remove only the known reproduction overlay so independent baseline cases can run.
  if (baseline) await page.locator('#desktop-status').evaluate(el => { el.hidden = true; });
  await page.mouse.move(600, 400); await page.mouse.down();
  await page.waitForFunction(() => !!document.captureElement);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await wait(100);
  check('captureAfterBlur', await page.evaluate(() => !!document.captureElement), false);
  if (!baseline) check('remoteMouseReleased', peer.pointers.at(-1)?.mask, 0);
  await page.mouse.up();
  runtime.windowVisible = false; await wait(1300);
  await page.getByRole('button', { name: '显示微信', exact: true }).waitFor();
  await page.locator('#desktop-reconnect').click();
  if (!baseline) await page.locator('#desktop-reconnect').waitFor({ state: 'hidden' });
  await page.mouse.move(600, 400); await page.mouse.down();
  await page.waitForFunction(() => !!document.captureElement);
  peer.disconnect(); await wait(300);
  check('captureAfterDisconnect', await page.evaluate(() => !!document.captureElement), false);
  await page.mouse.up();
  await page.getByRole('button', { name: '连接微信', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#desktop-status').hidden);
  const before = peer.pointers.length; await page.mouse.click(600, 400); await wait(100);
  check('mouseWorksAfterReconnect', peer.pointers.slice(before).some(event => event.mask === 1), true);
  if (!baseline) {
    const framesBeforeAuto = peer.frames, startsBeforeAuto = runtime.starts;
    peer.disconnect();
    await page.waitForFunction(() => !document.querySelector('#desktop-status').hidden);
    await page.waitForFunction(() => document.querySelector('#desktop-status').hidden, { timeout: 12000 });
    check('automaticReconnectReceivesFrames', peer.frames > framesBeforeAuto, true);
    check('automaticReconnectDoesNotRestartWeChat', runtime.starts, startsBeforeAuto);
    let pasteRoute;
    await page.route('**/clipboard', route => { pasteRoute = route; });
    await page.locator('#native-input').evaluate(input => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain','paste timeout fixture');
      input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
    });
    await wait(150); const blockedAt = peer.pointers.length;
    await page.mouse.click(600,400); await wait(100);
    check('clicksWaitDuringPaste',peer.pointers.slice(blockedAt).some(event=>event.mask===1),false);
    await page.locator('#toast').filter({hasText:'连接超时，请重试'}).waitFor({timeout:15000});
    await pasteRoute.abort().catch(()=>{}); await page.unroute('**/clipboard');
    const releasedAt=peer.pointers.length; await page.mouse.click(600,400); await wait(100);
    check('clicksResumeAfterPasteTimeout',peer.pointers.slice(releasedAt).some(event=>event.mask===1),true);
    await page.locator('#desktop-fullscreen').click(); await page.getByRole('button',{name:'退出全屏',exact:true}).click();
    await page.getByRole('button',{name:'全屏',exact:true}).waitFor();
    check('fullscreenExitButtonWorks',await page.evaluate(()=>!document.fullscreenElement),true);
    await page.locator('#desktop-back').click();
    let delayed, resume; const gate=new Promise(resolve=>{resume=resolve;});
    await page.route('**/instances/*/desktop',async route=>{delayed=true;await gate;await route.continue().catch(()=>{});});
    const frames=peer.frames;
    await page.locator('[data-action=open]').click();
    for(let i=0;i<100&&!delayed;i++) await wait(20);
    assert.ok(delayed); await page.locator('#desktop-back').click(); resume(); await wait(300);
    check('lateConnectionCannotReopenClosedDesktop',await page.locator('#desktop-view').isVisible(),false);
    check('lateConnectionDoesNotCreateRfb',peer.frames,frames);
  }
  check('scriptErrors', errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
  await mkdir(path.join(root, process.env.QIBOX_TEST_OUTPUT || 'reports'), { recursive: true });
  await writeFile(path.join(root, process.env.QIBOX_TEST_OUTPUT || 'reports', `desktop-recovery-${baseline ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
