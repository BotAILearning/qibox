import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
import {readGroupInbox} from '../server/ai-group-inbox.mjs';

async function fixture(t){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture(),a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();await a.configure(modelConfig);await a.scan();
 const save=a.save;t.after(async()=>{a.save=save;await a.close();await cleanup(root);});return{a,bridge,provider,root,save};
}
async function pendingWrite(f,{fail=true}={}){
 const entered=Promise.withResolvers(),held=Promise.withResolvers(),file=f.a.file,blocked=path.join(f.root,'blocked-settings-destination');await mkdir(blocked);let first=true;
 f.a.save=function(...args){if(!first)return f.save.apply(this,args);first=false;entered.resolve();return held.promise.then(async()=>{if(fail)this.file=blocked;try{return await f.save.apply(this,args);}finally{this.file=file;}});};
 return{entered:entered.promise,release:()=>held.resolve(),file};
}
for(const [key,before,next]of [['enabled',false,true],['enabled',true,false],['autoLearning',false,true],['autoLearning',true,false]])test(`failed settings ${key} ${before} to ${next} is not committed by a pending ordinary save`,async t=>{
 const f=await fixture(t);await f.a.settings({[key]:before});const watched=key==='autoLearning'&&before?f.a.profiles()[0]:null;if(watched){watched.memoryWatch={pendingAt:1,attempts:2};await f.a.save();}const gate=await pendingWrite(f),operation=f.a.settings({[key]:next}),rejected=assert.rejects(operation,e=>['EISDIR','EPERM','EACCES','ENOTDIR','EEXIST'].includes(e.code));await gate.entered;
 f.a.data.settingsSaveProbe='independent-progress';const background=f.a.save();gate.release();await rejected;await background;
 const disk=JSON.parse(await readFile(gate.file,'utf8'));t.diagnostic(`key=${key} original=${before} requested=${next} request=rejected memory=${f.a.data.settings[key]} disk=${disk.settings[key]} simulatedProviderCalls=${f.provider.calls.length} realProviderCalls=0 sends=${f.bridge.sent.length}`);
 assert.equal(f.a.data.settings[key],before);assert.equal(disk.settings[key],before);assert.equal(disk.settingsSaveProbe,'independent-progress');assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);
 if(watched){assert.deepEqual(watched.memoryWatch,{pendingAt:1,attempts:2});assert.deepEqual(disk.profiles[watched.id].memoryWatch,watched.memoryWatch);}
});
test('invalid settings cannot clear existing learning watch state before persistence',async t=>{
 const f=await fixture(t);await f.a.settings({autoLearning:true});const p=f.a.profiles()[0];p.memoryWatch={pendingAt:1,attempts:2};await f.a.save();const before=structuredClone(p.memoryWatch);
 await assert.rejects(f.a.settings({autoLearning:false,takeover:{enabled:'invalid'}}));assert.equal(f.a.data.settings.autoLearning,true);assert.deepEqual(p.memoryWatch,before);await f.a.save();assert.deepEqual(JSON.parse(await readFile(f.a.file,'utf8')).profiles[p.id].memoryWatch,before);
});
for(const expires of [false,true])test(`failed parent switch retains round, definite-not-sent cache and ${expires?'original five-minute deadline':'cached-answer reuse'}`,async t=>{
 const f=await fixture(t);let now=Date.parse('2026-10-22T08:00:00+08:00');f.a.now=()=>now;f.a.delay=async()=>{};f.bridge.stableMessageIds=true;
 const contact=f.bridge.contacts[0].id;await f.a.setReplyOptions({contact,enabled:true,judgeReply:false});await f.a.settings({enabled:true,proactive:true});await f.a.tick();
 const incoming=f.bridge.push(contact,'other','请回复这条合成测试');incoming.timestamp=Math.floor(now/1000);await f.a.tick();const sender=f.bridge.send.bind(f.bridge);f.bridge.send=()=>({status:'not-sent',diagnostic:{phase:'native-prepare',code:'fixture-controls-unavailable'}});f.provider.next=async()=>({action:'send',text:'保留已生成的合成答复'});now+=20000;await f.a.tick();
 const p=f.a.profiles().find(profile=>profile.contact===contact);assert.equal(f.provider.calls.length,1);assert.equal(p.preparedReply.state,'retry');p.rounds=2;
 f.a.data.queue={status:'running',items:[{id:p.id,status:'pending'}],nextAt:now+60000};await f.a.save();
 const before={preparedReply:structuredClone(p.preparedReply),rounds:p.rounds,replyRoundVersion:p.replyRoundVersion,replyWatchSince:p.replyWatchSince,queue:structuredClone(f.a.data.queue),globalWatch:f.a.data.replyWatchSince};
 const gate=await pendingWrite(f),operation=f.a.settings({enabled:false}),rejected=assert.rejects(operation,e=>['EISDIR','EPERM','EACCES','ENOTDIR','EEXIST'].includes(e.code));await gate.entered;
 (p.sentMessages||=[]).push({id:'concurrent-receipt',source:'reply',at:now});const background=f.a.save();gate.release();await rejected;await background;f.a.save=f.save;
 assert.equal(f.a.data.settings.enabled,true,'failed close is reported as failure and prior effective enabled value remains');assert.deepEqual(p.preparedReply,before.preparedReply);assert.equal(p.rounds,before.rounds);assert.equal(p.replyRoundVersion,before.replyRoundVersion);assert.equal(p.replyWatchSince,before.replyWatchSince);assert.equal(f.a.data.replyWatchSince,before.globalWatch);assert.deepEqual(f.a.data.queue,before.queue);assert.ok(p.sentMessages.some(row=>row.id==='concurrent-receipt'));
 const disk=JSON.parse(await readFile(f.a.file,'utf8'));assert.deepEqual(disk.profiles[p.id].preparedReply,before.preparedReply);assert.equal(disk.profiles[p.id].rounds,2);assert.ok(disk.profiles[p.id].sentMessages.some(row=>row.id==='concurrent-receipt'));
 f.a.data.queue.status='paused';f.bridge.send=sender;now=expires?before.preparedReply.retryStartedAt+300000:now+30000;await f.a.tick();assert.equal(f.provider.calls.length,1,'same incoming message must never generate again after failed settings');assert.equal(f.bridge.sent.length,expires?0:1);if(!expires)assert.equal(f.bridge.sent[0].text,'保留已生成的合成答复');
 t.diagnostic(`realProviderCalls=0 simulatedProviderCalls=${f.provider.calls.length} simulatedSends=${f.bridge.sent.length}; originalRetryStartedAt=${before.preparedReply.retryStartedAt}`);
});
for(const fail of [false,true])test(`${fail?'failed':'successful'} parent switch preserves new group arrivals while settling only observed messages`,async t=>{
 const f=await fixture(t);f.bridge.stableMessageIds=true;f.bridge.contacts[0].kind='group';await f.a.scan();const contact=f.bridge.contacts[0].id;await f.a.setGroupOptions({contact,atMe:true});await f.a.settings({enabled:true});await f.a.tick();
 const p=f.a.profiles().find(row=>row.contact===contact),old=f.bridge.push(contact,'other','合成原来信');old.mentions={verified:true,self:true};await f.a.tick();assert.ok(readGroupInbox(f.a.vault,p).pending.some(row=>row.id===old.id));
 const gate=await pendingWrite(f,{fail}),operation=f.a.settings({enabled:false}),completed=fail?assert.rejects(operation):operation;await gate.entered;
 const incoming=f.bridge.push(contact,'other','合成等待中的新来信');incoming.mentions={verified:true,self:true};const observed=f.a.observe(p,await f.bridge.read({contact}));await new Promise(resolve=>setImmediate(resolve));gate.release();await completed;await observed;
 const inbox=readGroupInbox(f.a.vault,p);assert.deepEqual(new Set(inbox.pending.map(row=>row.id)),new Set(fail?[old.id,incoming.id]:[incoming.id]));assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);
});
