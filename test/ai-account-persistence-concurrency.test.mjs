import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';

async function fixture(t){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture(),a=new AIAssistant({dataRoot:root,bridge,provider,delay:async()=>{}});
 await a.init();await a.configure(modelConfig);await a.scan();const save=a.save;
 t.after(async()=>{a.save=save;await a.close();await cleanup(root);});
 return{a,bridge,provider,root,save};
}

// Delay the real first write and then fail atomic rename against a directory.
// Background save remains the real production saver, rather than a fake throw.
async function pendingWrite(f,{fail=true}={}){
 const entered=Promise.withResolvers(),held=Promise.withResolvers(),file=f.a.file,blocked=path.join(f.root,'blocked-json-destination');
 await mkdir(blocked);let first=true;
 f.a.save=function(...args){
  if(!first)return f.save.apply(this,args);
  first=false;entered.resolve();
  return held.promise.then(async()=>{
   if(fail)this.file=blocked;
   try{return await f.save.apply(this,args);}finally{this.file=file;}
  });
 };
 return{entered:entered.promise,release:()=>held.resolve(),file};
}

const cases={
 'global strategy':async f=>{await f.a.configuration({type:'global-reply-strategy',strategy:{replyGoal:'saved',facts:'saved-fact',boundaries:'saved-boundary',maxRounds:37}});const account=f.a.data.account;return{run:()=>f.a.configuration({type:'global-reply-strategy',account,changes:{facts:'pending-fact'},expected:{facts:'saved-fact'}}),project:data=>data.globalReplyStrategies[account]};},
 'personal group sharing':async f=>{await f.a.configuration({type:'personal-information',entries:[{id:'private-info',field:'city',text:'private-city',allowGroup:false}]});const account=f.a.data.account;return{run:()=>f.a.configuration({type:'personal-information',account,entries:[{id:'private-info',field:'city',text:'private-city',allowGroup:true}]}),project:data=>f.a.vault.open(data.personalInformation[account])};},
 'record cleanup':async f=>{f.a.data.skipLog=[{id:'old-skip',account:f.a.data.account,at:f.a.now(),text:'synthetic skip'}];await f.a.save();const preview=await f.a.configuration({type:'clear-records',source:'skip'});return{run:()=>f.a.configuration({type:'clear-records',token:preview.confirmation.token}),project:data=>data.skipLog};},
 'default style':async f=>{await f.a.saveDefaultStyle({summary:'saved-default'});return{run:()=>f.a.saveDefaultStyle({summary:'pending-default'}),project:data=>data.learnedDefaultStyle};},
};
for(const [name,prepare]of Object.entries(cases))test(`failed ${name} cannot be persisted by a pending ordinary save`,async t=>{
 const f=await fixture(t),c=await prepare(f),before=structuredClone(c.project(f.a.data)),gate=await pendingWrite(f);
 const operation=c.run(),rejected=assert.rejects(operation,e=>['EISDIR','EPERM','EACCES','ENOTDIR','EEXIST'].includes(e.code));await gate.entered;
 f.a.data.pendingSaveProbe='unrelated-progress';const background=f.a.save();gate.release();await rejected;await background;
 assert.deepEqual(c.project(f.a.data),before,'failed operation is rolled back in memory');
 const disk=JSON.parse(await readFile(gate.file,'utf8'));
 assert.deepEqual(c.project(disk),before,'ordinary save must take a fresh snapshot only after rollback');
 assert.equal(disk.pendingSaveProbe,'unrelated-progress');assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);
 t.diagnostic(`${name}: real filesystem failure; memory and decrypted persisted projection retained; simulatedProviderCalls=0 realProviderCalls=0 sends=0`);
});
test('ordinary save after a successful pending default commit persists both changes',async t=>{
 const f=await fixture(t),c=await cases['default style'](f),gate=await pendingWrite(f,{fail:false}),operation=c.run();await gate.entered;
 f.a.data.pendingSaveProbe='unrelated-progress';const background=f.a.save();gate.release();await operation;await background;
 const disk=JSON.parse(await readFile(gate.file,'utf8'));assert.equal(disk.learnedDefaultStyle.style.summary,'pending-default');assert.equal(disk.pendingSaveProbe,'unrelated-progress');
});

for(const name of ['personal group sharing','global strategy'])test(`group reply cannot use uncommitted ${name} while its persistence is pending`,async t=>{
 const f=await fixture(t);f.bridge.stableMessageIds=true;f.bridge.contacts[0].kind='group';await f.a.scan();
 await f.a.setGroupOptions({contact:f.bridge.contacts[0].id,atMe:true});await f.a.settings({enabled:true});
 const profile=f.a.profiles().find(p=>p.contact===f.bridge.contacts[0].id);
 const c=await cases[name](f),gate=await pendingWrite(f),operation=c.run(),rejected=assert.rejects(operation,e=>['EISDIR','EPERM','EACCES','ENOTDIR','EEXIST'].includes(e.code));
 await gate.entered;
 const message=f.bridge.push(profile.contact,'other','请介绍你的城市');message.mentions={verified:true,self:true,all:false,others:false};
 const snapshot=await f.bridge.read({contact:profile.contact});
 f.provider.next=async()=>({action:'stop',stop:true});
 const generation=f.a.generate(profile,snapshot,'reply',f.a.revision,f.a.controller.signal);
 await new Promise(resolve=>setImmediate(resolve));
 const callsWhilePending=f.provider.calls.length;gate.release();await rejected;await generation;
 assert.equal(callsWhilePending,0,'normal group observation must persist before reading reply context');
 const input=JSON.stringify(f.provider.calls.map(call=>call.input));assert.doesNotMatch(input,/pending-fact/);
 for(const call of f.provider.calls)assert.ok(call.input.myInformation.every(row=>row.text!=='private-city'),'uncommitted allowGroup must not enter group context');
 assert.equal(f.provider.calls.length,1,'the safe post-rollback request proves this is not a non-running test');assert.equal(f.bridge.sent.length,0);
 t.diagnostic(`${name}: pendingProviderCalls=${callsWhilePending} simulatedProviderCalls=${f.provider.calls.length} realProviderCalls=0 sends=${f.bridge.sent.length}; safe post-rollback group request actually reached the simulated provider`);
});
