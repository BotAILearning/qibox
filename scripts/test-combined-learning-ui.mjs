// Disposable local browser check: one learning result requires one application
// before either its style or memory becomes active.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
import { readMemory } from '../server/ai-wiki.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const fixture = await proactiveFixture();
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url);
  await page.locator(`[data-instance="${fixture.instance.id}"] summary`).click();
  await page.locator('[data-action="ai"]').click();
  await page.locator('#ai-open').click();
  await page.locator('[data-ai-nav="learning"]').click();
  await page.locator('[data-ai-action="open-contact-picker"]').click();
  await page.locator('.ai-contact-picker-dialog [data-picker-id]').first().check();
  await page.locator('[data-picker-confirm]').click();
  assert.equal(await page.locator('input[name="learnTarget"][value="both"]').isChecked(), true);
  await page.locator('[data-ai-action="learn-selected"]').click();
  await page.locator('[data-ai-apply-result]').waitFor();
  const profile = fixture.ai.profiles().find(item => item.contact === fixture.bridge.contacts[0].id);
  assert.ok(profile.pendingStyle);
  assert.equal(profile.pendingMemorySource, 'combined');
  assert.equal(readMemory(fixture.ai.vault, profile).summary, '');
  assert.match(await page.locator('[data-ai-result-profile]').first().innerText(), /风格（待应用）[\s\S]*记忆（待应用）[\s\S]*学习到的长期事实/);
  await page.locator('[data-ai-apply-result]').click();
  await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false');
  assert.equal(readMemory(fixture.ai.vault, profile).summary, '学习到的长期事实');
  assert.equal(profile.pendingStyle, undefined);
  assert.equal(profile.pendingMemory, undefined);
  assert.deepEqual(errors, []);
  console.log('Combined learning browser flow passed: both results shown, one application saved both.');
} finally {
  await browser?.close();
  await fixture.close();
}
