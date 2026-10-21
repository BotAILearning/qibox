import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';

const {chromium}=createRequire(import.meta.url)(playwrightPath),f=await proactiveFixture(),{ai,provider,bridge}=f,save=ai.save;
const out=path.resolve(root,process.env.QIBOX_TEST_OUTPUT||'reports/ai-personal-sharing-recovery');await fs.mkdir(out,{recursive:true});
const files=['web/ai-assistant.mjs','web/ai-account-settings.mjs','server/ai-account-configuration.mjs','server/ai-configuration-commit.mjs','server/ai-service.mjs','public/app.js'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')])));
const proof={at:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),build:JSON.parse(await fs.readFile(path.join(root,'config/product.json'))).buildId,environment:{platform:process.platform,node:process.version},scope:'Production browser and API in isolated synthetic data; real filesystem rename failure, exact source hashes include any uncommitted repairs, no real model/WeChat',passed:false,realProviderCalls:0,simulatedProviderCalls:0,sends:0,sourceBefore:await hashes()};
let browser,context,release;
const settled=p=>p.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');
try{
 await ai.configuration({type:'personal-information',entries:[{id:'public-city',field:'city',text:'合成公开城市',allowGroup:true},{id:'private-city',field:'city',text:'合成私聊地点',allowGroup:false},{id:'private-work',field:'occupation',text:'合成原职业',allowGroup:false}]});
 browser=await chromium.launch({channel:'msedge',headless:true});proof.environment.browser=browser.version();context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();page.setDefaultTimeout(10000);
 await page.goto(f.url);await page.locator('[data-action=open]').click();await page.locator('#ai-open').click();await page.getByRole('button',{name:'系统设置',exact:true}).click();await page.locator('[data-ai-nav=personal-info]').click();
 const city=page.locator('[data-personal-field=city]'),job=page.locator('[data-personal-field=occupation]'),button=page.locator('#ai-personal-information-form button[type=submit]');
 assert.equal(await city.locator('[data-personal-share]').evaluate(node=>node.indeterminate),true);
 proof.before=structuredClone(ai.publicState().personalInformation);
 await city.locator('summary strong').click();await city.locator('[data-personal-input]').fill('合成公开城市\n合成私聊地点\n新增合成私聊地点🙂');await job.locator('summary strong').click();await job.locator('[data-personal-input]').fill('合成修改职业');
 const entered=Promise.withResolvers(),held=Promise.withResolvers(),file=ai.file,blocked=path.join(f.dataRoot,'blocked-personal-json');await fs.mkdir(blocked);let first=true;release=()=>held.resolve();
 ai.save=function(...args){if(!first)return save.apply(this,args);first=false;entered.resolve();return held.promise.then(async()=>{this.file=blocked;try{return await save.apply(this,args);}finally{this.file=file;}});};
 const failed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/ai')&&r.request().postDataJSON()?.value?.type==='personal-information');await button.click();await entered.promise;
 const background=ai.save();release();assert.equal((await failed).status(),500);await background;await settled(page);ai.save=save;
 proof.afterFailure=structuredClone(ai.publicState().personalInformation);assert.deepEqual(proof.afterFailure,proof.before);
 const disk=JSON.parse(await fs.readFile(file,'utf8'));proof.persistedAfterFailure=ai.vault.open(disk.personalInformation[ai.data.account]);assert.deepEqual(proof.persistedAfterFailure.entries,proof.before.entries);
 assert.equal(await city.locator('[data-personal-input]').inputValue(),'合成公开城市\n合成私聊地点\n新增合成私聊地点🙂');await page.screenshot({path:path.join(out,'01-real-write-failure-draft-preserved.png')});
 await page.getByRole('button',{name:'系统设置',exact:true}).click();await page.locator('[data-ai-nav=personal-info]').click();assert.equal(await city.locator('[data-personal-input]').inputValue(),'合成公开城市\n合成私聊地点\n新增合成私聊地点🙂');assert.equal(await job.locator('[data-personal-input]').inputValue(),'合成修改职业');
 const retried=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/ai')&&r.request().postDataJSON()?.value?.type==='personal-information');await button.click();assert.equal((await retried).status(),200);await settled(page);
 proof.afterRetry=structuredClone(ai.publicState().personalInformation);const cities=proof.afterRetry.entries.filter(row=>row.field==='city');assert.equal(cities.find(row=>row.text==='合成公开城市').allowGroup,true);assert.equal(cities.find(row=>row.text==='合成私聊地点').allowGroup,false);assert.equal(cities.find(row=>row.text==='新增合成私聊地点🙂').allowGroup,false);assert.equal(await city.locator('[data-personal-share]').evaluate(node=>node.indeterminate),true);await page.screenshot({path:path.join(out,'02-explicit-retry-mixed-sharing-preserved.png')});
 assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);proof.passed=true;
}catch(error){proof.error=error.stack;throw error;
}finally{release?.();ai.save=save;proof.simulatedProviderCalls=provider.calls.length;proof.sends=bridge.sent.length;proof.sourceAfter=await hashes();proof.sourcesUnchanged=JSON.stringify(proof.sourceBefore)===JSON.stringify(proof.sourceAfter);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(proof,null,2));await context?.close();await browser?.close();await f.close();}
console.log(JSON.stringify({passed:proof.passed,simulatedProviderCalls:proof.simulatedProviderCalls,realProviderCalls:0,sends:proof.sends,sourcesUnchanged:proof.sourcesUnchanged}));
