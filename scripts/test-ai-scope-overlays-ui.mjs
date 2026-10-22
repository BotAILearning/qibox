// Account-scoped overlays outside #ai-content, on the real production UI/API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
import { key } from '../test/ai-fixtures.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const out = path.resolve(root, process.env.QIBOX_TEST_OUTPUT || 'reports/ai-scope-overlays');
await fs.mkdir(out, {recursive:false});
const red = process.env.QIBOX_OVERLAY_RED === '1';
const files = ['config/product.json','web/ai-assistant.mjs','web/ai-proactive-view.mjs','web/ai-date-range.mjs','public/app.js',...(await fs.readdir(path.join(root,'public/chunks'))).filter(n=>n.endsWith('.js')).map(n=>'public/chunks/'+n)];
const hashes = async()=>Object.fromEntries(await Promise.all(files.map(async n=>[n,createHash('sha256').update(await fs.readFile(path.join(root,n))).digest('hex')])));
const proof = {at:new Date().toISOString(),redProbe:red,scope:'Actual Edge production app/API with synthetic accounts; native identity failure and switch; overlays outside content',realModelRequests:0,realWechatSends:0,cases:[],passed:false,sourceBefore:await hashes()};
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
 for (const width of red?[1280]:[1280,375]) for (const theme of red?['dark']:['light','dark']) {
  const fixture=await proactiveFixture(),{ai,bridge,provider}=fixture;
  const row={width,theme,checks:{},observations:{},screenshots:[],passed:false,pageErrors:[]};proof.cases.push(row);
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme});const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>row.pageErrors.push(e.message));
  const shot=async phase=>{await page.waitForTimeout(200);const n=`${width}-${theme}-${phase}.png`;await page.screenshot({path:path.join(out,n)});row.screenshots.push(n);};
  const nav=async name=>{if(width<640)await page.locator('.qibox-workspace-menu>summary').click();await page.locator('.ai-main-tabs').getByRole('button',{name,exact:true}).click();};
  const taskMenu=async id=>{if(width<640){const toggle=page.locator(`[data-proactive-expand="${id}"]`);await toggle.waitFor({state:'visible'});if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();}await page.locator(`[data-proactive-menu="${id}"]`).click();};
  const known=bridge.currentAccount.bind(bridge);
  const unknown=()=>{bridge.currentAccount=async()=>{throw Error('synthetic overlay identity unavailable');};};
  const waitUnknown=async()=>{await page.locator('#ai-content .ai-entry-loading').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#ai-feedback')?.getAttribute('role')==='alert');};
  try {
   const contact=bridge.contacts[0].id;bridge.contacts[0].label='PRIVATE_OVERLAY_CONTACT_017';await ai.scan();
   bridge.readDates=async({account,contact})=>({account,contact,dates:['2026-10-01','2026-10-15']});
   const created=await ai.proactiveTaskAction({command:'create',name:'PRIVATE_OVERLAY_TASK_017',taskType:'custom',contacts:[contact],goal:'已保存目标',requirements:'已保存规则',schedule:{cycle:'weekly',mode:'fixed',time:'14:40',weekdays:[5]}});
   const task=created.proactiveTasks[0];await ai.settings({enabled:false,autoLearning:false,proactive:false});
   await page.goto(fixture.url);if(width<640)await page.locator('[data-mobile-ai-open]').click();else{await page.locator('[data-action=open]').click();await page.locator('#ai-open').click();}
   await nav('主动聊天');await taskMenu(task.id);await page.locator(`[data-proactive-command=delete][data-task-id="${task.id}"]`).click();
   await page.locator('dialog.ai-proactive-dialog').waitFor({state:'visible'});unknown();await waitUnknown();
   row.observations.deleteDialogVisibleAfterUnknown=await page.locator('dialog.ai-proactive-dialog').isVisible();await shot('delete-dialog-unknown');
   if(row.observations.deleteDialogVisibleAfterUnknown){
    await page.locator('[data-proactive-delete-confirm]').click();await page.locator('dialog.ai-proactive-dialog .ap-picker-error').filter({hasText:'微信账号'}).waitFor();
    row.observations.deleteAttemptRejectedWithoutMutation=ai.data.proactiveTasks.some(t=>t.id===task.id&&!t.deletedAt);
    await page.locator('[data-proactive-delete-cancel]').click();row.observations.cancelStillWorks=true;
   } else {await page.locator('dialog.ai-proactive-dialog').waitFor({state:'detached'});assert.equal(await page.locator('[data-proactive-delete-confirm]').count(),0);row.checks.deleteOverlayClosedAndCannotSubmit=true;}
   bridge.currentAccount=known;await taskMenu(task.id);await page.locator(`[data-proactive-command=edit][data-task-id="${task.id}"]`).click();
   await page.locator('#ai-proactive-form [name=name]').fill('PRIVATE_OVERLAY_DRAFT_NAME_017');await page.locator('#ai-proactive-form [name=goal]').fill('PRIVATE_OVERLAY_DRAFT_GOAL_017');
   await page.locator('[data-proactive-pick]').click();await page.locator('.ap-contact-dialog').waitFor({state:'visible'});unknown();await waitUnknown();
   row.observations.proactivePickerVisibleAfterUnknown=await page.locator('.ap-contact-dialog').isVisible();await shot('contact-picker-unknown');
   if(row.observations.proactivePickerVisibleAfterUnknown)await page.locator('.ap-contact-dialog [data-picker-cancel]').last().click();
   else {await page.locator('.ap-contact-dialog').waitFor({state:'detached'});row.checks.proactivePickerClosed=true;}
   bridge.currentAccount=known;await page.locator('#ai-proactive-form [name=goal]').waitFor({state:'visible'});
   assert.equal(await page.locator('#ai-proactive-form [name=name]').inputValue(),'PRIVATE_OVERLAY_DRAFT_NAME_017');assert.equal(await page.locator('#ai-proactive-form [name=goal]').inputValue(),'PRIVATE_OVERLAY_DRAFT_GOAL_017');row.checks.sameAccountProactiveDraftRecovered=true;

   await nav('分析报告');await page.locator('[data-ai-analysis-pick]').click();await page.locator('dialog [data-picker-id]').first().check();await page.locator('dialog [data-picker-confirm]').click();
   await page.locator('details[data-ai-optional=analysis]>summary').click();await page.locator('#ai-analysis-request-text').fill('PRIVATE_ANALYSIS_DRAFT_OVERLAY_017');
   await page.locator('[data-ai-analysis-range=custom]').click();await page.locator('dialog.ai-calendar-dialog').waitFor({state:'visible'});unknown();await waitUnknown();
   row.observations.calendarVisibleAfterUnknown=await page.locator('dialog.ai-calendar-dialog').isVisible();row.observations.calendarMountedOutsideContent=await page.locator('dialog.ai-calendar-dialog').evaluateAll(nodes=>nodes.some(n=>!document.querySelector('#ai-content').contains(n)));await shot('calendar-unknown');
   if(row.observations.calendarVisibleAfterUnknown)await page.locator('dialog.ai-calendar-dialog [data-cancel]').click();else {await page.locator('dialog.ai-calendar-dialog').waitFor({state:'detached'});row.checks.calendarAbortedAndRemoved=true;}
   bridge.currentAccount=known;await page.locator('#ai-analysis-request-text').waitFor({state:'attached'});assert.equal(await page.locator('#ai-analysis-request-text').inputValue(),'PRIVATE_ANALYSIS_DRAFT_OVERLAY_017');row.checks.sameAccountAnalysisDraftRecovered=true;

   if(!red){
    await nav('主动聊天');await page.locator('#ai-proactive-form [name=name]').waitFor({state:'visible'});await page.locator('[data-proactive-pick]').click();await page.locator('.ap-contact-dialog').waitFor({state:'visible'});
    bridge.account=key(`overlay-new-native-${width}-${theme}`);bridge.contacts=[{id:contact,label:'NEW_OVERLAY_ACCOUNT_017',kind:'person'}];
    await page.locator('[data-proactive-new]').waitFor({state:'visible'});assert.equal(await page.locator('.ap-contact-dialog').count(),0);assert.equal(await page.locator('dialog.ai-proactive-dialog').count(),0);
    await page.locator('[data-proactive-new]').click();assert.equal(await page.locator('#ai-proactive-form [name=name]').inputValue(),'');assert.equal(await page.locator('#ai-proactive-form [name=goal]').inputValue(),'');row.checks.changedAccountDropsOldProactiveDraft=true;await shot('new-account-empty-draft');
   }
   assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);assert.deepEqual(row.pageErrors,[]);
   row.passed=!row.observations.deleteDialogVisibleAfterUnknown&&!row.observations.proactivePickerVisibleAfterUnknown&&!row.observations.calendarVisibleAfterUnknown;
  } catch(error){row.error=String(error.stack||error);await shot('failure');throw error;}
  finally {bridge.currentAccount=known;await context.close();await fixture.close();await fs.writeFile(path.join(out,'progress.json'),JSON.stringify(proof,null,2)+'\n');}
 }
 proof.passed=proof.cases.every(x=>x.passed);
} finally {proof.sourceAfter=await hashes();proof.sourceUnchanged=JSON.stringify(proof.sourceBefore)===JSON.stringify(proof.sourceAfter);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});await browser.close();}
console.log(JSON.stringify({passed:proof.passed,redProbe:red,cases:proof.cases.length,sourceUnchanged:proof.sourceUnchanged,observations:proof.cases.map(x=>x.observations)}));
if(!proof.passed)process.exitCode=1;
