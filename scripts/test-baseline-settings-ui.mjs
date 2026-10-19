import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
import { key } from '../test/ai-fixtures.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const f = await proactiveFixture(), out = path.resolve(root, process.argv[2] || 'local/stable-baseline-20261019/settings-recovery');
await mkdir(out, { recursive: true });
const report = { scope: 'Actual product browser and controller with isolated synthetic data; no NAS, actual model or WeChat delivery', checks: [], passed: false };
let browser, page;
try {
  const beforeCalls = f.provider.calls.length;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(6000);
  await page.goto(f.url); await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  const settings = () => page.locator('[data-ai-nav=settings]').first().click();
  await settings(); await page.locator('[data-ai-optional=global-rhythm] summary').click();
  const original = f.ai.data.settings.replyDelay;
  await page.locator('[name=replyDelay]').fill('27');
  let writes = 0;
  const route = async r => {
    if (r.request().method() === 'POST' && r.request().postDataJSON()?.action === 'settings') {
      writes++; await r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '隔离保存失败，请保留草稿' }) });
    } else await r.continue();
  };
  await page.route('**/api/instances/*/ai', route);
  await page.locator('#ai-takeover-form button[type=submit]').click();
  await page.getByText('隔离保存失败，请保留草稿', { exact: true }).waitFor();
  assert.equal(f.ai.data.settings.replyDelay, original);
  await page.screenshot({ path: path.join(out, '01-failed-save.png') });
  await page.locator('[data-ai-nav=provider]').click(); await settings();
  assert.equal(await page.locator('[name=replyDelay]').inputValue(), '27', 'Failed settings draft survives return from another existing page');
  assert.equal(writes, 1, 'Returning must not retry the mutation');
  report.checks.push('Failed save retains exact draft across navigation; saved configuration unchanged; no automatic retry');
  await page.unroute('**/api/instances/*/ai', route);
  await page.locator('#ai-takeover-form button[type=submit]').click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  assert.equal(f.ai.data.settings.replyDelay, 27);
  await page.locator('[data-ai-nav=provider]').click(); await settings();
  assert.equal(await page.locator('[name=replyDelay]').inputValue(), '27');
  report.checks.push('Explicit retry saves once; reopening displays effective value');
  await page.locator('[data-ai-nav=global-reply]').click();
  await page.locator('[name=replyGoal]').fill('保留失败的全局策略🙂');
  await page.route('**/api/instances/*/ai', async r => r.request().method() === 'POST' && r.request().postDataJSON()?.action === 'configuration'
    ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '全局策略保存失败' }) }) : r.continue());
  await page.locator('#ai-global-reply-form button[type=submit]').click();
  await page.getByText('全局策略保存失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回系统设置', exact: true }).click(); await page.locator('[data-ai-nav=global-reply]').click();
  assert.equal(await page.locator('[name=replyGoal]').inputValue(), '保留失败的全局策略🙂');
  report.checks.push('Global strategy failure retains Chinese/emoji draft across return');
  await page.screenshot({ path: path.join(out, '02-recovered-draft.png') });
  f.bridge.account = key('baseline-new-account'); await f.ai.scan();
  await page.waitForFunction(() => document.querySelector('#ai-global-reply-form [name=replyGoal]')?.value === '');
  assert.equal(await page.locator('[name=replyGoal]').inputValue(), '', 'Old account strategy draft cannot enter the next account');
  report.checks.push('Account change clears the retained failed draft before repainting private forms');
  assert.equal(f.provider.calls.length, beforeCalls); assert.equal(f.bridge.sent.length, 0);
  report.passed = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally { await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); await browser?.close(); await f.close(); console.log(JSON.stringify(report)); }
