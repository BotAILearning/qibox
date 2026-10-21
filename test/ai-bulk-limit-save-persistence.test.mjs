import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';

for(const kind of ['person','group'])for(const existing of [false,true])test(`failed ${kind} bulk limit with ${existing?'existing':'no'} profile cannot leak through ordinary saves`,async t=>{
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();bridge.contacts[0].kind=kind;
 const a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();await a.configure(modelConfig);await a.scan();const save=a.save;t.after(async()=>{a.save=save;await a.close();await cleanup(root);});
 if(existing){if(kind==='person')await a.setReplyOptions({contact:bridge.contacts[0].id,enabled:false});else await a.setGroupOptions({contact:bridge.contacts[0].id,atMe:false});}
 const account=a.data.account,p=a.profiles()[0];if(p){p.replyStrategy={replyGoal:'original',facts:'original-fact',boundaries:'original-boundary',maxRounds:37};await a.save();}
 const before=structuredClone(a.data.accountReplyRoundLimits[account]),strategy=p&&structuredClone(p.replyStrategy),file=a.file,blocked=path.join(root,'blocked-bulk-limit-json');await mkdir(blocked);
 const entered=Promise.withResolvers(),held=Promise.withResolvers();let first=true;a.save=function(...args){if(!first)return save.apply(this,args);first=false;entered.resolve();return held.promise.then(async()=>{this.file=blocked;try{return await save.apply(this,args);}finally{this.file=file;}});};
 const operation=a.applyReplyLimitToKind(kind,13,{account,contacts:[...a.contacts.values()].filter(row=>row.kind===kind).map(row=>row.id)}),rejected=assert.rejects(operation,e=>['EPERM','EACCES','EISDIR','ENOTDIR','EEXIST'].includes(e.code));await entered.promise;
 if(p)(p.sentMessages||=[]).push({id:'concurrent-receipt'});a.data.bulkSaveProbe='unrelated-progress';const background=a.save();held.resolve();await rejected;await background;
 const disk=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(a.data.accountReplyRoundLimits[account],before);assert.deepEqual(disk.accountReplyRoundLimits[account],before);if(p){assert.deepEqual(p.replyStrategy,strategy);assert.deepEqual(disk.profiles[p.id].replyStrategy,strategy);assert.ok(disk.profiles[p.id].sentMessages.some(row=>row.id==='concurrent-receipt'));}assert.equal(disk.bulkSaveProbe,'unrelated-progress');assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);
});
