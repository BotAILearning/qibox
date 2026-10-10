import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const fixture = await proactiveFixture();
const output = path.resolve(root, process.env.QIBOX_TEST_OUTPUT || 'reports/ai-keyboard-isolation');
const report = { startedAt: new Date().toISOString(), isolatedRuntime: true, realWechatSends: 0, checks: [] };
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['local-network-access'], { origin: new URL(fixture.url).origin });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(fixture.url);
  await page.locator('[data-action=open]').click();
  await page.waitForFunction(() => document.querySelector('#remote-canvas canvas')?.width === 1280 && document.querySelector('#desktop-status').hidden);
  await page.locator('#ai-open').click();
  await page.locator('#ai-panel:not([hidden])').waitFor();
  const initialKeys = fixture.peer.keys.length;
  for (const name of ['自动回复', '主动聊天', '执行记录', '分析报告', '系统设置']) {
    await page.locator('.ai-main-tabs').getByRole('button', { name, exact: true }).click();
    assert.equal(await page.locator('#desktop-screen').evaluate(e => e.inert), true);
    assert.equal(await page.locator('main.content').evaluate(e => e.inert), true);
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({ id: document.activeElement.id, panel: !!document.activeElement.closest('#ai-panel'), body: document.activeElement === document.body }));
      assert.ok(focused.panel || focused.body, `${name}: focus escaped to ${focused.id}`);
    }
    assert.equal(fixture.peer.keys.length, initialKeys, `${name}: Tab reached the remote desktop`);
    report.checks.push(`${name}: 50 Tab keys stay on the visible page; zero remote keyboard events`);
    await page.screenshot({ path: path.join(output, `${report.checks.length}-page.png`) });
  }
  await page.locator('#ai-close').click();
  assert.equal(await page.locator('#desktop-screen').evaluate(e => e.inert), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ai-open');
  const canvas = await page.locator('#remote-canvas canvas').boundingBox();
  await page.mouse.click(canvas.x + 300, canvas.y + 300);
  await page.keyboard.type('QA55');
  await page.waitForFunction(() => document.querySelector('#native-input').value === '');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(fixture.peer.keys.slice(initialKeys).filter(k => k.down).map(k => k.symbol), [81, 65, 53, 53]);
  report.checks.push('Returning to WeChat restores the original input path and return focus');
  await page.locator('#desktop-back').click();
  assert.equal(await page.locator('main.content').evaluate(e => e.inert), false);
  assert.equal(await page.locator('.topbar').evaluate(e => e.inert), false);
  report.checks.push('Returning home restores home controls');
  assert.deepEqual(errors, []);
  report.passed = true;
} finally {
  try { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
  finally { await browser?.close(); await fixture.close(); }
}
console.log(JSON.stringify(report));
