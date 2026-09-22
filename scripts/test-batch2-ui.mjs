import { createRequire } from 'node:module';
import { proactiveDraftCheck } from './proactive-browser-checks.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, key, modelConfig } from '../test/ai-fixtures.mjs';
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
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('测试微信'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.configure(modelConfig); await ai.scan(); await ai.settings({ enabled: false });
const output = path.join(root, process.argv[2] || 'reports/development-2026-09-15-batch2/browser'); await mkdir(output, { recursive: true });
const report = { scope: 'Local browser with disposable HTTP, AI and native fixtures; no live account or message.', checks: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', e => report.errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await page.locator('#ai-object-list button').first().waitFor();
  assert.equal(await page.locator('[data-ai-master], #ai-rail-status, #desktop-audio-toggle, #desktop-volume').count(), 0);
  const list = await page.locator('#ai-object-list').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
  assert.ok(list.height > 100 && list.scroll > list.height && list.overflow === 'auto', JSON.stringify(list));
  await page.locator(`[data-ai-object="${bridge.contacts[0].id}"]`).click();
  if (!(await page.locator('.ai-memory-fold').evaluate(n=>n.open))) await page.locator('.ai-memory-fold > summary').click(); await page.locator('[name=memorySummary]').fill('对方：周六下午有空。'); await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#ai-feedback').textContent.includes('保存'));
  assert.equal(ai.publicState().profiles.find(p => p.contact === bridge.contacts[0].id).memory.summary, '对方：周六下午有空。');
  await page.screenshot({ path: path.join(output, 'contacts-memory.png') });
  report.checks.push('Independent contact scrolling, removed rail/audio controls, editable memory saved through HTTP');
  await page.locator('#ai-content [data-ai-nav=provider]').click();
  await page.locator('.ai-model-item').first().locator('[data-ai-model-edit]').click();
  await page.locator('#ai-model-form').waitFor();
  const keyRect = await page.locator('#ai-api-key').boundingBox(), eye = await page.locator('[data-ai-action=toggle-key]').boundingBox();
  assert.ok(eye.x >= keyRect.x && eye.x + eye.width <= keyRect.x + keyRect.width + 1);
  await page.locator('[data-ai-action=toggle-key]').click(); await page.waitForFunction(() => document.querySelector('#ai-api-key').type === 'text');
  await page.locator('[data-ai-action=toggle-key]').click(); assert.equal(await page.locator('#ai-api-key').getAttribute('type'), 'password');
  const model = await page.locator('#ai-model-choice').boundingBox(), fetch = await page.locator('[data-ai-action=models]').boundingBox();
  assert.ok(Math.abs(model.y - fetch.y) < 8 && fetch.x >= model.x + model.width - 1);
  await page.locator('[data-ai-action=models]').click(); await page.waitForFunction(() => document.querySelector('#ai-model-choice').textContent.includes('fixture-chat'));
  await page.screenshot({ path: path.join(output, 'provider.png') }); report.checks.push('Embedded eye icon, reveal/remask, adjacent model fetch and refreshed choices');
  await proactiveDraftCheck(page);
  await page.screenshot({ path: path.join(output, 'proactive.png') }); report.checks.push('New single-page draft retains fields and contacts; picker cancellation is isolated; weekly/random controls work');
  const p = ai.profiles().find(p => p.contact === bridge.contacts[0].id), sent = bridge.push(p.contact, 'self', '已确认的测试代发正文。');
  p.generatedIds = [sent.id]; p.sentMessages = [{ id: sent.id, at: Date.now(), source: 'reply' }]; await ai.save();
  // Reopen obtains fresh public state before entering activity.
  await page.locator('#ai-close').click(); await page.locator('#ai-open').click();
  await page.locator('[data-ai-nav=activity]').click();
  await page.locator('[data-ai-record-source=reply]').click();
  await page.locator('.ai-contact-record details > summary').click(); await page.getByText('已确认的测试代发正文。', { exact: true }).waitFor();
  assert.equal(await page.locator('.ai-contact-record').count(), 1);
  await page.locator('.ai-contact-record [data-ai-open-conversation]').first().click(); await page.locator('#ai-panel').waitFor({ state: 'hidden' });
  assert.equal(navigations, 1); assert.equal(!!p.paused, false); report.checks.push('Actual sent body grouped once; direct navigation invoked once and does not pause target');
  await page.locator('#ai-open').click(); await page.locator('[data-ai-nav=overview]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-ai-object-back]').click(); await page.locator('[data-ai-kind=group]').click(); await page.locator('[data-ai-object]').first().click();
  assert.equal(await page.locator('[name=memorySummary]').isVisible(), true);
  if (!(await page.locator('.ai-memory-fold').evaluate(n=>n.open))) await page.locator('.ai-memory-fold > summary').click(); assert.equal(await page.locator('[name=memorySummary]').isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const font = await page.locator('[name=memorySummary]').evaluate(el => getComputedStyle(el).fontSize); assert.equal(font, '16px');
  await page.screenshot({ path: path.join(output, 'mobile-group.png') }); report.checks.push('390px group detail, no horizontal page overflow, readable 16px input text');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot); }
