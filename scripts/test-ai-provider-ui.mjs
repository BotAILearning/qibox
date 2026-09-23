import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, key, strategy } from '../test/ai-fixtures.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const proactiveContacts = bridge.contacts.slice();
for (let index = 4; index <= 12; index++) {
  const contact = { id: key(`ui-contact-${index}`), label: `测试对象${index}`, kind: 'person' };
  bridge.contacts.push(contact);
  bridge.messages.set(contact.id, [{ id: key(`initial-${contact.id}`), direction: 'self', text: 'CHAT_PRIVATE_MARKER' }]);
}
let scans = 0, reads = 0;
const fixtureScan = bridge.scan.bind(bridge);
bridge.scan = async (...args) => { scans++; return fixtureScan(...args); };
const fixtureRead = bridge.read.bind(bridge);
bridge.read = async (...args) => { reads++; return fixtureRead(...args); };
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge }) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
const report = { startedAt: new Date().toISOString(), scope: 'Disposable local application, RFB fixture and AI/native fixtures. No real account, model call, WeChat modification or contact message.', checks: [] };
let browser, page;
const errors = [];
const savedKeyMask = '********';
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', e => errors.push(e.message));
  const aiRequests = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/instances\/[^/]+\/ai$/.test(new URL(request.url()).pathname)) aiRequests.push(request.postDataJSON());
  });
  await page.goto(`${base}/?dev=${app.devKey}`);
  await page.locator('input[name=consent]').check(); await page.getByRole('button', { name: '开始使用' }).click();
  await page.locator('#download').click(); await page.locator('#add-instance').waitFor(); await page.locator('#add-instance').click();
  await page.getByRole('button', { name: '确定', exact: true }).click(); await page.locator('[data-action=open]').first().click();
  const space = await app.users.get('development'), instance = [...space.instances.values()][0], ai = instance.ai;
  await page.waitForFunction(() => document.querySelector('#desktop-status').hidden);
  assert.equal(await page.locator('#ai-open').isVisible(), false);
  assert.equal(await page.locator('#ai-panel').isVisible(), false);
  instance.runtime.loginStatus = 'logged-in';
  await page.locator('#ai-open').waitFor(); await page.locator('#ai-open').click();
  instance.runtime.loginStatus = 'relogin-required';
  await page.locator('#ai-open').waitFor({ state: 'hidden' });
  await page.locator('#ai-panel').waitFor({ state: 'hidden' });
  instance.runtime.loginStatus = 'unknown';
  await page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/state'));
  assert.equal(await page.locator('#ai-open').isVisible(), false);
  instance.runtime.loginStatus = 'logged-in';
  await page.locator('#ai-open').waitFor(); await page.locator('#ai-open').click();
  report.checks.push('AI stays hidden before login and during unknown login state; confirmed login shows it; logout closes the open panel and hides the entry; relogin restores access');
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.locator('.ai-settings-entry[data-ai-nav=provider]').click();
  await page.getByText('还没有模型，点击“添加模型”创建第一个。', { exact: false }).waitFor();
  // 添加第一个模型：MiniMax 预设，测试连接后保存，默认应用于全部功能
  await page.locator('.ai-model-sidebar .ai-model-add').click();
  await page.locator('#ai-model-form').waitFor();
  await page.locator('#ai-model-preset').selectOption('minimax');
  assert.equal(await page.locator('[name=protocol]').inputValue(), 'anthropic');
  assert.equal(await page.locator('[name=baseUrl]').inputValue(), 'https://api.minimaxi.com/anthropic');
  assert.equal(await page.locator('[name=model]').inputValue(), 'MiniMax-M3');
  const minimaxRequests = [], minimaxProvider = new AIProvider({ fetcher: async (url, options) => {
    minimaxRequests.push({ url, options });
    return options.method === 'POST' ? Response.json({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }) : new Response('unsupported-model-list', { status: 404 });
  } });
  provider.test = (...args) => minimaxProvider.test(...args); provider.models = (...args) => minimaxProvider.models(...args);
  await page.locator('[name=apiKey]').fill('temporary-minimax-key');
  assert.equal(await page.locator('[name=apiKey]').getAttribute('type'), 'password');
  await page.getByRole('button', { name: '展示 API Key', exact: true }).click();
  assert.equal(await page.locator('[name=apiKey]').getAttribute('type'), 'text');
  assert.equal(await page.locator('[name=apiKey]').inputValue(), 'temporary-minimax-key');
  await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click();
  assert.equal(await page.locator('[name=apiKey]').getAttribute('type'), 'password');
  assert.equal(await page.locator('[name=apiKey]').inputValue(), 'temporary-minimax-key');
  await page.locator('#ai-model-form [name=consent]').check();
  await page.getByRole('button', { name: '拉取支持的模型', exact: true }).click();
  await page.locator('#ai-model-status').filter({ hasText: '无法拉取模型，请手动填写对话模型并测试连接' }).waitFor();
  assert.equal(await page.locator('[name=model]').inputValue(), 'MiniMax-M3');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.locator('#ai-provider-status').filter({ hasText: '连接测试通过' }).waitFor();
  assert.deepEqual(minimaxRequests.map(x => x.url), ['https://api.minimaxi.com/anthropic/v1/models?limit=100', 'https://api.minimaxi.com/anthropic/v1/messages']);
  assert.equal(JSON.parse(minimaxRequests[1].options.body).model, 'MiniMax-M3');
  assert.equal(minimaxRequests[1].options.headers['x-api-key'], 'temporary-minimax-key');
  assert.equal(minimaxRequests[1].options.headers.Authorization, undefined);
  assert.equal(await page.locator('[name=apiKey]').inputValue(), 'temporary-minimax-key');
  assert.equal(await page.locator('[name=apiKey]').getAttribute('type'), 'password');
  provider.test = AIModelFixture.prototype.test; provider.models = AIModelFixture.prototype.models;
  report.checks.push('MiniMax preset uses Anthropic and MiniMax-M3; unsupported model discovery keeps manual testing usable; connection uses /anthropic/v1/messages and x-api-key; typed keys have show/hide controls');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  const firstItem = page.locator('.ai-model-item').filter({ hasText: 'MiniMax-M3' });
  await firstItem.waitFor();
  assert.match(await firstItem.innerText(), /用于：聊天类、学习分析类/);
  const firstId = await page.locator('[data-ai-assignment=chat]').inputValue();
  for (const feature of ['chat', 'learningAnalysis']) assert.equal(await page.locator(`[data-ai-assignment=${feature}]`).inputValue(), firstId);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false' && document.querySelector('#ai-feedback').textContent.includes('保存'));
  assert.match(await firstItem.locator('.ai-model-item-title').innerText(), /已验证/);
  assert.equal(ai.publicState().models.length, 1);
  assert.equal(ai.publicState().models[0].tested, true);
  assert.equal(ai.publicState().provider.hasKey, true);
  assert.equal(Object.hasOwn(ai.publicState().provider, 'apiKey'), false);
  report.checks.push('The first added model defaults to every feature; a successful connection marks it verified; saving applies it; public state only exposes hasKey');
  // 编辑模型：展示/隐藏已存密钥，reveal 请求有且仅有一次
  await page.locator(`[data-ai-model-edit=${firstId}]`).click();
  await page.locator('#ai-model-form').waitFor();
  assert.equal(await page.locator('[name=apiKey]').inputValue(), savedKeyMask);
  await page.getByRole('button', { name: '展示 API Key', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[name=apiKey]')?.value === 'temporary-minimax-key');
  assert.equal(await page.locator('[name=apiKey]').getAttribute('type'), 'text');
  await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click();
  assert.equal(await page.locator('[name=apiKey]').inputValue(), savedKeyMask);
  assert.equal(await page.locator('[name=apiKey]').getAttribute('type'), 'password');
  await page.locator('[data-ai-action=model-cancel]').click();
  // 添加第二个模型：自定义服务，只分配给“聊天分析”，编辑不清空已存密钥以外的字段
  await page.locator('.ai-model-sidebar .ai-model-add').click();
  await page.locator('#ai-model-preset').selectOption('deepseek');
  assert.equal(await page.locator('[name=baseUrl]').inputValue(), 'https://api.deepseek.com/v1');
  await page.locator('[name=apiKey]').fill('temporary-key');
  await page.locator('#ai-model-preset').selectOption('custom');
  assert.equal(await page.locator('[name=apiKey]').inputValue(), 'temporary-key');
  await page.locator('[name=baseUrl]').fill('https://models.example.test/v1'); await page.locator('[name=model]').fill('fixture-model');
  await page.locator('[name=apiKey]').fill('test-key-never-rendered'); await page.locator('#ai-model-form [name=consent]').check();
  await page.getByRole('button', { name: '拉取支持的模型', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-model-choice').options.length === 3);
  assert.equal(await page.locator('[name=apiKey]').inputValue(), 'test-key-never-rendered');
  await page.locator('#ai-model-choice').selectOption('fixture-chat-pro');
  assert.equal(await page.locator('[name=model]').inputValue(), 'fixture-chat-pro');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.locator('#ai-provider-status').filter({ hasText: '连接测试通过' }).waitFor();
  assert.equal(await page.locator('[name=apiKey]').inputValue(), 'test-key-never-rendered');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  const secondItem = page.locator('.ai-model-item').filter({ hasText: 'fixture-chat-pro' });
  await secondItem.waitFor();
  assert.match(await secondItem.innerText(), /未分配功能/);
  const secondId = await secondItem.locator('[data-ai-model-edit]').getAttribute('data-ai-model-edit');
  assert.ok(secondId && secondId !== firstId, secondId);
  assert.equal(await page.locator('[data-ai-assignment=chat]').inputValue(), firstId);
  assert.equal(await page.locator('[data-ai-assignment=learningAnalysis]').inputValue(), firstId);
  // 下拉把学习分析类切到第二个模型 → 保存后生效
  await page.locator('[data-ai-assignment=learningAnalysis]').selectOption(secondId);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false' && document.querySelector('#ai-feedback').textContent.includes('保存'));
  assert.equal(ai.publicState().assignments.chat, firstId);
  assert.equal(ai.publicState().assignments.learningAnalysis, secondId);
  assert.equal(ai.publicState().models.find(m => m.id === secondId).usedBy.join(','), 'learningAnalysis');
  assert.match(await secondItem.innerText(), /用于：学习分析类/);
  // 应用于所有功能 → 全部下拉切换到第二个模型
  await page.locator(`[data-ai-model-apply=${secondId}]`).click();
  for (const feature of ['chat', 'learningAnalysis']) assert.equal(await page.locator(`[data-ai-assignment=${feature}]`).inputValue(), secondId);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false' && document.querySelector('#ai-feedback').textContent.includes('保存'));
  assert.equal(ai.publicState().assignments.learningAnalysis, secondId);
  assert.equal(ai.publicState().assignments.chat, secondId);
  assert.match(await firstItem.innerText(), /未分配功能/);
  report.checks.push('Second model is not auto-assigned; per-feature dropdown saves and applies; “应用于所有功能” reassigns every feature; unassigned models show 未分配功能');
  // 删除第二个模型 → 引用它的功能回退到剩余第一个
  await page.locator(`[data-ai-model-delete=${secondId}]`).click();
  await page.locator('.ai-model-item').filter({ hasText: 'fixture-chat-pro' }).waitFor({ state: 'detached' });
  for (const feature of ['chat', 'learningAnalysis']) assert.equal(await page.locator(`[data-ai-assignment=${feature}]`).inputValue(), firstId);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false' && document.querySelector('#ai-feedback').textContent.includes('保存'));
  assert.equal(ai.publicState().models.length, 1);
  assert.equal(ai.publicState().assignments.learningAnalysis, firstId);
  report.checks.push('Deleting a model falls back to the remaining first model for features that referenced it');
  // 重新打开面板：密钥仍掩码；保存请求不携带掩码值
  await page.getByRole('button', { name: '收起 AI 辅助', exact: true }).click();
  await page.locator('#ai-open').click();
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.locator('.ai-settings-entry[data-ai-nav=provider]').click();
  await page.locator(`[data-ai-model-edit=${firstId}]`).click();
  assert.equal(await page.locator('[name=apiKey]').inputValue(), savedKeyMask);
  assert.equal(aiRequests.filter(request => request.action === 'reveal-key').length, 1);
  for (const request of aiRequests) {
    if (request.action === 'configure' || request.action === 'models-save') assert.notEqual(request.value?.apiKey, savedKeyMask);
    if (request.action === 'models-save') for (const entry of request.value.models) assert.notEqual(entry.apiKey, savedKeyMask);
  }
  await mkdir(path.join(root, 'reports/screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'reports/screenshots/ai-provider.png') });
  report.checks.push('Saved keys stay masked after reopen; explicit reveal returns the original key exactly once; save/configure requests never carry the mask');
  assert.deepEqual(errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
finally {
  const output = path.join(root, process.argv[2] || 'reports/layout-2026-09-16/browser-provider'); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
}
