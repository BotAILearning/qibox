import test from 'node:test';
import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {readMemory,mergeMemory,editMemory} from '../server/ai-wiki.mjs';
import {ChatFixture,AIModelFixture,modelConfig,strategy} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
import {validateClipboardFiles} from '../server/clipboard.mjs';
async function fixture(t){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let now=Date.UTC(2026,8,17,0);
 const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{}});await a.init();
 t.after(async()=>{await a.close();await cleanup(root);});await a.configure(modelConfig);await a.scan();
 return {a,bridge,provider,advance:ms=>now+=ms};
}
test('Wiki appends facts, protects manual entries, retains others, encrypts history, and rolls back',async t=>{
 const {a}=await fixture(t),p={};
 Object.assign(p,editMemory(a.vault,p,{summary:'本人明确的旧约定'},1));
 const manual=readMemory(a.vault,p).entries[0];
 Object.assign(p,mergeMemory(a.vault,p,{entries:[{id:manual.id,text:'相反的新约定'},{text:'新事实',manual:true}]},2));
 assert.equal(readMemory(a.vault,p).summary,'本人明确的旧约定\n新事实');
 assert.equal(readMemory(a.vault,p).entries[1].manual,undefined);
 assert.equal(readMemory(a.vault,p,'memorySuggestion').summary,'相反的新约定');
 assert.doesNotMatch(JSON.stringify(p),/旧约定|新事实/);
 Object.assign(p,editMemory(a.vault,p,{restoreId:p.memoryHistory[0].id},3));
 assert.equal(readMemory(a.vault,p).summary,'本人明确的旧约定');
 assert.throws(()=>editMemory(a.vault,{}, {restoreId:p.memoryHistory[0].id},4),/历史版本/);
});
test('chat memory accepts only evidence IDs actually supplied for this contact',async t=>{
 const {a}=await fixture(t),p={};
 Object.assign(p,mergeMemory(a.vault,p,{entries:[{text:'有依据',evidence:['m1']},{text:'未发送承诺',evidence:['planned']},{text:'无证据'}]},1,{evidence:new Set(['m1'])}));
 assert.equal(readMemory(a.vault,p).summary,'有依据');
});
test('analysis omits unreadable bodies but keeps database errors visible',async t=>{
 const {a,bridge,provider}=await fixture(t);let fail=false;
 bridge.readRange=async args=>{assert.equal(args.skipUnparsed,true);if(fail)throw Error('database unavailable');return {account:args.account,contact:args.contact,messages:[{id:'bad',text:'',timestamp:args.from},{id:'ok',text:'有效信息',timestamp:args.from+1}]};};
 provider.complete=async(_c,_s,input)=>{assert.deepEqual(input.messages.map(m=>m.id),['ok']);return {report:'完成'};};
 const args={contacts:[bridge.contacts[0].id],request:'总结',from:'2026-09-01',to:'2026-09-02'};
 const result=await a.analyze(args);assert.equal(result.reports[0].skipped,1);assert.equal(result.reports[0].count,1);
 fail=true;assert.equal((await a.analyze(args)).reports[0].status,'error');
});
test('clipboard rejects paths, duplicate filenames and invalid base64 before staging',()=>{
 const good={name:'截图.png',type:'image/png',data:Buffer.from('fixture').toString('base64')};
 assert.equal(validateClipboardFiles([good]).length,1);
 for(const files of [[{...good,name:'../x'}],[good,good],[{...good,data:'!!!'}],Array(11).fill(good)])assert.throws(()=>validateClipboardFiles(files));
});

test('individual task pause/edit/resume retains its target and uses saved edits at execution',async t=>{
 const {a,bridge,provider}=await fixture(t);
 await a.saveStrategy(strategy);await a.prepareTargets({contacts:bridge.contacts.slice(0,2).map(c=>c.id)});
 await a.settings({enabled:true,proactive:true,reply:false});await a.queueAction('start');
 const id=a.data.queue.items[0].id;
 await a.queueAction({command:'pause',id});assert.equal(a.data.queue.items[0].status,'paused');
 await a.queueAction({command:'edit',id,value:{...strategy,purpose:'修改后的邀请'}});
 await a.tick();assert.equal(bridge.sent.length,1);assert.equal(a.data.queue.items[0].status,'paused');
 assert.notEqual(a.data.queue.status,'completed');
 await a.queueAction({command:'resume',id});
 provider.next=async input=>{assert.equal(input.strategy.purpose,'修改后的邀请');return {action:'send',text:'新的邀请。'};};
 await a.tick();assert.equal(bridge.sent.length,2);assert.equal(a.data.queue.status,'completed');
 await assert.rejects(a.queueAction({command:'resume',id}),/任务已变化/);
});

test('scheduled task edits replace the paused occurrence and keep future schedule paused',async t=>{
 const {a,bridge,advance}=await fixture(t);
 await a.settings({enabled:true,proactive:true,reply:false});
 await a.scheduleAction({time:'每天上午9点',strategy,contacts:[bridge.contacts[0].id]});
 const s=a.data.schedules[0];await a.scheduleAction({command:'pause',id:s.id});advance(86400000);
 await a.scheduledTick(a.revision);assert.equal(a.data.queue.status,'idle');
 await a.scheduleAction({command:'edit',id:s.id,time:'每天上午10点',strategy:{...strategy,purpose:'新目标'},contacts:[bridge.contacts[1].id]});
 assert.equal(s.status,'paused');assert.equal(s.targets.length,1);assert.equal(s.strategy.purpose,'新目标');
 await a.scheduleAction({command:'resume',id:s.id});assert.equal(s.status,'active');
});

test('pre-submit failures stop after three attempts; uncertain is never automatically retried',async t=>{
 const {a,bridge,advance}=await fixture(t);let sends=0;
 await a.saveStrategy(strategy);await a.prepareTargets({contacts:[bridge.contacts[0].id]});await a.settings({enabled:true,proactive:true,reply:false});await a.queueAction('start');
 bridge.send=async()=>{sends++;return {status:'not-sent',diagnostic:{phase:'native-navigation',code:'controls-unavailable'}};};
 for(let i=0;i<4;i++){a.available=true;await a.proactiveTick(a.revision,a.controller.signal);advance(100000);}
 assert.equal(sends,3);assert.equal(a.data.queue.status,'failed');assert.equal(a.data.queue.items[0].diagnostic.phase,'native-navigation');
 a.available=true;await a.queueAction({command:'resume',id:a.data.queue.items[0].id});
 bridge.send=async()=>{sends++;return {status:'uncertain'};};await a.proactiveTick(a.revision,a.controller.signal);
 await assert.rejects(a.queueAction({command:'resume',id:a.data.queue.items[0].id}),/核对/);advance(100000);await a.proactiveTick(a.revision,a.controller.signal);assert.equal(sends,4);
});
