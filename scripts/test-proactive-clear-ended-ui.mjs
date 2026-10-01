import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const fixture = await proactiveFixture(), { ai, bridge } = fixture;
const output = path.join(root, 'reports/proactive-clear-ended-2026-10-01');
await mkdir(output, { recursive: true });
const report = { scope: 'Disposable local application and simulated tasks; no NAS or real messages.', checks: [], errors: [], requests: [], layouts: [] };
let browser, page;
try {
  ai.tick = async () => {};
  const createTask = async (name, status) => {
    const created = await ai.proactiveTaskAction({ command:'create', name, taskType:'custom', contacts:[bridge.contacts[0].id], goal:'确认周末安排', requirements:'', schedule:{cycle:'daily',mode:'fixed',time:'23:59'} });
    const task = created.proactiveTasks.find(row=>row.name===name);
    if (status==='ended' || status==='paused') await ai.proactiveTaskAction({command:status==='ended'?'end':'pause',id:task.id});
    if (status==='failed') { const stored = ai.data.proactiveTasks.find(row=>row.id===task.id); stored.status='failed'; stored.lastError='模拟执行失败'; await ai.save(); }
    return task.id;
  };
  const endedIds = [], failedIds = [], keptIds = [];
  for (const [name, status] of [['已经结束的任务甲','ended'],['已经结束的任务乙','ended'],['执行失败的任务甲','failed'],['执行失败的任务乙','failed'],['仍在执行的任务','running'],['已经暂停的任务','paused']]) {
    const id = await createTask(name,status);
    (status==='ended'?endedIds:status==='failed'?failedIds:keptIds).push(id);
  }
  ai.data.proactiveRecords.push({id:'kept-history',account:ai.data.account,taskId:failedIds[0],taskName:'执行失败的任务甲',profileId:ai.profiles()[0].id,contact:bridge.contacts[0].id,label:bridge.contacts[0].label,status:'failed',at:Date.now(),body:ai.vault.seal({text:'保留的执行记录'})});
  await ai.save();
  browser = await chromium.launch({ channel:'msedge', headless:true });
  page = await browser.newPage({ viewport:{width:1440,height:1000} });
  page.setDefaultTimeout(12000); page.on('pageerror', error=>report.errors.push(error.message));
  page.on('request', request=> { if (request.url().includes('/ai') && request.method()==='POST') { const data=request.postDataJSON(); report.requests.push({action:data.action,type:data.value?.type,scope:data.value?.scope,hasToken:!!data.value?.token}); } });
  const settled = () => page.waitForFunction(() => document.querySelector('#ai-panel')?.getAttribute('aria-busy')!=='true');
  const tasks = page.locator('[data-proactive-task]'), scope = page.locator('[data-proactive-cleanup-scope]');
  const clear = page.locator('[data-ai-clear-tasks]'), dialog = page.locator('dialog.qbx-product-dialog');
  const open = async () => { await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click(); await page.locator('[data-ai-nav=proactive]').last().click(); await tasks.first().waitFor(); };
  const choose = async value => { await scope.selectOption(value); await settled(); assert.equal(await scope.inputValue(),value); };
  const confirm = async () => {
    const deleted = page.waitForResponse(response=>response.url().includes('/ai') && response.request().method()==='POST' && response.request().postDataJSON()?.value?.token);
    const [response] = await Promise.all([deleted, dialog.locator('button[type=submit]').click()]);
    const result = await response.json(); await settled(); return {response,result};
  };
  const checkCount = async count => { await page.waitForFunction(expected=>document.querySelectorAll('[data-proactive-task]').length===expected,count); };
  const poll = async () => { await page.waitForResponse(response=>/\/ai(?:\?|$)/.test(response.url()) && response.request().method()==='GET'); await settled(); };
  await page.goto(fixture.url); await open(); await checkCount(6);
  assert.equal(await clear.isDisabled(),true); assert.equal(await scope.inputValue(),'');
  assert.equal(await scope.locator('option[value=ended]').innerText(),'已结束（2）');
  assert.equal(await scope.locator('option[value=failed]').innerText(),'执行失败（2）');
  assert.equal(await scope.locator('option[value=ended-failed]').innerText(),'结束 + 失败（4）');
  assert.equal(await page.locator('.ap-heading [data-ai-clear-tasks]').count(),0);
  assert.equal(await page.locator('.ap-reference-toolbar [data-ai-clear-tasks]').count(),1);
  await choose('ended-failed');
  await page.locator('[data-proactive-filter=running]').click(); await checkCount(1);
  assert.equal(await scope.locator('option[value=ended-failed]').innerText(),'结束 + 失败（4）');
  await page.locator('[data-proactive-filter=all]').click(); await checkCount(6);
  await choose('failed'); await scope.focus();
  ai.data.proactiveTasks.find(row=>row.id===keptIds[0]).name='仍在执行的任务（已更新）'; await ai.save();
  const changedFailures = ai.data.proactiveTasks.filter(row=>failedIds.includes(row.id));
  for (const task of changedFailures) task.status='running'; await ai.save();
  await poll(); assert.equal(await scope.evaluate(node=>node===document.activeElement),true);
  await page.locator(`[data-proactive-task="${keptIds[0]}"]`).getByText('仍在执行的任务（已更新）',{exact:true}).last().waitFor();
  assert.equal(await scope.locator('option[value=failed]').innerText(),'执行失败（0）'); assert.equal(await clear.isDisabled(),true);
  for (const task of changedFailures) task.status='failed'; await ai.save(); await poll();
  assert.equal(await scope.locator('option[value=failed]').innerText(),'执行失败（2）'); assert.equal(await clear.isDisabled(),false);
  await choose('ended-failed');
  await clear.focus();
  report.checks.push('The task-list toolbar offers three cleanup scopes with counts across the whole list; choosing nothing disables cleanup; selection survives filters and polling.');

  for (const width of [1440,1024,768,390,320]) {
    await page.setViewportSize({width,height:1000});
    const layout = await page.locator('#ai-panel').evaluate(node=>{
      const group=node.querySelector('.ap-task-cleanup'), select=group.querySelector('select'), button=group.querySelector('button');
      const bounds=group.getBoundingClientRect(), field=select.getBoundingClientRect(), action=button.getBoundingClientRect();
      return {clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,groupLeft:bounds.left,groupRight:bounds.right,selectWidth:field.width,buttonWidth:action.width,selectHeight:field.height,buttonHeight:action.height,heightDifference:Math.abs(field.height-action.height),overlap:field.right>action.left};
    });
    assert.ok(layout.scrollWidth<=layout.clientWidth+1,JSON.stringify({width,layout}));
    assert.ok(layout.groupLeft>=-1 && layout.groupRight<=width+1,JSON.stringify({width,layout}));
    assert.ok(layout.selectWidth>=120 && !layout.overlap,JSON.stringify({width,layout}));
    assert.ok(layout.heightDifference<=1,JSON.stringify({width,layout}));
    report.layouts.push({width,...layout});
    await page.screenshot({path:path.join(output,`task-toolbar-${width}.png`)});
  }
  report.checks.push('Five viewport widths keep the selector and button aligned, readable and inside the page.');
  await page.setViewportSize({width:1440,height:1000});

  await choose('ended');
  const confirmedBefore = report.requests.filter(row=>row.hasToken).length;
  for (const dismiss of [()=>page.keyboard.press('Escape'),()=>dialog.locator('[data-cancel]').click(),()=>dialog.locator('.qbx-dialog-close').click()]) {
    await clear.click(); await dialog.waitFor(); assert.match(await dialog.innerText(),/2 个已结束任务/);
    await dismiss(); await checkCount(6);
  }
  assert.equal(report.requests.filter(row=>row.hasToken).length,confirmedBefore);
  report.checks.push('Escape, cancel and close dismiss the confirmation without deleting tasks.');

  await choose('failed'); await clear.click(); await dialog.waitFor();
  assert.match(await dialog.innerText(),/2 个执行失败任务/);
  const save = ai.save; ai.save = async () => { throw Error('本地验收：保存失败'); };
  let rejected;
  try { rejected = await confirm(); } finally { ai.save = save; }
  assert.equal(rejected.response.ok(),false); await checkCount(6);
  assert.match(await page.locator('#ai-feedback').innerText(),/操作未完成/);
  assert.equal(ai.publicState().proactiveTasks.length,6);
  report.checks.push('A server save failure retains all visible and stored tasks and reports an error.');
  await clear.click(); await dialog.waitFor();
  const failed = await confirm(); assert.equal(failed.result.clearedCount,2); await checkCount(4);
  for (const id of failedIds) assert.equal(await page.locator(`[data-proactive-task="${id}"]`).count(),0);
  assert.equal(await scope.locator('option[value=failed]').innerText(),'执行失败（0）'); assert.equal(await clear.isDisabled(),true);
  await poll(); await checkCount(4);
  assert.match(await page.locator('#ai-feedback').innerText(),/已清理 2 个任务/);
  report.checks.push('Failed-only cleanup immediately removes both failures, updates counts and remains correct after polling.');

  await choose('ended'); await clear.click(); await dialog.waitFor();
  const ended = await confirm(); assert.equal(ended.result.clearedCount,2); await checkCount(2);
  for (const id of endedIds) assert.equal(await page.locator(`[data-proactive-task="${id}"]`).count(),0);
  assert.ok(ai.data.proactiveRecords.some(row=>row.id==='kept-history'));
  await page.reload(); await open(); await checkCount(2);
  assert.deepEqual(new Set(await tasks.evaluateAll(nodes=>nodes.map(node=>node.dataset.proactiveTask))),new Set(keptIds));
  report.checks.push('Ended-only cleanup keeps running and paused work plus execution history, and stays deleted after a full reload.');

  await createTask('新结束任务','ended'); await createTask('新失败任务','failed'); await poll(); await checkCount(4);
  await choose('ended-failed'); await clear.click(); await dialog.waitFor();
  assert.match(await dialog.innerText(),/2 个已结束和执行失败任务/);
  const combined = await confirm(); assert.equal(combined.result.clearedCount,2); await checkCount(2);
  assert.deepEqual(new Set(ai.publicState().proactiveTasks.map(row=>row.id)),new Set(keptIds));
  assert.ok(ai.data.proactiveRecords.some(row=>row.id==='kept-history'));
  assert.equal(await scope.locator('option[value=ended-failed]').innerText(),'结束 + 失败（0）'); assert.equal(await clear.isDisabled(),true);
  await page.screenshot({path:path.join(output,'after-clear.png')});
  report.checks.push('Combined cleanup removes ended and failed tasks together while preserving active work and execution records.');
  assert.deepEqual(report.errors,[]); report.passed=true;
} catch(error) { report.failure=error.stack; if (page) { report.feedback=await page.locator('#ai-feedback').innerText(); await page.screenshot({path:path.join(output,'failure.png')}); } throw error; }
finally { await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)); await browser?.close(); await fixture.close(); }
console.log(JSON.stringify({passed:report.passed,checks:report.checks,layouts:report.layouts,errors:report.errors},null,2));
