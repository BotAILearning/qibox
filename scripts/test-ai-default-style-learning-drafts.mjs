import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {learnedStyle} from '../test/ai-fixtures.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const fixture=await proactiveFixture(),{ai,bridge,provider}=fixture;
const output=pathToFileURL(path.resolve(root,process.env.QIBOX_TEST_OUTPUT||'reports/ai-default-style-learning-drafts')+path.sep);
const proof={scope:'Synthetic production learning UI/API; existing learning requests use only the in-process mock provider',at:new Date().toISOString(),passed:false,realProviderCalls:0,realWechatSends:0,stages:[]};
let browser;
try{
 await fs.mkdir(output,{recursive:true});await ai.saveDefaultStyle({summary:'CONFIRMED_BASE_STYLE'});
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.goto(fixture.url);await page.locator('[data-action=open]').click();await page.locator('#ai-open').click();await page.getByRole('button',{name:'系统设置',exact:true}).click();await page.locator('[data-ai-nav=default-style]').click();
 const summary=()=>page.locator('#ai-default-style-form [name=summary]');
 const untilValue=async value=>page.waitForFunction(expected=>document.querySelector('#ai-default-style-form [name=summary]')?.value===expected,value,{timeout:10000});
 const learned=()=>page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/ai')&&response.request().postDataJSON()?.action==='learn');
 const cancel=async()=>{await page.locator('[data-ai-action=cancel-default-style]').click();await page.locator('dialog.qbx-product-dialog').getByRole('button',{name:'确认',exact:true}).click();await untilValue('CONFIRMED_BASE_STYLE');};
 for(const source of ['paste','contacts']){
   await page.locator(`[data-ai-default-mode=${source}]`).click();
   if(source==='contacts'){
     await page.locator('[data-ai-action=open-contact-picker]').click();await page.locator(`dialog.ai-contact-picker-dialog input[data-picker-id="${bridge.contacts[0].id}"]`).check();await page.locator('[data-picker-confirm]').click();
   }
   const start=async()=>{if(source==='paste')await page.locator('#ai-paste-form [name=text]').fill('我：好的，先休息🙂。\n对方：明天联系。');const response=learned();await page.locator(source==='paste'?'button[form=ai-paste-form]':'[data-ai-action=learn-default]').click();return response;};
   await summary().fill(`OLD_DRAFT_BEFORE_${source}`);let before=provider.calls.length;
   const response=await start();assert.equal(response.status(),200);await untilValue(ai.publicState().learnedDefaultStyle.style.summary);
   assert.notEqual(await summary().inputValue(),`OLD_DRAFT_BEFORE_${source}`);assert.equal(ai.publicState().effectiveDefaultStyle.summary,'CONFIRMED_BASE_STYLE');
   proof.stages.push({source,scenario:'replace submitted old draft with returned candidate',mockProviderCalls:provider.calls.length-before,passed:true});await cancel();
   let entered,release;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
   provider.next=async()=>{entered();await held;return {style:learnedStyle('延迟候选，用于测试')};};
   await summary().fill(`OLD_DRAFT_BEFORE_DELAYED_${source}`);before=provider.calls.length;
   const pending=start();await started;await summary().fill(`NEW_EDIT_DURING_${source}`);release();const delayed=await pending;assert.equal(delayed.status(),200);
   await page.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');assert.equal(await summary().inputValue(),`NEW_EDIT_DURING_${source}`);
   proof.stages.push({source,scenario:'late candidate preserves newer edit',mockProviderCalls:provider.calls.length-before,passed:true});await cancel();
 }
 await summary().fill('KEEP_DRAFT_DURING_REMOTE_LEARNING');const before=provider.calls.length;
 const refreshed=page.waitForResponse(async response=>response.request().method()==='GET'&&/\/ai$/.test(new URL(response.url()).pathname)&&await response.json().then(body=>body.defaultStyleUndoable===true).catch(()=>false));
 await ai.learn({contacts:[bridge.contacts[0].id],asDefault:true});await refreshed;await page.waitForTimeout(200);assert.equal(await summary().inputValue(),'KEEP_DRAFT_DURING_REMOTE_LEARNING');
 proof.stages.push({source:'contacts',scenario:'remote learning preserves local dirty summary',mockProviderCalls:provider.calls.length-before,passed:true});
 const cleared=page.waitForResponse(async response=>response.request().method()==='GET'&&/\/ai$/.test(new URL(response.url()).pathname)&&await response.json().then(body=>body.learnedDefaultStyle===null).catch(()=>false));
 await ai.clearDefaultStyle();await cleared;await page.waitForTimeout(200);assert.equal(await summary().inputValue(),'KEEP_DRAFT_DURING_REMOTE_LEARNING');assert.equal(ai.publicState().effectiveDefaultStyle,null);proof.remoteClearKeepsDirtyDraft=true;
 await page.screenshot({path:fileURLToPath(new URL('remote-clear-keeps-dirty-draft.png',output))});
 proof.mockProviderCalls=provider.calls.length;assert.ok(proof.mockProviderCalls>0);assert.equal(bridge.sent.length,0);proof.passed=true;
}finally{await fs.writeFile(new URL('report.json',output),JSON.stringify(proof,null,2));await browser?.close();await fixture.close();}
console.log(JSON.stringify(proof));
