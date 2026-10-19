// Mobile scope updated by explicit user decision on 2026-10-19; original failure retained in baseline evidence.
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';

const {chromium}=createRequire(import.meta.url)(playwrightPath);
const f=await proactiveFixture(),out=path.resolve(root,process.argv[2]||'reports/mobile-scope');
await mkdir(out,{recursive:true});let browser,page;
const report={scope:'Production web with disposable synthetic account and desktop; no NAS, real phone, provider or WeChat delivery',checks:[],errors:[],fullReads:[],masterReads:0,passed:false};
try {
 const calls=f.provider.calls.length;
 browser=await chromium.launch({channel:'msedge',headless:true});
 page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(8000);
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{const u=new URL(r.url());if(r.method()!=='GET')return;if(/\/ai(?:\?|$)/.test(u.pathname+u.search))report.fullReads.push(u.pathname+u.search);if(u.pathname.endsWith('/ai/master'))report.masterReads++;});
 await page.goto(f.url);await page.locator('[data-mobile-ai-master]').waitFor();
 assert.equal(report.fullReads.length,0,'List must not prefetch private workspace state');
 for(const width of [320,390,760]){
  await page.setViewportSize({width,height:844});await page.locator('[data-mobile-ai-master]').waitFor();
  assert.equal(await page.locator('[data-mobile-ai-open]').count(),1);assert.equal(await page.locator('#ai-panel').isVisible(),false);
  assert.ok(await page.locator('.mobile-ai-card [data-mobile-ai-open]').count());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(out,`phone-list-${width}.png`)});
 }
 await page.locator('[data-mobile-ai-master]').first().check();await page.waitForFunction(()=>document.querySelector('[data-mobile-ai-master]')?.checked&&!document.querySelector('[data-mobile-ai-master]')?.disabled);
 assert.equal(f.ai.data.settings.enabled,true);await page.locator('[data-mobile-ai-master]').first().uncheck();await page.waitForFunction(()=>!document.querySelector('[data-mobile-ai-master]')?.checked&&!document.querySelector('[data-mobile-ai-master]')?.disabled);assert.equal(f.ai.data.settings.enabled,false);
 report.checks.push('320/390/760 phone lists preserve explicit workspace entry; master switches persist with lightweight reads.');
 await page.setViewportSize({width:1440,height:1000});await page.locator('[data-action=open]').first().click();await page.locator('#ai-open').click();await page.getByRole('button',{name:'陈小雨',exact:false}).waitFor();report.checks.push('Desktop still opens the full AI workspace and its correct contacts.');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#ai-panel').isVisible(),true);
 for(const [key,title] of [['settings','系统设置'],['proactive','主动聊天'],['activity','执行记录'],['analysis','分析报告'],['overview','自动回复']]){
  await page.locator(`[data-ai-nav=${key}]`).first().click();assert.equal(await page.locator('#ai-title').textContent(),title);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(out,`workspace-${key}-390.png`)});
 }
 await page.locator('#ai-mobile-back').click();await page.locator('#ai-panel').waitFor({state:'hidden'});
 const afterResize=report.fullReads.length;await page.waitForTimeout(5500);assert.equal(report.fullReads.length,afterResize,'Leaving workspace stops full-state reads');
 await page.locator('[data-mobile-ai-open]').first().click();await page.locator('[data-ai-object]').first().waitFor();
 assert.ok(report.fullReads.length>afterResize,'Explicit mobile entry attaches full state');await page.locator('#ai-mobile-back').click();await page.locator('#ai-panel').waitFor({state:'hidden'});
 report.checks.push('User-confirmed complete mobile workspace: five pages reachable, explicit entry reads full state; back stops full polling.');
 const entry=(await f.app.users.get('development')).get(f.instance.id);entry.runtime.loginStatus='logged-out';
 await page.reload();await page.locator('[data-mobile-login]').waitFor();const loginReads=report.fullReads.length;await page.locator('[data-mobile-login]').first().click();await page.locator('#desktop-view.mobile-login-view').waitFor();await page.waitForTimeout(350);assert.equal(await page.locator('#ai-rail').isVisible(),false);assert.equal(report.fullReads.length,loginReads);await page.locator('#mobile-login-back').click();entry.runtime.loginStatus='logged-in';report.checks.push('The synthetic phone login renderer stays available without attaching or reading the full AI workspace. Native scanning is separately unverified.');
 const phone=await browser.newContext({viewport:{width:844,height:390},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'});const landscape=await phone.newPage();let full=0;landscape.on('request',r=>{if(r.method()==='GET'&&/\/ai(?:\?|$)/.test(new URL(r.url()).pathname+new URL(r.url()).search))full++;});await landscape.goto(f.url);await landscape.locator('[data-mobile-ai-master]').waitFor();assert.equal(await landscape.locator('[data-mobile-ai-open]').count(),1);assert.equal(full,0);
 await landscape.locator('[data-mobile-ai-open]').first().click();await landscape.locator('[data-ai-object]').first().waitFor();
 assert.ok(full>0);await landscape.setViewportSize({width:320,height:812});assert.equal(await landscape.locator('#ai-panel').isVisible(),true);
 await phone.close();report.checks.push('Phone user-agent landscape and 320px retain the explicit full workspace; no physical iOS claim.');
 assert.equal(f.provider.calls.length,calls);assert.equal(f.bridge.sent.length,0);assert.deepEqual(report.errors,[]);report.realModelCalls=0;report.realMessages=0;report.passed=true;
}catch(e){report.failure=e.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await f.close();console.log(JSON.stringify(report));}
