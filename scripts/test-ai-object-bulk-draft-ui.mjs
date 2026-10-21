// Production controller + disposable API/data root. No device or model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
import {proactiveFixture} from './proactive-ui-fixture.mjs';
import {key,strategy} from '../test/ai-fixtures.mjs';
const require=createRequire(import.meta.url),{build}=require('esbuild'),{chromium}=require(playwrightPath);
const output=path.resolve(root,process.env.QIBOX_TEST_OUTPUT||'reports/ai-object-bulk-draft');await fs.mkdir(output,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex');
const proof={at:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 buildId:JSON.parse(await fs.readFile(path.join(root,'config/product.json'),'utf8')).buildId,
 scope:'Current production controller/views bundled directly from source + production bulk method/API dispatch in temporary fixture account; no real account/device/model/WeChat',
 controllerSha256:hash(await fs.readFile(path.join(root,'web/ai-assistant.mjs'))),cases:[],passed:false,blockedExternal:[],realProviderCalls:0,realWechatSends:0};
const sourceCommit=process.env.QIBOX_TEST_UI_SOURCE_COMMIT;
if(sourceCommit)assert.match(sourceCommit,/^[a-f0-9]{40}$/);
if(sourceCommit)proof.controllerSha256=hash(execFileSync('git',['show',`${sourceCommit}:web/ai-assistant.mjs`],{cwd:root,encoding:'utf8'}));
const sourcePlugins=sourceCommit?[{name:'frozen-ui',setup(plugin){
 plugin.onResolve({filter:/.*/},args=>({path:path.posix.normalize(args.importer?path.posix.join(path.posix.dirname(args.importer),args.path):args.path),namespace:'frozen-ui'}));
 plugin.onLoad({filter:/.*/,namespace:'frozen-ui'},args=>{assert.match(args.path,/^(web|server)\/[\w./-]+\.mjs$/);return{contents:execFileSync('git',['show',`${sourceCommit}:${args.path}`],{cwd:root,encoding:'utf8'}),loader:'js'};});
}}]:[];
proof.uiSourceCommit=sourceCommit||proof.sourceCommit;proof.uiSourceMode=sourceCommit?'frozen git source':'current working source';
const compiled=await build({entryPoints:[sourceCommit?'web/ai-assistant.mjs':path.join(root,'web/ai-assistant.mjs')],bundle:true,write:false,format:'esm',platform:'browser',plugins:sourcePlugins});
const bundle=compiled.outputFiles[0].text;proof.uiBundleSha256=hash(bundle);
const fixture=await proactiveFixture(),{ai,provider,bridge}=fixture;let browser,server,active;
const capture=page=>page.locator('#ai-object-form').evaluate(form=>({maxRounds:form.elements.maxRounds.value,
 dirty:!form.querySelector('[data-ai-dirty]').hidden,replyGoal:form.elements.replyGoal.value,
 values:[...new FormData(form)].map(([k,v])=>[k,String(v)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}));
const cases=['inherited-limit-only','explicit-profile-limit-only','leading-zero-limit-only','decimal-limit-only','other-reply-goal','cancel','failure','new-limit-during-response','invalid-limit-during-response','new-goal-during-response','object-changed-during-response','account-changed-during-response'];
try{
 await ai.settings({enabled:false,reply:true,replyScope:'all',autoLearning:false,judgeReply:false});
 const shell=(await fs.readFile(path.join(root,'web/index.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')
 .replace('<section id="desktop-view" hidden>','<section id="desktop-view">').replace('data-desktop-style="./ai-workspace.css"','href="./ai-workspace.css"')+
 `<script type="module">import{aiAssistant}from'/qa-ui.mjs';window.qa=aiAssistant({api:async(url,payload)=>{const response=await fetch('/qa-state'+(url.includes('?')?url.slice(url.indexOf('?')):''),{method:payload?'POST':'GET',headers:{'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});const value=await response.json();if(!payload)window.qaLastReadAccount=value.account;if(!response.ok)throw Error(value.error);return value;}});await qa.attach('fixture-instance');qa.show();window.qaReady=true;</script>`;
 server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');let data,type='text/javascript';
  if(url.pathname==='/'){data=shell;type='text/html';}else if(url.pathname==='/qa-ui.mjs')data=bundle;
  else if(url.pathname==='/qa-state'){
   type='application/json';let result;
   if(req.method==='POST'){
    let text='';for await(const chunk of req)text+=chunk;const request=JSON.parse(text);active.requests.push(request);
    assert.ok(request.action==='apply-reply-limit'||request.action==='reply-profile'&&['inherited-limit-only','explicit-profile-limit-only'].includes(active.name),'No unrelated writes are permitted by this fixture');
    if(active.name==='failure')throw Error('fixture bulk persistence failure');
    result=request.action==='reply-profile'?await ai.saveReplyProfile(request.value):await ai.applyReplyLimitToKind(request.value.kind,request.value.maxRounds,{account:request.value.account,contacts:request.value.contacts});
    if(active.hold){active.entered();await active.held;}
   }else result=url.searchParams.get('view')==='live'?ai.publicLiveState(url.searchParams.get('contact')):ai.publicState();
   data=JSON.stringify(result);
  }else{
   const asset=path.resolve(root,'public','.'+url.pathname);assert.ok(asset.startsWith(path.resolve(root,'public')+path.sep));
   data=await fs.readFile(asset);type=url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.png')?'image/png':'application/octet-stream';
  }
  res.writeHead(200,{'Content-Type':type});res.end(data);
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({channel:'msedge',headless:true});
 for(const name of cases){
  const row={name,requests:[],passed:false};proof.cases.push(row);active=row;
  row.hold=name.endsWith('during-response');if(row.hold){row.held=new Promise(resolve=>row.release=resolve);row.started=new Promise(resolve=>row.entered=resolve);}
  bridge.account=key('object-bulk-draft-'+name);await ai.scan();
  const contact=bridge.contacts[0].id,otherContact=bridge.contacts[1].id;
  if(name==='explicit-profile-limit-only')await ai.saveReplyProfile({contact,style:ai.publicState().schema.defaultStyle,strategy:{...strategy,maxRounds:50},inheritStrategy:true,replyEnabled:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}});let page;
  await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/')||url.startsWith('data:'))return route.continue();proof.blockedExternal.push(url);return route.abort();});
  const open=async()=>{const target=await context.newPage();target.setDefaultTimeout(10000);await target.goto(origin);await target.waitForFunction(()=>window.qaReady);await target.locator(`[data-ai-object="${contact}"]`).click();return target;};
  const editLimit=async value=>{await page.locator('[data-ai-reply-limit-choice]').selectOption('custom');await page.locator('[data-ai-reply-limit-custom]').fill(String(value));};
  const editGoal=async value=>{await page.locator('[data-ai-optional=reply-strategy]').evaluate(node=>node.open=true);await page.locator('[name=replyGoal]').fill(value);};
  try{
   page=await open();row.before=await capture(page);assert.equal(row.before.maxRounds,'50');assert.equal(row.before.dirty,false);
   await editLimit(name==='leading-zero-limit-only'?'013':name==='decimal-limit-only'?'13.0':13);if(name==='other-reply-goal')await editGoal('UNSAVED_OTHER_GOAL');
   await page.locator('[data-ai-apply-limit-kind=person]').click();const modal=page.locator('dialog.qbx-product-dialog');
   if(name==='object-changed-during-response'){
    // Selection is forbidden once busy. Inject the scope-change in the earlier
    // confirmation window, then edit that new object while the reply is held.
    row.objectChangeTrigger='synthetic DOM click during pending confirmation into production controller; not a physical modal/pointer acceptance claim';
    await page.locator(`[data-ai-object="${otherContact}"]`).evaluate(button=>button.click());
    await page.waitForFunction(expected=>document.querySelector('#ai-object-form')?.dataset.contact===expected,otherContact);
   }
   if(name==='cancel'){
    await modal.locator('[data-cancel]').click();row.after=await capture(page);assert.equal(row.after.dirty,true);assert.equal(row.after.maxRounds,'13');assert.equal(row.requests.length,0);assert.equal(ai.publicState().replyRoundLimits.person,null);
   }else{
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/qa-state',{timeout:30000}).catch(error=>({qaError:error.message}));
    await modal.locator('button[type=submit]').click();
    if(row.hold){
     await row.started;
     if(name==='new-limit-during-response')await editLimit(17);
     if(name==='invalid-limit-during-response')await editLimit('');
     if(name==='new-goal-during-response')await editGoal('NEW_GOAL_DURING_WAIT');
     if(name==='object-changed-during-response'){
      await editGoal('OTHER_OBJECT_PRIVATE_DRAFT');await editLimit(19);
     }
     if(name==='account-changed-during-response'){
      bridge.account=key(name+'-next-account');await ai.scan();await page.waitForFunction(account=>window.qaLastReadAccount===account,bridge.account,{timeout:10000});
      await page.locator(`[data-ai-object="${contact}"]`).click();await editGoal('NEW_ACCOUNT_PRIVATE_DRAFT');await editLimit(23);
     }
     row.release();
    }
    assert.ok(!(await response).qaError,'The observed bulk response must complete');await page.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');await page.waitForTimeout(40);
    row.after=await capture(page);
    if(name==='failure'){assert.equal(row.after.dirty,true);assert.equal(row.after.maxRounds,'13');assert.equal(ai.publicState().replyRoundLimits.person,null);}
    else if(name==='new-limit-during-response'){assert.equal(row.after.maxRounds,'17');assert.equal(row.after.dirty,true);assert.equal(ai.publicState().replyRoundLimits.person,13);}
    else if(name==='invalid-limit-during-response'){assert.equal(row.after.maxRounds,'');assert.equal(row.after.dirty,true);assert.equal(ai.publicState().replyRoundLimits.person,13);}
    else if(name==='new-goal-during-response'){assert.equal(row.after.replyGoal,'NEW_GOAL_DURING_WAIT');assert.equal(row.after.maxRounds,'13');assert.equal(row.after.dirty,true);}
    else if(name==='object-changed-during-response'){assert.equal(row.after.replyGoal,'OTHER_OBJECT_PRIVATE_DRAFT');assert.equal(row.after.maxRounds,'19');assert.equal(row.after.dirty,true);}
    else if(name==='account-changed-during-response'){assert.equal(row.after.replyGoal,'NEW_ACCOUNT_PRIVATE_DRAFT');assert.equal(row.after.maxRounds,'23');assert.equal(row.after.dirty,true);assert.equal(ai.publicState().replyRoundLimits.person,null);}
    else{
     const fresh=await open();row.fresh=await capture(fresh);
     assert.equal(row.after.maxRounds,'13');assert.equal(ai.publicState().replyRoundLimits.person,13);
     if(name==='other-reply-goal'){assert.equal(row.after.replyGoal,'UNSAVED_OTHER_GOAL');assert.equal(row.after.dirty,true);assert.notEqual(row.after.replyGoal,row.fresh.replyGoal);}
     else{assert.deepEqual(row.after.values,row.fresh.values);assert.equal(row.fresh.dirty,false);assert.equal(row.after.dirty,false,'A bulk success committed the only changed field; no unsaved value remains');}
     if(name==='explicit-profile-limit-only')assert.equal(ai.profiles().find(p=>p.contact===contact).replyStrategy.maxRounds,13);
     else assert.equal(ai.publicState().profiles.length,0);
     await fresh.close();
    }
    assert.equal(row.requests.length,1);assert.equal(row.requests[0].action,'apply-reply-limit');
    if(['inherited-limit-only','explicit-profile-limit-only'].includes(name)){
     await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/qa-state'),page.locator('#ai-object-form button[type=submit]').click()]);
     await page.waitForFunction(()=>document.querySelector('#ai-panel')?.getAttribute('aria-busy')==='false');
     assert.equal(row.requests.length,2);assert.equal(row.requests[1].action,'reply-profile');assert.equal(row.requests[1].value.strategy.maxRounds,13);
     assert.equal(ai.profiles().find(profile=>profile.contact===contact).replyStrategy.maxRounds,13);assert.equal((await capture(page)).maxRounds,'13');
     row.postBulkObjectSaveLimit=13;
    }
   }
   row.passed=true;
  }catch(error){row.error=error.stack;}
  finally{row.release?.();delete row.held;delete row.started;delete row.entered;delete row.release;if(page)await page.screenshot({path:path.join(output,name+'.png')}).catch(()=>{});await context.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(proof,null,2)+'\n');}
 }
 assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);assert.equal(ai.publicState().settings.enabled,false);
 proof.passed=proof.cases.every(row=>row.passed);
}finally{proof.mockProviderCalls=provider.calls.length;proof.fixtureSendCount=bridge.sent.length;await fs.writeFile(path.join(output,'report.json'),JSON.stringify(proof,null,2)+'\n');await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await fixture.close();}
console.log(JSON.stringify({passed:proof.passed,cases:proof.cases.map(({name,passed,error})=>({name,passed,error:error?.split('\n')[0]})),mockProviderCalls:proof.mockProviderCalls,fixtureSendCount:proof.fixtureSendCount,output}));
assert.equal(proof.passed,true,'All production UI bulk/draft cases must pass');
