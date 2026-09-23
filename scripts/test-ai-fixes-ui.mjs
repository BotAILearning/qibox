import { createRequire } from 'node:module';
import { proactiveCommand } from './proactive-browser-checks.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, key, modelConfig, strategy } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
for (let n = 4; n <= 85; n++) {
  const c = { id: key(`batch2-${n}`), label: `${n > 65 ? '群聊' : '联系人'} ${String(n).padStart(2, '0')}`, kind: n > 65 ? 'group' : 'person', lastChatAt: 1000 - n, contactOrder: n };
  bridge.contacts.push(c); bridge.messages.set(c.id, [{ id: key(`initial-${n}`), direction: 'self', text: '测试上下文' }]);
}
let navigations = 0;
bridge.openChat = async () => { navigations++; return { opened: true }; };
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('测试微信'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.configure(modelConfig); await ai.scan(); await ai.settings({ enabled: false });
const output = path.join(root, process.argv[2] || 'reports/ai-fixes-20260915/browser'); await mkdir(output, { recursive: true });
const report = { scope: 'Local browser with disposable HTTP, AI and native fixtures; no live account or message.', checks: [], errors: [] };
let browser;
try {
  let now = Date.parse('2026-09-15T10:00:00+08:00'); ai.now = () => now;
  await ai.settings({ enabled: true });
  const contact = bridge.contacts[0].id, second = bridge.contacts[1].id;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', e => report.errors.push(e.message)); page.setDefaultTimeout(15000);
  const open = async () => {
    await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
    await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
    await page.locator(`[data-ai-object="${contact}"]`).click();
  };
  const settled = () => page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false');
  const save = async () => {
    await page.getByRole('button', { name: '保存设置', exact: true }).click(); await settled();
    assert.match(await page.locator('#ai-feedback').textContent(), /设置已保存/);
  };
  await open(); const custom = '始终称呼对方王老师，表达正式简短。';
  await page.locator('[data-ai-style=custom]').click(); await page.locator('[name=summary]').fill(custom); await save();
  assert.equal(await page.locator('[name=summary]').inputValue(), custom);
  assert.equal(await page.locator('[name=styleId]').inputValue(), 'custom');
  if (!(await page.locator('.ai-memory-fold').evaluate(n=>n.open))) await page.locator('.ai-memory-fold > summary').click(); await page.locator('[name=memorySummary]').fill('对方周六有空。'); await save();
  if (!(await page.locator('[data-ai-fold=reply]').evaluate(n=>n.open))) await page.locator('[data-ai-fold=reply] summary').click(); await page.locator('[name=replyGoal]').fill('先确认周六具体时间。'); await save();
  await page.locator(`[data-ai-object="${second}"]`).click(); await page.locator(`[data-ai-object="${contact}"]`).click();
  assert.equal(await page.locator('[name=summary]').inputValue(), custom); await open();
  assert.equal(await page.locator('[name=summary]').inputValue(), custom);
  await page.screenshot({ path: path.join(output, 'style-memory-preserved.png') });
  report.checks.push('AI-01 custom style survives memory/goal saves, switching contacts and reloading');

  const learned = '学习结果：使用独特的简短书面语。';
  provider.next = async () => ({ style: { summary: learned } });
  await page.locator('[data-ai-learn-contact]').click(); await settled();
  assert.match(await page.locator('#ai-feedback').textContent(), /学习完成/);
  await page.locator('#ai-content nav [data-ai-nav=overview]').click(); await page.locator(`[data-ai-object="${contact}"]`).click();
  assert.equal(await page.locator('[name=summary]').inputValue(), learned);
  const presetId = ai.publicState().schema.replyPresets[0].id;
  await page.locator(`[data-ai-style="preset:${presetId}"]`).click(); await save();
  await open(); assert.equal(await page.locator('[name=styleId]').inputValue(), 'preset:' + presetId);
  await page.locator('[data-ai-style=learned]').click();
  assert.equal(await page.locator('[name=summary]').inputValue(), learned); await save(); await open();
  assert.equal(await page.locator('[name=summary]').inputValue(), learned);
  assert.equal(await page.locator('[name=styleId]').inputValue(), 'learned');
  await page.screenshot({ path: path.join(output, 'learned-style-restored.png') });
  report.checks.push('AI-07 learning through UI, preset save, learned selection and reload retain independent snapshot');

  const profile = ai.profiles().find(p => p.contact === contact);
  const m1 = bridge.push(contact, 'self', '14日代发正文'), m2 = bridge.push(contact, 'self', '15日代发正文');
  profile.generatedIds = [m1.id, m2.id]; profile.sentMessages = [{ id: m1.id, at: Date.parse('2026-09-14T23:59:59+08:00'), source:'reply' }, { id: m2.id, at: Date.parse('2026-09-15T00:00:00+08:00'), source:'reply' }];
  await ai.save(); await open(); await page.locator('#ai-content nav [data-ai-nav=activity]').click();
  await page.locator('[data-ai-record-source=reply]').click(); await page.locator('[data-ai-toggle-filters]').click();
  for (const [date, wanted, absent] of [['2026-09-14', '14日代发正文', '15日代发正文'], ['2026-09-15', '15日代发正文', '14日代发正文']]) {
    await page.locator('[name=from]').fill(date); await page.locator('[name=to]').fill(date);
    await page.getByRole('button', { name: '筛选并刷新', exact: true }).click();
    await page.waitForFunction(({ wanted, absent }) => { const text = document.querySelector('#ai-activity-entries').textContent; return text.includes(wanted) && !text.includes(absent); }, { wanted, absent });
    assert.doesNotMatch(await page.locator('#ai-activity-entries').textContent(), new RegExp(absent));
  }
  await page.screenshot({ path: path.join(output, 'dated-records.png') });
  report.checks.push('AI-04 date filtering over HTTP selects earlier delivery and excludes out-of-range body');

  await ai.settings({ enabled: true, proactive: true, reply: false });
  await ai.proactiveTaskAction({command:'create',name:'单次联系',contacts:[second],goal:strategy.purpose,requirements:strategy.content,schedule:{cycle:'once'}});
  const taskId=ai.publicState().proactiveTasks[0].id;
  await open(); await page.locator('#ai-content nav [data-ai-nav=proactive]').click();
  await proactiveCommand(page,taskId,'pause'); assert.equal(ai.data.proactiveTasks[0].status, 'paused');
  await proactiveCommand(page,taskId,'resume'); assert.equal(ai.data.proactiveTasks[0].status, 'running');
  now += 16000; await ai.tick(); // Let the manual-interaction grace period elapse.
  assert.equal(bridge.sent.length, 1, JSON.stringify({task:ai.publicState().proactiveTasks,records:ai.publicState().proactiveRecords,notice:ai.notice,hold:ai.manualHolds.size,busy:ai.userBusyUntil,now:ai.now()}));
  report.checks.push('Independent proactive task pauses and resumes through UI');

  const missing = bridge.contacts[2]; await ai.proactiveTaskAction({command:'create',name:'失败项恢复',contacts:[missing.id,contact],goal:strategy.purpose,requirements:strategy.content,schedule:{cycle:'once'}});
  const failedTask=ai.data.proactiveTasks.at(-1);
  bridge.contacts = bridge.contacts.filter(c => c.id !== missing.id); await ai.scan(); now += 61000; await ai.tick(); await ai.tick();
  assert.equal(failedTask.status, 'failed'); const beforeRetry = bridge.sent.length;
  await open(); await page.locator('#ai-content nav [data-ai-nav=proactive]').click();
  assert.match(await page.locator(`[data-proactive-task="${failedTask.id}"]`).textContent(), /执行失败/);
  await page.screenshot({ path: path.join(output, 'failed-schedule-recovery.png') });
  bridge.contacts.push(missing);
  await ai.scan();
  await proactiveCommand(page,failedTask.id,'retry');
  assert.equal(failedTask.status, 'running'); now += 16000; await ai.tick();
  assert.equal(bridge.sent.length, beforeRetry + 1); assert.equal(bridge.sent.at(-1).contact, missing.id);
  assert.equal(failedTask.status, 'ended');
  report.checks.push('Failed task visible; refresh and retry only missing target without replaying successful contacts');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; process.exitCode = 1; }
finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
}
