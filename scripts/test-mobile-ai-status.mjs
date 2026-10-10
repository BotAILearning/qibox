import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const src=path.resolve(import.meta.dirname,'..');
const load=name=>import(pathToFileURL(path.join(src,name)).href);
const {root,playwrightPath}=await load('scripts/tooling.mjs');
const {createApplication}=await load('server/index.mjs');
const {temp,cleanup,runtimeFactory,extractor,fetcher,packageSha256}=await load('test/fixtures.mjs');
const {ChatFixture,AIModelFixture,modelConfig}=await load('test/ai-fixtures.mjs');
const {chromium}=createRequire(path.join(src,'package.json'))(playwrightPath);
const dataRoot=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();
const output=pathToFileURL(path.resolve(root,process.argv[2]||'reports/mobile-ai-status-ui')+path.sep);await mkdir(output,{recursive:true});
const report={at:new Date().toISOString(),scope:'Production web bundle with disposable server, synthetic account and provider; no live device, actual model request or real WeChat send.',checks:[],observed:{}};
let app,browser;
try{
 app=await createApplication({appRoot:root,dataRoot,dev:true,fetcher,extract:extractor,trustedHashes:[packageSha256],aiProvider:provider,runtimeFactory:(...args)=>({...runtimeFactory(...args),aiBridge:bridge,loginStatus:'logged-in'})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const space=await app.users.get('development');await space.setConsent(true);app.library.download();await app.library.working;
 const meta=await space.add('合成开关状态测试');await space.start(meta.id);const entry=space.get(meta.id),ai=entry.ai;
 await ai.configure(modelConfig);await ai.scan();await ai.settings({enabled:true});
 const base=`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`;
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let mode='hold',reads=0,release,started,failedRead;
 const startedPromise=new Promise(resolve=>started=resolve);
 let failureStarted=new Promise(resolve=>failedRead=resolve);
 await page.route(`**/api/instances/${meta.id}/ai/master`,async route=>{
  reads++;
  if(mode==='hold'){await new Promise(resolve=>{release=resolve;started();});return route.continue();}
  if(mode==='failure'){failedRead();return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成读取失败'})});}
  return route.continue();
 });
 page.setDefaultTimeout(5000);await page.goto(base);await Promise.race([startedPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Master read did not start within 5 seconds')),5000))]);
 report.observed.loadingHasSwitch=await page.locator('[data-mobile-ai-master]').count()>0;
 report.observed.loadingText=await page.locator('#mobile-ai-list').innerText();
 await page.screenshot({path:fileURLToPath(new URL('loading.png',output))});
 mode='pass';release();await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked===true&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 report.checks.push('Saved ON readback observed. Loading state evaluated separately.');
 mode='failure';await page.reload();await Promise.race([failureStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('Failure request did not start within 5 seconds')),5000))]);
 await page.getByText('暂时无法读取开关',{exact:true}).waitFor();
 const failedAtReads=reads;await page.waitForTimeout(6200);
 report.observed.failureReadDelta=reads-failedAtReads;
 report.observed.failureHasSwitch=await page.locator('[data-mobile-ai-master]').count()>0;
 report.observed.failureText=await page.locator('#mobile-ai-list').innerText();
 for(const width of [320,390,760]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:fileURLToPath(new URL('failed.png',output))});
 mode='pass';if(await page.locator('[data-mobile-ai-retry]').count())await page.locator('[data-mobile-ai-retry]').click();
 await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked===true&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 report.checks.push('Failed read stops immediate retries; explicit retry reads the saved ON without any POST.');
 let writes=0,unknownSave=false;await page.route(`**/api/instances/${meta.id}/ai`,async route=>{
  if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='mobile-master'){
   writes++;
   if(unknownSave){unknownSave=false;await route.fetch();return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成保存结果未知'})});}
  }
  return route.continue();
 });
 await page.locator('[data-mobile-ai-master]').uncheck();
 await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked===false&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 assert.equal(ai.data.settings.enabled,false);
 await page.locator('[data-mobile-ai-master]').check();
 await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked===true&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 assert.equal(ai.data.settings.enabled,true);assert.equal(writes,2);
 report.checks.push('Normal OFF and ON saves each submit once, then read back real saved state.');
 unknownSave=true;await page.locator('[data-mobile-ai-master]').uncheck();
 await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked===false&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 await page.waitForTimeout(300);assert.equal(ai.data.settings.enabled,false);assert.equal(writes,3);
 await page.locator('[data-mobile-ai-master]').check();await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked===true&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 assert.equal(ai.data.settings.enabled,true);assert.equal(writes,4);
 report.checks.push('A save that reached the server but returned an error reads actual state and never repeats the POST.');
 failureStarted=new Promise(resolve=>failedRead=resolve);mode='failure';await page.reload();await Promise.race([failureStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('Second failure read did not start')),5000))]);
 await page.getByText('暂时无法读取开关',{exact:true}).waitFor();
 mode='pass';await page.context().setOffline(true);await page.context().setOffline(false);
 await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked===true&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 assert.equal(writes,4);report.checks.push('An actual offline-to-online browser transition resumes reading saved ON, without a write.');
 await page.emulateMedia({reducedMotion:'reduce'});
 report.observed.reducedMotion=await page.locator('[data-mobile-ai-master]').evaluate(el=>({matches:matchMedia('(prefers-reduced-motion:reduce)').matches,switchDuration:getComputedStyle(el).transitionDuration,thumbDuration:getComputedStyle(el,'::before').transitionDuration}));
 assert.equal(report.observed.reducedMotion.matches,true);
 for(const duration of [report.observed.reducedMotion.switchDuration,report.observed.reducedMotion.thumbDuration])assert.ok(duration.split(',').every(part=>parseFloat(part)===0),'Reduced motion disables both switch and thumb transitions');
 report.checks.push('The real reduced-motion media preference disables both master-switch and thumb transitions.');
 entry.runtime.loginStatus='logged-out';await page.reload();await page.getByText('微信登录后可用',{exact:true}).waitFor({timeout:2500}).catch(()=>{});
 report.observed.loggedOutHasSwitch=await page.locator('[data-mobile-ai-master]').count()>0;
 report.observed.loggedOutText=await page.locator('#mobile-ai-list').innerText();
 await page.screenshot({path:fileURLToPath(new URL('logged-out.png',output))});
 report.observed.actualSavedEnabled=ai.data.settings.enabled;
 report.observed.syntheticMasterWrites=writes;
 assert.equal(report.observed.loadingHasSwitch,false,'No OFF switch before settings arrive');
 assert.equal(report.observed.failureHasSwitch,false,'No OFF switch after failed reading');
 assert.equal(report.observed.failureReadDelta,0,'No immediate automatic read storm after failed reading');
 assert.equal(report.observed.loggedOutHasSwitch,false,'No OFF switch when login is unavailable');
 assert.equal(report.observed.actualSavedEnabled,true);assert.equal(bridge.sent.length,0);assert.deepEqual(errors,[]);
 report.checks.push('Logged-out state describes unavailability; saved ON stays unchanged.');report.passed=true;
}catch(error){report.failure=error.stack;report.passed=false;process.exitCode=1;}
finally{await writeFile(new URL('report.json',output),JSON.stringify(report,null,2)+'\n');await browser?.close();if(app){await new Promise(resolve=>app.server.close(resolve));await app.close();}await cleanup(dataRoot);console.log(JSON.stringify(report,null,2));}
