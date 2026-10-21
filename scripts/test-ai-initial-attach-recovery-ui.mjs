// Faults are injected only at the browser HTTP boundary of a disposable app.
// The backend stays off; no model or WeChat send is allowed by this check.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath),fixture=await proactiveFixture();
const out=path.resolve(root,process.env.QIBOX_TEST_OUTPUT||'reports/ai-initial-attach-recovery');await fs.mkdir(out,{recursive:true});
const proof={at:new Date().toISOString(),scope:'Production browser bundle + real isolated app/API; delayed initial GET and rejected settings writes are HTTP fault injections, not real device/model/Wechat evidence',cases:[],passed:false,realModelRequests:0,mockModelRequests:0,wechatSends:0,sourceSha256:createHash('sha256').update(await fs.readFile(path.join(root,'web/ai-assistant.mjs'))).digest('hex')};
proof.frontendBundleHashes=Object.fromEntries(await Promise.all(['app.js',...(await fs.readdir(path.join(root,'public/chunks'))).filter(name=>name.endsWith('.js')).map(name=>'chunks/'+name)].map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(root,'public',file))).digest('hex')])));
let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 for(const status of [409,500])for(const initialFailure of [false,true]){
  const name=`settings-${status}-late-initial-${initialFailure?'failure':'success'}`,row={name,status,initialFailure,fullReads:0,liveReads:0,settingsRequests:0,passed:false};proof.cases.push(row);
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();let release,entered;const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  page.setDefaultTimeout(10000);
  await page.route(`**/instances/${fixture.instance.id}/ai**`,async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='POST'&&request.postDataJSON()?.action==='settings'){
    row.settingsRequests++;return route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:`fixture settings ${status}`,code:'FIXTURE_REJECTED_SETTINGS'})});
   }
   if(request.method()==='GET'){
    if(url.searchParams.get('view')==='live')row.liveReads++;
    else if(++row.fullReads===1){const response=await route.fetch();entered();await held;return initialFailure?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fixture delayed initial read failed'})}):route.fulfill({response});}
   }
   return route.continue();
  });
  try{
   await page.goto(fixture.url);await page.locator('[data-action=open]').click();await started;
   const toggle=page.locator('#ai-rail [data-ai-setting=enabled]');await toggle.waitFor({state:'visible'});await toggle.check();
   await page.locator('#ai-panel').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#ai-feedback')?.getAttribute('role')==='alert');
   await page.screenshot({path:path.join(out,name+'-loading-after-rejection.png')});release();
   await page.locator('#ai-object-list').waitFor({state:'visible',timeout:8000});
   assert.equal(await toggle.isChecked(),false);assert.equal(fixture.ai.publicState().settings.enabled,false);assert.equal(row.settingsRequests,1);
   assert.equal(await page.locator('#ai-content .ai-entry-loading').count(),0);row.initialLoadingRecovered=true;
   await page.waitForFunction(()=>!document.querySelector('#ai-panel')?.hidden);await page.waitForTimeout(3400);
   assert.ok(row.fullReads>=2);assert.ok(row.liveReads>=1,'Polling must continue after the recovered full state');assert.equal(row.settingsRequests,1,'Recovery may re-read state, never repeat the failed write');
   row.subsequentPollingContinues=true;row.backendAndRailStayOff=true;row.passed=true;
   await page.screenshot({path:path.join(out,name+'-recovered.png')});
  }finally{release();await context.close();}
 }
 assert.equal(fixture.provider.calls.length,0);assert.equal(fixture.bridge.sent.length,0);proof.passed=proof.cases.every(row=>row.passed);assert.equal(proof.passed,true);
}finally{proof.mockModelRequests=fixture.provider.calls.length;proof.wechatSends=fixture.bridge.sent.length;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(proof,null,2));await browser?.close();await fixture.close();}
console.log(JSON.stringify(proof));
