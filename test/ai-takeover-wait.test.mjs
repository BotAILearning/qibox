import test from 'node:test';
import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
async function fixture(t,kind='person'){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();bridge.stableMessageIds=true;bridge.contacts[0].kind=kind;
 let now=1700000000000,a;const contact=bridge.contacts[0].id;
 const create=async()=>{a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{}});await a.init();await a.scan();};
 await create();await a.configure(modelConfig);
 if(kind==='group')await a.setGroupOptions({contact,atMe:true});else await a.setReplyOptions({contact,enabled:true});
 await a.settings({enabled:true,takeover:{enabled:true,minutes:1}});await a.tick();
 t.after(async()=>{await a.close();await cleanup(root);});
 return {get a(){return a;},bridge,provider,get p(){return a.profiles()[0];},advance:ms=>{now+=ms;},async push(direction,text='测试消息'){
  const m=bridge.push(contact,direction,text);Object.assign(m,{timestamp:Math.floor(now/1000),mentions:{verified:true,self:true,all:false,others:false}});await a.tick();return m;
 },async restart(){await a.close();await create();}};
}
for(const kind of ['person','group'])test(`${kind}: takeover starts at first incoming, keeps original deadline through more messages`,async t=>{
 const f=await fixture(t,kind);await f.push('self');f.advance(120000);await f.a.tick();assert.equal(f.bridge.sent.length,0);
 await f.push('other','第一条');const due=f.a.liveStates().find(x=>x.reason==='手动回复后的接续等待')?.dueAt;assert.ok(due);
 f.advance(40000);await f.push('other','第二条');assert.equal(f.a.liveStates().find(x=>x.reason==='手动回复后的接续等待')?.dueAt,due);
 f.advance(19999);await f.a.tick();assert.equal(f.provider.calls.length,0);
 f.advance(1);await f.a.tick();assert.equal(f.bridge.sent.length,1);
});
test('manual reply ends the pending round; next incoming begins a new full wait',async t=>{
 const f=await fixture(t);await f.push('self');await f.push('other');f.advance(50000);await f.push('self','这轮我处理');f.advance(20000);await f.a.tick();assert.equal(f.bridge.sent.length,0);
 await f.push('other','新一轮');f.advance(59999);await f.a.tick();assert.equal(f.bridge.sent.length,0);f.advance(1);await f.a.tick();assert.equal(f.bridge.sent.length,1);
});
test('disabled takeover never sends on a timer; explicit saved reply can resume new messages',async t=>{
 const f=await fixture(t);await f.a.settings({takeover:{enabled:false,minutes:1}});await f.push('self');await f.push('other');f.advance(86400000);await f.a.tick();assert.equal(f.bridge.sent.length,0);
 await f.a.saveReplyProfile({contact:f.p.contact,style:f.p.style,strategy:f.a.data.replyStrategy,replyEnabled:true});
 f.advance(1000);await f.push('other','保存后新消息');f.advance(3000);await f.a.tick();assert.equal(f.bridge.sent.length,1);
});
test('restart preserves elapsed wait and pending incoming without restarting the timer',async t=>{
 const f=await fixture(t);await f.push('self');await f.push('other');const started=f.p.manualWait?.startedAt;assert.ok(started);f.advance(40000);await f.restart();await f.a.tick();assert.equal(f.p.manualWait.startedAt,started);
 f.advance(19999);await f.a.tick();assert.equal(f.bridge.sent.length,0);f.advance(1);await f.a.tick();assert.equal(f.bridge.sent.length,1);
});
test('AI generated self messages do not arm takeover, explicit stop remains stopped after expiry',async t=>{
 const f=await fixture(t);await f.push('other');f.advance(3000);await f.a.tick();assert.equal(f.bridge.sent.length,1);await f.a.tick();assert.equal(f.p.manualWait,undefined);
 await f.push('self');await f.push('other');f.a.pauseProfile(f.p,'explicit');f.advance(60000);await f.a.tick();assert.equal(f.bridge.sent.length,1);assert.equal(f.p.paused,true);
});
