import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
const fields=p=>Object.fromEntries(['manualWait','groupContextWait','replyRetryAt','readRetryAt','sendRetryAt'].map(key=>[key,structuredClone(p[key])]));
async function fixture(t,group=false){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();bridge.stableMessageIds=true;if(group)bridge.contacts[0].kind='group';
 let now=Date.parse('2026-10-22T12:00:00+08:00');const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{},random:min=>min});await a.init();await a.configure(modelConfig);await a.scan();const contact=bridge.contacts[0].id;
 if(group)await a.setGroupOptions({contact,atMe:true});else await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});const save=a.save,tick=a.tick;t.after(async()=>{a.save=save;a.tick=tick;await a.close();await cleanup(root);});return{a,root,bridge,provider,save,tick,contact,p:a.profiles().find(p=>p.contact===contact),advance:ms=>now+=ms};
}
async function holdWrite(f,fail){
 const entered=Promise.withResolvers(),held=Promise.withResolvers(),file=f.a.file,blocked=path.join(f.root,'blocked-skip-destination');await mkdir(blocked);let first=true;
 f.a.save=function(...args){if(!first)return f.save.apply(this,args);first=false;entered.resolve();return held.promise.then(async()=>{if(fail)this.file=blocked;try{return await f.save.apply(this,args);}finally{this.file=file;}});};
 return{entered:entered.promise,release:()=>held.resolve()};
}
for(const group of [false,true])for(const fail of [false,true])test(`skip wait ${group?'group':'person'} ${fail?'failure preserves state and performs no urgent tick':'success commits once and triggers one urgent tick'}`,async t=>{
 const f=await fixture(t,group),now=f.a.now();f.a.cursors.set(f.p.id,{pending:true,changedAt:now-60000,pendingSince:now-60000});f.p.manualWait={ownId:'own',incomingId:'incoming',startedAt:now-60000};if(group)f.p.groupContextWait={trigger:'atMe',dueAt:now+45000};f.p.replyRetryAt=now+60000;f.p.readRetryAt=now+90000;f.p.sendRetryAt=now+120000;await f.a.save();const before=fields(f.p),gate=await holdWrite(f,fail),urgent=[];f.a.tick=async value=>urgent.push(value);
 const operation=f.a.skipReplyWait(f.p.id),completed=fail?assert.rejects(operation,e=>['EPERM','EACCES','EISDIR','ENOTDIR','EEXIST'].includes(e.code)):operation;await gate.entered;assert.deepEqual(fields(f.p),before,'pending configuration must not expose candidate retry gates');
 (f.p.sentMessages||=[]).push({id:'parallel-receipt'});const background=f.a.save();gate.release();const result=await completed;await background;await new Promise(resolve=>setImmediate(resolve));
 const expected=fail?before:{manualWait:undefined,groupContextWait:undefined,replyRetryAt:0,readRetryAt:0,sendRetryAt:0};assert.deepEqual(fields(f.p),expected);assert.deepEqual(fields(JSON.parse(await readFile(f.a.file,'utf8')).profiles[f.p.id]),expected);assert.equal(urgent.length,fail?0:1);if(!fail){assert.equal(result.accepted,true);assert.equal(urgent[0].urgentReplyId,f.p.id);}assert.ok(f.p.sentMessages.some(row=>row.id==='parallel-receipt'));assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);
});
test('skip-wait commits never regenerate a definite-not-sent answer or extend its original deadline',async t=>{
 const f=await fixture(t);await f.a.tick();const message=f.bridge.push(f.contact,'other','请回应合成测试');message.timestamp=Math.floor(f.a.now()/1000);await f.a.tick();f.bridge.send=()=>({status:'not-sent',diagnostic:{phase:'native-prepare',code:'fixture-controls'}});f.provider.next=async()=>({action:'send',text:'已经生成的合成答复'});f.advance(20000);await f.a.tick();const before=structuredClone(f.p.preparedReply);assert.equal(f.provider.calls.length,1);assert.equal(before.state,'retry');
 const urgent=[];f.a.tick=async value=>urgent.push(value);await f.a.skipReplyWait(f.p.id);await new Promise(resolve=>setImmediate(resolve));assert.equal(urgent.length,1);assert.deepEqual(f.p.preparedReply,before);assert.equal(f.provider.calls.length,1);
 f.a.tick=f.tick;f.advance(before.retryStartedAt+300000-f.a.now());await f.a.tick();assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,0);assert.equal(f.p.preparedReply,undefined);t.diagnostic('simulatedProviderCalls=1 realProviderCalls=0 simulatedSends=0; original five-minute retry deadline enforced');
});
