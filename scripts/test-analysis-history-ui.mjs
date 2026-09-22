import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, key, modelConfig } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp();
const bridge = new ChatFixture();
const provider = new AIModelFixture();
const contact = bridge.contacts[0];
contact.label = '分析报告测试联系人';
const output = path.join(root, process.argv[2] || 'reports/analysis-report-history-ui/browser');
await mkdir(output, { recursive: true });
const report = { scope: 'Disposable local fixtures; no live account, NAS or WeChat messages.', checks: [], errors: [] };
let peer, app, browser, ai, restoreAiSave;

bridge.readRange = async args => ({
  account: args.account,
  contact: args.contact,
  messages: [
    { id: key('analysis-ui-system'), direction: 'system', text: 'fixture system marker', timestamp: 1788307200 },
    { id: key('analysis-ui-self'), direction: 'self', text: '周六下午见，记得带票。', timestamp: 1788307200 },
    { id: key('analysis-ui-other'), direction: 'other', text: '好，下午三点见。', timestamp: 1788393600 },
  ],
});
provider.complete = async (_config, system, input) => {
  provider.calls.push({ system, input });
  return { report: `数据开场\n\n这段时间记录了 ${input.metrics.total} 条消息。\n\n值得记住\n\n周六下午三点见，记得带票。` };
};

try {
  peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
  app = await createApplication({
    appRoot: root,
    dataRoot,
    dev: true,
    extract: extractor,
    fetcher,
    aiProvider: provider,
    trustedHashes: [packageSha256],
    runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const space = await app.users.get('development');
  await space.setConsent(true);
  app.library.download();
  await app.library.working;
  const meta = await space.add('分析报告 UI 测试微信');
  await space.start(meta.id);
  ai = space.get(meta.id).ai;
  clearInterval(ai.timer);
  await ai.verifyProvider(modelConfig);
  await ai.scan();
  await ai.settings({ enabled: false });

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`;
  const settled = () => page.waitForFunction(() => document.querySelector('#ai-panel')?.getAttribute('aria-busy') !== 'true');
  const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  const openAnalysis = async () => {
    await page.goto(base);
    await page.locator('[data-action=open]').first().click();
    await page.locator('#ai-open').click();
    await settled();
    await page.locator('[data-ai-nav=analysis]').click();
    await settled();
  };
  const generate = async request => {
    await page.locator('[name=request]').fill(request);
    await page.locator('#ai-analysis-form [name=contacts]').first().check();
    const before = provider.calls.length;
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await page.locator('[data-analysis-report]').first().waitFor();
    assert.ok(provider.calls.length > before, '生成分析报告必须调用模型');
    return before;
  };
  const historyCount = () => page.locator('.ai-analysis-history-list [data-ai-history-item]').count();

  await openAnalysis();
  const beforeFirst = await generate('总结具体约定');
  assert.equal(await page.locator('.ai-report-sections h4').first().textContent(), '数据开场');
  assert.equal(await page.locator('.ai-report-sections h4').nth(1).textContent(), '值得记住');
  assert.equal(await page.locator('.ai-report-excerpts blockquote').count(), 2, '系统消息不得进入对话摘录');
  await screenshot('01-generated');
  report.checks.push('Generated report renders model short-title sections and excludes system excerpts');

  const providerAfterFirst = provider.calls.length;
  await page.reload();
  await page.locator('[data-action=open]').first().click();
  await page.locator('#ai-open').click();
  await settled();
  await page.locator('[data-ai-nav=analysis]').click();
  await settled();
  assert.equal(provider.calls.length, providerAfterFirst, 'refresh/history view must not call the provider');
  assert.equal(await historyCount(), 1);
  await page.locator('.ai-analysis-history-list [data-ai-history-open]').first().click();
  await page.locator('.ai-analysis-history-detail').waitFor();
  assert.equal(await page.locator('.ai-analysis-history-detail h3').textContent(), '分析报告');
  assert.match(await page.locator('.ai-analysis-history-detail .ai-page-heading p').textContent(), /联系人：分析报告测试联系人/);
  const copied = await page.locator('.ai-analysis-history-detail [data-ai-history-copy]').click().then(() => page.evaluate(() => navigator.clipboard.readText()));
  assert.match(copied, /数据开场/);
  report.checks.push('Refresh reads persisted history/detail without another provider call and copy returns complete report');
  await screenshot('02-history-detail');

  const detailDelete = page.locator('.ai-analysis-history-detail [data-ai-history-delete]');
  await detailDelete.click();
  await page.locator('dialog[open]').waitFor();
  await page.locator('dialog[open] [data-cancel]').click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.ai-analysis-history-detail').count(), 1, 'cancel keeps current report');
  await detailDelete.click();
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.ai-analysis-history-detail').count(), 1, 'Escape keeps current report');
  report.checks.push('Cancel and Escape close delete confirmation without deleting');

  await page.locator('[data-ai-history-back]').click();
  await settled();
  await generate('第二份独立测试报告');
  assert.equal(await historyCount(), 2, 'repeated generation creates a second snapshot');
  const firstHistoryId = await page.locator('.ai-analysis-history-list [data-ai-history-delete]').first().getAttribute('data-ai-history-delete');
  const originalSave = ai.save.bind(ai);
  restoreAiSave = originalSave;
  ai.save = async () => { throw new Error('fixture delete failure'); };
  await page.locator(`.ai-analysis-history-list [data-ai-history-delete="${firstHistoryId}"]`).click();
  await page.locator('dialog[open] [data-confirm]').click();
  await page.locator('#ai-feedback').filter({ hasText: /操作未完成|fixture delete failure/ }).waitFor();
  assert.equal(await historyCount(), 2, 'failed deletion keeps the history item');
  ai.save = originalSave;
  restoreAiSave = null;
  report.checks.push('Delete failure preserves history and reports the server error');

  await page.locator(`.ai-analysis-history-list [data-ai-history-delete="${firstHistoryId}"]`).click();
  await page.locator('dialog[open] [data-confirm]').click();
  await page.locator('#ai-feedback').filter({ hasText: '分析报告已删除' }).waitFor();
  assert.equal(await historyCount(), 1, 'confirmed deletion removes only the selected test report');
  report.checks.push('Confirmed deletion removes one test snapshot after second confirmation');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px page must not overflow horizontally');
  await screenshot('03-mobile-390');
  report.checks.push('390px analysis/history view has no horizontal overflow');
  assert.equal(bridge.sent.length, 0, 'browser fixture must not send WeChat messages');
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  if (restoreAiSave && ai) ai.save = restoreAiSave;
  await app?.close();
  await peer?.close();
  await cleanup(dataRoot);
}
