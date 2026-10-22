import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { neutralGeneratedReplyRepair } from '../server/ai-personal-answer.mjs';
import { AIModelFixture, ChatFixture, key, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const now = Date.parse('2026-10-22T15:00:00+08:00'), ts = now / 1000;
const raw = '明天上午十点集合，九点那条作废。';
const expected = '明天十点集合，九点那条作废。';
const member = key('member-a');
const source = (text, timestamp) => ({ direction:'other', text, timestamp, sender:member, speaker:{id:member,identified:true} });
const context = {
  kind:'group',mode:'reply',now,timezone:'Asia/Shanghai',
  messages:[source('明天九点集合。',ts-1200),source('更正，刚才九点那条作废，改成十点。',ts-900)],
  pendingMessages:[source('所以几点？',ts-60)],
};

test('actual023 GQ04 preserves a proven cancellation while removing invented daypart', async t => {
  const root=await temp(), bridge=new ChatFixture(), provider=new AIModelFixture(); let clock=now;
  bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);
  bridge.contacts[0].kind='group'; await a.scan(); const contact=bridge.contacts[0].id;
  for (const m of context.messages) Object.assign(bridge.push(contact,m.direction,m.text),m);
  await a.setGroupOptions({contact,atMe:true});await a.settings({enabled:true});await a.tick();
  assert.equal(provider.calls.length,0);
  provider.next=async()=>({action:'send',text:raw,followUp:false});
  Object.assign(bridge.push(contact,'other','所以几点？'),context.pendingMessages[0],{mentions:{verified:true,self:true,all:false,others:false}});
  await a.tick();clock+=20000;await a.tick();clock+=20000;await a.tick();
  assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(x=>x.text),[expected]);
  clock+=20000;await a.tick();assert.equal(provider.calls.length,1);
});

test('cancellation repair requires the same current author and literal cancelled hour',()=>{
  assert.equal(neutralGeneratedReplyRepair([raw],context),expected);
  for(const text of [
    '明天上午十点集合，八点那条作废。',
    '明天上午十点集合，九点那条作废，我已经订好车了。',
    '明天上午十点集合，九点那条可能作废。',
    '明天上午十点集合，九点那条作废了吗？',
    '“明天上午十点集合，九点那条作废。”',
  ]) assert.equal(neutralGeneratedReplyRepair([text],context),'',text);
  for(const patch of [
    {messages:[context.messages[0],{...context.messages[1],sender:key('member-b'),speaker:{id:key('member-b'),identified:true}}]},
    {messages:context.messages.map(m=>({...m,timestamp:m.timestamp-86400}))},
    {messages:[context.messages[0],{...context.messages[1],timestamp:ts+60}]},
    {messages:[context.messages[0],{...context.messages[1],text:'更正，刚才八点那条作废，改成十点。'}]},
    {messages:[context.messages[0],{...context.messages[1],aiGenerated:true}]},
  ]) assert.equal(neutralGeneratedReplyRepair([raw],{...context,...patch}),'',JSON.stringify(patch));
  assert.equal(neutralGeneratedReplyRepair([raw],{...context,followUp:true}),'');
  assert.equal(neutralGeneratedReplyRepair([raw],{...context,mode:'proactive'}),'');
  assert.equal(neutralGeneratedReplyRepair(['明天上午十点集合，我已经订好车了。'],{
    ...context,messages:[source('明天十点集合。',ts-1200)],
  }),'','a missing cancellation record never authorizes an arbitrary second clause');
});
