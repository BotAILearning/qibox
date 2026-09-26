import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
import { proactiveDraftCheck, proactiveCommand } from './proactive-browser-checks.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const fixture = await proactiveFixture(), { ai, bridge } = fixture;
const output = path.join(root, process.argv[2] || 'reports/proactive-redesign-2026-09-17/browser');
await mkdir(output, { recursive: true });
const report = { scope: 'Local application with disposable model/WeChat fixtures. No NAS, real model or real messages.', checks: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(error.message));
  const settled = () => page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') !== 'true');
  const shot = name => page.screenshot({ path: path.join(output, name + '.png') });
  const nav = async key => { await page.locator(`.ai-main-tabs [data-ai-nav=${key}]`).click(); await settled(); };
  await page.goto(fixture.url);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await proactiveDraftCheck(page);
  report.checks.push('Single-page draft retention, isolated picker cancellation, weekly and random controls');
  await page.locator('[data-proactive-new]').click();
  await page.locator('[name=name]').fill('春日问候计划');
  await page.locator('[data-proactive-pick]').click();
  await page.locator('[data-proactive-contact]').nth(0).check();
  await page.locator('[data-proactive-contact]').nth(1).check();
  await page.locator('[data-proactive-refresh]').click(); await settled();
  assert.equal(await page.locator('[data-proactive-contact]:checked').count(), 2);
  await page.locator('[data-proactive-picker-confirm]').click();
  await page.locator('[name=taskType]').selectOption('relationship');
  await page.locator('[name=goal]').fill('询问最近是否有空喝咖啡');
  await page.locator('[name=requirements]').fill('语气轻松，不承诺具体时间。');
  await page.locator('[name=cycle]').selectOption('weekly');
  await page.locator('[name=weekdays][value="5"]').check();
  await page.locator('[name=mode]').selectOption('random');
  await page.locator('[name=start]').fill('18:00'); await page.locator('[name=end]').fill('21:00');
  await shot('editor');
  await page.locator('[data-proactive-submit]').click(); await settled();
  const task = ai.data.proactiveTasks[0];
  assert.equal(task.name, '春日问候计划'); assert.equal(task.contacts.length, 2);
  assert.equal(task.taskType, 'relationship'); assert.deepEqual(task.schedule.weekdays, [1, 5]);
  assert.equal(ai.data.settings.reply, false); assert.equal(ai.data.settings.enabled, true);
  await proactiveCommand(page, task.id, 'pause'); assert.equal(task.status, 'paused');
  await proactiveCommand(page, task.id, 'edit');
  assert.equal(await page.locator('[name=goal]').inputValue(), task.goal);
  assert.equal(await page.locator('[name=start]').inputValue(), '18:00');
  assert.equal(await page.locator('[name=taskType]').inputValue(), 'relationship');
  assert.equal(await page.locator('[name=weekdays][value="5"]').isChecked(), true);
  assert.equal(await page.locator('#ai-proactive-selected .ap-chip').count(), 2);
  await page.locator('[name=requirements]').fill('不要提工作压力。');
  await page.locator('[data-proactive-submit]').click(); await settled();
  assert.equal(task.requirements, '不要提工作压力。'); assert.equal(task.status, 'paused');
  await proactiveCommand(page, task.id, 'resume'); assert.equal(task.status, 'running');
  report.checks.push('Real HTTP create, all fields persist, full edit prefill, pause/save/resume keeps the same task and state');
  await shot('tasks');

  // Immediate task is executed only by the fixture runner after UI saves it.
  await page.locator('[data-proactive-new]').click(); await page.locator('[name=name]').fill('立即联系测试');
  await page.locator('[data-proactive-pick]').click(); await page.locator('[data-proactive-contact]').first().check();
  await page.locator('[data-proactive-picker-confirm]').click(); await page.locator('[name=goal]').fill('确认周末安排');
  assert.equal(await page.locator('[name=time]').count(), 0);
  await page.locator('[data-proactive-submit]').click(); await settled();
  const immediate = ai.data.proactiveTasks.at(-1); await ai.tick();
  assert.equal(immediate.status, 'ended'); assert.equal(bridge.sent.length, 1);
  await nav('activity');
  await page.locator('[data-ai-record-source="proactive"]').click(); await settled();
  await page.locator('[data-proactive-record]').waitFor();
  assert.match(await page.locator('#ai-proactive-records').textContent(), /确认周末安排/);
  assert.equal(await page.locator('#ai-activity-entries').count(), 0);
  await shot('records');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `activity page overflows at ${width}px`);
    const controls = await page.locator('#ai-proactive-records .ap-record-table button:not(.ai-record-message)').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
    assert.ok(controls.every(height => height >= 36), `record action target below 36px at ${width}px: ${controls}`);
    await shot(`records-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[data-proactive-record] [data-ai-open-conversation]').click();
  assert.equal(fixture.opened.at(-1), immediate.contacts[0].id);
  await page.locator('#ai-open').click(); await nav('proactive');
  await proactiveCommand(page, immediate.id, 'delete');
  await page.locator('[data-proactive-delete-confirm]').click(); await settled();
  assert.equal(await page.locator(`[data-proactive-task="${immediate.id}"]`).count(), 0);
  await nav('activity'); await page.locator('[data-ai-record-source="proactive"]').click(); await settled(); assert.equal(await page.locator('[data-proactive-record]').count(), 1);
  report.checks.push('Immediate send fixture confirmed once; actual body in separate records; correct conversation opened; deletion retains history');

  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 844 }); await nav('proactive');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if(width<=860){
      const toggle=page.locator('[data-proactive-expand]').first();
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');
      assert.ok(await page.locator('.mobile-expanded .ap-reference-goal').isVisible());
      await shot('task-expanded-'+width);
      await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    }
    await shot('tasks-' + width);
    await page.locator('[data-proactive-new]').click();
    assert.ok(await page.locator('.ap-editor').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.locator('[data-proactive-pick]').click();
    assert.ok(await page.locator('.ai-proactive-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await shot('picker-' + width);
    await page.locator('[data-proactive-picker-cancel]').last().click();
    await page.locator('[data-proactive-cancel]').click();
  }
  report.checks.push('Desktop, tablet and phone: page/editor/contact dialog fit; task table is independently scrollable');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await fixture.close(); }
