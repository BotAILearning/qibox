import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath),out=path.resolve(root,process.argv[2]||'reports/ui030-pages');await fs.mkdir(out,{recursive:true});
const fixture=await proactiveFixture(),browser=await chromium.launch({channel:'msedge',headless:true}),report={scope:'Actual product with disposable data, synthetic model and desktop fixture; no NAS or phone claim',checks:[],errors:[],passed:false};
let page;
try {
 page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));await page.goto(fixture.url);await page.locator('[data-action=open]').first().click();await page.locator('#ai-open').click();
 const nav=async key=>{if(await page.locator('.qibox-workspace-menu > summary').isVisible()&&await page.locator('.qibox-workspace-menu').getAttribute('open')===null)await page.locator('.qibox-workspace-menu > summary').click();await page.locator(`.ai-main-tabs [data-ai-nav=${key}]`).click();await page.waitForFunction(()=>document.querySelector('#ai-panel').getAttribute('aria-busy')!=='true');};
 const object=async section=>{await nav('overview');if(await page.locator('[data-ai-object]').first().isVisible())await page.locator('[data-ai-object]').first().click();await page.locator(`[data-ai-object-section=${section}]`).click();};
 const setting=async key=>{await nav('settings');await page.locator(`.qbx-settings-links [data-ai-nav="${key}"]`).click();};
 const cases=[
  ['overview',async()=>{await nav('overview');if(await page.locator('#ai-mobile-back').isVisible()&&await page.locator('#ai-mobile-back').getAttribute('aria-label')==='返回对象列表')await page.locator('#ai-mobile-back').click();}],['object-reply',()=>object('reply')],['object-style',()=>object('style')],['object-memory',()=>object('memory')],
  ['settings',()=>nav('settings')],['provider',()=>setting('provider')],['model-editor',async()=>{await setting('provider');await page.locator('[data-ai-action=model-add]').click();}],
  ['personal',()=>setting('personal-info')],['global-reply',()=>setting('global-reply')],['default-style',()=>setting('default-style')],['learning',async()=>{await nav('overview');if(!await page.locator('[data-ai-nav=learning]').isVisible())await page.locator('#ai-mobile-back').click();await page.locator('[data-ai-nav=learning]').click();}],
  ['proactive',()=>nav('proactive')],['task-editor',async()=>{await nav('proactive');await page.locator('[data-proactive-new]').click();}],
  ['activity',()=>nav('activity')],['analysis',()=>nav('analysis')],['contact-picker',async()=>{await nav('analysis');await page.locator('[data-ai-analysis-pick]').click();}]
 ];
 const initialCalls=fixture.provider.calls.length;
 for(const [width,height]of [[1280,800],[1440,900],[375,812],[320,812]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.locator('html').evaluate((n,t)=>n.dataset.qiTheme=t,theme);
  for(const [name,open]of cases.filter(([name])=>!process.env.QIBOX_UI030_CASES||process.env.QIBOX_UI030_CASES.split(',').includes(name))){
   await open();await page.waitForTimeout(250);
   const state=await page.locator('#ai-content').evaluate(n=>{const r=n.getBoundingClientRect();const outside=[...n.querySelectorAll('button,input,select,textarea')].filter(x=>x.getClientRects().length&&x.getBoundingClientRect().width&&getComputedStyle(x).visibility!=='hidden').map(x=>({name:x.getAttribute('aria-label')||x.name||x.textContent.slice(0,50),left:x.getBoundingClientRect().left,right:x.getBoundingClientRect().right})).filter(x=>x.left<r.left-1||x.right>r.right+1);return{overflow:n.scrollWidth>n.clientWidth,content:{left:r.left,right:r.right,width:r.width},outside,view:document.querySelector('#ai-panel').dataset.page};});
   await page.screenshot({path:path.join(out,`${name}-${width}-${theme}.png`)});report.checks.push({name,width,height,theme,...state});assert.equal(state.overflow,false,JSON.stringify(report.checks.at(-1)));assert.deepEqual(state.outside,[],JSON.stringify(report.checks.at(-1)));
   if(name==='model-editor')assert.deepEqual(await page.locator('#ai-content').evaluate(n=>({scrollTop:n.scrollTop,focus:document.activeElement.id})),{scrollTop:0,focus:'ai-model-preset'});
   if(name==='contact-picker')await page.locator('.ai-contact-picker-dialog[open]').press('Escape');
   if(name==='task-editor')await page.locator('[data-proactive-cancel]').click();
   if(name==='model-editor'){if(await page.locator('[data-ai-action=model-cancel]').isVisible())await page.locator('[data-ai-action=model-cancel]').click();else await page.locator('#ai-mobile-back').click();assert.equal(await page.locator('[data-ai-action=model-add]').evaluate(n=>n===document.activeElement),true);}
  }
 }
 assert.equal(fixture.provider.calls.length,initialCalls,'navigation must not generate model requests');assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.failure=e.stack;throw e;}finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();await fixture.close();}
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length}));
