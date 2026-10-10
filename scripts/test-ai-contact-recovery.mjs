import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {AppError} from '../server/files.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const output=pathToFileURL(path.resolve(root,process.env.QIBOX_TEST_OUTPUT||'reports/ai-contact-recovery')+path.sep),fixture=await proactiveFixture();
const {ai,bridge,provider}=fixture,proof={scope:'Production UI in disposable local application; controlled failures and accounts',realWechatSends:0,realProviderCalls:0,checks:[],passed:false};
let browser;
try{
 await fs.mkdir(output,{recursive:true});
 const contact=bridge.contacts[0].id;await ai.setReplyOptions({contact,enabled:true});await ai.settings({reply:true});
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.goto(fixture.url);await page.locator('[data-action=open]').click();await page.locator('#ai-open').click();await page.locator(`[data-ai-object="${contact}"]`).click();
 await page.locator('#ai-object-form details').filter({hasText:'回复策略'}).locator('summary').click();
 await page.locator('#ai-object-form [name=boundaries]').fill('CONTROLLED_DRAFT_KEEP60');
 const originalScan=bridge.scan.bind(bridge);bridge.scan=async()=>{throw new AppError('受控联系人读取中断，请重试',503)};
 await page.getByRole('button',{name:'刷新列表',exact:true}).click();await page.getByText('受控联系人读取中断，请重试',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-ai-object]').count(),3);assert.equal(await page.locator('#ai-object-form [name=boundaries]').inputValue(),'CONTROLLED_DRAFT_KEEP60');
 proof.checks.push({case:'CON-02/UI-13',scenario:'temporary read failure',contactsRetained:3,draftPreserved:true});
 await page.screenshot({path:fileURLToPath(new URL('failure-draft.png',output))});
 bridge.scan=originalScan;await page.getByRole('button',{name:'刷新列表',exact:true}).click();await page.getByText('联系人已更新',{exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false',undefined,{timeout:7000});
 assert.equal(await page.locator('#ai-object-form [name=boundaries]').inputValue(),'CONTROLLED_DRAFT_KEEP60');proof.checks.push({case:'CON-02/UI-13',scenario:'recovery',contacts:3,draftPreserved:true});
 let held,release,fullSeen,fullRelease,holdFull=false;const heldGate=new Promise(r=>held=r),releaseGate=new Promise(r=>release=r),fullGate=new Promise(r=>fullSeen=r),fullReleaseGate=new Promise(r=>fullRelease=r);
 await page.route('**/api/instances/*/ai',async route=>{
  const body=route.request().postDataJSON();
  if(route.request().method()==='POST'&&body?.action==='scan'){
   const response=await route.fetch();held();await releaseGate;await route.fulfill({response});
  }else if(route.request().method()==='GET'&&holdFull){const response=await route.fetch();fullSeen();await fullReleaseGate;await route.fulfill({response});}
  else await route.continue();
 });
 await page.getByRole('button',{name:'刷新列表',exact:true}).click();await Promise.race([heldGate,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Controlled slow scan was not issued')),7000))]);
 holdFull=true;bridge.account=createHash('sha256').update('late-account-contact60').digest('hex');bridge.contacts=[{id:contact,label:'NEW_ACCOUNT_CONTACT60',kind:'person'}];await ai.scan();
 await Promise.race([fullGate,new Promise((_,reject)=>setTimeout(()=>reject(new Error('New account full read was not issued')),7000))]);
 assert.equal(await page.locator('#ai-object-form [name=boundaries]').count(),0,'Old private fields must be concealed before the full state arrives');
 proof.checks.push({case:'CON-10/UI-14',scenario:'new account full configuration still delayed',oldPrivateFieldsConcealed:true});holdFull=false;fullRelease();
 try { await page.locator(`[data-ai-object="${contact}"]`).filter({hasText:'NEW_ACCOUNT_CONTACT60'}).waitFor({timeout:7000}); }
 catch (error) {
  proof.lateFailure={backendAccountChanged:true,backendContacts:ai.publicState().contacts.map(c=>c.label),visibleOldContacts:await page.locator('[data-ai-object]').allTextContents(),oldPrivateDraftVisible:await page.locator('#ai-object-form [name=boundaries]').inputValue(),panelBusy:await page.locator('#ai-panel').getAttribute('aria-busy')};
  await page.screenshot({path:fileURLToPath(new URL('late-account-before.png',output))});
  fullRelease();release();throw error;
 }
 release();await page.waitForTimeout(700);
 assert.equal(await page.locator('[data-ai-object]').count(),1);assert.match(await page.locator('[data-ai-object]').innerText(),/NEW_ACCOUNT_CONTACT60/);
 assert.equal(await page.locator('#ai-object-form [name=boundaries]').count(),0);proof.checks.push({case:'CON-10/UI-14',scenario:'late scan response after account change',oldListRejected:true,oldDraftRemoved:true});
 await page.screenshot({path:fileURLToPath(new URL('late-new-account.png',output))});
 await page.unroute('**/api/instances/*/ai');
 bridge.contacts=[];await page.getByRole('button',{name:'刷新列表',exact:true}).click();
 await page.getByText('当前微信没有可读取的联系人。',{exact:true}).waitFor({timeout:7000});
 proof.empty={available:ai.available,contacts:ai.publicState().contacts.length,visible:await page.locator('#ai-content').innerText()};
 await page.screenshot({path:fileURLToPath(new URL('valid-empty.png',output))});
 bridge.scan=async()=>({available:false});await page.getByRole('button',{name:'刷新列表',exact:true}).click();await page.getByText('暂时无法获取联系人，请打开微信并登录后重试',{exact:true}).waitFor();
 await page.getByText('暂时无法读取联系人，请确认微信已登录后刷新。',{exact:true}).waitFor({timeout:7000});
 proof.unavailable={available:ai.available,contacts:ai.publicState().contacts.length,visible:await page.locator('#ai-content').innerText()};
 await page.screenshot({path:fileURLToPath(new URL('unavailable.png',output))});
 assert.equal(proof.empty.available,true);assert.equal(proof.unavailable.available,false);
 assert.notEqual(proof.empty.visible,proof.unavailable.visible);
 proof.checks.push({case:'CON-03',scenario:'valid empty versus unreadable',statesDiffer:true,persistentVisibleContentDiffers:proof.empty.visible!==proof.unavailable.visible});
 assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);proof.passed=true;
}finally{await fs.writeFile(new URL('report.json',output),JSON.stringify(proof,null,2));await browser?.close();await fixture.close();}
console.log(JSON.stringify(proof));

