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
for (let index = 0; index < 10; index++) bridge.contacts.push({ id: key(`analysis-ui-batch-${index}`), label: `批量测试对象${index + 1}`, kind: 'person' });
const provider = new AIModelFixture();
const contact = bridge.contacts[0];
contact.label = '分析报告测试联系人';
const output = path.join(root, process.argv[2] || 'reports/analysis-report-history-ui/browser');
await mkdir(output, { recursive: true });
const report = { scope: 'Disposable local fixtures; no live account, NAS or WeChat messages.', checks: [], errors: [] };
let peer, app, browser, ai, restoreAiSave, queuedAnalyzeCalls = [];

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
  return {
    report: `数据开场\n\n这段时间记录了 ${input.metrics.total} 条消息。\n\n值得记住\n\n周六下午三点见，记得带票。`,
    excerptIds: input.messages.filter(item => item[1] === 's' || item[1] === 'o').slice(0, 2).map(item => item[0]),
  };
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
  const analyze = ai.analyze.bind(ai);
  ai.analyze = value => { queuedAnalyzeCalls.push(value.contacts?.length); return analyze(value); };
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
    await settled();
    await page.locator('[data-analysis-status=complete], [data-analysis-status=error]').first().waitFor();
    const status = await page.locator('[data-analysis-report]').first().getAttribute('data-analysis-status');
    assert.equal(status, 'complete', await page.locator('[data-analysis-report]').first().innerText());
    assert.ok(provider.calls.length > before, '生成分析报告必须调用模型');
    return before;
  };
  const historyCount = () => page.locator('.ai-analysis-history-list [data-ai-history-item]').count();

  await openAnalysis();
  const beforeFirst = await generate('总结具体约定');
  assert.equal(await page.locator('.ai-report-sections h4').first().textContent(), '数据开场');
  assert.equal(await page.locator('.ai-report-sections h4').nth(1).textContent(), '值得记住');
  assert.equal(await page.locator('.ai-report-excerpts blockquote').count(), 0, '分析报告不保留原始聊天摘录');
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

  for (let index = 1; index < 11; index++) await page.locator('#ai-analysis-form [name=contacts]').nth(index).check();
  let queuedModelCalls = 0;
  provider.complete = async (_config, system, input) => {
    provider.calls.push({ system, input });
    if (++queuedModelCalls === 1) throw new Error('fixture first-contact failure');
    return { report: `批量测试报告 ${input.contact}`, excerptIds: input.messages.slice(-1).map(item => item.id) };
  };
  const beforeQueue = queuedAnalyzeCalls.length, beforeModels = provider.calls.length;
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await settled();
  assert.equal(await page.locator('[data-analysis-status=error]').count(), 1, 'first failed contact remains visible');
  assert.equal(await page.locator('[data-analysis-status=complete]').count(), 10, 'later contacts continue and finish');
  assert.equal(queuedAnalyzeCalls.length - beforeQueue, 11);
  assert.ok(queuedAnalyzeCalls.slice(beforeQueue).every(count => count === 1), 'every analyze POST contains exactly one contact');
  assert.equal(provider.calls.length - beforeModels, 11, 'each selected contact makes exactly one model call');
  report.checks.push('Eleven-contact queue posts one contact per request and continues after an individual model failure');

  for (let index = 0; index < 11; index++) await page.locator('#ai-analysis-form [name=contacts]').nth(index).uncheck();
  await page.locator('#ai-analysis-form [name=contacts]').nth(0).check();
  await page.locator('#ai-analysis-form [name=contacts]').nth(1).check();
  provider.complete = async (_config, _system, _input, signal) => {
    provider.calls.push({ input: _input });
    await new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return { report: '不应在取消后出现', excerptIds: [] };
  };
  const beforeCancel = queuedAnalyzeCalls.length, modelCallsBeforeCancel = provider.calls.length;
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await page.locator('[data-analysis-status=analyzing]').first().waitFor();
  await page.locator('#ai-operation [data-ai-action=cancel]').waitFor();
  await page.locator('#ai-operation [data-ai-action=cancel]').click();
  await settled();
  assert.equal(queuedAnalyzeCalls.length - beforeCancel, 1, 'cancel stops before posting the next contact');
  assert.equal(provider.calls.length - modelCallsBeforeCancel, 1, 'in-flight contact was the only model request');
  assert.equal(await page.locator('[data-analysis-status=cancelled]').count(), 2);
  report.checks.push('Cancel aborts the in-flight contact and prevents later contacts from being posted');

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
