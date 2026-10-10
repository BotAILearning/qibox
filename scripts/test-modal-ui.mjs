// Real production page, disposable runtime/data only. No NAS or model service.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {root,playwrightPath} from './tooling.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const out=path.join(root,'reports/modal-ui');await fs.mkdir(out,{recursive:true});
const fixture=await proactiveFixture();let browser,failNextRename=false;
const proof={scope:'Production page and newly disposable synthetic application, no real NAS/model/message',cases:[],errors:[],requests:[],passed:false};
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>proof.errors.push(e.message));
 await page.addInitScript(()=>{
  window.ownedModalFeedback=[];let activated;
  document.addEventListener('submit',event=>{if(event.target.id==='modal-form')activated=performance.now();},true);
  new MutationObserver(records=>{
   if(activated===undefined||!records.some(row=>row.attributeName==='disabled'&&row.target.disabled&&row.target.closest('#modal-form')))return;
   const started=activated;activated=undefined;requestAnimationFrame(()=>window.ownedModalFeedback.push(performance.now()-started));
  }).observe(document,{subtree:true,attributes:true,attributeFilter:['disabled']});
 });
 const providerBefore=fixture.provider.calls.length;
 await page.route('**/api/instances**',async route=>{
  const request=route.request();if(request.method()!=='POST')return route.continue();
  const pathname=new URL(request.url()).pathname;proof.requests.push({path:pathname});
  const failure=failNextRename&&pathname.endsWith('/rename');if(failure)failNextRename=false;
  await new Promise(resolve=>setTimeout(resolve,700));
  if(failure)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'旧弹窗的合成失败'})});
  await route.continue();
 });
 await page.goto(fixture.url);await page.locator('#add-instance').click();await page.locator('input[name=name]').fill('连点合成实例');
 const beforeCreate=proof.requests.length;await page.getByRole('button',{name:'确定',exact:true}).dblclick();await page.locator('#modal').waitFor({state:'hidden'});
 assert.equal(proof.requests.length-beforeCreate,1);await page.getByRole('heading',{name:'连点合成实例',exact:true}).waitFor();proof.cases.push({name:'rapid-create',requests:1,passed:true});
 const space=await fixture.app.users.get('development'),id=[...space.instances.values()].find(x=>x.meta.name==='连点合成实例').meta.id;
 const owned=page.locator(`[data-instance="${id}"]`);
 await owned.locator('.app-menu summary').click();await owned.getByRole('button',{name:'启动设置',exact:true}).click();await page.locator('input[value=continuous]').check();
 const beforeSave=proof.requests.length;await page.getByRole('button',{name:'保存设置',exact:true}).dblclick();await page.locator('#modal').waitFor({state:'hidden'});assert.equal(proof.requests.length-beforeSave,1);proof.cases.push({name:'rapid-schedule-save',requests:1,passed:true});
 await owned.locator('.app-menu summary').click();await owned.getByRole('button',{name:'重命名',exact:true}).click();await page.locator('input[name=name]').fill('合成实例已保存');
 const beforeRename=proof.requests.length;await page.getByRole('button',{name:'确定',exact:true}).dblclick();await page.locator('#modal').waitFor({state:'hidden'});assert.equal(proof.requests.length-beforeRename,1);await page.getByRole('heading',{name:'合成实例已保存',exact:true}).waitFor();proof.cases.push({name:'rapid-rename',requests:1,passed:true});
 for(const outcome of ['success','failure'])for(const dismissal of ['cancel','escape','header-close']){
  await owned.locator('.app-menu summary').click();await owned.getByRole('button',{name:'重命名',exact:true}).click();await page.locator('input[name=name]').fill('延迟保存-'+outcome+'-'+dismissal);
  failNextRename=outcome==='failure';const before=proof.requests.length;await page.getByRole('button',{name:'确定',exact:true}).click();
  assert.equal(await page.locator('#modal-pending').isVisible(),true);assert.match(await page.locator('#modal-pending').innerText(),/关闭窗口后仍会继续/);
  if(dismissal==='cancel')await page.locator('#modal-actions').getByRole('button',{name:'关闭',exact:true}).click();
  else if(dismissal==='header-close')await page.locator('#modal-close').click();
  else await page.keyboard.press('Escape');
  await page.locator('#add-instance').click();const draft='新弹窗未保存草稿-'+outcome+'-'+dismissal;await page.locator('input[name=name]').fill(draft);
  await page.waitForTimeout(1200);assert.equal(await page.locator('#modal').isVisible(),true);assert.equal(await page.locator('input[name=name]').inputValue(),draft);assert.equal(await page.locator('#modal-error').isVisible(),false);assert.equal(await page.locator('#modal-pending').isVisible(),false);assert.equal(await page.locator('#modal-form').getAttribute('aria-busy'),'false');assert.equal(proof.requests.length-before,1);
  await page.screenshot({path:path.join(out,`${outcome}-${dismissal}.png`)});proof.cases.push({name:'late-'+outcome+'-after-'+dismissal,requests:1,newDraftPreserved:true,newErrorUnchanged:true,passed:true});await page.getByRole('button',{name:'取消',exact:true}).click();
 }
 await owned.locator('.app-menu summary').click();await owned.getByRole('button',{name:'删除',exact:true}).click();
 const beforeDelete=proof.requests.length;await page.locator('#modal-actions').getByRole('button',{name:'删除',exact:true}).dblclick();await page.locator('#modal').waitFor({state:'hidden'});await owned.waitFor({state:'detached'});assert.equal(proof.requests.length-beforeDelete,1);assert.ok(space.catalog.some(x=>x.id===id&&x.removedAt));proof.cases.push({name:'rapid-preserve-data-remove',requests:1,passed:true});
 proof.submitFeedbackPaintMs=await page.evaluate(()=>window.ownedModalFeedback);assert.ok(proof.submitFeedbackPaintMs.length>=10);assert.ok(proof.submitFeedbackPaintMs.every(ms=>ms<=100),'Every observed form submission must paint its disabled feedback within 100ms');
 assert.equal(fixture.provider.calls.length,providerBefore);assert.equal(fixture.bridge.sent.length,0);assert.deepEqual(proof.errors,[]);proof.realModelCalls=0;proof.realMessages=0;proof.passed=true;
}catch(e){proof.failure=e.stack;process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(proof,null,2));await browser?.close();await fixture.close();console.log(JSON.stringify(proof));}
