import {calendarFixture,selectSeptemberRange} from './ai-calendar-fixture.mjs';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { FileChooser } from '../server/file-chooser.mjs';
import { AppError } from '../server/files.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, key, modelConfig } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(), home = path.join(dataRoot, 'native-home');
await mkdir(home);
bridge.waitForIdle = async () => { if (bridge.manualInputBlocked) throw new AppError('draft', 409, 'ai_draft_check'); };
bridge.releaseManualBlock = () => { bridge.manualInputBlocked = false; };
const ranges = [];
calendarFixture(bridge);
bridge.readRange = async args => { ranges.push(args); return { account: args.account, contact: args.contact, rangeRevision: key(args.contact), messages: [{ id: key(args.contact), timestamp: args.from + 1, direction: 'self', text: args.contact }] }; };
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const chooser = new FileChooser({ dataRoot, home, send: async value => {
  if (value.watch) { await writeFile(fileURLToPath(value.uris[0]), 'NATIVE_FILE_BYTES_语音之外的附件'); chooser.receive({ type: 'saved', id: value.id }); }
} }); await chooser.init();
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), fileChooser: chooser, port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('开发回归微信'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.configure(modelConfig); await ai.testProvider(); await ai.scan(); await ai.settings({ enabled: false });
const output = path.join(root, process.argv[2] || 'reports/layout-2026-09-16/browser-development'); await mkdir(output, { recursive: true });
const report = { scope: 'Disposable browser, model, native file and RFB fixtures. No real WeChat send or NAS acceptance.', checks: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read','clipboard-write'], acceptDownloads: true });
  await context.addInitScript(() => { window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await page.locator(`[data-ai-object="${bridge.contacts[0].id}"]`).click();
  assert.equal(await page.locator('[name=memorySummary]').isVisible(), true);
  if (!(await page.locator('[data-ai-fold=reply]').evaluate(n=>n.open))) await page.locator('[data-ai-fold=reply] summary').click(); await page.locator('[name=replyGoal]').fill('核实需求再答复');
  await page.locator('[data-ai-fold=strategy] > summary').click();
  await page.locator('[name=facts]').fill('只使用已确认的材料'); await page.locator('[name=boundaries]').fill('报价由本人决定'); await page.locator('[name=maxRounds]').fill('8');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-feedback').textContent.includes('设置已保存'));
  const profile = ai.publicState().profiles.find(p => p.contact === bridge.contacts[0].id);
  assert.equal(profile.replyStrategy.replyGoal, '核实需求再答复'); assert.equal(profile.replyStrategy.maxRounds, 8); assert.ok(!profile.learnedAt);
  report.checks.push('All reply strategy fields save on an unlearned contact; detailed memory starts expanded');
  await page.screenshot({ path: path.join(output, 'automatic-reply.png') });
  await page.locator('[data-ai-nav=analysis]').click();
  await page.locator('#ai-analysis-form [name=request]').fill('分别总结约定');
  for (const c of bridge.contacts.slice(0, 2)) await page.locator(`#ai-analysis-form [value="${c.id}"]`).check();
  provider.complete = async (_config, _system, input) => ({ report: '独立报告 ' + bridge.contacts.find(c => c.id === input.messages[0].text).label });
  await selectSeptemberRange(page);
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await page.locator('[data-ai-copy-report="1"]').waitFor();
  assert.equal(await page.locator('[data-analysis-report]').count(), 2); assert.equal(ranges.length, 4);
  assert.ok(ranges.every(r => r.from === Date.parse('2026-09-01T00:00:00+08:00') / 1000 && r.to === Date.parse('2026-09-03T00:00:00+08:00') / 1000));
  await page.locator('[data-ai-copy-report="1"]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '独立报告 测试对象乙');
  assert.equal(bridge.sent.length, 0); await page.screenshot({ path: path.join(output, 'analysis.png') });
  report.checks.push('Two independent reports use real request date bounds and full-text copy; no sends');
  for (const [nav, file] of [['proactive','proactive.png'],['activity','activity.png'],['provider','provider.png']]) {
    await page.locator(`.ai-main-tabs [data-ai-nav=${nav}]`).click(); await page.screenshot({ path: path.join(output, file) });
  }
  await page.locator('#ai-close').click();
  bridge.manualInputBlocked = true;
  await page.locator('#remote-canvas canvas').hover(); await page.mouse.click(680, 350);
  assert.equal(await page.locator('#desktop-takeover,#ai-manual-recovery').count(),0);
  bridge.manualInputBlocked=false;await page.locator('#remote-canvas canvas').hover();
  report.checks.push('No recovery button is exposed; ordinary input continues after background verification');
  await page.locator('#remote-canvas canvas').click({ position: { x: 200, y: 150 } });
  const fileRequest = randomUUID(); chooser.receive({ operation: 'save', id: fileRequest, name: '附件.txt' });
  await page.locator('[data-file-name]').waitFor(); await page.locator('[data-file-name]').fill('下载报告.txt');
  const waiting = page.waitForEvent('download'); await page.locator('[data-file-choose]').click();
  const download = await waiting; assert.equal(download.suggestedFilename(), '下载报告.txt');
  const received = path.join(dataRoot, 'received.txt'); await download.saveAs(received);
  assert.equal(await readFile(received, 'utf8'), 'NATIVE_FILE_BYTES_语音之外的附件');
  await page.locator('#file-transfer').waitFor({ state: 'hidden' }); assert.equal(chooser.exports.pending, null);
  report.checks.push('Native SaveFile returns only after close-write completion, then authenticated HTTP download preserves Unicode name and exact bytes');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await app.close(); await peer.close(); await chooser.close(); await cleanup(dataRoot); }

