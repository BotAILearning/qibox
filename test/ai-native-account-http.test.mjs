import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root } from '../scripts/tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from './fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';

async function fixture(t) {
  const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const app = await createApplication({ appRoot: root, dataRoot, fetcher, extract: extractor, aiProvider: provider, trustedHashes: [packageSha256],
    runtimeFactory: (...args) => ({ ...runtimeFactory(...args), aiBridge: bridge }) });
  // Register before initialization: a failed installation must still close the
  // listener and timers, and must never turn a fixture failure into a hung suite.
  t.after(async()=>{
    try { assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0); }
    finally { await app.close();await cleanup(dataRoot); }
  });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\qibox-test-native-scope-${process.pid}-${Date.now()}` : path.join(dataRoot,'scope.sock');
  await new Promise(resolve=>app.server.listen(socketPath,resolve));
  const call = (route, data, uid = '1001', csrf) => new Promise((resolve,reject) => {
    if (data?.action && /\/ai(?:\?|$)/.test(route) && !Object.hasOwn(data, 'expectedAccount')) data = { ...data, expectedAccount: bridge.account };
    const req = http.request({ socketPath, path:'/app/qibox/api'+route, method:data===undefined?'GET':'POST', headers:{'x-trim-userid':uid,...(data===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf||token})}},res=>{
      let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(body)}));
    });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
  });
  let token = (await call('/session')).value.csrf;
  await call('/consent',{accepted:true});await call('/install/download',{});await app.library.working;
  assert.equal(app.library.job?.status,'complete',app.library.lastError || app.library.job?.message);
  const instance = (await call('/instances',{name:'隔离账号门禁测试'})).value;
  await call(`/instances/${instance.id}/start`,{});
  const ai = (await app.users.get('1001')).get(instance.id).ai;
  await ai.configure(modelConfig);await ai.scan();
  await ai.setReplyOptions({contact:bridge.contacts[0].id,enabled:false});
  await ai.configuration({type:'personal-information',account:ai.data.account,entries:[{field:'city',text:'PRIVATE_OLD_NATIVE_ACCOUNT'}]});
  return {app,ai,bridge,provider,call,route:`/instances/${instance.id}/ai`,oldAccount:bridge.account,newAccount:key('new-native-http-account')};
}

test('HTTP reads authenticate native identity and replace cached private fields after a switch without a prior scan', async t=>{
  const f=await fixture(t);assert.equal((await f.call(f.route)).value.personalInformation.entries[0].text,'PRIVATE_OLD_NATIVE_ACCOUNT');
  f.bridge.account=f.newAccount;
  for(const suffix of ['?view=live','']){const response=await f.call(f.route+suffix);assert.equal(response.status,200);assert.equal(response.value.account,f.newAccount);assert.equal(JSON.stringify(response).includes('PRIVATE_OLD_NATIVE_ACCOUNT'),false);}
  assert.equal(f.ai.data.settings.enabled,false);
});

test('HTTP rejects old native account mutations before contacts are rescanned', async t=>{
  const f=await fixture(t),before=await readFile(f.ai.file,'utf8');f.bridge.account=f.newAccount;
  const actions=[
    {action:'settings',value:{enabled:true}},{action:'settings',value:{autoLearning:true}},
    {action:'reply-options',value:{contact:f.bridge.contacts[0].id,enabled:true}},
    {action:'configuration',value:{type:'personal-information',account:f.oldAccount,entries:[{field:'city',text:'WRONG'}]}},
    {action:'configuration',value:{type:'global-reply-strategy',account:f.oldAccount,changes:{facts:'WRONG'},expected:{facts:f.ai.globalReplyStrategy().facts||''}}},
    {action:'clear-activity-errors'},
  ];
  for(const action of actions){const response=await f.call(f.route,action);assert.equal(response.status,409,action.action);assert.equal(response.value.code,'AI_SCOPE_CHANGED');assert.equal(await readFile(f.ai.file,'utf8'),before);}
});

test('unavailable identity returns no cached private data and safe cancel/close never waits for that reader', async t=>{
  const f=await fixture(t);f.bridge.currentAccount=async()=>{throw Error('unavailable');};
  const unknown=await f.call(f.route);assert.equal(unknown.status,409);assert.equal(unknown.value.code,'AI_ACCOUNT_UNVERIFIED');assert.equal(JSON.stringify(unknown).includes('PRIVATE_OLD_NATIVE_ACCOUNT'),false);
  f.bridge.currentAccount=()=>new Promise(()=>{});
  for(const action of [{action:'cancel'},{action:'settings',value:{enabled:false}}]){
    const response=await f.call(f.route,action);assert.equal(response.status,200);assert.equal(response.value.scopeUnknown,true);assert.equal(response.value.settings.enabled,false);assert.equal(JSON.stringify(response).includes('PRIVATE_OLD_NATIVE_ACCOUNT'),false);
  }
});

for (const identity of ['unknown', 'changed']) {
  test(`HTTP empty target selection cannot erase saved account configuration while native identity is ${identity}`, async t=>{
    const f=await fixture(t),profile=f.ai.profiles()[0];
    await f.ai.targets([profile.id]);
    f.ai.data.settings.replyScope='all';await f.ai.save();
    assert.deepEqual(f.ai.data.replyTargets,[profile.id]);assert.deepEqual(f.ai.data.proactiveTargets,[profile.id]);
    const before=await readFile(f.ai.file,'utf8');
    if(identity==='unknown')f.bridge.currentAccount=async()=>{throw Error('synthetic identity unavailable');};else f.bridge.account=f.newAccount;
    for(const mode of [undefined,'reply','proactive']){
      const response=await f.call(f.route,{action:'targets',ids:[],...(mode?{mode}:{})});
      assert.equal(response.status,409,mode||'both target lists');
      assert.equal(response.value.code,identity==='unknown'?'AI_ACCOUNT_UNVERIFIED':'AI_SCOPE_CHANGED');
      assert.equal(await readFile(f.ai.file,'utf8'),before);
      assert.equal(f.ai.data.settings.replyScope,'all');assert.deepEqual(f.ai.data.replyTargets,[profile.id]);assert.deepEqual(f.ai.data.proactiveTargets,[profile.id]);
    }
  });
  test(`HTTP ending a proactive task requires verified native identity when it is ${identity}`, async t=>{
    const f=await fixture(t);
    const created=await f.ai.proactiveTaskAction({command:'create',name:'身份门禁任务',taskType:'custom',contacts:[f.bridge.contacts[0].id],goal:'只验证任务保存',schedule:{cycle:'weekly',mode:'fixed',time:'14:40',weekdays:[5]}});
    const id=created.proactiveTasks[0].id;await f.ai.settings({enabled:false,proactive:false});
    const before=await readFile(f.ai.file,'utf8');
    if(identity==='unknown')f.bridge.currentAccount=async()=>{throw Error('synthetic identity unavailable');};else f.bridge.account=f.newAccount;
    const response=await f.call(f.route,{action:'proactive-task',value:{command:'end',id}});
    assert.equal(response.status,409);assert.equal(response.value.code,identity==='unknown'?'AI_ACCOUNT_UNVERIFIED':'AI_SCOPE_CHANGED');
    assert.equal(await readFile(f.ai.file,'utf8'),before);assert.equal(f.ai.data.proactiveTasks.find(t=>t.id===id).status,'running');
  });
}

test('HTTP still pauses tasks and closes parent switches immediately when the native identity reader is held', async t=>{
  const f=await fixture(t);
  const created=await f.ai.proactiveTaskAction({command:'create',name:'可立即暂停的任务',taskType:'custom',contacts:[f.bridge.contacts[0].id],goal:'只验证任务保存',schedule:{cycle:'weekly',mode:'fixed',time:'14:40',weekdays:[5]}});
  const id=created.proactiveTasks[0].id;f.bridge.currentAccount=()=>new Promise(()=>{});
  for(const action of [{action:'settings',value:{enabled:false,reply:false,proactive:false,autoLearning:false}},{action:'proactive-task',value:{command:'pause',id}},{action:'cancel'}]){
    const response=await f.call(f.route,action);assert.equal(response.status,200);assert.equal(response.value.scopeUnknown,true);assert.equal(response.value.proactiveTasks.length,0);
  }
  assert.equal(f.ai.data.proactiveTasks.find(t=>t.id===id).status,'paused');assert.equal(f.ai.data.settings.enabled,false);
});

for(const action of ['targets','prepare-targets','reply-options','proactive-task'])test(`HTTP ${action} remains bound to its originally verified account after another scan completes in the queue`,async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers(),identityRead=Promise.withResolvers();
  await f.ai.settings({replyScope:'all'});
  const hold=f.ai.exclusive(async()=>{entered.resolve();await release.promise;});await entered.promise;const heldTail=f.ai.actions;
  f.bridge.currentAccount=async()=>{identityRead.resolve();return {account:f.bridge.account};};
  const actions={
    targets:{action:'targets',ids:[],mode:'reply'},
    'prepare-targets':{action:'prepare-targets',value:{contacts:[f.bridge.contacts[0].id]}},
    'reply-options':{action:'reply-options',value:{contact:f.bridge.contacts[0].id,enabled:true}},
    'proactive-task':{action:'proactive-task',value:{command:'create',name:'旧请求不得写入新账号',taskType:'custom',contacts:[f.bridge.contacts[0].id],goal:'只验证请求账号绑定',schedule:{cycle:'once',at:'2099-01-01T14:40'}}},
  };
  try{
    const pending=f.call(f.route,actions[action]);await identityRead.promise;
    for(let attempt=0;attempt<100&&f.ai.actions===heldTail;attempt++)await new Promise(resolve=>setImmediate(resolve));
    assert.notEqual(f.ai.actions,heldTail,'The real HTTP action must enter the held application queue');
    f.bridge.account=f.newAccount;await f.ai.scan();assert.equal(f.ai.data.account,f.newAccount);
    const before=await readFile(f.ai.file,'utf8');release.resolve();await hold;const response=await pending;
    assert.equal(response.status,409);assert.equal(response.value.code,'AI_SCOPE_CHANGED');
    assert.equal(await readFile(f.ai.file,'utf8'),before);assert.equal(f.ai.data.settings.replyScope,'all');
  }finally{release.resolve();await hold;}
});

test('independent model configuration and parent closing remain available without an account request scope',async t=>{
  const f=await fixture(t);f.bridge.currentAccount=async()=>{throw Error('synthetic unknown native account');};
  const configured=await f.call(f.route,{action:'configure',value:{...modelConfig,model:'independent-model-change'}});
  assert.equal(configured.status,200);assert.equal(configured.value.scopeUnknown,true);assert.equal(configured.value.provider.model,'independent-model-change');
  assert.equal(JSON.stringify(configured).includes('PRIVATE_OLD_NATIVE_ACCOUNT'),false);
  const closed=await f.call(f.route,{action:'settings',value:{enabled:false,reply:false,proactive:false,autoLearning:false}});
  assert.equal(closed.status,200);assert.equal(closed.value.scopeUnknown,true);assert.equal(f.ai.data.settings.enabled,false);
});

// Removed feature: even an obsolete authenticated page cannot incur a request.
test('retired style trial actions return410 without reading native identity, saving or calling a model',async t=>{
 const f=await fixture(t),before=await readFile(f.ai.file,'utf8');f.bridge.currentAccount=async()=>{throw Error('must not read identity for a removed action');};
 for(const action of ['style-trial','style-trial-cancel']){const r=await f.call(f.route,{action,value:{account:f.oldAccount,style:{summary:'old browser'}}});assert.equal(r.status,410);assert.equal(r.value.code,'ai_style_trial_removed');assert.equal(await readFile(f.ai.file,'utf8'),before);}
 assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);
});
