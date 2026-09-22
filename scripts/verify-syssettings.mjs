import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge }) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
const report = { scope: '系统设置入口重构验证（模型设置 → 系统设置，入口置底，模型设置成为子项）', checks: [] };
let browser, page;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?dev=${app.devKey}`);
  await page.locator('input[name=consent]').check(); await page.getByRole('button', { name: '开始使用' }).click();
  await page.locator('#download').click(); await page.locator('#add-instance').waitFor(); await page.locator('#add-instance').click();
  await page.getByRole('button', { name: '确定', exact: true }).click(); await page.locator('[data-action=open]').first().click();
  const space = await app.users.get('development'), instance = [...space.instances.values()][0];
  await page.waitForFunction(() => document.querySelector('#desktop-status').hidden);
  instance.runtime.loginStatus = 'logged-in';
  await page.locator('#ai-open').waitFor(); await page.locator('#ai-open').click();
  await page.locator('#ai-panel').waitFor({ state: 'visible' });
  await page.waitForTimeout(800);

  // 1. 头部不再有“高级设置 / 模型设置”按钮
  const headerButtons = await page.locator('.ai-heading-actions button').allTextContents();
  report.checks.push(`头部 actions 按钮：${JSON.stringify(headerButtons)}（应只剩关闭按钮）`);

  // 2. 左侧导航含“系统设置”且为最后一项，不含“模型设置”
  const navItems = await page.locator('.ai-main-tabs button span').allTextContents();
  const navLast = navItems[navItems.length - 1];
  report.checks.push(`导航项：${JSON.stringify(navItems)}；最后一项：${navLast}`);
  if (!navItems.includes('系统设置')) throw new Error('导航缺少系统设置');
  if (navItems.includes('模型设置')) throw new Error('导航不应再直接显示模型设置');
  if (navLast !== '系统设置') throw new Error('系统设置应位于导航最下方');

  // 3. 点击系统设置 → 标题为“系统设置”，页面含“模型设置”子项入口
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.waitForTimeout(400);
  const title = await page.locator('#ai-title').textContent();
  report.checks.push(`系统设置页标题：${title}`);
  const entryText = await page.locator('.ai-settings-entry[data-ai-nav=provider]').innerText();
  report.checks.push(`模型设置入口文本：${entryText.replace(/\s+/g, ' ')}`);
  const defaultEntryCount = await page.locator('.ai-settings-entry[data-ai-nav=default-style]').count();
  const defaultEntryText = defaultEntryCount ? await page.locator('.ai-settings-entry[data-ai-nav=default-style]').innerText() : '';
  report.checks.push(`学习默认风格入口存在：${defaultEntryCount === 1}；入口文本：${defaultEntryText.replace(/\s+/g, ' ')}`);
  if (title !== '系统设置') throw new Error('系统设置页标题错误');
  if (!entryText.includes('模型设置')) throw new Error('系统设置页缺少模型设置子项');
  if (defaultEntryCount !== 1 || !defaultEntryText.includes('学习默认风格')) throw new Error('系统设置页缺少学习默认风格子项');
  await page.screenshot({ path: path.join(root, 'reports/screenshots/sys-settings-page.png') });

  // 3.5 点击“学习默认风格”子项 → 页面含学习方向、联系人选择与粘贴学习
  await page.locator('.ai-settings-entry[data-ai-nav=default-style]').click();
  await page.waitForTimeout(400);
  const dsTitle = await page.locator('#ai-title').textContent();
  const perspectiveCount = await page.locator('input[name=default-perspective]').count();
  const pasteCount = await page.locator('#ai-paste-form').count();
  const pickerCount = await page.locator('.ai-learning-contacts').count();
  const runCount = await page.locator('[data-ai-action=learn-default]').count();
  report.checks.push(`学习默认风格页标题：${dsTitle}；学习方向：${perspectiveCount}；粘贴学习表单：${pasteCount}；联系人选择：${pickerCount}；学习按钮：${runCount}`);
  if (dsTitle !== '学习默认风格') throw new Error('学习默认风格页标题错误');
  if (perspectiveCount !== 2) throw new Error('学习默认风格页缺少学习方向选项');
  if (pasteCount !== 1) throw new Error('学习默认风格页缺少粘贴学习模块');
  if (pickerCount !== 1 || runCount !== 1) throw new Error('学习默认风格页缺少联系人选择或学习按钮');
  await page.screenshot({ path: path.join(root, 'reports/screenshots/default-style-page.png') });
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.waitForTimeout(400);

  // 4. 点击“模型设置”子项 → 进入模型设置页（标题“模型设置”）
  await page.locator('.ai-settings-entry[data-ai-nav=provider]').click();
  await page.waitForTimeout(400);
  const providerTitle = await page.locator('#ai-title').textContent();
  report.checks.push(`模型设置页标题：${providerTitle}`);
  if (providerTitle !== '模型设置') throw new Error('模型设置子页标题错误');
  await page.screenshot({ path: path.join(root, 'reports/screenshots/model-settings-page.png') });

  // 5. 返回系统设置 → 原高级设置内容仍在（身份开关 + 接续表单）
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.waitForTimeout(400);
  const hasSwitch = await page.locator('[data-ai-setting=acknowledgeAI]').count();
  const hasTakeover = await page.locator('#ai-takeover-form').count();
  report.checks.push(`身份开关存在：${hasSwitch}；接续表单存在：${hasTakeover}`);
  if (!hasSwitch || !hasTakeover) throw new Error('系统设置页缺少原高级设置内容');

  if (errors.length) throw new Error('页面错误: ' + JSON.stringify(errors));
  report.status = 'passed';
} catch (e) {
  report.status = 'failed'; report.error = e.message;
} finally {
  console.log(JSON.stringify(report, null, 2));
  try { await browser?.close(); } catch {}
  await cleanup(dataRoot);
  process.exit(report.status === 'passed' ? 0 : 1);
}
