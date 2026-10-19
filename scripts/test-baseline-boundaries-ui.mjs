import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath),f=await proactiveFixture();
const out=path.join(root,'local/stable-baseline-20261019/boundaries');await mkdir(out,{recursive:true});
const report={scope:'Actual product forms in isolated browser, explicit container widths and simulated coarse pointer; no physical device claim',checks:[],passed:false};let browser,page;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(6000);
 await f.ai.setReplyOptions({contact:f.bridge.contacts[0].id,enabled:true});
 await page.goto(f.url);await page.locator('[data-action=open]').first().click();await page.locator('#ai-open').click();await page.locator('[data-ai-object]').first().click();
 await page.locator('[data-ai-optional=reply-strategy] summary').click();
 for(const width of [520,583,584,585,599,600,879,880]){
  await page.locator('.ai-object-detail').evaluate((n,w)=>{n.style.boxSizing='content-box';n.style.width=w+'px';n.style.maxWidth='none';},width);
  const grid=await page.locator('.ai-reference-strategy-fields').evaluate(n=>({columns:getComputedStyle(n).gridTemplateColumns.split(' ').length,overflow:n.scrollWidth-n.clientWidth}));
  assert.equal(grid.columns,width>=584?2:1,`Related fields follow actual container ${width}`);assert.ok(grid.overflow<=1);
  report.checks.push({container:width,...grid});
 }
 await page.locator('.ai-object-detail').evaluate(n=>n.removeAttribute('style'));
 await page.locator('[data-ai-nav=settings]').first().click();await page.locator('[data-ai-nav=default-style]').click();
 for(const width of [320,375,520,639,640]){
  await page.setViewportSize({width,height:812});
  const labels=await page.locator('.ai-default-source-tabs button small').evaluateAll(ns=>ns.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,owner:n.closest('button').getBoundingClientRect().width,text:n.textContent})));
  assert.equal(labels.length,2);assert.ok(labels.every(n=>n.width>=120&&n.height<120),`Source descriptions cannot collapse into vertical text: ${JSON.stringify(labels)}`);
  await page.screenshot({path:path.join(out,`default-source-${width}.png`)});
 }
 report.checks.push('Source descriptions remain in the text column at320/375/520/639/640; no single-character vertical collapse');
 await page.setViewportSize({width:1440,height:900});await page.locator('[data-ai-nav=settings]').first().click();
 const density=await page.locator('#ai-takeover-form button[type=submit]').evaluate(n=>n.getBoundingClientRect().height);assert.equal(density,32);
 const context=await browser.newContext({hasTouch:true,viewport:{width:1440,height:900},reducedMotion:'reduce'});
 const touch=await context.newPage();await touch.goto(f.url);await touch.locator('[data-action=open]').first().click();await touch.locator('#ai-open').click();await touch.locator('[data-ai-nav=settings]').first().click();
 assert.equal(await touch.locator('#ai-takeover-form button[type=submit]').evaluate(n=>n.getBoundingClientRect().height),44);
 const switches=await touch.locator('#ai-takeover-form input[role=switch]').evaluateAll(ns=>ns.map(n=>({w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height,transition:getComputedStyle(n,'::before').transitionDuration})));
 assert.ok(switches.every(n=>n.w>=44&&n.h>=44&&n.transition.split(',').every(v=>parseFloat(v)===0)));
 await touch.screenshot({path:path.join(out,'mixed-touch-1440.png')});await context.close();
 await page.locator('#ai-takeover-form button[type=submit]').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
 assert.equal(await page.locator('#ai-takeover-form button[type=submit]').evaluate(n=>document.activeElement===n),true);
 report.checks.push('1440px mouse compact32, mixed-pointer touch44 with44x44 switches, reduced motion, and Tab/ShiftTab focus path');
 report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));await browser?.close();await f.close();console.log(JSON.stringify(report));}
