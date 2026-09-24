import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
const output = path.join(root, process.argv[2] || 'reports/ai-wait-switch-20260924/ui');
await mkdir(output, { recursive: true });
let browser;
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
  const meta = await space.add('等待设置界面验收'); await space.start(meta.id); const ai = space.get(meta.id).ai; clearInterval(ai.timer);
  await ai.scan();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click({ timeout: 5000 });
  await page.locator('#ai-open').click({ timeout: 5000 });
  await page.getByRole('button', { name: '系统设置', exact: true }).click({ timeout: 5000 });
  const toggle = page.locator('#ai-takeover-form [name=enabled]'), minutes = page.locator('#ai-takeover-form [name=minutes]');
  assert.equal(await toggle.getAttribute('role'), 'switch'); assert.equal(await toggle.isChecked(), true);
  assert.equal(await minutes.inputValue(), '5'); assert.equal(await minutes.isVisible(), true);
  assert.match(await page.locator('#ai-takeover-form .ai-help').textContent(), /关闭.*对应联系人.*群聊.*其他联系人/);
  await toggle.uncheck(); assert.equal(await minutes.isVisible(), false); assert.equal(await minutes.isDisabled(), true);
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  assert.equal(ai.data.settings.takeover.enabled, false); assert.equal(ai.data.settings.takeover.minutes, 5);
  await toggle.check(); assert.equal(await minutes.isVisible(), true); await minutes.fill('8');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  assert.deepEqual(ai.data.settings.takeover, { enabled: true, minutes: 8 });
  if (errors.length) throw new Error(JSON.stringify(errors));
  const report = { status: 'passed', viewport: '1440x900', default: { enabled: true, minutes: 5 }, offHidesAndDisablesMinutes: true, onAcceptsCustomMinutes: 8, errors };
  const { writeFile } = await import('node:fs/promises'); await writeFile(path.join(output, 'ai-assisted-wait-ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
}
