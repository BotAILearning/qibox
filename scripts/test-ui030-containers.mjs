import {createRequire} from 'node:module';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {root,playwrightPath} from './tooling.mjs';import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath),out=path.resolve(root,process.argv[2]||'reports/ui030-containers');await fs.mkdir(out,{recursive:true});
const f=await proactiveFixture(),browser=await chromium.launch({channel:'msedge',headless:true}),report={scope:'Actual product at constrained content containers in a desktop browser; disposable synthetic data, no device claim',checks:[],passed:false};
try {
 f.ai.data.proactiveTasks=['running','paused','failed','ended'].map((status,i)=>({id:randomUUID(),account:f.ai.data.account,name:'容器边界长任务名称与错误恢复验证'+i,status,revision:1,contacts:[{id:f.bridge.contacts[0].id,label:'测试联系人'}],goal:'这是一条用于验证窄容器换行的完整聊天目标。',schedule:{cycle:'once'},createdAt:Date.now()+i,lastError:status==='failed'?'合成服务超时，请检查连接并保留原目标。':undefined}));await f.ai.save();
 const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(f.url);await page.locator('[data-action=open]').first().click();await page.locator('#ai-open').click();
 const nav=async key=>page.locator(`.ai-main-tabs [data-ai-nav=${key}]`).click();
 const cases=[
  ['object','.ai-object-detail',[439,440,583,584,679,680],async()=>{await nav('overview');await page.locator('[data-ai-object]').first().click();}],
  ['provider','.ai-model-workspace',[599,600],async()=>{await nav('settings');await page.locator('.qbx-settings-links [data-ai-nav=provider]').click();}],
  ['activity','.ai-activity-page',[459,460,759,760,899,900],()=>nav('activity')],
  ['proactive','.ai-proactive-page',[619,620,919,920],()=>nav('proactive')],
  ['default-style','.ai-default-material',[449,450],async()=>{await nav('settings');await page.locator('.qbx-settings-links [data-ai-nav=default-style]').click();}],
  ['learning','.ai-page-body',[619,620,879,880],async()=>{await nav('overview');await page.locator('[data-ai-nav=learning]').click();}]
 ];
 for(const theme of ['light','dark'])for(const [name,selector,widths,open]of cases)for(const width of widths){
  await open();await page.locator('html').evaluate((n,t)=>n.dataset.qiTheme=t,theme);
  await page.locator(selector).evaluate((n,w)=>{n.style.width=w+'px';n.style.maxWidth='none';},width);await page.waitForTimeout(150);
  const state=await page.locator(selector).evaluate(n=>{const r=n.getBoundingClientRect();const outside=[...n.querySelectorAll('button,input,select,textarea')].filter(x=>x.getClientRects().length&&x.getBoundingClientRect().width&&getComputedStyle(x).visibility!=='hidden').map(x=>({name:x.getAttribute('aria-label')||x.name||x.textContent.trim().slice(0,24),left:x.getBoundingClientRect().left,right:x.getBoundingClientRect().right})).filter(x=>x.left<r.left-1||x.right>r.right+1);return{actualWidth:r.width,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,outside,containerName:getComputedStyle(n).containerName};});
  report.checks.push({name,width,theme,...state});await page.screenshot({path:path.join(out,`${name}-${width}-${theme}.png`)});
  assert.ok(Math.abs(state.actualWidth-width)<=1);assert.ok(state.scrollWidth<=state.clientWidth,JSON.stringify(report.checks.at(-1)));assert.deepEqual(state.outside,[],JSON.stringify(report.checks.at(-1)));
 }
 report.passed=true;
}catch(e){report.failure=e.stack;throw e;}finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();await f.close();}
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length}));
