import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const fixture = await proactiveFixture(), { ai, bridge, provider } = fixture;
const output = path.resolve(root, process.env.QIBOX_TEST_OUTPUT || 'reports/ai-contact-return');
const proof = { at: new Date().toISOString(), syntheticContacts: 53, realWechatSends: 0, passed: false };
let browser;
try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 50; i++) bridge.contacts.push({ id: createHash('sha256').update('contact-return-'+i).digest('hex'), label: `合成对象 ${i}`, kind: 'person' });
  await ai.scan();
  const contact = bridge.contacts[0].id;
  await ai.saveReplyProfile({ contact, style: { summary: '简洁自然' }, strategy: { replyGoal: '回应对方' } });
  await ai.setReplyOptions({ contact, enabled: true, judgeReply: false });
  const callsBefore = provider.calls.length;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['local-network-access'], { origin: new URL(fixture.url).origin });
  const page = await context.newPage();
  await page.goto(fixture.url);
  await page.locator('[data-action=open]').click();
  await page.waitForFunction(() => document.querySelector('#desktop-status').hidden && document.querySelector('#remote-canvas canvas')?.width === 1280);
  await page.locator('#ai-open').click();
  await page.locator(`[data-ai-object="${contact}"]`).click();
  await page.getByRole('switch', { name: '自动回复', exact: true }).uncheck();
  assert.match(await page.locator(`[data-ai-object="${contact}"]`).getAttribute('aria-label'), /自动回复已开启/);
  const list = page.locator('#ai-object-list'), box = await list.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 778);
  await page.waitForFunction(() => document.querySelector('#ai-object-list').scrollTop >= 300);
  proof.before = await list.evaluate(e => e.scrollTop);
  await page.locator('.ai-main-tabs').getByRole('button', { name: '执行记录', exact: true }).click();
  await page.locator('.ai-main-tabs').getByRole('button', { name: '自动回复', exact: true }).click();
  proof.after = await list.evaluate(e => e.scrollTop);
  assert.equal(proof.after, proof.before, 'Returning from another page must preserve a nonzero contact-list position');
  assert.equal(await page.getByRole('switch', { name: '自动回复', exact: true }).isChecked(), false, 'The unsaved draft must remain a draft');
  assert.equal(ai.profiles().find(p => p.contact === contact).replyOptions.enabled, true, 'Navigation cannot save the draft');
  await page.locator('#ai-object-search').fill('合成对象 49');
  assert.equal(await list.evaluate(e => e.scrollTop), 0, 'A new search starts at the top');
  await page.locator('.ai-main-tabs').getByRole('button', { name: '执行记录', exact: true }).click();
  await page.locator('.ai-main-tabs').getByRole('button', { name: '自动回复', exact: true }).click();
  assert.equal(await page.locator('#ai-object-search').inputValue(), '合成对象 49');
  await page.locator('#ai-close').click();
  await page.locator('#desktop-back').click();
  await page.locator('[data-action=open]').click();
  await page.locator('#ai-open').waitFor({state:'visible'});
  await page.locator('#ai-open').click();
  assert.equal(await page.locator('#ai-object-search').inputValue(), '', 'Reattaching an instance must not retain old local search context');
  assert.equal(await page.locator('#ai-object-list').evaluate(e => e.scrollTop), 0, 'Reattaching must clear the old cursor');
  assert.equal(provider.calls.length, callsBefore);
  assert.equal(bridge.sent.length, 0);
  await page.screenshot({ path: path.join(output, 'returned-search.png') });
  proof.passed = true;
} finally {
  try { await writeFile(path.join(output, 'report.json'), JSON.stringify(proof, null, 2)); }
  finally { await browser?.close(); await fixture.close(); }
}
console.log(JSON.stringify(proof));
