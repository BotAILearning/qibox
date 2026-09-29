// Browser audit for action hierarchy, empty states and narrow-screen geometry.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher,
  aiProvider: provider, trustedHashes: [packageSha256],
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const space = await app.users.get('development'); await space.setConsent(true);
const output = path.join(root, process.argv[2] || 'reports/ui-proportions');
await mkdir(output, { recursive: true });
const report = { scope: 'Disposable local app, WeChat and model fixtures; browser geometry only.', checks: [], errors: [], widths: [320, 390, 1024, 1440] };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`;
  const noOverflow = async label => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: horizontal overflow`);
  const size = async (selector, parent) => page.locator(selector).evaluate((node, parentSelector) => {
    const rect = node.getBoundingClientRect(), outer = node.closest(parentSelector).getBoundingClientRect();
    return { width: rect.width, height: rect.height, ratio: rect.width / outer.width, parentHeight: outer.height };
  }, parent);

  await page.goto(base);
  await page.locator('[data-market-action=download]').waitFor();
  for (const width of report.widths) {
    await page.setViewportSize({ width, height: 900 });
    const utility = await size('[data-market-action=import]', '.store-card');
    assert.ok(utility.ratio < .7, `${width}px: package import occupies ${utility.ratio.toFixed(2)} of card`);
    assert.ok(utility.height >= 40, `${width}px: package import touch target is too short`);
    await noOverflow(`${width}px store`);
    if (width === 390 || width === 1440) await page.screenshot({ path: path.join(output, `store-${width}.png`) });
  }
  const market = await size('.market-panel', '.workspace');
  assert.ok(market.height < 450, `market sidebar expands to ${market.height}px without content`);
  report.checks.push('Market: one prominent installation action, compact import link, content-sized sidebar, no overflow at four widths.');

  app.library.download(); await app.library.working;
  await page.goto(base);
  await page.locator('[data-market-action=add]').first().waitFor();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const visible = page.locator('[data-market-action=add]:visible');
    assert.equal(await visible.count(), 1, `${width}px: installed app must expose exactly one primary action`);
    assert.match(await visible.innerText(), /^添加(实例|到桌面)$/);
    await noOverflow(`${width}px installed market`);
    await page.screenshot({ path: path.join(output, `store-installed-${width}.png`) });
  }
  report.checks.push('Installed market: exactly one primary action is visible on phone and desktop.');
  const meta = await space.add('比例检查微信'); await space.start(meta.id);
  const ai = space.get(meta.id).ai;
  clearInterval(ai.timer); await ai.verifyProvider(modelConfig); await ai.scan(); await ai.settings({ enabled: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await page.locator('.ai-contact-footer').waitFor();
  const footer = await page.locator('.ai-contact-footer').evaluate(node => {
    const parent = node.getBoundingClientRect(), buttons = [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    return { parent: parent.width, widths: buttons.map(rect => rect.width), tops: buttons.map(rect => rect.top) };
  });
  assert.equal(footer.widths.length, 2);
  assert.ok(footer.widths.every(width => width / footer.parent < .65), `sidebar utilities fill the column: ${JSON.stringify(footer)}`);
  assert.ok(Math.abs(footer.tops[0] - footer.tops[1]) < 2, `sidebar utilities should share one row: ${JSON.stringify(footer)}`);
  await page.screenshot({ path: path.join(output, 'automatic-reply-1440.png') });
  report.checks.push('Automatic reply: related utility controls share a compact row in the contact sidebar.');

  await page.locator('.ai-main-tabs [data-ai-nav=analysis]').click();
  await page.locator('[data-ai-analysis-pick]').waitFor();
  assert.equal(await page.locator('.ai-analysis-eyebrow:visible').count(), 0, 'analysis should not display numbered steps');
  for (const width of report.widths) {
    await page.setViewportSize({ width, height: 900 });
    const action = await size('[data-ai-analysis-pick]', '.ai-analysis-selection');
    const card = await size('.ai-analysis-selection', '.ai-analysis-selection');
    assert.ok(action.ratio < .72, `${width}px: add-contact occupies ${action.ratio.toFixed(2)} of card`);
    assert.ok(action.height >= 43.5, `${width}px: add-contact touch target is too short: ${JSON.stringify(action)}`);
    assert.ok(card.height < 220, `${width}px: empty contact card too tall (${card.height}px)`);
    if (width <= 390) {
      const fold = await page.evaluate(() => ({ toolbar: document.querySelector('.qbx-mobile-toolbar').getBoundingClientRect().height, actionTop: document.querySelector('[data-ai-analysis-pick]').getBoundingClientRect().top, reportTop: document.querySelector('.ai-analysis-request').getBoundingClientRect().top }));
      assert.ok(fold.toolbar <= 60, `${width}px: mobile toolbar too tall: ${JSON.stringify(fold)}`);
      assert.ok(fold.actionTop < 170 && fold.reportTop < 250, `${width}px: useful controls fall below the first screen: ${JSON.stringify(fold)}`);
    }
    await noOverflow(`${width}px analysis`);
    if (width === 390 || width === 1440) await page.screenshot({ path: path.join(output, `analysis-empty-${width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('[data-ai-analysis-pick]').click();
  await page.locator('.ai-contact-picker-dialog [data-picker-id]').first().check();
  await page.locator('.ai-contact-picker-dialog [data-picker-confirm]').click();
  assert.equal(await page.locator('#ai-analysis-count').innerText(), '1');
  assert.ok((await size('[data-ai-analysis-pick]', '.ai-analysis-selection')).ratio < .72);
  await page.screenshot({ path: path.join(output, 'analysis-selected-390.png') });
  report.checks.push('Analysis: empty and selected contact entries stay compact and usable at four widths; picker still selects a person.');

  await page.locator('.ai-main-tabs [data-ai-nav=settings]').click();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const settings = await page.evaluate(() => {
      const links = document.querySelector('.qbx-settings-links').getBoundingClientRect();
      const group = document.querySelector('.qbx-settings-group').getBoundingClientRect();
      return { linksTop: links.top, linksBottom: links.bottom, groupTop: group.top, groupGap: group.top - links.bottom };
    });
    assert.ok(settings.groupGap >= 0 && settings.groupGap <= 30, `${width}px: settings group gap is excessive: ${JSON.stringify(settings)}`);
    if (width <= 390) assert.ok(settings.linksTop < 100, `${width}px: settings start too low: ${JSON.stringify(settings)}`);
    const switches = await page.locator('input[role=switch]:visible').evaluateAll(nodes => nodes.map(node => {
      const track = getComputedStyle(node), before = getComputedStyle(node, '::before'), thumb = getComputedStyle(node, '::after');
      return { width: parseFloat(track.width), height: parseFloat(track.height), before: before.content, thumb: thumb.content, left: parseFloat(thumb.left), top: parseFloat(thumb.top), thumbWidth: parseFloat(thumb.width), thumbHeight: parseFloat(thumb.height), transform: thumb.transform };
    }));
    assert.ok(switches.length >= 3, `${width}px: settings switches missing`);
    for (const sw of switches) {
      assert.equal(sw.before, 'none', `${width}px: a second switch thumb is visible`);
      assert.equal(sw.width, 48); assert.equal(sw.height, 28);
      assert.equal(sw.top, 4); assert.equal(sw.left, 4);
      assert.equal(sw.thumbWidth, 20); assert.equal(sw.thumbHeight, 20);
    }
    if (width === 390 || width === 1440) await page.screenshot({ path: path.join(output, `settings-${width}.png`) });
    await noOverflow(`${width}px settings`);
  }
  const toggle = page.locator('.qbx-settings-group input[name=acknowledgeAI]');
  const beforeToggle = await toggle.isChecked();
  await toggle.evaluate(node => { node.checked = !node.checked; });
  const changedThumb = await toggle.evaluate(node => getComputedStyle(node, '::after').transform);
  assert.equal(changedThumb === 'none' || changedThumb === 'matrix(1, 0, 0, 1, 0, 0)', beforeToggle, 'switch thumb must travel to the opposite end when state changes');
  await toggle.evaluate((node, checked) => { node.checked = checked; }, beforeToggle);
  await page.setViewportSize({ width: 390, height: 900 });
  const navContrast = await page.locator('.qbx-bottom-nav button[aria-current=page]').evaluate(node => {
    const style = getComputedStyle(node);
    const rgb = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
    const luminosity = value => rgb(value).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
    const a = luminosity(style.color), b = luminosity(style.backgroundColor);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  assert.ok(navContrast >= 4.5, `active navigation label contrast is ${navContrast.toFixed(2)}`);
  report.checks.push('Qibox components: compact mobile toolbar and first-screen actions; settings groups have no oversized gap; every visible switch has one centered thumb; active navigation label meets 4.5:1 contrast.');
  await page.locator('[data-ai-nav=default-style]').click();
  for (const width of report.widths) {
    await page.setViewportSize({ width, height: 900 });
    const empty = await size('.ai-default-current.ai-default-empty', '.ai-default-current');
    assert.ok(empty.height < 260, `${width}px: default-style empty state is ${empty.height}px tall`);
    await noOverflow(`${width}px default style`);
    if (width === 390) await page.screenshot({ path: path.join(output, 'default-style-390.png') });
  }
  report.checks.push('Default style: empty state follows its content instead of reserving a 500px panel.');
  for (const nav of ['learning', 'provider', 'proactive', 'activity', 'settings']) {
    if (nav === 'learning') { await page.locator('.ai-main-tabs [data-ai-nav=overview]').click(); await page.locator('.ai-contact-footer [data-ai-nav=learning]').click(); }
    else if (nav === 'provider') { await page.locator('.ai-main-tabs [data-ai-nav=settings]').click(); await page.locator('.ai-reference-settings [data-ai-nav=provider]').click(); }
    else await page.locator(`.ai-main-tabs [data-ai-nav=${nav}]`).click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(`${width}px ${nav}`);
    }
  }
  report.checks.push('Other AI pages: learning, model, proactive, activity and settings remain within 320px, 390px and 1440px viewports.');
  assert.equal(bridge.sent.length, 0);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot); }
