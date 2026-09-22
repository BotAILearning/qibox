// Local browser check for the batch-learning page redesign (2026-09-20):
// back label "返回自动回复", hero/paste/contacts/range cards, handlers intact.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, key, modelConfig } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
for (let n = 1; n <= 12; n++) {
  const c = { id: key(`learn-${n}`), label: `联系人 ${String(n).padStart(2, '0')}`, kind: 'person', lastChatAt: 1000 - n, contactOrder: n };
  bridge.contacts.push(c); bridge.messages.set(c.id, [{ id: key(`initial-${n}`), direction: 'self', text: '测试上下文' }]);
}
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('测试微信'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.configure(modelConfig); await ai.scan(); await ai.settings({ enabled: false });
const output = path.join(root, 'reports/learning-redesign-2026-09-20/browser'); await mkdir(output, { recursive: true });
const report = { scope: 'Local browser with disposable fixtures; batch-learning page redesign.', checks: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', e => report.errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await page.locator('#ai-object-list button').first().waitFor();
  await page.locator('[data-ai-nav=learning]').click();
  await page.locator('.ai-learning-page').waitFor();
  const backText = await page.locator('.ai-learning-back').textContent();
  assert.ok(backText.includes('返回自动回复'), `back label: ${backText}`);
  assert.ok(!backText.includes('AI 辅助'), `back label should not say AI 辅助: ${backText}`);
  report.checks.push('返回按钮文案为「返回自动回复」');
  for (const sel of ['.ai-learning-hero', '.ai-learning-contacts', '.ai-learning-range', '[data-ai-action=learn-selected]', '[data-ai-date-range=learning]']) await page.locator(sel).waitFor();
  assert.equal(await page.locator('.ai-learning-hero .ai-paste').count(), 0, '粘贴学习已从学习页移出');
  report.checks.push('学习页卡片（hero/contacts/range）存在，粘贴学习模块已移出');
  assert.ok((await page.locator('.ai-contact-list .ai-check').count()) >= 12, 'contact cards present');
  assert.equal(await page.locator('[data-ai-action=learn-selected]').isDisabled(), true);
  await page.locator('.ai-contact-list .ai-check').first().click();
  await page.waitForFunction(() => document.querySelector('#ai-contact-count').textContent.includes('已选择 1 位'));
  assert.equal(await page.locator('[data-ai-action=learn-selected]').isEnabled(), true);
  await page.locator('.ai-learning-contacts [data-ai-action=select-contacts]').click();
  await page.waitForFunction(() => document.querySelector('#ai-contact-count').textContent.includes('已选择 10 位'));
  report.checks.push('学习页勾选联系人联动计数与「开始学习」按钮启用状态');
  // 系统设置 → 学习默认风格：粘贴学习移入，且不再需要风格名称
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.locator('.ai-settings-entry[data-ai-nav=default-style]').click();
  await page.locator('.ai-default-style-page').waitFor();
  assert.equal(await page.locator('.ai-default-style-page input[name=default-perspective]').count(), 0, '学习方向不再平铺在页面上');
  assert.equal(await page.locator('.ai-default-style-page .ai-learning-range').count(), 0, '时间范围卡片已移到选择联系人右上角');
  await page.locator('.ai-default-style-page .ai-paste > summary').click();
  await page.locator('#ai-paste-form').waitFor();
  assert.equal(await page.locator('#ai-paste-form [name=contact]').count(), 0, '粘贴学习不再选择对应联系人');
  assert.equal(await page.locator('#ai-paste-form [name=text]').count(), 1);
  assert.equal(await page.locator('[data-ai-action=learn-default]').count(), 1);
  assert.equal(await page.locator('.ai-learning-contacts .ai-card-heading .ai-badge').count(), 0, '最多 5 位徽标已被学习按钮替换');
  assert.ok(await page.locator('.ai-learning-contacts .ai-learning-heading-tools [data-ai-date-range=learning]').isVisible(), '学习范围筛选在学习按钮下方');
  assert.equal((await page.locator('.ai-learning-contacts .ai-learning-heading-tools [data-ai-date-range=learning]').textContent()).trim(), '时间筛选', '未筛选时按钮显示时间筛选');
  report.checks.push('学习默认风格页：学习按钮在选择联系人右上角、其下为时间范围筛选、粘贴表单（仅 text，无 contact）、学习方向改为弹窗');
  // 默认风格学习最多 5 位联系人
  await page.locator('.ai-learning-contacts [data-ai-action=clear-contacts]').click();
  const dsChecks = page.locator('.ai-contact-list .ai-check');
  for (let i = 0; i < 5; i++) await dsChecks.nth(i).click();
  await page.waitForFunction(() => document.querySelector('#ai-contact-count').textContent.includes('已选择 5 位'));
  assert.equal(await page.locator('[data-ai-action=learn-default]').isEnabled(), true);
  await dsChecks.nth(5).click();
  assert.equal(await dsChecks.nth(5).locator('input').isChecked(), false, '第六位被拒绝');
  assert.equal(await page.locator('#ai-contact-count').textContent(), '已选择 5 位联系人，每次最多 5 位');
  report.checks.push('默认风格学习限制 5 位联系人');
  // 点击【学习默认风格】弹出学习方向选择；取消则不开始学习
  await page.locator('[data-ai-action=learn-default]').click();
  await page.locator('.ai-perspective-dialog').waitFor();
  assert.equal(await page.locator('.ai-perspective-dialog input[name=default-perspective]').count(), 2, '弹窗内两个学习方向');
  await page.locator('.ai-perspective-dialog input[value=other]').check();
  await page.locator('.ai-perspective-dialog [data-cancel]').click();
  await page.locator('.ai-perspective-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.ai-perspective-dialog').count(), 0, '取消后弹窗关闭且未开始学习');
  report.checks.push('点击学习默认风格弹出学习方向选择，可取消');
  await page.screenshot({ path: path.join(output, 'learning-redesign.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile horizontal overflow');
  await page.screenshot({ path: path.join(output, 'learning-mobile.png'), fullPage: true });
  report.checks.push('390px 移动端无横向溢出');
  assert.deepEqual(report.errors, []); report.passed = true;
  console.log('LEARNING_REDESIGN_OK');
} catch (error) { report.failure = error.stack; throw error; }
finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
}
