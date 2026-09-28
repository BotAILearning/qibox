import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {playwrightPath} from './tooling.mjs';

const {chromium}=createRequire(import.meta.url)(playwrightPath);
const fixture=await proactiveFixture(),browser=await chromium.launch({channel:'msedge',headless:true});
try {
  fixture.bridge.contacts[0].nickname='小雨同学';
  await fixture.ai.scan();
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.url);
  await page.locator(`[data-instance="${fixture.instance.id}"] summary`).click();
  await page.locator('[data-action="ai"]').click();
  await page.locator('#ai-open').click();

  await page.locator('[data-ai-nav="learning"]').click();
  await page.locator('[data-ai-action="open-contact-picker"]').click();
  assert.equal(await page.locator('.ai-contact-picker-dialog [data-picker-kind]').count(),2);
  await page.locator('#ai-modal-contact-search').fill('小雨同学');
  assert.equal(await page.locator('.ai-contact-picker-dialog [data-picker-id]').count(),1);
  assert.equal(await page.locator('.ai-contact-picker-dialog .ai-contact-nick').innerText(),'（小雨同学）');
  await page.locator('.ai-contact-picker-dialog [data-picker-id]').check();
  await page.locator('#ai-modal-contact-search').fill('不存在的测试联系人');
  assert.equal(await page.locator('.ai-contact-picker-dialog [data-picker-id]').count(),0);
  await page.locator('#ai-modal-contact-search').fill('');
  assert.equal(await page.locator('.ai-contact-picker-dialog [data-picker-id]:checked').count(),1);
  await page.locator('[data-picker-confirm]').click();
  assert.match(await page.locator('#ai-contact-count').innerText(),/1/);

  await page.locator('.ai-main-tabs [data-ai-nav="settings"]').click();
  await page.locator('[data-ai-nav="default-style"]').click();
  await page.locator('[data-ai-action="open-contact-picker"]').click();
  assert.equal(await page.locator('.ai-contact-picker-dialog [data-picker-kind]').count(),0);
  assert.equal(await page.locator('.ai-contact-picker-dialog [data-picker-id]:checked').count(),1);
  await page.locator('[data-picker-cancel]').first().click();
  assert.equal(await page.locator('.ai-contact-picker-dialog').count(),0);

  await page.locator('.ai-main-tabs [data-ai-nav="analysis"]').click();
  await page.locator('[data-ai-analysis-pick]').click();
  await page.locator('.ai-contact-picker-dialog [data-picker-id]').first().check();
  await page.locator('[data-picker-confirm]').click();
  assert.equal(await page.locator('#ai-analysis-contacts [name=contacts]').count(),1);

  await page.locator('.ai-main-tabs [data-ai-nav="proactive"]').click();
  await page.locator('[data-proactive-new]').click();
  await page.locator('[data-proactive-pick]').click();
  assert.equal(await page.locator('.ap-contact-dialog.ai-contact-picker-dialog').count(),1);
  await page.locator('.ap-contact-dialog [data-picker-id]').first().check();
  await page.locator('[data-picker-confirm]').click();
  assert.match(await page.locator('#ai-proactive-contact-count').innerText(),/1/);
  assert.deepEqual(errors,[]);
  console.log('Shared contact picker passed in learning, default style, analysis and proactive chat');
} finally { await browser.close(); await fixture.close(); }
