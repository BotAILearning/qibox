import { createRequire } from 'node:module';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture } from '../test/ai-fixtures.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const minimaxProvider = new AIProvider({ fetcher: async (url, options) => {
  return options.method === 'POST' ? Response.json({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }) : new Response('unsupported-model-list', { status: 404 });
} });
provider.test = (...args) => minimaxProvider.test(...args); provider.models = (...args) => minimaxProvider.models(...args);
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge }) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
const report = { scope: '模型名称字段改造验证（去掉展示名 label，展示统一用调用模型名 model）', checks: [] };
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
  // 进入系统设置 → 模型设置
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.locator('.ai-settings-entry[data-ai-nav=provider]').click();
  await page.waitForTimeout(400);

  // 1. 添加模型表单不再有 label 字段
  await page.getByRole('button', { name: '添加模型', exact: true }).first().click();
  await page.locator('#ai-model-form').waitFor();
  const labelCount = await page.locator('input[name=label]').count();
  const modelCount = await page.locator('input[name=model]').count();
  report.checks.push(`表单字段：label 数量=${labelCount}（应 0），model 数量=${modelCount}（应 1）`);
  if (labelCount !== 0) throw new Error('label 字段应已移除');
  if (modelCount !== 1) throw new Error('调用模型名（model）字段应保留');

  // 2. 使用 MiniMax 预设，保存模型
  await page.locator('#ai-model-preset').selectOption('minimax');
  await page.locator('[name=apiKey]').fill('temporary-minimax-key');
  await page.locator('#ai-model-form [name=consent]').check();
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.locator('.ai-model-item').waitFor();
  await page.waitForTimeout(600);

  // 3. 模型列表标题直接显示调用模型名 MiniMax-M3
  const itemText = await page.locator('.ai-model-item').first().innerText();
  report.checks.push(`模型列表首项：${itemText.replace(/\s+/g, ' ')}`);
  if (!itemText.includes('MiniMax-M3')) throw new Error('列表应直接显示调用模型名 MiniMax-M3');

  // 4. 功能分配下拉显示调用模型名
  const assignmentText = await page.locator('[data-ai-assignment=chat] option').allTextContents();
  report.checks.push(`功能分配下拉选项：${JSON.stringify(assignmentText)}`);
  if (!assignmentText.includes('MiniMax-M3')) throw new Error('功能分配下拉应显示调用模型名');

  // 5. 功能分配点“保存” → 服务端生效，label 兜底为调用模型名
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false' && document.querySelector('#ai-feedback').textContent.includes('保存'));
  const publicModels = instance.ai.publicState().models;
  report.checks.push(`服务端保存模型 label：${JSON.stringify(publicModels.map(m => m.label))}（应为 MiniMax-M3）`);
  if (publicModels[0]?.label !== 'MiniMax-M3') throw new Error('服务端 label 应兜底为调用模型名');

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
