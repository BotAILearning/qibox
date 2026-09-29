// Browser audit for action hierarchy, readable controls and responsive geometry.
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
const desktopWidths = [1180, 1200, 1280, 1366, 1440, 1920];
const report = { scope: 'Disposable local app, WeChat and model fixtures; browser geometry only.', checks: [], errors: [], widths: [320, 390, 1024, ...desktopWidths], desktopWidths, geometry: { analysis: [] } };
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
  // Measure rendered glyph rectangles, rather than accepting a CSS declaration
  // such as nowrap when the text is actually clipped or an ancestor hides it.
  const textGeometry = async (selector, ownerSelector) => page.locator(selector).evaluateAll((nodes, ownerSelector) => nodes.map(node => {
    const box = node.getBoundingClientRect(), owner = node.closest(ownerSelector).getBoundingClientRect();
    const rects = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    const rows = [];
    for (const rect of rects) if (!rows.some(top => Math.abs(top - rect.top) < 2)) rows.push(rect.top);
    const inside = (rect, bounds) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    const clippedBy = [];
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
      const left = rect.left + ancestor.clientLeft, top = rect.top + ancestor.clientTop;
      if (rects.some(text => /hidden|clip|auto|scroll/.test(style.overflowX) && (text.left < left - 1 || text.right > left + ancestor.clientWidth + 1) || /hidden|clip|auto|scroll/.test(style.overflowY) && (text.top < top - 1 || text.bottom > top + ancestor.clientHeight + 1))) clippedBy.push(ancestor.id || ancestor.className || ancestor.tagName);
    }
    return { text: node.textContent.trim(), rows: rows.length, width: box.width, glyphWidth: rects.length ? Math.max(...rects.map(rect => rect.right)) - Math.min(...rects.map(rect => rect.left)) : 0,
      fits: rects.length > 0 && rects.every(rect => inside(rect, box) && inside(rect, owner)), clippedBy };
  }), ownerSelector);
  const assertReadable = (rows, label, singleLine = false) => {
    assert.ok(rows.length, `${label}: expected visible text`);
    for (const row of rows) {
      if (singleLine) assert.equal(row.rows, 1, `${label}: label wraps: ${JSON.stringify(row)}`);
      assert.ok(row.fits && !row.clippedBy.length, `${label}: text is clipped: ${JSON.stringify(row)}`);
    }
  };

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
  report.checks.push(`Market: one prominent installation action, compact import link, content-sized sidebar, no overflow at ${report.widths.join('/')}px.`);

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
  clearInterval(ai.timer); await ai.verifyProvider({ ...modelConfig, model: 'fixture-chat-pro' }); await ai.scan(); await ai.settings({ enabled: false });
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

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-ai-object]').first().click();
  // The master switch remains off; this is only an unsaved per-contact draft.
  const originalObjectEnabled = await page.locator('#ai-object-form [name=enabled]').isChecked();
  await page.locator('#ai-object-form [name=enabled]').check();
  await page.locator('.ai-reference-child-grid').waitFor();
  const objectLayout = await page.locator('.ai-reference-child-grid').evaluate(grid => {
    const bounds = grid.getBoundingClientRect();
    const items = [...grid.querySelectorAll('button,input:not([type=hidden]),select,b,small,label,.ai-reference-toggle,.ai-reference-limit,.ai-reference-limit-controls')].filter(node => node.getBoundingClientRect().width > 0);
    return { width: bounds.width, overflow: grid.scrollWidth - grid.clientWidth,
      outside: items.flatMap(node => { const rect = node.getBoundingClientRect(); return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ? [{ label: node.textContent.trim() || node.name, left: rect.left - bounds.left, right: rect.right - bounds.right }] : []; }) };
  });
  assert.ok(objectLayout.overflow <= 1 && !objectLayout.outside.length, `1280px object: child settings overflow or are hidden by the grid: ${JSON.stringify(objectLayout)}`);
  assertReadable(await textGeometry('.ai-reference-child-grid b,.ai-reference-child-grid small', '.ai-reference-toggle'), '1280px object child settings');
  const save = page.locator('#ai-object-form button[type=submit]');
  assert.equal(await save.isVisible(), true, '1280px object: save action is missing');
  const saveGeometry = await save.evaluate(node => {
    const rect = node.getBoundingClientRect(), clip = node.closest('.ai-object-detail').getBoundingClientRect();
    const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      visible: rect.top >= Math.max(0, clip.top) && rect.bottom <= Math.min(innerHeight, clip.bottom) + 1 && rect.left >= 0 && rect.right <= innerWidth + 1,
      unobstructed: center === node || node.contains(center) };
  });
  assert.ok(saveGeometry.visible && saveGeometry.unobstructed, `1280px object: save must be reachable in the visible panel: ${JSON.stringify(saveGeometry)}`);
  await noOverflow('1280px object settings');
  report.geometry.object = { ...objectLayout, save: saveGeometry };
  await page.screenshot({ path: path.join(output, 'object-settings-1280.png') });
  // Restore the original draft value, leaving later regressions unchanged.
  await page.locator('#ai-object-form [name=enabled]').setChecked(originalObjectEnabled);
  report.checks.push('1280px object settings: enabled child controls stay inside their grid, labels are readable and Save is visible and unobstructed.');

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
  for (const width of desktopWidths) {
    await page.setViewportSize({ width, height: 900 });
    const presets = await textGeometry('.ai-analysis-presets button span', '.ai-analysis-presets button');
    assert.equal(presets.length, 8, `${width}px analysis: all eight direction labels are present`);
    assertReadable(presets, `${width}px analysis directions`, true);
    const layout = await page.locator('#ai-analysis-form').evaluate(form => {
      // The form may use display:contents, so measure its visible cards against
      // their actual workspace instead of relying on the form's empty rectangle.
      const workspace = form.closest('.ai-page-body'), outer = workspace.getBoundingClientRect();
      const sections = [...form.querySelectorAll('.ai-analysis-selection,.ai-analysis-request,.ai-analysis-main-fields,.ai-analysis-presets,.ai-analysis-time-entry')];
      const outside = sections.flatMap(node => { const rect = node.getBoundingClientRect(); return rect.left < outer.left - 1 || rect.right > outer.right + 1 || node.scrollWidth > node.clientWidth + 1 ? [{ name: node.className, width: rect.width, overflow: node.scrollWidth - node.clientWidth }] : []; });
      const time = form.querySelector('.ai-analysis-time-entry'), timeBox = time.getBoundingClientRect();
      const content = [...time.querySelectorAll('strong,p,button')].map(node => node.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
      return { overflow: workspace.scrollWidth - workspace.clientWidth, outside, time: { height: timeBox.height,
        contentHeight: Math.max(...content.map(rect => rect.bottom)) - Math.min(...content.map(rect => rect.top)),
        trailingSpace: timeBox.bottom - Math.max(...content.map(rect => rect.bottom)) } };
    });
    assert.ok(layout.overflow <= 1 && !layout.outside.length, `${width}px analysis: form contents overflow: ${JSON.stringify(layout)}`);
    // A small card should end near its last control, even alongside a tall editor.
    assert.ok(layout.time.trailingSpace >= 0 && layout.time.trailingSpace <= 40, `${width}px analysis: time card contains excessive empty space: ${JSON.stringify(layout.time)}`);
    report.geometry.analysis.push({ width, presets, ...layout });
    await noOverflow(`${width}px analysis form`);
    await page.screenshot({ path: path.join(output, `analysis-directions-${width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('[data-ai-analysis-pick]').click();
  await page.locator('.ai-contact-picker-dialog [data-picker-id]').first().check();
  await page.locator('.ai-contact-picker-dialog [data-picker-confirm]').click();
  assert.equal(await page.locator('#ai-analysis-count').innerText(), '1');
  assert.ok((await size('[data-ai-analysis-pick]', '.ai-analysis-selection')).ratio < .72);
  await page.screenshot({ path: path.join(output, 'analysis-selected-390.png') });
  report.checks.push(`Analysis: compact contact entry at ${report.widths.join('/')}px; eight readable single-line direction labels, unclipped form and content-sized time card at ${desktopWidths.join('/')}px; picker still selects a person.`);

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
  // Wait for the actual thumb endpoint; an immediate style read can catch the
  // first frame of its transition and report a false failure.
  await page.waitForFunction(({ selector, checked }) => {
    const node = document.querySelector(selector), track = getComputedStyle(node), thumb = getComputedStyle(node, '::after');
    const travel = parseFloat(track.width) - parseFloat(thumb.width) - 2 * parseFloat(thumb.left);
    const shift = thumb.transform === 'none' ? 0 : new DOMMatrixReadOnly(thumb.transform).m41;
    return Math.abs(shift - (checked ? travel : 0)) < .5;
  }, { selector: '.qbx-settings-group input[name=acknowledgeAI]', checked: !beforeToggle });
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
    if (nav === 'provider') {
      await page.setViewportSize({ width: 1280, height: 900 });
      const names = await textGeometry('.ai-model-item-title strong', '.ai-model-item');
      assertReadable(names, '1280px model names', true);
      assert.ok(names.some(row => row.text === 'fixture-chat-pro'), '1280px model: configured model name is shown');
      const models = await page.locator('.ai-model-workspace').evaluate(workspace => {
        const rect = workspace.getBoundingClientRect();
        const cards = [...workspace.children].map(node => { const box = node.getBoundingClientRect(); return { name: node.className, inside: box.left >= rect.left - 1 && box.right <= rect.right + 1, overflow: node.scrollWidth - node.clientWidth }; });
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        const assignments = [...workspace.querySelectorAll('[data-ai-assignment]')].map(select => {
          const style = getComputedStyle(select); context.font = style.font;
          const text = select.selectedOptions[0]?.textContent || '';
          return { text, textWidth: context.measureText(text).width, available: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 20 };
        });
        return { cards, assignments };
      });
      assert.ok(models.cards.every(card => card.inside && card.overflow <= 1), `1280px model workspace: cards overflow: ${JSON.stringify(models)}`);
      assert.equal(models.assignments.length, 2, '1280px model: both feature assignment controls are present');
      assert.ok(models.assignments.every(row => row.text && row.available >= row.textWidth), `1280px model: selected model names are not readable: ${JSON.stringify(models.assignments)}`);
      await noOverflow('1280px model workspace');
      report.geometry.models = { width: 1280, names, ...models };
      await page.screenshot({ path: path.join(output, 'models-readable-1280.png') });
      report.checks.push('1280px model workspace: saved model names and selected assignments are readable, and both cards remain within their workspace.');
    }
  }
  report.checks.push('Other AI pages: learning, model, proactive, activity and settings remain within 320px, 390px and 1440px viewports.');
  assert.equal(bridge.sent.length, 0);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot); }
