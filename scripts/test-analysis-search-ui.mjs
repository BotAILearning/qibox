// Focused regression: analysis contact picker search box (2026-09-20).
// Verifies: search input exists; filtering hides non-matching labels; checked
// state survives filtering; hidden checked inputs still submit (FormData);
// count unaffected; no-match empty state; clear restores all; reports render.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const output = path.join(root, process.argv[2] || 'reports/analysis-search-2026-09-20/browser'); await mkdir(output, { recursive: true });
const completed = [], report = { scope: 'Disposable local fixtures; no live model, NAS or WeChat messages.', checks: [], errors: [] };
bridge.contacts[0].label = '陈小雨'; bridge.contacts[1].label = '林一'; bridge.contacts[2].label = '周末';
bridge.contacts.push({ id: key('group'), label: '产品设计讨论', kind: 'group' });
bridge.readRange = async args => ({ account: args.account, contact: args.contact, rangeRevision: key(args.contact), messages: [{ id: key(args.contact), timestamp: args.from + 1, text: args.contact, direction: 'self' }] });
provider.complete = async (config, _system, input) => { completed.push({ config, input }); return { report: `独立报告：${input.contact}\n\n事项与约定\n双方约定继续确认周末安排。`, excerptIds: [] }; };
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
  trustedHashes: [packageSha256],
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('界面验收微信'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.verifyProvider(modelConfig); await ai.scan(); await ai.settings({ enabled: false });

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click();
  const settled = () => page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') !== 'true');
  const shot = async file => { await page.screenshot({ path: path.join(output, file + '.png') }); };
  await page.locator('#ai-open').click();
  await page.locator('.ai-main-tabs [data-ai-nav=analysis]').click(); await settled();
  await page.locator('[data-ai-analysis-range=week]').click();
  assert.match(await page.locator('#ai-analysis-form [name=from]').inputValue(), /^\d{4}-\d{2}-\d{2}$/);
  await page.locator('[data-ai-analysis-range=all]').click();
  assert.equal(await page.locator('#ai-analysis-form [name=from]').inputValue(), '');
  report.checks.push('分析时间范围快捷选择更新并可恢复全部');

  // 1) Search box present with all person contacts visible initially.
  const search = page.locator('#ai-analysis-search');
  assert.equal(await search.count(), 1);
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]').count(), 3, 'all three person contacts rendered');
  assert.equal(await page.locator('#ai-analysis-contacts label[hidden]').count(), 0, 'no hidden labels initially');
  report.checks.push('搜索框存在，初始展示全部联系人');

  // 2) Select two contacts (one will be filtered out later).
  await page.locator('#ai-analysis-contacts [name=contacts]').nth(0).check();   // 陈小雨
  await page.locator('#ai-analysis-contacts [name=contacts]').nth(2).check();   // 周末
  assert.equal(await page.locator('#ai-analysis-count').textContent(), '2');

  assert.equal(await page.locator('#ai-analysis-form button[type=submit]').textContent(), '开始分析 · 2 位');
  // 3) Search "林" -> only 林一 visible; filtered-out labels stay hidden but checked.
  await search.fill('林');
  assert.equal(await page.locator('#ai-analysis-contacts label[hidden]').count(), 2, 'two contacts hidden by search');
  assert.equal(await page.locator('#ai-analysis-contacts label:not([hidden])').count(), 1);
  assert.equal(await page.locator('#ai-analysis-contacts label:not([hidden])').textContent(), '林一');
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]:checked').count(), 2, 'checked state preserved while filtering');
  assert.equal(await page.locator('#ai-analysis-count').textContent(), '2', 'count unaffected by filtering');
  await shot('search-filtered');

  // 4) No-match search shows the empty hint, not the generic refresh hint.
  await search.fill('不存在的人');
  assert.equal(await page.locator('#ai-analysis-contacts .ai-help').textContent(), '未找到匹配的联系人。');
  await shot('search-empty');

  // 5) Clear search -> all contacts restored, prior checks intact.
  await search.fill('');
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]').count(), 3);
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]:checked').count(), 2, 'checks retained after clear');
  report.checks.push('搜索过滤隐藏不匹配项、保留勾选、计数不变，清空恢复全部');

  // 6) Submit while a filtered-out contact is checked: hidden checked inputs must
  //    still be included in the queue and each sent in its own request.
  await page.locator('[name=request]').fill('分别总结约定');
  await search.fill('林');  // 陈小雨/周末 now hidden but still checked
  await page.getByRole('button', { name: '开始分析', exact: true }).click(); await settled();
  assert.equal(completed.length, 2, 'hidden checked contacts are each sent once');
  assert.ok(completed.every(call => !Array.isArray(call.input.contacts)), 'each provider call carries a single contact payload');
  assert.deepEqual(new Set(completed.map(c => c.input.contact)), new Set(['陈小雨', '周末']));
  assert.equal(await page.locator('[data-analysis-report]').count(), 2);
  await shot('search-reports');
  report.checks.push('隐藏的已勾选联系人仍进入逐人队列并分别生成报告');

  assert.equal(bridge.sent.length, 0); assert.deepEqual(report.errors, []); report.passed = true;

  // 7) Mobile: no horizontal overflow, search box usable at 390px.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.ai-main-tabs [data-ai-nav=analysis]').click(); await settled();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px body overflow');
  await search.fill('周'); assert.equal(await page.locator('#ai-analysis-contacts label:not([hidden])').textContent(), '周末');
  await shot('search-mobile');
  report.checks.push('390px 移动端无横向溢出，搜索仍可用');
  await search.fill('');
  for (const width of [320,360,375,390,414,480,768,850,860,1024,1440]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await page.locator('#ai-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1), width+' content overflow');
    const request=await page.locator('.ai-analysis-request').boundingBox();
    assert.ok(request.x>=0 && request.x+request.width<=width+1,width+' request fits screen');
    await page.locator('#ai-analysis-contacts [name=contacts]').nth(1).check();
    const count=await page.locator('#ai-analysis-contacts [name=contacts]:checked').count();
    assert.equal(await page.locator('#ai-analysis-form button[type=submit]').textContent(), '开始分析 · '+count+' 位');
    await page.locator('#ai-analysis-contacts [name=contacts]').nth(1).uncheck();
    await shot('responsive-'+width);
  }
  report.checks.push('320–1440px content bounds and selection/button synchronization passed');
  for (const width of [320,390,768]) {
    await page.setViewportSize({width,height:844});
    for (const nav of ['overview','proactive','activity','settings']) {
      const button=page.locator('.ai-main-tabs [data-ai-nav='+nav+']');
      if(!await button.count()) continue;
      await button.click();await settled();
      assert.ok(await page.locator('#ai-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1),width+' '+nav+' overflow');
      await shot('workspace-'+width+'-'+nav);
    }
  }
  report.checks.push('All available main navigation pages fit 320,390,768px');
  for (const width of [320,390,768]) {
    await page.setViewportSize({width,height:844});
    const navBox=await page.locator('.ai-main-tabs').boundingBox();
    const contentBox=await page.locator('#ai-content').boundingBox();
    assert.ok(navBox.y>=contentBox.y+contentBox.height-1,'navigation below content');
    assert.equal(await page.locator('#ai-close').isVisible(),false);
    assert.equal(await page.locator('.ai-header-master').isVisible(),false);
    await page.locator('.ai-main-tabs [data-ai-nav=settings]').click();
    await page.locator('[data-ai-nav=provider]').click();await settled();
    await shot('phone-'+width+'-models');
    await page.locator('[data-ai-action=model-add]').click();
    await shot('phone-'+width+'-model-editor');
    await page.locator('#ai-mobile-back').click();
    assert.equal(await page.locator('#ai-model-form').count(),0,'one back returns to model list');
    await page.locator('#ai-mobile-back').click();
    assert.equal(await page.locator('#ai-panel').getAttribute('data-page'),'settings');
    await page.locator('.ai-main-tabs [data-ai-nav=proactive]').click();
    await page.locator('[data-proactive-new]').click();
    const area=page.locator('#ai-proactive-form textarea').first();
    await area.fill('长内容自动适应\n'.repeat(25));
    assert.equal(await area.evaluate(el=>getComputedStyle(el).resize),'none');
    assert.ok(await area.evaluate(el=>el.getBoundingClientRect().height>=96));
    assert.ok(await page.locator('#ai-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1),width+' task editor overflow');
    await shot('phone-'+width+'-task-editor');
    await page.locator('#ai-mobile-back').click();
    assert.equal(await page.locator('#ai-proactive-form').count(),0);
    await page.locator('.ai-main-tabs [data-ai-nav=activity]').click();await settled();
    const searchBox=await page.locator('#ai-log-search').boundingBox(),filterBox=await page.locator('.ai-reference-filter-button').boundingBox();
    assert.ok(Math.abs(searchBox.y-filterBox.y)<2 && Math.abs(searchBox.height-filterBox.height)<2,'search and filter aligned');
  }
  report.checks.push('Bottom navigation, header cleanup, single back, model/task editors, auto-sized input and search/filter alignment passed');
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot); }
