import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const groupId = key('layout-test-group');
bridge.contacts[0].label = '测试对象甲：这是一个特意加长的中文联系人名称，用于检查窄屏下是否正确换行和保留语义';
bridge.contacts.push({ id: groupId, label: '测试群聊布局：这是一个较长的群聊名称，用来检查手机宽度下的中文换行效果', kind: 'group' });
bridge.messages.set(groupId, [{ id: 'initial-layout-test-group', direction: 'self', text: 'GROUP_FIXTURE_MARKER' }]);
bridge.stableMessageIds = true;
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
const output = path.resolve(root, process.argv[2] || 'reports/ai-wait-switch-20260924/ui');
await mkdir(output, { recursive: true });
let browser;
let zoomContext, zoomTemp;
const uiScaleEvidence = { viewportEquivalent380: true, cssZoomSimulation: null, browserZoom200: { status: 'pending', note: '尚未由浏览器页面缩放证实' } };
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
  const meta = await space.add('等待设置界面验收'); await space.start(meta.id); const ai = space.get(meta.id).ai; clearInterval(ai.timer);
  await ai.scan();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click({ timeout: 5000 });
  let releaseInitialRead, initialReadStarted;
  const initialReadGate = new Promise(resolve => { releaseInitialRead = resolve; });
  const initialReadRequest = new Promise(resolve => { initialReadStarted = resolve; });
  let initialReadHeld = false;
  const holdInitialRead = async route => {
    const request = route.request(), url = request.url();
    if (!initialReadHeld && request.method() === 'GET' && url.includes('/api/instances/') && /\/ai(?:\?|$)/.test(url)) {
      initialReadHeld = true; initialReadStarted(); await initialReadGate;
    }
    await route.continue();
  };
  await page.route('**/*', holdInitialRead);
  await page.locator('#ai-open').click({ timeout: 5000 });
  await initialReadRequest;
  assert.ok(await page.locator('.ai-entry-loading').isVisible(), 'expected real app loading state while the initial read is delayed');
  await page.waitForTimeout(350); // let the real loading entrance animation become visible before capture
  await page.screenshot({ path: path.join(output, 'settings-loading.png'), fullPage: true });
  releaseInitialRead();
  await page.getByRole('button', { name: '系统设置', exact: true }).click({ timeout: 5000 });
  await page.unroute('**/*', holdInitialRead);
  assert.equal(await page.locator('#ai-takeover-form .ai-time-range').count(), 3);
  for (const range of await page.locator('#ai-takeover-form .ai-time-range').all()) assert.equal(await range.locator('input[type=number]').count(), 2);
  const settingsWidth = (await page.locator('#ai-takeover-form').boundingBox()).width;
  assert.ok(settingsWidth <= 761, `settings form exceeds 760px: ${settingsWidth}`);
  const settingsPadding = await page.locator('#ai-takeover-form').evaluate(node => getComputedStyle(node).paddingInlineStart);
  assert.equal(settingsPadding, '24px', `global settings content inset must be 24px, got ${settingsPadding}`);
  const configBox = page.locator('.ai-reference-settings .qbx-settings-config');
  assert.ok((await configBox.boundingBox()).width <= 761, 'reply configuration card exceeds 760px');
  assert.match(await page.locator('#ai-takeover-form [data-effective-timing]').textContent(), /20 秒.*60 秒.*15–60 秒.*45–120 秒/);
  assert.match(await page.locator('#ai-takeover-form [data-effective-takeover]').textContent(), /开启，5 分钟/);
  const numericMeasure = await page.locator('#ai-takeover-form .ai-time-range .qi-number-unit').first().evaluate(node => ({
    inputWidth: node.querySelector('input').getBoundingClientRect().width,
    unitGap: node.querySelector('span').getBoundingClientRect().left - node.querySelector('input').getBoundingClientRect().right,
  }));
  assert.ok(numericMeasure.inputWidth >= 112, `timing input too narrow: ${numericMeasure.inputWidth}`);
  assert.ok(numericMeasure.unitGap >= 8, `number/unit gap too narrow: ${numericMeasure.unitGap}`);
  await page.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'dark'; });
  await page.screenshot({ path: path.join(output, 'settings-dark.png'), fullPage: true });
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'light'; });
  await page.setViewportSize({ width: 720, height: 900 });
  assert.equal(await page.locator('#ai-takeover-form .ai-time-range').count(), 3);
  assert.equal(await page.locator('#ai-takeover-form').evaluate(node => getComputedStyle(node).paddingInlineStart), '16px');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'settings overflow at 720px');
  await page.screenshot({ path: path.join(output, 'settings-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 380, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'settings overflow at 380px/200%');
  await page.screenshot({ path: path.join(output, 'settings-200pct.png'), fullPage: true });
  uiScaleEvidence.viewportEquivalent380 = { viewport: '380x900 CSS px', status: 'passed', description: '窄视口等效检查，不代表浏览器缩放' };
  await page.setViewportSize({ width: 1440, height: 900 });
  const cssZoomBefore = await page.evaluate(() => ({ innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale || 1 }));
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  const cssZoomAfter = await page.evaluate(() => ({ innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale || 1, styleZoom: document.documentElement.style.zoom, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  await page.screenshot({ path: path.join(output, 'settings-css-zoom-simulation-2x.png') });
  uiScaleEvidence.cssZoomSimulation = { status: 'captured', description: '通过 document.documentElement.style.zoom=2 的CSS缩放模拟，不等同浏览器缩放；截图为当前视口，避免整页截图重复固定导航', before: cssZoomBefore, after: cssZoomAfter, screenshot: 'settings-css-zoom-simulation-2x.png' };
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  const browserZoomBefore = await page.evaluate(() => ({ innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale || 1 }));
  try {
    for (let step = 0; step < 5; step++) await page.keyboard.press('Control+Shift+Equal');
    await page.waitForTimeout(250);
    const browserZoomAfter = await page.evaluate(() => ({ innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale || 1 }));
    const widthScale = browserZoomBefore.innerWidth / browserZoomAfter.innerWidth;
    if (Math.abs(widthScale - 2) < 0.15 && browserZoomAfter.devicePixelRatio >= browserZoomBefore.devicePixelRatio * 1.7) {
      uiScaleEvidence.browserZoom200 = { status: 'confirmed', before: browserZoomBefore, after: browserZoomAfter, screenshot: 'settings-browser-zoom-200pct.png' };
      await page.screenshot({ path: path.join(output, 'settings-browser-zoom-200pct.png'), fullPage: true });
    } else {
      uiScaleEvidence.browserZoom200 = { status: 'pending', note: '当前Playwright/Microsoft Edge窗口快捷键未产生可验证的200%浏览器缩放', before: browserZoomBefore, after: browserZoomAfter };
    }
  } catch (error) {
    uiScaleEvidence.browserZoom200 = { status: 'pending', note: `浏览器缩放快捷键不受当前自动化环境支持：${error.message}` };
  } finally {
    try { await page.keyboard.press('Control+0'); } catch {}
  }
  zoomTemp = await mkdtemp(path.join(os.tmpdir(), 'qibox-browser-zoom-'));
  const extensionPath = path.join(zoomTemp, 'extension'), profilePath = path.join(zoomTemp, 'profile');
  await mkdir(extensionPath, { recursive: true });
  await writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Qibox local browser zoom verification',
    version: '1.0.0',
    permissions: ['tabs'],
    host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'service-worker.js' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['probe.js'], run_at: 'document_idle' }],
  }));
  await writeFile(path.join(extensionPath, 'service-worker.js'), `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind !== 'qibox-zoom-probe' || sender.tab?.id == null) return;
  (async () => {
    try {
      await chrome.tabs.setZoom(sender.tab.id, 2);
      const zoom = await chrome.tabs.getZoom(sender.tab.id);
      sendResponse({ status: 'ok', zoom, tabId: sender.tab.id });
    } catch (error) {
      sendResponse({ status: 'error', error: String(error) });
    }
  })();
  return true;
});`);
  await writeFile(path.join(extensionPath, 'probe.js'), `window.addEventListener('qibox-browser-zoom-probe', () => {
  const before = { innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale || 1 };
  chrome.runtime.sendMessage({ kind: 'qibox-zoom-probe' }, result => {
    const after = { innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale || 1 };
    document.documentElement.dataset.qiboxZoomProbe = JSON.stringify({ ...result, before, after });
  });
}, { once: true });`);
  try {
    zoomContext = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      viewport: { width: 1440, height: 900 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath, '--no-first-run', '--no-default-browser-check'],
    });
    const zoomPage = zoomContext.pages()[0] || await zoomContext.newPage();
    zoomPage.setDefaultTimeout(15000);
    await zoomPage.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
    await zoomPage.locator('[data-action=open]').first().click();
    await zoomPage.locator('#ai-open').click();
    await zoomPage.getByRole('button', { name: '系统设置', exact: true }).click();
    await zoomPage.evaluate(() => window.dispatchEvent(new Event('qibox-browser-zoom-probe')));
    await zoomPage.waitForFunction(() => Boolean(document.documentElement.dataset.qiboxZoomProbe), null, { timeout: 12000 });
    const zoomProbe = await zoomPage.evaluate(() => JSON.parse(document.documentElement.dataset.qiboxZoomProbe));
    if (zoomProbe.status === 'ok') {
      const layoutRatio = zoomProbe.before.innerWidth / zoomProbe.after.innerWidth;
      const verified = zoomProbe.zoom === 2 && Number.isFinite(layoutRatio) && Math.abs(layoutRatio - 2) <= 0.2;
      if (verified) {
        assert.ok(await zoomPage.locator('#ai-takeover-form').isVisible(), 'global settings form must remain visible at true browser zoom 200%');
        const horizontalOverflow = await zoomPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        assert.equal(horizontalOverflow, false, 'global settings must not overflow horizontally at true browser zoom 200%');
        await zoomPage.screenshot({ path: path.join(output, 'settings-browser-zoom-200pct.png') });
        uiScaleEvidence.browserZoom200 = { status: 'confirmed', method: 'isolated persistent Chromium profile + local MV3 extension chrome.tabs.setZoom/getZoom', zoom: zoomProbe.zoom, layoutViewportRatio: layoutRatio, before: zoomProbe.before, after: zoomProbe.after, settingsFormVisible: true, horizontalOverflow: false, screenshot: 'settings-browser-zoom-200pct.png' };
      } else {
        uiScaleEvidence.browserZoom200 = { status: 'pending', note: '本地扩展API已运行，但缩放值或布局视口比例未达到2倍验收条件', zoom: zoomProbe.zoom, layoutViewportRatio: layoutRatio, before: zoomProbe.before, after: zoomProbe.after };
      }
    } else {
      uiScaleEvidence.browserZoom200 = { status: 'pending', note: `本地扩展调用 chrome.tabs.setZoom/getZoom 失败：${zoomProbe.error || 'unknown error'}`, probe: zoomProbe };
    }
  } catch (error) {
    const probePage = zoomContext?.pages()[0];
    const pageState = await probePage?.evaluate(() => ({ url: location.href, title: document.title, probe: document.documentElement.dataset.qiboxZoomProbe || null, innerWidth: window.innerWidth })).catch(() => null);
    const workers = zoomContext?.serviceWorkers().map(worker => worker.url()) || [];
    const chromiumFailure = { note: error.message, pageState, serviceWorkers: workers };
    await zoomContext?.close(); zoomContext = undefined;
    try {
      zoomContext = await chromium.launchPersistentContext(path.join(zoomTemp, 'edge-profile'), {
        channel: 'msedge',
        headless: false,
        viewport: { width: 1440, height: 900 },
        ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath, '--no-first-run', '--no-default-browser-check'],
      });
      const edgePage = zoomContext.pages()[0] || await zoomContext.newPage();
      edgePage.setDefaultTimeout(15000);
      await edgePage.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
      await edgePage.locator('[data-action=open]').first().click();
      await edgePage.locator('#ai-open').click();
      await edgePage.getByRole('button', { name: '系统设置', exact: true }).click();
      await edgePage.evaluate(() => window.dispatchEvent(new Event('qibox-browser-zoom-probe')));
      await edgePage.waitForFunction(() => Boolean(document.documentElement.dataset.qiboxZoomProbe), null, { timeout: 12000 });
      const edgeProbe = await edgePage.evaluate(() => JSON.parse(document.documentElement.dataset.qiboxZoomProbe));
      const edgeRatio = edgeProbe.before.innerWidth / edgeProbe.after.innerWidth;
      if (edgeProbe.status === 'ok' && edgeProbe.zoom === 2 && Number.isFinite(edgeRatio) && Math.abs(edgeRatio - 2) <= 0.2) {
        assert.ok(await edgePage.locator('#ai-takeover-form').isVisible(), 'global settings form must remain visible at true browser zoom 200%');
        const horizontalOverflow = await edgePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        assert.equal(horizontalOverflow, false, 'global settings must not overflow horizontally at true browser zoom 200%');
        await edgePage.screenshot({ path: path.join(output, 'settings-browser-zoom-200pct.png') });
        uiScaleEvidence.browserZoom200 = { status: 'confirmed', method: 'isolated persistent Edge profile + local MV3 extension chrome.tabs.setZoom/getZoom', zoom: edgeProbe.zoom, layoutViewportRatio: edgeRatio, before: edgeProbe.before, after: edgeProbe.after, settingsFormVisible: true, horizontalOverflow: false, screenshot: 'settings-browser-zoom-200pct.png', chromiumHeadlessAttempt: chromiumFailure };
      } else {
        uiScaleEvidence.browserZoom200 = { status: 'pending', note: '隔离Edge扩展已运行，但缩放值或布局视口比例未达到2倍验收条件', zoom: edgeProbe.zoom, layoutViewportRatio: edgeRatio, before: edgeProbe.before, after: edgeProbe.after, chromiumHeadlessAttempt: chromiumFailure };
      }
    } catch (edgeError) {
      const edgePage = zoomContext?.pages()[0];
      const edgePageState = await edgePage?.evaluate(() => ({ url: location.href, title: document.title, probe: document.documentElement.dataset.qiboxZoomProbe || null, innerWidth: window.innerWidth })).catch(() => null);
      uiScaleEvidence.browserZoom200 = { status: 'pending', note: `隔离持久化Chromium和Edge扩展验证均未能完成：${edgeError.message}`, chromiumHeadlessAttempt: chromiumFailure, edgePageState };
    }
  } finally {
    await zoomContext?.close();
    zoomContext = undefined;
    if (zoomTemp) { await rm(zoomTemp, { recursive: true, force: true }); zoomTemp = undefined; }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#ai-content [data-ai-nav="personal-info"]').click();
  assert.ok(await page.locator('#ai-personal-information-form').isVisible());
  await page.screenshot({ path: path.join(output, 'personal-information-desktop.png'), fullPage: true });
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'dark'; });
  const darkPersonalSurfaces = await page.locator('#ai-panel').evaluate(node => ({
    header: getComputedStyle(node.querySelector('.ai-panel-heading')).backgroundColor,
    footer: getComputedStyle(node.querySelector('.ai-personal-save')).backgroundColor,
    headerText: getComputedStyle(node.querySelector('.ai-panel-heading .ai-breadcrumb')).color,
  }));
  assert.equal(darkPersonalSurfaces.header, darkPersonalSurfaces.footer, 'dark personal information header and sticky save bar must share a dark surface');
  assert.notEqual(darkPersonalSurfaces.footer, 'rgb(255, 255, 255)', 'dark personal information sticky save bar must not remain white');
  assert.notEqual(darkPersonalSurfaces.headerText, 'rgb(255, 255, 255)', 'dark breadcrumb text must retain contrast on its surface');
  await page.screenshot({ path: path.join(output, 'personal-information-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 720, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'personal information overflow at 720px');
  const darkPersonalMobileSurfaces = await page.locator('#ai-panel').evaluate(node => ({
    toolbar: getComputedStyle(node.querySelector('.ai-mobile-navigation')).backgroundColor,
    title: getComputedStyle(node.querySelector('#ai-mobile-title')).color,
    tabs: getComputedStyle(node.querySelector('.ai-main-tabs')).backgroundColor,
  }));
  assert.notEqual(darkPersonalMobileSurfaces.toolbar, 'rgb(255, 255, 255)', 'dark mobile personal-information toolbar must not remain white');
  assert.notEqual(darkPersonalMobileSurfaces.title, darkPersonalMobileSurfaces.toolbar, 'dark mobile title must contrast with its toolbar');
  assert.equal(darkPersonalMobileSurfaces.tabs, darkPersonalMobileSurfaces.toolbar, 'dark mobile toolbar and bottom navigation must share a surface');
  await page.screenshot({ path: path.join(output, 'personal-information-mobile-dark.png'), fullPage: true });
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'light'; });
  await page.screenshot({ path: path.join(output, 'personal-information-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-ai-nav="settings"]').first().click();
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'dark'; });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const surfaces = await page.evaluate(() => {
      const toolbar = document.querySelector('#ai-panel .ai-mobile-navigation');
      const tabs = document.querySelector('#ai-panel .ai-main-tabs');
      const luminance = color => color.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum,v,i) => sum + v * [0.2126,0.7152,0.0722][i],0);
      const background = getComputedStyle(tabs).backgroundColor, foreground = getComputedStyle(tabs.querySelector('button[aria-current="false"]')).color;
      const a = luminance(background), b = luminance(foreground);
      return { toolbar: getComputedStyle(toolbar).backgroundColor, title: getComputedStyle(document.querySelector('#ai-mobile-title')).color, tabs: background, inactiveTextContrast: (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05) };
    });
    assert.notEqual(surfaces.toolbar, 'rgb(255, 255, 255)', 'dark system settings mobile toolbar must share the theme');
    assert.notEqual(surfaces.title, surfaces.toolbar, 'dark mobile title must contrast with its toolbar');
    assert.equal(surfaces.tabs, surfaces.toolbar, 'dark mobile navigation surfaces must agree');
    assert.ok(surfaces.inactiveTextContrast >= 4.5, `mobile navigation text contrast is ${surfaces.inactiveTextContrast}`);
    await page.screenshot({ path: path.join(output, `settings-mobile-dark-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'light'; });
  const toggle = page.locator('#ai-takeover-form [name=enabled]'), minutes = page.locator('#ai-takeover-form [name=minutes]');
  assert.equal(await toggle.getAttribute('role'), 'switch'); assert.equal(await toggle.isChecked(), true);
  assert.equal(await minutes.inputValue(), '5'); assert.equal(await minutes.isVisible(), true);
  assert.match((await page.locator('#ai-takeover-form .ai-help').allTextContents()).join(' '), /关闭.*对应联系人.*群聊.*其他联系人/);
  await toggle.uncheck(); assert.equal(await minutes.isVisible(), false); assert.equal(await minutes.isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'settings-takeover-disabled.png'), fullPage: true });
  let releaseSettingsSave, settingsSaveStarted;
  const settingsSaveGate = new Promise(resolve => { releaseSettingsSave = resolve; });
  const settingsSaveRequest = new Promise(resolve => { settingsSaveStarted = resolve; });
  let settingsSaveHeld = false;
  const holdSettingsSave = async route => {
    const request = route.request(); let action = '';
    try { action = request.postDataJSON()?.action || ''; } catch {}
    if (!settingsSaveHeld && request.url().includes('/api/instances/') && request.url().includes('/ai') && action === 'settings') {
      settingsSaveHeld = true; settingsSaveStarted(); await settingsSaveGate;
    }
    await route.continue();
  };
  await page.route('**/*', holdSettingsSave);
  const settingsSaveClick = page.getByRole('button', { name: '保存设置', exact: true }).click();
  await settingsSaveRequest;
  assert.equal(await page.locator('#ai-panel').getAttribute('aria-busy'), 'true', 'saving state must be real and remain uncommitted until the held request continues');
  assert.equal(await page.getByRole('button', { name: '保存中…', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#ai-takeover-form [name=replyDelay]').isDisabled(), true, 'a pending save must not discard newly edited values');
  await page.screenshot({ path: path.join(output, 'settings-saving-pending.png'), fullPage: true });
  releaseSettingsSave(); await settingsSaveClick;
  await page.unroute('**/*', holdSettingsSave);
  await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  assert.equal(ai.data.settings.takeover.enabled, false); assert.equal(ai.data.settings.takeover.minutes, 5);
  await toggle.check(); assert.equal(await minutes.isVisible(), true); await minutes.fill('8');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  assert.deepEqual(ai.data.settings.takeover, { enabled: true, minutes: 8 });
  await ai.configure(modelConfig);
  await ai.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
  await ai.settings({ enabled: true });
  await ai.tick();
  await page.getByRole('button', { name: '自动回复', exact: true }).click();
  await page.locator(`[data-ai-object="${bridge.contacts[0].id}"]`).click();
  const objectReply = page.locator('#ai-object-form [data-object-option="enabled"]');
  if (!await objectReply.isChecked()) {
    await objectReply.check();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  }
  assert.equal(await page.locator('#ai-object-form .ai-time-range').count(), 3);
  assert.equal(await page.locator('#ai-object-form [name=inheritTiming]').isChecked(), true);
  assert.match(await page.locator('#ai-object-form [data-effective-timing]').textContent(), /继承全局设置.*20 秒.*60 秒.*15–60 秒.*45–120 秒/);
  assert.match(await page.locator('#ai-object-form [data-effective-takeover]').textContent(), /继承全局设置.*开启，8 分钟/);
  assert.equal(await page.locator('#ai-object-form .ai-object-timing > .ai-reply-module-heading').evaluate(node => getComputedStyle(node).paddingInlineStart), '24px');
  assert.equal(await page.locator('#ai-object-form .ai-object-timing > .ai-reply-module-body').evaluate(node => getComputedStyle(node).paddingInlineStart), '24px');
  assert.ok(await page.locator('#ai-object-form .ai-object-timing').isVisible());
  assert.ok(await page.locator('#ai-object-form [name=replyDelay]').isDisabled(), 'inherited timing controls must be disabled');
  await page.locator('#ai-object-form .ai-object-timing').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'object-desktop.png') });
  await page.screenshot({ path: path.join(output, 'object-inherited-disabled.png') });
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'dark'; });
  await page.screenshot({ path: path.join(output, 'object-dark.png') });
  await page.locator('html').evaluate(node => { node.dataset.qiTheme = 'light'; });
  await page.setViewportSize({ width: 720, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'object settings overflow at 720px');
  await page.locator('#ai-object-form .ai-object-timing').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'object-mobile.png') });
  await page.setViewportSize({ width: 380, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'object settings overflow at 380px/long Chinese copy');
  const objectChineseLines = await page.locator('#ai-object-form .ai-person-head h3').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length; });
  const objectHelpLines = await page.locator('#ai-object-form .ai-object-timing .ai-help').filter({ hasText: '你手动回复后' }).evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length; });
  assert.ok(objectChineseLines > 1, `long Chinese contact title should wrap, got ${objectChineseLines} line(s)`);
  assert.ok(objectHelpLines > 1, `long Chinese helper copy should wrap, got ${objectHelpLines} line(s)`);
  await page.screenshot({ path: path.join(output, 'object-long-chinese-380.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const inheritTiming = page.locator('#ai-object-form [name=inheritTiming]');
  await inheritTiming.uncheck();
  await page.locator('#ai-object-form [name=replyDelay]').fill('7');
  await page.locator('#ai-object-form [name=replyMaxWait]').fill('29');
  assert.match(await page.locator('#ai-object-form [data-effective-timing]').textContent(), /继承全局设置.*20 秒.*60 秒/);
  await page.screenshot({ path: path.join(output, 'object-override.png') });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  const contactTiming = ai.profiles().find(profile => profile.contact === bridge.contacts[0].id);
  assert.equal(contactTiming.timing.replyDelay, 7);
  assert.equal(contactTiming.timing.replyMaxWait, 29);
  await page.locator('[data-ai-kind="group"]').click();
  await page.locator(`[data-ai-object="${groupId}"]`).click();
  assert.equal(await page.locator('#ai-object-form [name=inheritTiming]').isChecked(), true);
  assert.match(await page.locator('#ai-object-form [data-effective-timing]').textContent(), /继承全局设置/);
  await page.screenshot({ path: path.join(output, 'group-inherit.png'), fullPage: true });
  await page.setViewportSize({ width: 380, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'long Chinese group label overflows at 380px');
  const groupChineseLines = await page.locator('#ai-object-form .ai-person-head h3').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length; });
  assert.ok(groupChineseLines > 1, `long Chinese group title should wrap, got ${groupChineseLines} line(s)`);
  await page.screenshot({ path: path.join(output, 'group-long-chinese-380.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#ai-object-form [name=inheritTiming]').uncheck();
  await page.locator('#ai-object-form [name=replyDelay]').fill('11');
  await page.locator('#ai-object-form .ai-object-timing').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'group-override.png') });
  let failProfileSave = true;
  const failOneProfileSave = async route => {
    const request = route.request();
    let action = '';
    try { action = request.postDataJSON()?.action || ''; } catch {}
    if (failProfileSave && request.url().includes('/api/instances/') && request.url().includes('/ai') && action === 'reply-profile') {
      failProfileSave = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '视觉回归：模拟保存失败' }) });
    } else await route.continue();
  };
  await page.route('**/*', failOneProfileSave);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('视觉回归：模拟保存失败'));
  await page.screenshot({ path: path.join(output, 'group-override-save-error.png'), fullPage: true });
  await page.unroute('**/*', failOneProfileSave);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  const groupTiming = ai.profiles().find(profile => profile.contact === groupId);
  assert.equal(groupTiming.timing.replyDelay, 11);
  await page.locator('[data-ai-kind="person"]').click();
  await page.locator(`[data-ai-object="${bridge.contacts[0].id}"]`).click();
  assert.match(await page.locator('#ai-object-form [data-effective-timing]').textContent(), /此对象独立设置.*7 秒.*29 秒.*15–60 秒.*45–120 秒/);
  assert.match(await page.locator('#ai-object-form [data-effective-takeover]').textContent(), /继承全局设置.*开启，8 分钟/);
  assert.deepEqual(ai.data.settings.takeover, { enabled: true, minutes: 8 }, 'manual-reply continuation test requires enabled global takeover');
  assert.equal(ai.profiles().find(profile => profile.contact === bridge.contacts[0].id).takeover, undefined, 'person must still inherit global takeover');
  await page.locator('[data-ai-optional="reply-strategy"] > summary').click();
  await page.locator('#ai-object-form [name=replyGoal]').fill('草稿保留检查');
  const now = Math.floor(Date.now() / 1000);
  // Treat this fixture's synthetic UI interaction as completed before exercising background polling.
  ai.userBusyUntil = 0;
  Object.assign(bridge.push(bridge.contacts[0].id, 'self', '手动接管'), { timestamp: now, authorship: 'human' });
  await ai.tick();
  Object.assign(bridge.push(bridge.contacts[0].id, 'other', '请回复'), { timestamp: now + 1 });
  await ai.tick();
  await page.locator('[data-ai-optional="object-live"] > summary').click();
  const continuationProfile = ai.profiles().find(item => item.contact === bridge.contacts[0].id);
  const continuationDebug = {
    settings: { enabled: ai.data.settings.enabled, reply: ai.data.settings.reply, takeover: ai.data.settings.takeover },
    profile: { id: continuationProfile?.id, paused: continuationProfile?.paused, pauseReason: continuationProfile?.pauseReason, replyOptions: continuationProfile?.replyOptions, effectiveTakeover: continuationProfile?.effectiveTakeover, takeover: continuationProfile?.takeover, manualWait: continuationProfile?.manualWait, lastManualAt: continuationProfile?.lastManualAt, replyWatchSince: continuationProfile?.replyWatchSince },
    cursor: ai.cursors.get(continuationProfile?.id), targets: ai.data.targets, replyTargets: ai.data.replyTargets, selected: ai.selected(continuationProfile), replySelected: ai.replySelected(continuationProfile), eligible: ai.eligible(continuationProfile), available: ai.available, operation: ai.operation || ai.scanOperation || null, ticking: ai.ticking, activeRuns: [...ai.activeRuns.keys()], userBusyUntil: ai.userBusyUntil || 0, retryAt: ai.retryAt, now: ai.now(), ready: ai.ready(), modelReady: ai.modelReady(), prerequisites: ai.prerequisites('reply'), liveStates: ai.liveStates(), watchedTargets: await ai.watchBatch(ai.controller.signal), executionInnerText: await page.locator('[data-ai-object-execution]').innerText(), messages: (await bridge.read({ contact: bridge.contacts[0].id })).messages,
  };
  await writeFile(path.join(output, 'manual-continuation-debug.json'), JSON.stringify(continuationDebug, null, 2));
  try {
    await page.waitForFunction(() => document.querySelector('[data-ai-object-execution]')?.textContent.includes('手动回复后的接续等待'), null, { timeout: 8000 });
  } catch (error) {
    throw new Error(`${error.message}; manual continuation state=${JSON.stringify(continuationDebug)}`);
  }
  assert.equal(await page.locator('#ai-object-form [name=replyGoal]').inputValue(), '草稿保留检查');
  let finishModel;
  provider.next = () => new Promise(resolve => { finishModel = resolve; });
  await page.locator('[data-ai-skip-reply-wait]').click();
  await page.waitForFunction(() => document.querySelector('[data-ai-object-execution] .ai-reply-flow')?.dataset.phase === 'requesting');
  assert.equal(await page.locator('#ai-object-form [name=replyGoal]').inputValue(), '草稿保留检查');
  finishModel({ action: 'send', text: '已回复' });
  await page.waitForFunction(() => document.querySelector('[data-ai-object-execution] .ai-object-execution-label')?.matches('.sent, .idle'));
  assert.equal(bridge.sent.length, 1);
  if (errors.length) throw new Error(JSON.stringify(errors));
  const report = { status: 'passed', viewport: '1440x900', default: { enabled: true, minutes: 5 }, offHidesAndDisablesMinutes: true, onAcceptsCustomMinutes: 8, visibleWaitAndSkipReply: true, scaling: uiScaleEvidence, addedVisualStates: ['settings-loading.png', 'settings-takeover-disabled.png', 'settings-saving-pending.png', 'object-inherited-disabled.png', 'object-long-chinese-380.png', 'group-long-chinese-380.png', 'personal-information-dark.png', 'personal-information-mobile-dark.png'], errors };
  await writeFile(path.join(output, 'ai-assisted-wait-ui.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'ui-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await zoomContext?.close();
  if (zoomTemp) await rm(zoomTemp, { recursive: true, force: true });
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
}
