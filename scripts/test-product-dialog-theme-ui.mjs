// Production dialog module + pinned production styles in a disposable browser
// fixture. Opening, keyboard, cancellation and callbacks are real DOM behavior.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath),fixture=await proactiveFixture();
const output=path.resolve(root,process.env.QIBOX_TEST_OUTPUT||'reports/product-dialog-theme');await fs.mkdir(output,{recursive:true});
const source=process.env.QIBOX_DIALOG_PRE_FIX?execFileSync('git',['show','1f077a4:web/dialogs.mjs'],{cwd:root,encoding:'utf8'}):await fs.readFile(path.join(root,'web/dialogs.mjs'),'utf8');
const proof={scope:'Actual production dialog source + pinned product CSS, isolated synthetic test surface; no real account/model/WeChat',at:new Date().toISOString(),preFix:!!process.env.QIBOX_DIALOG_PRE_FIX,baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dialogSourceSha256:createHash('sha256').update(source).digest('hex'),cases:[],passed:false,realProviderCalls:0,mockProviderCalls:0,wechatSends:0};let browser;
const lum=rgb=>{const c=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};
const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 for(const width of [1280,320])for(const colorScheme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:844},colorScheme,hasTouch:width===320,isMobile:width===320}),page=await context.newPage();
  await page.route('**/qa-dialog.mjs',route=>route.fulfill({contentType:'text/javascript',body:source}));await page.goto(fixture.url);
  if(width===320)await page.locator('[data-mobile-ai-open]').click();else{await page.locator('[data-action=open]').click();await page.locator('#ai-open').click();}await page.locator('#ai-panel').waitFor({state:'visible'});
  await page.evaluate(async()=>{const {productDialog}=await import(new URL('qa-dialog.mjs',location.href));const origin=document.createElement('button');origin.className='qi-btn';origin.dataset.variant='secondary';origin.id='qa-dialog-origin';origin.textContent='隔离确认框验收';origin.style.cssText='position:fixed;left:16px;top:16px;z-index:99';origin.addEventListener('click',()=>{window.qaDialogResult='pending';window.qaController=new AbortController();productDialog({...window.qaDialogOptions,signal:window.qaController.signal}).then(result=>window.qaDialogResult=result);});document.body.append(origin);});
  const result={width,colorScheme,contrastPassed:true,checks:[],samples:[]};proof.cases.push(result);
  const open=async options=>{await page.evaluate(value=>window.qaDialogOptions=value,options);await page.locator('#qa-dialog-origin').click();await page.locator('dialog.qbx-product-dialog').waitFor();};
  for(const danger of [false,true]){
   await open({title:danger?'确认删除？':'取消本次学习？',message:('取消只影响当前候选，已有联系人设置会保留；请核对本次操作范围。').repeat(width===320?8:3),danger,confirm:danger?'确认删除':'确认'});
   const samples=await page.evaluate(async()=>{const rows=[];const capture=()=>rows.push([...document.querySelectorAll('dialog.qbx-product-dialog button')].map(n=>{const s=getComputedStyle(n);let background=s.backgroundColor,ancestor=n;while(background==='rgba(0, 0, 0, 0)'&&ancestor.parentElement){ancestor=ancestor.parentElement;background=getComputedStyle(ancestor).backgroundColor;}const r=n.getBoundingClientRect();return{text:n.textContent,color:s.color,background,variant:n.dataset.variant,disabled:n.disabled,width:r.width,height:r.height,font:s.fontSize};}));await new Promise(requestAnimationFrame);capture();await new Promise(resolve=>setTimeout(resolve,40));capture();await new Promise(resolve=>setTimeout(resolve,160));capture();return rows;});
   for(const frame of samples)for(const button of frame){button.contrast=contrast(button.color,button.background);if(!button.disabled&&button.contrast<4.5)result.contrastPassed=false;}
   result.samples.push({danger,frames:samples});await page.screenshot({path:path.join(output,`${width}-${colorScheme}-${danger?'danger':'normal'}-long.png`)});
   const dialog=page.locator('dialog.qbx-product-dialog'),cancel=dialog.locator('[data-cancel]'),confirm=dialog.locator('button[type=submit]'),close=dialog.locator('.qbx-dialog-close');
   assert.equal(await cancel.evaluate(n=>document.activeElement===n),true);await page.keyboard.press('Tab');assert.equal(await confirm.evaluate(n=>document.activeElement===n),true);await page.screenshot({path:path.join(output,`${width}-${colorScheme}-${danger?'danger':'normal'}-keyboard-focus.png`)});await page.keyboard.press('Tab');assert.equal(await close.evaluate(n=>document.activeElement===n),true);await page.keyboard.press('Shift+Tab');assert.equal(await confirm.evaluate(n=>document.activeElement===n),true);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.qaDialogResult),null);assert.equal(await page.locator('#qa-dialog-origin').evaluate(n=>document.activeElement===n),true);result.checks.push(`${danger?'danger':'normal'} focus trap, Shift+Tab, Esc, origin focus, no callback mutation`);
  }
  await open({message:'确认返回布尔结果'});await page.keyboard.press('Tab');await page.keyboard.press('Enter');await page.locator('dialog.qbx-product-dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.qaDialogResult),true);result.checks.push('keyboard confirmation returns true');
  await open({input:'旧名字',confirm:'保存名称'});await page.locator('dialog.qbx-product-dialog input').fill(' 新名字🙂 ');await page.keyboard.press('Enter');await page.locator('dialog.qbx-product-dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.qaDialogResult),'新名字🙂');result.checks.push('input editing and trim callback unchanged');
  await open({message:'取消返回空结果'});await page.locator('dialog.qbx-product-dialog [data-cancel]').click();await page.locator('dialog.qbx-product-dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.qaDialogResult),null);result.checks.push('cancel button returns null');
  await open({message:'关闭返回空结果'});await page.locator('dialog.qbx-product-dialog .qbx-dialog-close').click();await page.locator('dialog.qbx-product-dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.qaDialogResult),null);result.checks.push('close button returns null');
  await open({message:'取消信号关闭'});await page.evaluate(()=>window.qaController.abort());await page.locator('dialog.qbx-product-dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.qaDialogResult),null);result.checks.push('abort signal returns null');
  result.passed=result.contrastPassed;await context.close();
 }
 assert.equal(fixture.provider.calls.length,0);assert.equal(fixture.bridge.sent.length,0);proof.passed=proof.cases.every(row=>row.passed);assert.equal(proof.passed,true,'All enabled dialog labels must remain readable from first frame through stable styles');
}finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify(proof,null,2));await browser?.close();await fixture.close();}
console.log(JSON.stringify({passed:proof.passed,preFix:proof.preFix,cases:proof.cases.map(row=>({width:row.width,theme:row.colorScheme,passed:row.passed,minimumContrast:Math.min(...row.samples.flatMap(x=>x.frames.flat().map(b=>b.contrast)))}))}));
