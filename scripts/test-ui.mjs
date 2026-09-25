import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageBytes, packageSha256 } from '../test/fixtures.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp();
const downloadBytes = Buffer.alloc(4 * 1024 ** 2); packageBytes.copy(downloadBytes);
let downloadStream, downloads = 0, extractions = 0, preparations = 0, reportExtraction;
const preparation = Promise.withResolvers(), extraction = Promise.withResolvers();
const app = await createApplication({ appRoot: root, dataRoot, dev: true, runtimeFactory,
  fetcher: () => ++downloads === 1 ? new Response(new ReadableStream({ start(controller) { downloadStream = controller; controller.enqueue(downloadBytes.subarray(0, 2 * 1024 ** 2)); } }), { headers: { 'content-length': String(downloadBytes.length) } }) : fetcher(),
  extract: async (file, destination, appRoot, runtimeRoot, progress) => {
    if (++extractions === 1) { reportExtraction = progress; await extraction.promise; }
    return extractor(file, destination);
  }
});
const beforeInstall = app.library.beforeInstall;
// The disposable fixture is an intentionally tiny fake executable; trust its
// exact bytes here so this UI test exercises installation progress, not the
// production executable-structure compatibility gate.
app.library.trustedHashes.push(createHash('sha256').update(downloadBytes).digest('hex'), packageSha256);
app.library.beforeInstall = async () => { await beforeInstall(); if (++preparations === 1) await preparation.promise; };
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}${app.prefix}`;
const report = { startedAt: new Date().toISOString(), note: 'Disposable simulated NAS/runtime fixtures. Real browser layout and application HTTP requests; no real WeChat login.', checks: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?dev=${app.devKey}`);
  await page.getByRole('heading', { name: '欢迎使用栖盒' }).waitFor();
  await page.locator('input[name=consent]').check(); await page.getByRole('button', { name: '开始使用' }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.brand img').naturalWidth === 512);
  assert.equal(await page.getByRole('button', { name: '下载安装微信', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '导入安装包', exact: true }).isVisible(), true);
  await mkdir(path.join(root, 'reports/screenshots'), { recursive: true });
  assert.match(await page.locator('#install-format').textContent(), /x86_64.*\.deb/);
  for (const width of [320, 390, 760, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('#install-format').isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Import format fits at ${width}`);
    if (width === 390) await page.screenshot({ path: path.join(root, 'reports/screenshots/mobile-store.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: path.join(root, 'reports/screenshots/desktop-store.png'), fullPage: true });
  report.checks.push('Desktop: independent brand, official download and package import entries; x86_64 .deb hint visible at all five desktop/mobile widths');
  await page.getByRole('button', { name: '下载安装微信', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#job-percent').textContent === '50%' && document.querySelector('#job-detail').textContent.includes('/s'));
  assert.match(await page.locator('#job-detail').textContent(), /2\.0 MB \/ 4\.0 MB/);
  assert.equal(await page.locator('#job-progress').getAttribute('value'), '50');
  await page.screenshot({ path: path.join(root, 'reports/screenshots/download-progress.png'), fullPage: true });
  await page.waitForFunction(() => document.querySelector('#job-detail').textContent.endsWith(' · 0 B/s'));
  assert.equal(await page.locator('#job-percent').textContent(), '50%');
  downloadStream.enqueue(downloadBytes.subarray(2 * 1024 ** 2, 3 * 1024 ** 2));
  await page.waitForFunction(() => document.querySelector('#job-percent').textContent === '75%' && !document.querySelector('#job-detail').textContent.endsWith(' · 0 B/s'));
  downloadStream.enqueue(downloadBytes.subarray(3 * 1024 ** 2)); downloadStream.close(); downloadStream = null;
  await page.waitForFunction(() => document.querySelector('#job-message').textContent === '正在准备安装');
  assert.equal(await page.locator('#job-progress').getAttribute('value'), null);
  assert.equal(await page.locator('#job-percent').textContent(), ''); assert.equal(await page.locator('#job-detail').textContent(), '');
  assert.equal(await page.locator('#job-progress').evaluate(element => getComputedStyle(element).animationName), 'install-activity');
  await page.screenshot({ path: path.join(root, 'reports/screenshots/install-preparing.png'), fullPage: true });
  preparation.resolve();
  await page.waitForFunction(() => document.querySelector('#job-message').textContent === '正在检查安装包');
  assert.equal(await page.locator('#job-progress').getAttribute('value'), null);
  reportExtraction({ stage: 'extracting', bytes: 2 * 1024 ** 2, total: 8 * 1024 ** 2 });
  await page.waitForFunction(() => document.querySelector('#job-percent').textContent === '25%');
  assert.equal(await page.locator('#job-message').textContent(), '正在解压微信文件');
  assert.equal(await page.locator('#job-detail').textContent(), '2.0 MB / 8.0 MB');
  await page.screenshot({ path: path.join(root, 'reports/screenshots/install-extracting.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(root, 'reports/screenshots/mobile-progress.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  reportExtraction({ stage: 'extracting', bytes: 8 * 1024 ** 2, total: 8 * 1024 ** 2 });
  await page.waitForFunction(() => document.querySelector('#job-percent').textContent === '100%');
  assert.equal(await page.locator('#launch-installed').count(), 0);
  extraction.resolve();
  try { await page.locator('#add-instance').waitFor(); }
  catch (error) {
    report.installDiagnostic = await page.evaluate(() => ({ message: document.querySelector('#job-message')?.textContent || '',
      progress: document.querySelector('#job-percent')?.textContent || '', body: document.body.innerText.slice(-600) }));
    await page.screenshot({ path: path.join(root, 'reports/screenshots/install-timeout.png'), fullPage: true });
    throw error;
  }
  assert.equal(await page.locator('#install-progress').isVisible(), false);
  report.checks.push('Received-byte download 50% and 75% with MB/s; stalled speed becomes zero and recovers; preparing/checking indeterminate; unpacking has its own byte percentage; no stale transfer speed or premature installed state; mobile progress fits');
  await page.locator('#add-instance').click(); await page.locator('input[name=name]').fill('工作微信'); await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.locator('[data-instance]').first().waitFor();
  await page.locator('#add-instance').click(); await page.locator('input[name=name]').fill('个人微信'); await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-instance]').length === 2);
  await page.locator('.app-menu summary').first().click(); await page.getByRole('button', { name: '启动设置', exact: true }).first().click();
  assert.equal(await page.locator('input[value=manual]').isChecked(), true);
  assert.equal(await page.locator('input[value=idle]').isDisabled(), false);
  await page.locator('input[value=continuous]').check(); await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('.app-menu summary').first().click(); await page.getByRole('button', { name: '启动设置', exact: true }).first().click();
  assert.equal(await page.locator('input[value=continuous]').isChecked(), true);
  await page.screenshot({ path: path.join(root, 'reports/screenshots/startup-settings.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.app-menu summary').first().click(); await page.getByRole('button', { name: '启动设置', exact: true }).first().click();
  assert.equal(await page.locator('input[name=autoLoginReady]').count(), 0);
  const detectedInstance = [...(await app.users.get('development')).instances.values()][0];
  detectedInstance.runtime.autoLoginStatus = 'ready';
  assert.equal(await page.getByRole('button', { name: '检测自动登录', exact: true }).count(), 0);
  await page.waitForFunction(() => !document.querySelector('input[value=idle]').disabled);
  const otherInstance = [...(await app.users.get('development')).instances.values()][1];
  await otherInstance.scheduler.tick(); assert.equal(otherInstance.scheduler.publicState().idleAvailable, true);
  await page.locator('input[value=idle]').check();
  await page.locator('input[name=startTime]').fill('23:00'); await page.locator('input[name=endTime]').fill('06:00');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('.app-menu summary').first().click(); await page.getByRole('button', { name: '启动设置', exact: true }).first().click();
  assert.equal(await page.locator('input[value=idle]').isChecked(), true);
  assert.equal(await page.locator('input[name=startTime]').inputValue(), '23:00');
  await page.screenshot({ path: path.join(root, 'reports/screenshots/idle-settings.png') });
  detectedInstance.runtime.inspectAutoLogin = () => { throw new Error('Must not inspect automatic-login eligibility'); };
  await detectedInstance.scheduler.tick();
  await page.waitForResponse(response => response.url().endsWith('/api/state'));
  assert.equal(await page.locator('input[value=idle]').isChecked(), true);
  assert.equal(await page.locator('input[value=idle]').isDisabled(), false);
  assert.match(await page.locator('#modal-body').innerText(), /前期使用需扫码登录/);
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  report.checks.push('Idle is selectable without eligibility checks, saves cross-midnight times and remains selected during polling. Login limitations are visible and no detection button remains.');
  await page.locator('.app-menu summary').first().click();
  await page.getByRole('button', { name: '重命名', exact: true }).first().click(); await page.locator('input[name=name]').fill('办公室'); await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.getByRole('heading', { name: '办公室', exact: true }).waitFor();
  const market = await page.locator('#store-panel').boundingBox(), desktop = await page.locator('#mine-panel').boundingBox();
  assert.ok(market.x + market.width < desktop.x && Math.abs(market.y - desktop.y) < 1);
  assert.equal(await page.locator('#store-panel #add-instance').count(), 1);
  assert.equal(await page.locator('#mine-panel #add-instance').count(), 0);
  assert.equal(await page.locator('[data-instance] .desktop-icon').count(), 2);
  assert.equal(await page.locator('.app-menu[open]').count(), 0);
  const firstIcon = await page.locator('.desktop-icon').first().boundingBox(), secondIcon = await page.locator('.desktop-icon').nth(1).boundingBox();
  assert.ok(secondIcon.x > firstIcon.x && Math.abs(firstIcon.y - secondIcon.y) < 1);
  assert.equal(await page.getByRole('button', { name: '启动设置', exact: true }).first().isVisible(), false);
  report.checks.push('Market is on the left, desktop on the right; add/restore/install stay in the market; desktop uses named icon buttons and compact menus');
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(root, 'reports/screenshots/desktop-installed.png'), fullPage: true });
  await page.locator('.app-menu summary').first().click();
  await page.getByRole('button', { name: '删除', exact: true }).first().click();
  await page.locator('#modal-actions').getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-instance]').length === 1);
  assert.equal(await page.locator('#retained-open').isVisible(), true);
  await page.locator('#add-instance').click(); await page.getByRole('heading', { name: '保留的数据', exact: true }).waitFor();
  await page.locator('#create-fresh').click();
  assert.equal(await page.locator('input[name=name]').inputValue(), '微信');
  for (const duplicate of ['个人微信', ' 办公室 ']) {
    await page.locator('input[name=name]').fill(duplicate); await page.getByRole('button', { name: '确定', exact: true }).click();
    await page.locator('#modal-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#modal-error').textContent(), /名称已存在/);
    assert.equal(await page.locator('[data-instance]').count(), 1);
  }
  await page.screenshot({ path: path.join(root, 'reports/screenshots/duplicate-name.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.app-menu summary').first().click(); await page.getByRole('button', { name: '重命名', exact: true }).first().click();
  await page.locator('input[name=name]').fill('办公室'); await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.locator('#modal-error').waitFor({ state: 'visible' }); assert.match(await page.locator('#modal-error').textContent(), /名称已存在/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('#retained-open').click();
  await page.getByRole('button', { name: '恢复使用', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-instance]').length === 2);
  report.checks.push('Rename, keep data on removal, re-add retained instance');
  const space = await app.users.get('development');
  const legacy = space.list().instances.find(x => x.name === '办公室'), originalHome = space.get(legacy.id).home;
  const retainedFile = path.join(originalHome, 'restore-name-fixture'); await writeFile(retainedFile, 'original retained data');
  await space.remove(legacy.id);
  // Seed the duplicate that a previous release could leave in retained data.
  await space.mutate(async () => {
    const next = space.catalog.map(x => x.id === legacy.id ? { ...x, name: '个人微信' } : x);
    await writeFile(space.file, JSON.stringify(next)); space.catalog = next;
  });
  await page.reload(); await page.locator('#retained-open').click();
  await page.getByRole('button', { name: '恢复使用', exact: true }).click();
  await page.getByRole('heading', { name: '修改名称后恢复', exact: true }).waitFor();
  assert.equal(await page.locator('input[name=name]').inputValue(), '个人微信');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(space.instances.has(legacy.id), false); assert.equal(space.list().retained.length, 1);
  // An older page may not know another application has already taken the name.
  const stale = await (await page.request.get(`${base}/api/state`)).json(); stale.instances[0].name = '过去的名称';
  await page.route('**/api/state', route => route.fulfill({ json: stale }));
  await page.reload(); await page.locator('#retained-open').click();
  const rejectedRestore = page.waitForResponse(response => response.url().endsWith(`/instances/${legacy.id}/restore`));
  await page.getByRole('button', { name: '恢复使用', exact: true }).click();
  assert.equal((await rejectedRestore).status(), 409); await page.unroute('**/api/state');
  await page.getByRole('heading', { name: '修改名称后恢复', exact: true }).waitFor();
  await page.getByRole('button', { name: '恢复使用', exact: true }).click();
  await page.locator('#modal-error').waitFor({ state: 'visible' }); assert.match(await page.locator('#modal-error').textContent(), /名称已存在/);
  await page.screenshot({ path: path.join(root, 'reports/screenshots/restore-name-conflict.png') });
  await page.locator('input[name=name]').fill('办公室'); await page.getByRole('button', { name: '恢复使用', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.querySelectorAll('[data-instance]').length === 2);
  assert.equal(space.get(legacy.id).home, originalHome); assert.equal(space.get(legacy.id).meta.name, '办公室');
  assert.equal(await readFile(retainedFile, 'utf8'), 'original retained data');
  report.checks.push('Creation and rename reject active/retained duplicate names; normal restore remains direct; legacy and server-detected stale-page conflicts require a new name; cancel preserves data; renamed restore reuses the original ID, home and bytes');
  for (const width of [320, 390, 760, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}`);
    if (width <= 760) {
      assert.equal(await page.getByRole('button', { name: '启动设置', exact: true }).first().isVisible(), false);
      assert.equal(await page.locator('#add-instance').isVisible(), false);
      let starts = 0; const listener = request => { if (/\/start$|\/desktop$/.test(new URL(request.url()).pathname)) starts++; }; page.on('request', listener);
      await page.locator('#launch-installed').click(); await page.getByRole('heading', { name: '选择要登录的微信' }).waitFor();
      assert.equal(await page.locator('.mobile-instance-choice').count(), 2);
      assert.equal(await page.locator('#desktop-view').isVisible(), false); assert.equal(starts, 0);
      if (width === 390) await page.screenshot({ path: path.join(root, 'reports/screenshots/mobile-pc-prompt.png'), fullPage: true });
      await page.getByRole('button', { name: '取消', exact: true }).click(); page.off('request', listener);
      if (width === 390) await page.screenshot({ path: path.join(root, 'reports/screenshots/mobile-installed.png'), fullPage: true });
    }
  }
  report.checks.push('320/390/760/1024/1440 layouts do not overflow; mobile opens prompt without starting or connecting to WeChat');
  const mobileContext = await browser.newContext({ viewport: { width: 844, height: 390 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  const mobilePage = await mobileContext.newPage(); await mobilePage.goto(`${base}/?dev=${app.devKey}`);
  await mobilePage.locator('#launch-installed').waitFor(); assert.equal(await mobilePage.locator('#add-instance').isVisible(), false);
  await mobilePage.locator('#launch-installed').click(); await mobilePage.getByRole('heading', { name: '选择要登录的微信' }).waitFor();
  assert.equal(await mobilePage.locator('.mobile-instance-choice').count(), 2);
  assert.equal(await mobilePage.locator('#desktop-view').isVisible(), false);
  report.checks.push('Phone landscape remains restricted even above the width breakpoint');
  await page.setViewportSize({ width: 1440, height: 960 });
  const homeBefore = [...(await app.users.get('development')).instances.values()][0].home;
  await page.locator('#uninstall').click();
  assert.equal(await page.locator('input[name=deleteData][value=no]').isChecked(), true);
  await page.screenshot({ path: path.join(root, 'reports/screenshots/uninstall.png') });
  await page.getByRole('button', { name: '卸载', exact: true }).click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('#download').waitFor(); assert.equal(await page.locator('[data-instance]').count(), 2);
  assert.equal(await page.locator('[data-action=open]').first().isDisabled(), true);
  await page.locator('#download').click(); await page.locator('#uninstall').waitFor();
  assert.equal([...(await app.users.get('development')).instances.values()][0].home, homeBefore);
  const deletingName = await page.locator('[data-instance] h3').first().innerText();
  await page.locator('.app-menu summary').first().click(); await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('input[name=deleteData][value=yes]').check();
  await page.locator('input[name=confirmName]').fill(deletingName);
  await page.locator('#modal-actions button[type=submit]').click(); await page.locator('#modal-error').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(root, 'reports/screenshots/delete-confirm.png') });
  await page.locator('input[name=confirmName]').fill(`确认删除${deletingName}`);
  await page.locator('#modal-actions button[type=submit]').click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-instance]').count(), 1);
  await page.locator('#uninstall').click(); await page.locator('input[name=deleteData][value=yes]').check();
  await page.locator('input[name=confirmName]').fill('微信'); await page.locator('#modal-actions button[type=submit]').click();
  await page.locator('#modal-error').waitFor({ state: 'visible' });
  await page.locator('input[name=confirmName]').fill('确认删除微信'); await page.locator('#modal-actions button[type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' }); await page.locator('#download').waitFor();
  assert.equal(await page.locator('[data-instance]').count(), 0);
  report.checks.push('Visible uninstall entry; preserve data and reinstall reuse the same home; per-instance deletion and uninstall purge require the full confirmation phrase');
  assert.deepEqual(errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  preparation.resolve(); extraction.resolve();
  if (downloadStream) { try { downloadStream.error(new Error('Test closed')); } catch {} }
  await browser?.close(); await app.close(); await cleanup(dataRoot); report.finishedAt = new Date().toISOString();
  await mkdir(path.join(root, 'reports'), { recursive: true }); await writeFile(path.join(root, 'reports/ui-tests.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
}
