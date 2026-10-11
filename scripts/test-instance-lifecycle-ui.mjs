import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
import { playwrightPath, root } from './tooling.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const out = new URL('../dist/test-instance-lifecycle-ui/', import.meta.url);
await fs.mkdir(out, { recursive: true });
const fixture = await proactiveFixture();
const space = await fixture.app.users.get('development');
const item = space.get(fixture.instance.id);
const proof = { build: JSON.parse(await fs.readFile(root + '/config/product.json')).buildId,
  scope: 'Production browser bundle, disposable synthetic instance/runtime and delayed or failed HTTP responses; no real device, model service or WeChat delivery.',
  checks: [], errors: [], passed: false };
let browser, release;
try {
  let stops = 0, starts = 0;
  const stop = item.runtime.stop.bind(item.runtime), start = item.runtime.start.bind(item.runtime);
  item.runtime.stop = async () => { stops++; await stop(); };
  item.runtime.start = async () => { starts++; await start(); };
  // Native runtime publishes logged-out when the process is stopped. The base
  // fixture retains its login flag, so normalize only this synthetic publication.
  const publicState = item.runtime.publicState.bind(item.runtime);
  item.runtime.publicState = () => ({ ...publicState(),
    loginStatus: item.runtime.status === 'running' ? item.runtime.loginStatus : 'logged-out' });
  const beforeModel = fixture.provider.calls.length;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => proof.errors.push(error.message));
  await page.goto(fixture.url);
  const card = page.locator(`[data-instance="${item.meta.id}"]`);
  await card.waitFor();
  const menu = async () => { if (await card.locator('details').getAttribute('open') === null) await card.locator('summary').click(); };
  const open = async () => {
    if (await card.locator('details').getAttribute('open') !== null) await card.locator('summary').click();
    await card.locator('[data-action=open]').click();
  };
  const delayed = async (action, click, inspect, name) => {
    let requests = 0;
    const gate = Promise.withResolvers(), first = Promise.withResolvers();
    release = () => gate.resolve();
    const pattern = `**/api/instances/${item.meta.id}/${action}`;
    await page.route(pattern, async route => { requests++; first.resolve(); await gate.promise; await route.continue(); });
    await click();
    let timer;
    try { await Promise.race([first.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Expected instance request not observed')), 6000); })]); }
    finally { clearTimeout(timer); }
    await inspect();
    await page.screenshot({ path: fileURLToPath(new URL(name + '.png', out)) });
    assert.equal(requests, 1, 'One user action must remain one request while its response is pending');
    release();
    await page.waitForFunction(() => ![...document.querySelectorAll('.instance-card .status, .mobile-instance-card .status')].some(x => x.textContent === '请稍候…'));
    await page.unroute(pattern);
    proof.checks.push(name);
  };
  await delayed('stop', async () => { await menu(); await card.getByRole('button', { name: '停止', exact: true }).click(); }, async () => {
    await menu();
    assert.equal(await card.getByRole('button', { name: '停止', exact: true }).isEnabled(), false);
    assert.equal(await card.locator('[data-action=open]').isEnabled(), false);
    assert.equal(await card.locator('.status').innerText(), '请稍候…');
  }, 'desktop-pending-stop');
  assert.equal(stops, 1); assert.equal(item.runtime.status, 'stopped');
  await delayed('start', open, async () => {
    await page.locator('#desktop-back').click();
    assert.equal(await card.locator('[data-action=open]').isEnabled(), false);
    assert.equal(await card.locator('.status').innerText(), '请稍候…');
  }, 'desktop-pending-start');
  assert.equal(starts, 1); assert.equal(item.runtime.status, 'running');
  let failedStops = 0;
  const stopPattern = `**/api/instances/${item.meta.id}/stop`;
  await page.route(stopPattern, async route => { failedStops++; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成停止失败，请重试' }) }); });
  await menu(); await card.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByText('合成停止失败，请重试', { exact: true }).waitFor();
  await card.locator('[data-action=open]').waitFor({ state: 'visible' });
  assert.equal(await card.locator('[data-action=open]').isEnabled(), true);
  assert.equal(item.runtime.status, 'running'); assert.equal(failedStops, 1); assert.equal(stops, 1);
  await page.screenshot({ path: fileURLToPath(new URL('desktop-stop-failure.png', out)) });
  await page.unroute(stopPattern); proof.checks.push('desktop-stop-failure-restores-action-without-retry');
  await menu(); await card.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-instance] .status')?.textContent !== '请稍候…');
  assert.equal(stops, 2); assert.equal(item.runtime.status, 'stopped');
  let failedStarts = 0;
  const startPattern = `**/api/instances/${item.meta.id}/start`;
  await page.route(startPattern, async route => { failedStarts++; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成启动失败，请重试' }) }); });
  await open(); await page.getByText('合成启动失败，请重试', { exact: true }).waitFor();
  await page.locator('#desktop-back').click(); assert.equal(await card.locator('[data-action=open]').isEnabled(), true);
  assert.equal(item.runtime.status, 'stopped'); assert.equal(failedStarts, 1); assert.equal(starts, 1);
  await page.screenshot({ path: fileURLToPath(new URL('desktop-start-failure.png', out)) });
  await page.unroute(startPattern); proof.checks.push('desktop-start-failure-restores-action-without-retry');
  await open(); await page.locator('#ai-open').waitFor(); await page.locator('#desktop-back').click();
  assert.equal(starts, 2); assert.equal(item.runtime.status, 'running');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.locator(`[data-mobile-instance="${item.meta.id}"]`);
  await delayed('stop', () => mobile.locator('[data-mobile-stop]').click(), async () => {
    assert.equal(await mobile.locator('[data-mobile-stop]').isEnabled(), false);
    assert.equal(await mobile.locator('.status').innerText(), '请稍候…');
  }, 'mobile-pending-stop');
  assert.equal(stops, 3); assert.equal(item.runtime.status, 'stopped');
  await delayed('start', () => mobile.locator('[data-mobile-login]').click(), async () => {
    await page.locator('#mobile-login-back').click();
    assert.equal(await mobile.locator('[data-mobile-login]').isEnabled(), false);
    assert.equal(await mobile.locator('.status').innerText(), '请稍候…');
  }, 'mobile-pending-start');
  assert.equal(starts, 3); assert.equal(item.runtime.status, 'running');
  assert.equal(fixture.provider.calls.length, beforeModel); assert.equal(fixture.bridge.sent.length, 0);
  assert.deepEqual(proof.errors, []); proof.realModelCalls = 0; proof.realMessages = 0; proof.passed = true;
} catch (error) { proof.failure = error.stack; process.exitCode = 1; }
finally {
  release?.();
  await fs.writeFile(new URL('report.json', out), JSON.stringify(proof, null, 2));
  await browser?.close(); await fixture.close(); console.log(JSON.stringify(proof));
}
