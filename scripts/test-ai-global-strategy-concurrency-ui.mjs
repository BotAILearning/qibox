import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {key} from '../test/ai-fixtures.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath),f=await proactiveFixture(),save=f.ai.save;
const out=path.resolve(root,process.env.QIBOX_TEST_OUTPUT||'reports/ai-global-strategy-concurrency');await fs.mkdir(out,{recursive:true});
const base={replyGoal:'原要求',facts:'原事实',boundaries:'原边界',maxRounds:37};
const proof={at:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),build:JSON.parse(await fs.readFile(path.join(root,'config/product.json'))).buildId,environment:{platform:process.platform,node:process.version},scope:'Production browser/UI/API in disposable synthetic data; exact source hashes include any uncommitted repairs, no real account/model/message',cases:[],writes:[],steps:[],passed:false,realModelRequests:0,mockModelRequests:0,wechatSends:0,sourceHashes:{},afterHashes:{}};
const boundFiles=['web/ai-assistant.mjs','server/ai-account-configuration.mjs','server/ai-default-style-scope.mjs','server/ai-configuration-commit.mjs','server/ai-service.mjs','public/app.js'];
for(const file of boundFiles)proof.sourceHashes[file]=createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
const step=name=>{proof.steps.push({at:new Date().toISOString(),name});console.log(name);};
let browser,context,a,b;const gates=[];
const aiRoute=`**/instances/${f.instance.id}/ai`;
const matching=r=>r.request().method()==='POST'&&r.url().endsWith('/ai')&&r.request().postDataJSON()?.value?.type==='global-reply-strategy';
const settled=p=>p.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');
const button=p=>p.locator('#ai-global-reply-form button[type=submit]');
async function open(p){await p.goto(f.url);await p.locator('[data-action=open]').click();await p.locator('#ai-open').click();await p.locator('#ai-panel').waitFor({state:'visible'});await p.getByRole('button',{name:'系统设置',exact:true}).click();await p.locator('[data-ai-nav=global-reply]').click();await p.locator('[data-ai-optional=global-facts] summary').click();}
async function reset(){step('reset fixture pages');await context?.close();await f.ai.configuration({type:'global-reply-strategy',strategy:base});context=await browser.newContext({viewport:{width:1280,height:900}});a=await context.newPage();b=await context.newPage();for(const p of [a,b]){p.setDefaultTimeout(10000);p.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/ai')&&r.postDataJSON()?.value?.type==='global-reply-strategy')proof.writes.push(r.postDataJSON().value);});await open(p);}}
async function commit(p){const response=p.waitForResponse(matching);await button(p).click();const result=await response;await settled(p);return result;}
async function holdWrite(p){let entered,release,timer;const started=new Promise((resolve,reject)=>{entered=value=>{clearTimeout(timer);resolve(value);};timer=setTimeout(()=>reject(Error('global write was not dispatched within 15s')),15000);}),held=new Promise(resolve=>release=resolve);let first=true;const route=async r=>{if(first&&r.request().method()==='POST'&&r.request().postDataJSON()?.value?.type==='global-reply-strategy'){first=false;entered(r.request().postDataJSON().value);await held;}await r.continue();};await p.route(aiRoute,route);const gate={started,release:()=>{clearTimeout(timer);release();},close:()=>p.unroute(aiRoute,route)};gates.push(gate);return gate;}
async function expectValue(p,name,value){await p.waitForFunction(({name,value})=>document.querySelector(`#ai-global-reply-form [name=${name}]`)?.value===value,{name,value},{timeout:10000});}
try{
 browser=await chromium.launch({channel:'msedge',headless:true});proof.environment.browser=browser.version();await reset();
 await a.locator('[name=boundaries]').fill('本页边界');await b.locator('[name=replyGoal]').fill('另页要求');await b.locator('[name=facts]').fill('另页事实');assert.equal((await commit(b)).status(),200);
 await expectValue(a,'replyGoal','另页要求');await expectValue(a,'facts','另页事实');assert.equal(await a.locator('[name=boundaries]').inputValue(),'本页边界');assert.equal((await commit(a)).status(),200);
 assert.deepEqual(f.ai.globalReplyStrategy(),{...base,replyGoal:'另页要求',facts:'另页事实',boundaries:'本页边界'});proof.cases.push({name:'refresh untouched fields and retain only dirty boundaries',passed:true});await a.screenshot({path:path.join(out,'01-different-fields-merged.png')});

 await reset();await a.locator('[name=boundaries]').fill('在途边界');const gate=await holdWrite(a),response=a.waitForResponse(matching);await button(a).click();const submitted=await gate.started;
 assert.deepEqual(submitted.changes,{boundaries:'在途边界'});assert.equal(await a.locator('[name=replyGoal]').isDisabled(),true);assert.equal(await a.locator('[name=boundaries]').isDisabled(),true);
 await b.locator('[name=facts]').fill('发出请求后的新事实');assert.equal((await commit(b)).status(),200);gate.release();assert.equal((await response).status(),200);await settled(a);await gate.close();
 assert.equal(f.ai.globalReplyStrategy().facts,'发出请求后的新事实');assert.equal(f.ai.globalReplyStrategy().boundaries,'在途边界');proof.cases.push({name:'server merges other field changed after request dispatch; pending inputs disabled',passed:true});

 await reset();await a.locator('[name=replyGoal]').fill('本页冲突草稿');const same=await holdWrite(a),rejected=a.waitForResponse(matching);await button(a).click();await same.started;
 await b.locator('[name=replyGoal]').fill('另页先保存');await b.locator('[name=facts]').fill('另页未冲突事实');assert.equal((await commit(b)).status(),200);same.release();assert.equal((await rejected).status(),409);await same.close();await settled(a);await a.locator('#ai-feedback').filter({hasText:/回复要求.*其他页面/}).waitFor();
 assert.equal(await a.locator('[name=replyGoal]').inputValue(),'本页冲突草稿');assert.equal(f.ai.globalReplyStrategy().replyGoal,'另页先保存');await a.screenshot({path:path.join(out,'02-conflict-draft-preserved.png')});
 step('same-field rejection observed; open and cancel confirmation');const beforeCancel=proof.writes.length;await button(a).click();const dialog=a.locator('dialog.qbx-product-dialog');await dialog.waitFor();assert.match(await dialog.locator('p').textContent(),/回复要求/);assert.doesNotMatch(await dialog.locator('p').textContent(),/可使用的已知信息/);await a.screenshot({path:path.join(out,'02b-only-conflicting-field-confirmation.png')});await dialog.locator('[data-cancel]').click();assert.equal(proof.writes.length,beforeCancel);assert.equal(f.ai.globalReplyStrategy().replyGoal,'另页先保存');
 step('open confirmation and change same field again in B');await button(a).click();await dialog.waitFor();await b.locator('[name=replyGoal]').fill('确认框期间再次变化');assert.equal((await commit(b)).status(),200);step('B changed; confirm old observed value should reject');
 const raced=a.waitForResponse(matching);await dialog.getByRole('button',{name:'保存我的修改',exact:true}).click();assert.equal((await raced).status(),409);await settled(a);assert.equal(f.ai.globalReplyStrategy().replyGoal,'确认框期间再次变化');assert.equal(await a.locator('[name=replyGoal]').inputValue(),'本页冲突草稿');
 await button(a).click();await dialog.waitFor();const confirmed=a.waitForResponse(matching);await dialog.getByRole('button',{name:'保存我的修改',exact:true}).focus();await a.keyboard.press('Enter');assert.equal((await confirmed).status(),200);await settled(a);assert.equal(f.ai.globalReplyStrategy().replyGoal,'本页冲突草稿');assert.equal(f.ai.globalReplyStrategy().facts,'另页未冲突事实');proof.cases.push({name:'same-field conflict rejects; cancel no write; keyboard confirmation uses observed CAS and rejects a second race',passed:true});await a.screenshot({path:path.join(out,'03-confirmed-conflict-preserves-other-fields.png')});

 await reset();await a.locator('[name=facts]').fill('保存失败后保留的中文🙂');f.ai.save=async()=>{throw Error('fixture global strategy disk full');};assert.equal((await commit(a)).status(),500);f.ai.save=save;assert.deepEqual(f.ai.globalReplyStrategy(),base);
 await a.getByRole('button',{name:'系统设置',exact:true}).click();await a.locator('[data-ai-nav=global-reply]').click();await a.locator('[data-ai-optional=global-facts] summary').click();assert.equal(await a.locator('[name=facts]').inputValue(),'保存失败后保留的中文🙂');assert.equal((await commit(a)).status(),200);assert.equal(f.ai.globalReplyStrategy().facts,'保存失败后保留的中文🙂');proof.cases.push({name:'persistence failure keeps draft across navigation and explicit retry',passed:true});await a.screenshot({path:path.join(out,'04-failed-draft-retried.png')});

 await reset();await a.locator('[name=replyGoal]').fill('页面切换时的冲突草稿');await b.locator('[name=replyGoal]').fill('另一页要求');assert.equal((await commit(b)).status(),200);await a.waitForTimeout(3200);assert.equal((await commit(a)).status(),409);await button(a).click();const navigationDialog=a.locator('dialog.qbx-product-dialog');await navigationDialog.waitFor();const beforeNav=proof.writes.length;
 // Synthetic route transition invokes the same production navigation handler;
 // it covers app-driven page changes while a native modal makes user clicks inert.
 await a.locator('.ai-main-tabs [data-ai-nav=settings]').evaluate(node=>node.click());await navigationDialog.waitFor({state:'detached'});assert.equal(proof.writes.length,beforeNav);proof.cases.push({name:'app-driven page change aborts pending overwrite confirmation',passed:true});

 await reset();const originalAccount=f.ai.data.account;await a.locator('[name=replyGoal]').fill('旧账号等待中的草稿');const accountGate=await holdWrite(a),oldResponse=a.waitForResponse(matching);await button(a).click();await accountGate.started;f.bridge.account=key('global-browser-next-account');await f.ai.scan();
 await expectValue(a,'replyGoal','');await a.locator('[name=replyGoal]').fill('新账号尚未保存的草稿');accountGate.release();assert.equal((await oldResponse).status(),409);await accountGate.close();await a.waitForTimeout(250);assert.equal(await a.locator('[name=replyGoal]').inputValue(),'新账号尚未保存的草稿');assert.equal(f.ai.data.globalReplyStrategies[originalAccount].replyGoal,base.replyGoal);assert.notEqual(f.ai.globalReplyStrategy().replyGoal,'新账号尚未保存的草稿');proof.cases.push({name:'account change retires pending write and preserves new account draft against late failure',passed:true});await a.screenshot({path:path.join(out,'05-new-account-draft-after-old-write.png')});
 assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);proof.passed=true;
}catch(error){proof.error={message:error.message,stack:error.stack};console.error(error);if(a&&!a.isClosed())await a.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;
}finally{for(const gate of gates)gate.release();f.ai.save=save;proof.mockModelRequests=f.provider.calls.length;proof.wechatSends=f.bridge.sent.length;for(const file of boundFiles)proof.afterHashes[file]=createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');proof.sourcesUnchanged=JSON.stringify(proof.sourceHashes)===JSON.stringify(proof.afterHashes);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(proof,null,2));await context?.close();await browser?.close();await f.close();}
console.log(JSON.stringify({passed:proof.passed,cases:proof.cases,modelCalls:f.provider.calls.length,sends:f.bridge.sent.length}));
