import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {root,playwrightPath} from './tooling.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const out=path.resolve(root,process.argv[2]||'reports/startup');await mkdir(out,{recursive:true});
const fixture=await proactiveFixture();let browser;
const report={scope:'Isolated production frontend; no real WeChat or model service',passed:false,checks:[],errors:[],initialDeferredRequests:[]};
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>report.errors.push(e.message));
 let initial=true;
 page.on('request',r=>{if(initial&&/\/chunks\/desktop-runtime-|\/ai-workspace\.css/.test(r.url()))report.initialDeferredRequests.push(new URL(r.url()).pathname);});
 let unblock;
 const unavailable=new Promise(resolve=>unblock=resolve);
 const waitForFeature=async route=>{await unavailable;await route.continue();};
 await page.route('**/chunks/desktop-runtime-*.js',waitForFeature);
 await page.route('**/ai-workspace.css*',waitForFeature);
 try {
   await page.goto(fixture.url,{waitUntil:'commit'});
   await page.locator('[data-action=open]').waitFor({timeout:2000});
 } finally {
   unblock();await page.unroute('**/chunks/desktop-runtime-*.js',waitForFeature);await page.unroute('**/ai-workspace.css*',waitForFeature);
 }
 await page.screenshot({path:path.join(out,'home.png')});
 report.entryBytes=await page.evaluate(()=>performance.getEntriesByType('resource').find(r=>new URL(r.name).pathname.endsWith('/app.js'))?.decodedBodySize);
 initial=false;
 assert.deepEqual(report.initialDeferredRequests,[],'Home must not download or execute desktop/AI resources before they are opened');
 assert.ok(report.entryBytes<100000,'The startup entry must stay below 100 kB decoded');
 report.checks.push('The homepage becomes usable within two seconds even while desktop/AI resource requests are held unavailable; it downloads neither feature.');
 const heavy=[];page.on('request',r=>{if(/\/chunks\/desktop-runtime-|\/ai-workspace\.css/.test(r.url()))heavy.push(new URL(r.url()).pathname);});
 await page.locator('[data-action=open]').click();await page.locator('#ai-open').waitFor();
 assert.ok(heavy.some(p=>p.endsWith('/ai-workspace.css')));assert.ok(heavy.some(p=>p.includes('/chunks/')));
 await page.locator('#ai-open').click();await page.locator('#ai-panel').waitFor({state:'visible'});await page.locator('[data-ai-nav=overview]').waitFor();
 await page.screenshot({path:path.join(out,'ai.png')});
 report.checks.push('First desktop open loads the runtime and stylesheet, then the existing AI workbench opens.');
 await page.locator('#ai-close').click();await page.locator('#desktop-back').click();
 const after=heavy.length;await page.locator('[data-action=open]').click();await page.locator('#ai-open').waitFor();
 assert.equal(heavy.length,after,'Reopening must reuse the loaded runtime and stylesheet');
 report.checks.push('Reopening reuses the runtime and stylesheet.');
 await page.close();
 for(const expire of [false,true]){
  const delayed=await browser.newPage({viewport:{width:1280,height:900}});let release,seen,starts=0,runtimeUrl;
  const gate=new Promise(r=>release=r),requested=new Promise(r=>seen=r);
  delayed.on('pageerror',e=>report.errors.push(e.message));delayed.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/start'))starts++;});
  await delayed.route('**/chunks/desktop-runtime-*.js',async route=>{runtimeUrl=route.request().url();seen();await gate;await route.continue();});
  try{
   await delayed.goto(fixture.url);await delayed.locator('[data-action=open]').click();await requested;
   if(expire){await delayed.route('**/api/state',r=>r.fulfill({status:200,contentType:'text/plain',body:'invalid token'}));await delayed.evaluate(()=>window.dispatchEvent(new Event('online')));await delayed.locator('#connection-error').filter({hasText:'飞牛登录已失效'}).waitFor();}
   else await delayed.locator('#desktop-back').click();
   release();await delayed.evaluate(url=>import(url).then(()=>true),runtimeUrl);
   await delayed.locator('link[data-desktop-style]').evaluate(link=>link.sheet?true:new Promise(resolve=>link.addEventListener('load',()=>resolve(true),{once:true})));
   await delayed.waitForFunction(()=>document.querySelector('#desktop-view').hidden&&document.querySelector('#ai-panel').hidden);
   assert.equal(starts,0,'A cancelled or expired desktop load must not start the instance');assert.equal(await delayed.locator('#remote-canvas canvas').count(),0);
   report.checks.push(expire?'Session expiry during deferred loading cannot revive the desktop or start the instance.':'Returning home during deferred loading cancels the pending open without a late connection.');
  }finally{release();await delayed.close();}
 }
 const retry=await browser.newPage({viewport:{width:1280,height:900}});let rejectStyle=true;
 retry.on('pageerror',e=>report.errors.push(e.message));
 await retry.route('**/ai-workspace.css*',route=>rejectStyle?route.abort('failed'):route.continue());
 await retry.goto(fixture.url);await retry.locator('[data-action=open]').click();await retry.locator('#toast').filter({hasText:'组件未能加载'}).waitFor();
 assert.equal(await retry.locator('#remote-canvas canvas').count(),0);await retry.locator('#desktop-back').click();rejectStyle=false;
 await retry.locator('[data-action=open]').click();await retry.locator('#ai-open').waitFor();await retry.close();
 report.checks.push('A failed stylesheet reports an actionable error and a new desktop open can recover.');
 assert.equal(fixture.bridge.sent.length,0);assert.equal(fixture.provider.calls.length,0);assert.deepEqual(report.errors,[]);
 report.passed=true;
}finally{await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await fixture.close();}
console.log(JSON.stringify(report));
