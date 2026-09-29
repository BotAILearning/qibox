import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, key, modelConfig } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
import { unzipSync } from 'fflate';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp();
const bridge = new ChatFixture();
bridge.readDates = async ({ account, contact }) => ({ account, contact, dates: ['2026-09-01', '2026-09-02', '2026-09-28'] });
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
  const initialMaster = await ai.mobileMasterState(meta.id);
  assert.deepEqual(Object.keys(initialMaster).sort(), ['available', 'enabled', 'scopeToken', 'settingsToken'].sort(), 'phone master endpoint returns only its narrow state');
  const originalAccount = bridge.account;
  bridge.account = key('account-switched-during-phone-toggle');
  await assert.rejects(ai.mobileMasterChange(meta.id, { enabled: true, scopeToken: initialMaster.scopeToken, settingsToken: initialMaster.settingsToken }), error => error.code === 'AI_SCOPE_CHANGED');
  bridge.account = originalAccount;
  await ai.settings({ reply: false });
  await assert.rejects(ai.mobileMasterChange(meta.id, { enabled: true, scopeToken: initialMaster.scopeToken, settingsToken: initialMaster.settingsToken }), error => error.code === 'AI_SETTINGS_CHANGED');
  await ai.settings({ reply: true });

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
  const chooseContacts = async indexes => {
    await page.locator('[data-ai-analysis-pick]').click();
    const picker = page.locator('.ai-contact-picker-dialog');
    await picker.locator('[data-picker-clear]').click();
    for (const index of indexes) await picker.locator('[data-picker-id]').nth(index).check();
    await picker.locator('[data-picker-confirm]').click();
  };
  const generate = async request => {
    await page.locator('[name=request]').fill(request);
    await chooseContacts([0]);
    const before = provider.calls.length;
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await settled();
    await page.locator('[data-analysis-status=complete], [data-analysis-status=error]').first().waitFor();
    const status = await page.locator('[data-analysis-report]').first().getAttribute('data-analysis-status');
    assert.equal(status, 'complete', await page.locator('[data-analysis-report]').first().innerText());
    assert.ok(provider.calls.length > before, '生成分析报告必须调用模型');
    assert.equal(await page.locator('#ai-analysis-form [name=contacts]').count(), 0, '完成报告后清空原联系人勾选');
    return before;
  };
  const historyCount = () => page.locator('.ai-analysis-history-list [data-ai-history-item]').count();

  await openAnalysis();
  const desktopLayout = await page.evaluate(() => {
    const form = document.querySelector('#ai-analysis-form');
    const selection = document.querySelector('.ai-analysis-selection')?.getBoundingClientRect();
    const request = document.querySelector('.ai-analysis-request')?.getBoundingClientRect();
    const requestFields = document.querySelector('.ai-analysis-request-fields')?.getBoundingClientRect();
    const time = document.querySelector('.ai-analysis-time-entry')?.getBoundingClientRect();
    return {
      formDisplay: getComputedStyle(form).display,
      selectionWidth: selection?.width || 0,
      selectionHeight: selection?.height || 0,
      requestWidth: request?.width || 0,
      requestStartsAfterSelection: (request?.x || 0) > (selection?.right || 0),
      timeStartsAfterRequest: (time?.x || 0) > (requestFields?.right || 0),
    };
  });
  assert.equal(desktopLayout.formDisplay, 'contents', '分析表单应展开到外层工作区网格');
  assert.ok(desktopLayout.selectionWidth >= 220, `联系人入口宽度过窄: ${desktopLayout.selectionWidth}`);
  assert.ok(desktopLayout.selectionHeight < 400, `联系人入口仍占据整屏: ${desktopLayout.selectionHeight}`);
  assert.ok(desktopLayout.requestWidth >= 500, `分析要求区宽度过窄: ${desktopLayout.requestWidth}`);
  assert.ok(desktopLayout.requestStartsAfterSelection, '分析要求区应位于联系人区右侧');
  assert.ok(desktopLayout.timeStartsAfterRequest, '时间范围应位于分析要求右侧');
  assert.equal(await page.locator('.ai-analysis-presets button').count(), 8, 'request composer shows original directions and custom question');
  await screenshot('00-analysis-request');
  await page.locator('[data-ai-analysis-preset=review]').click();
  assert.match(await page.locator('[name=request]').inputValue(), /重点事项/);
  await page.locator('[data-ai-analysis-other]').click();
  assert.equal(await page.locator('[name=request]').inputValue(), '', 'other question opens an empty editable request');
  await page.locator('[name=request]').fill('请总结明确约定');
  assert.equal(await page.locator('#ai-analysis-request-count').textContent(), '7/1000');
  await page.locator('[name=request]').fill('');
  await chooseContacts([0]);
  await page.locator('[data-ai-analysis-range=custom]').click();
  await page.locator('.ai-calendar-dialog-analysis').waitFor();
  await screenshot('00-analysis-custom-range');
  await page.locator('.ai-calendar-dialog-analysis [data-cancel]').click();
  await page.locator('.ai-calendar-dialog-analysis').waitFor({ state: 'detached' });
  await chooseContacts([]);
  await page.locator('[data-ai-analysis-range=all]').click();
  report.checks.push('Desktop analysis layout keeps contact selection left and gives the request area the main width');
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
  await page.locator('[data-ai-export-detail]').click();
  const exportDialog = page.locator('#ai-report-export-dialog[open]'); await exportDialog.waitFor();
  assert.doesNotMatch(await exportDialog.innerText(), /方便阅读分享|方便编辑/);
  await screenshot('02a-export-dialog');
  await exportDialog.locator('[name=report-export-format][value=docx]').check();
  const singleDownload = page.waitForEvent('download');
  await exportDialog.locator('[data-ai-export-download]').click();
  const word = await singleDownload;
  assert.match(word.suggestedFilename(), /\.docx$/);
  assert.ok(unzipSync(await readFile(await word.path()))['word/document.xml']);
  assert.equal(provider.calls.length, providerAfterFirst, 'export reads the saved snapshot without asking the model');
  report.checks.push('Single Word download opens from saved history and omits the removed format descriptions');

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
  await page.locator('[data-ai-history-export-mode]').click();
  await page.locator('[data-ai-history-export-all]').click();
  assert.match(await page.locator('.ai-history-export-bar strong').textContent(), /已选 2 份/);
  await page.locator('[data-ai-history-export-next]').click();
  const batchDialog = page.locator('#ai-report-export-dialog[open]'); await batchDialog.waitFor();
  assert.match(await batchDialog.innerText(), /下载为 ZIP/);
  await screenshot('02b-batch-export-dialog');
  const batchDownload = page.waitForEvent('download');
  await batchDialog.locator('[data-ai-export-download]').click();
  const archive = await batchDownload;
  assert.match(archive.suggestedFilename(), /\.zip$/);
  assert.equal(Object.keys(unzipSync(await readFile(await archive.path()))).filter(name => name.endsWith('.pdf')).length, 2);
  report.checks.push('Batch PDF download contains two independent saved reports in one ZIP');
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

  await chooseContacts(Array.from({length:11},(_,index)=>index));
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

  await chooseContacts([0,1]);
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
  await page.goto(base);
  const mobileMaster = page.locator('[data-mobile-ai-master]');
  await mobileMaster.waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-mobile-ai-master]');
    return input && !input.disabled;
  });
  const mobileEntry = page.locator(`[data-mobile-ai-open="${meta.id}"]`);
  assert.equal(await page.locator('#mobile-instances h2').textContent(), '桌面');
  assert.equal(await mobileEntry.isEnabled(), true, 'logged-in WeChat shows an enabled AI settings entry');
  assert.equal(await page.locator('#mobile-ai > p').count(), 0, 'mobile AI section has no helper copy');
  assert.equal((await mobileEntry.textContent()).trim(), '分析报告 UI 测试微信', 'the button is named after the instance');
  assert.equal(await page.locator('#ai-panel').isVisible(), false, 'mobile AI workspace starts closed');
  let resumeSettingsRequest;
  let settingsRequestStarted;
  let pendingSettingsReads = 0;
  const settingsRequest = new Promise(resolve => { settingsRequestStarted = resolve; });
  const holdSettingsRequest = async route => {
    if (route.request().method() !== 'GET') return route.continue();
    pendingSettingsReads++;
    if (pendingSettingsReads > 1) return route.continue();
    await new Promise(resolve => { resumeSettingsRequest = resolve; settingsRequestStarted(); });
    await route.continue();
  };
  await page.route(`**/api/instances/${meta.id}/ai`, holdSettingsRequest);
  await mobileEntry.click();
  await settingsRequest;
  assert.equal(await page.locator('#desktop-view').isVisible(), true, 'AI settings reacts immediately while the request is pending');
  assert.equal(await page.locator('.ai-entry-loading').isVisible(), true, 'the pending request shows the in-page loading illustration');
  assert.equal(await page.locator('#ai-rail').isVisible(), false, 'loading does not reveal the empty desktop rail');
  assert.equal(pendingSettingsReads, 1, 'showing loading does not duplicate the settings request');
  await page.waitForTimeout(250);
  await screenshot('mobile-ai-loading-390');
  await page.locator('#ai-mobile-back').click();
  assert.equal(await page.locator('#desktop-view').isVisible(), false, 'back works while settings are loading');
  const settingsResponse = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith(`/api/instances/${meta.id}/ai`));
  resumeSettingsRequest();
  await settingsResponse;
  await page.unroute(`**/api/instances/${meta.id}/ai`, holdSettingsRequest);
  assert.equal(await page.locator('#desktop-view').isVisible(), false, 'a late settings response does not reopen the page');
  await mobileEntry.click();
  await page.locator('#ai-panel .ai-main-tabs [data-ai-nav="settings"]').waitFor();
  assert.equal(await page.locator('#ai-rail').isVisible(), false, 'the desktop rail stays hidden after AI settings open');
  assert.equal(await page.locator('.ai-entry-loading').count(), 0, 'loading art disappears as soon as settings render');
  assert.equal(await page.locator('#ai-panel .ai-panel-heading').isVisible(), false, 'the redundant mobile heading is removed');
  assert.equal(await page.locator('#ai-mobile-back').getAttribute('aria-label'), '返回上一级', 'icon-only mobile back keeps an accessible name');
  const backFits = await page.locator('#ai-mobile-back').evaluate(button => {
    const icon = button.querySelector('svg').getBoundingClientRect(), edge = button.getBoundingClientRect();
    return edge.width >= 44 && icon.left >= edge.left && icon.right <= edge.right && edge.right <= innerWidth;
  });
  assert.equal(backFits, true, 'mobile back icon fits inside a 44px touch target');
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.locator('#ai-mobile-back').evaluate(button => button.getBoundingClientRect().right <= innerWidth), true, 'back button fits at 320px');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#ai-panel .ai-main-tabs [data-ai-nav="settings"]').click();
  assert.equal(await page.locator('#ai-title').textContent(), '系统设置', 'entry opens the usable AI settings workspace');
  await screenshot('mobile-ai-settings-390');
  await page.locator('.ai-settings-entry[data-ai-nav="provider"]').click();
  assert.equal(await page.locator('#ai-title').textContent(), '模型设置', 'mobile model settings opens as a child page');
  assert.equal(await page.locator('#ai-panel .ai-panel-heading').isVisible(), false, 'child pages have no redundant heading');
  await screenshot('mobile-ai-provider-390');
  await page.locator('#ai-mobile-back').click();
  assert.equal(await page.locator('#ai-title').textContent(), '系统设置', 'mobile back returns from model settings to system settings');
  await page.locator('#ai-mobile-back').click();
  assert.equal(await page.locator('#ai-title').textContent(), '自动回复', 'mobile back returns to the AI overview');
  await screenshot('mobile-ai-overview-390');
  await page.locator('#ai-mobile-back').click();
  assert.equal(await page.locator('#desktop-view').isVisible(), false, 'closing settings returns to the mobile instance list');
  await screenshot('mobile-ai-outer-switch-390');
  const waitMasterPost = expected => page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/api/instances/${meta.id}/ai`) && response.request().postDataJSON()?.action === 'mobile-master' && response.request().postDataJSON()?.value?.enabled === expected);
  const enableResponse = waitMasterPost(true);
  await mobileMaster.check();
  assert.equal((await enableResponse).status(), 200, 'enable request must be accepted by the server');
  await page.waitForFunction(() => document.querySelector('[data-mobile-ai-master]')?.checked);
  assert.equal(ai.data.settings.enabled, true, 'outer switch updates the fixture AI setting');
  assert.equal((await ai.mobileMasterState(meta.id)).enabled, true, 'server readback confirms the saved enable state');
  assert.equal(await page.locator('#ai-panel').isVisible(), false, 'switching AI does not open the workspace');
  const disableResponse = waitMasterPost(false);
  await mobileMaster.uncheck();
  assert.equal((await disableResponse).status(), 200, 'disable request must be accepted by the server');
  await page.waitForFunction(() => !document.querySelector('[data-mobile-ai-master]')?.checked);
  assert.equal(ai.data.settings.enabled, false, 'outer switch can restore the fixture AI setting');
  assert.equal((await ai.mobileMasterState(meta.id)).enabled, false, 'server readback confirms the saved disable state');
  report.checks.push('390px AI entry has no desktop flash or redundant heading; back navigation and the outer switch work');
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
