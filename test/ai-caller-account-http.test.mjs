import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key, strategy } from './ai-fixtures.mjs';

async function fixture(t) {
  const dataRoot=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();
  const app=await createApplication({appRoot:root,dataRoot,fetcher,extract:extractor,aiProvider:provider,trustedHashes:[packageSha256],runtimeFactory:(...args)=>({...runtimeFactory(...args),aiBridge:bridge})});
  t.after(async()=>{try{assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);}finally{await app.close();await cleanup(dataRoot);}});
  const socketPath=process.platform==='win32'?`\\\\.\\pipe\\qibox-caller-account-${process.pid}-${Date.now()}`:path.join(dataRoot,'caller.sock');
  await new Promise(resolve=>app.server.listen(socketPath,resolve));let token;
  const call=(route,data)=>new Promise((resolve,reject)=>{const req=http.request({socketPath,path:'/app/qibox/api'+route,method:data===undefined?'GET':'POST',headers:{'x-trim-userid':'1001',...(data===undefined?{}:{'content-type':'application/json','x-csrf-token':token})}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(text)}));});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});
  token=(await call('/session')).value.csrf;await call('/consent',{accepted:true});await call('/install/download',{});await app.library.working;assert.equal(app.library.job?.status,'complete');
  const instance=(await call('/instances',{name:'隔离旧页面账号测试'})).value;await call(`/instances/${instance.id}/start`,{});const ai=(await app.users.get('1001')).get(instance.id).ai;
  await ai.configure(modelConfig);await ai.scan();const contact=bridge.contacts[0].id,A=bridge.account,B=key('caller-account-B');
  await ai.saveReplyProfile({contact,style:{summary:'A 的原有表达'},strategy:{...strategy,maxRounds:50},preserveSwitches:true,replyEnabled:false});
  const oldProfile=structuredClone(ai.profiles().find(x=>x.contact===contact));
  // Another window's verified read has already advanced the real service to B.
  bridge.account=B;const route=`/instances/${instance.id}/ai`;assert.equal((await call(route)).value.account,B);
  await ai.saveReplyProfile({contact,style:{summary:'B 的独立表达'},strategy:{...strategy,maxRounds:60},preserveSwitches:true,replyEnabled:false});
  return {ai,bridge,call,route,contact,A,B,oldProfile};
}

for(const action of ['reply-profile','settings'])for(const supplied of ['old-account','missing-account'])test(`HTTP rejects stale page ${action} after the service has fully switched: ${supplied}`,async t=>{
  const f=await fixture(t),before=await readFile(f.ai.file,'utf8');
  const request={action,...(supplied==='old-account'?{expectedAccount:f.A}:{}),value:action==='settings'?{enabled:true}:{contact:f.contact,style:{summary:'OLD_PAGE_A_MUST_NOT_ENTER_B'},strategy:{...strategy,maxRounds:51},preserveSwitches:true,replyEnabled:false}};
  const response=await f.call(f.route,request);
  t.diagnostic(JSON.stringify({status:response.status,currentIsB:f.ai.data.account===f.B,oldPageStyleEnteredB:f.ai.profiles().find(x=>x.contact===f.contact)?.style?.summary==='OLD_PAGE_A_MUST_NOT_ENTER_B',oldPageEnabledB:f.ai.data.settings.enabled}));
  assert.equal(response.status,409,'The already-scanned B identity must not authorize a stale A page');
  assert.equal(response.value.code,'AI_SCOPE_CHANGED');if(supplied==='missing-account')assert.match(response.value.error,/刷新栖盒页面/);assert.equal(await readFile(f.ai.file,'utf8'),before,'No B setting, style or history may be changed');
});

test('HTTP accepts the current B caller and preserves the stored A profile',async t=>{
  const f=await fixture(t),response=await f.call(f.route,{action:'reply-profile',expectedAccount:f.B,value:{contact:f.contact,style:{summary:'B 明确保存的新表达'},strategy:{...strategy,maxRounds:61},preserveSwitches:true,replyEnabled:false}});
  assert.equal(response.status,200);assert.equal(response.value.account,f.B);const b=f.ai.profiles().find(x=>x.contact===f.contact);assert.equal(b.replyStrategy.maxRounds,61);assert.equal(b.style.summary,'B 明确保存的新表达');assert.deepEqual(f.ai.data.profiles[f.oldProfile.id],f.oldProfile);
});

test('HTTP stale caller cannot read B account records and malformed callers cannot enable B',async t=>{
  const f=await fixture(t),before=await readFile(f.ai.file,'utf8');
  for(const action of ['error-records','skip-records','activity-records']){
    const response=await f.call(f.route,{action,expectedAccount:f.A,ids:[],value:{limit:50}});
    assert.equal(response.status,409);assert.equal(response.value.code,'AI_SCOPE_CHANGED');assert.equal(JSON.stringify(response).includes('B 的独立表达'),false);
  }
  for(const expectedAccount of [null,1,[],{},'display-name']){
    const response=await f.call(f.route,{action:'settings',expectedAccount,value:{enabled:true,account:f.B}});
    assert.equal(response.status,409);assert.equal(response.value.code,'AI_SCOPE_CHANGED');
  }
  assert.equal(await readFile(f.ai.file,'utf8'),before);
});

test('HTTP already account-bearing current settings remain compatible without a top-level duplicate',async t=>{
  const f=await fixture(t),response=await f.call(f.route,{action:'settings',value:{account:f.B,enabled:false}});
  assert.equal(response.status,200);assert.equal(response.value.account,f.B);assert.equal(response.value.settings.enabled,false);assert.deepEqual(f.ai.data.profiles[f.oldProfile.id],f.oldProfile);
});
