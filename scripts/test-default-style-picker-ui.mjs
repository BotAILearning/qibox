import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {playwrightPath} from './tooling.mjs';

const {chromium}=createRequire(import.meta.url)(playwrightPath);
const fixture=await proactiveFixture(),browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const output=path.join(process.cwd(),'reports/default-style-picker');await mkdir(output,{recursive:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(fixture.url);
  await page.locator(`[data-instance="${fixture.instance.id}"] summary`).click();
  await page.locator('[data-action="ai"]').click();await page.locator('#ai-open').click();
  await page.locator('.ai-main-tabs [data-ai-nav=settings]').click();
  await page.locator('[data-ai-nav=default-style]').click();
  assert.equal(await page.locator('[data-ai-action=cancel-default-style]').count(),0);
  const columns=await page.evaluate(()=>({left:document.querySelector('.ai-default-result').getBoundingClientRect().x,right:document.querySelector('.ai-default-material').getBoundingClientRect().x}));
  assert.ok(columns.left<columns.right,'current style is on the left');
  await page.locator('[data-ai-action=open-contact-picker]').click();
  assert.equal(await page.locator('.ai-contact-picker-dialog [data-picker-kind]').count(),0);
  await page.locator('.ai-contact-picker-dialog [data-picker-id]').first().check();
  await page.locator('.ai-contact-picker-dialog [data-picker-confirm]').click();
  assert.match(await page.locator('#ai-contact-count').innerText(),/1/);
  await page.locator('input[name=default-perspective][value=other]').check();
  await page.locator('[data-ai-default-range=week]').click();
  assert.equal(await page.locator('input[name=default-perspective][value=other]').isChecked(),true);
  await page.screenshot({path:path.join(output,'contacts-desktop.png')});

  await page.locator('[data-ai-default-mode=paste]').click();
  const paste=page.locator('#ai-paste-form [name=text]');
  await paste.fill('我：周末见面吗？\n对方：可以，周六下午。');
  await page.locator('input[name=default-perspective][value=self]').check();
  assert.match(await paste.inputValue(),/周末见面/,'changing direction retains the paste draft');
  await page.locator('button[form=ai-paste-form]').click();
  await page.locator('#ai-default-style-form').waitFor();
  assert.equal(await page.locator('[data-ai-action=cancel-default-style]').count(),1,'new learning can be cancelled');
  await page.locator('#ai-default-style-form button[type=submit]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-ai-action=cancel-default-style]'));
  await page.screenshot({path:path.join(output,'saved-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile has no horizontal overflow');
  await page.screenshot({path:path.join(output,'saved-mobile.png')});
  assert.deepEqual(errors,[]);
  console.log('Default-style layout, picker, paste draft and save state passed');
}finally{await browser.close();await fixture.close();}
