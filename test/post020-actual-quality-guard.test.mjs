import test from'node:test';import assert from'node:assert/strict';
import{unsupportedPersonalAnswer,ownerConfirmationRepair,knownDateCorrection}from'../server/ai-personal-answer.mjs';
import{AIAssistant}from'../server/ai-service.mjs';import{AIModelFixture,ChatFixture,modelConfig}from'./ai-fixtures.mjs';import{temp,cleanup}from'./fixtures.mjs';
const now=Date.parse('2026-10-22T20:00:00+08:00'),ts=Math.floor(now/1000),human=(text,extra={})=>({direction:'self',authorship:'human',text,timestamp:ts-60,...extra});
const dateInput='改成周日吧，周六我不行。',raw130='好，周日再看吧，我这边先确认一下。',raw137='这个得本人确认一下，我这边暂时没有资料。';
const dateContext={now,messages:[human('先按周六记着。')],pendingMessages:[{direction:'other',text:dateInput}]};
test('actual020 owner-check promise keeps the same source and date correction gates',()=>{
  assert.equal(unsupportedPersonalAnswer([raw130],dateContext),'future-notice');
  assert.equal(knownDateCorrection(dateContext),'行，改成周日。');
  for(const text of ['我这边先确认一下。','我这边再确认一下。','我这边回头确认一下。'])assert.equal(unsupportedPersonalAnswer([text],{now}),'future-notice',text);
  for(const text of ['你这边先确认一下。','具体时间需要本人确认一下。','如果我这边先确认一下，你就不用再查了吗？'])assert.equal(unsupportedPersonalAnswer([text],{now}),'',text);
  assert.equal(knownDateCorrection({...dateContext,messages:[human('先按周六记着。',{aiGenerated:true})]}),'');
  assert.equal(knownDateCorrection({...dateContext,messages:[human('先按周六记着。',{authorship:'unknown'})]}),'');
});
test('actual020 pure unavailable-record tail keeps only the existing neutral clause',()=>{
  const ctx={pendingMessages:[{direction:'other',text:'你今天在哪家公司上班？'}]};
  assert.equal(ownerConfirmationRepair([raw137],ctx),'这个得本人确认一下');
  for(const tail of ['我这边没有资料','我目前暂无资料','我暂时没有相关信息','我现在没有记录'])assert.equal(ownerConfirmationRepair(['这个得本人确认一下，'+tail+'。'],ctx),'这个得本人确认一下',tail);
  for(const tail of ['我没有资料能证明我在家','我没有资料但我在公司','我没有资料后通知你','我没有你工作的资料','我没有资料库','他没有资料'])assert.equal(ownerConfirmationRepair(['这个得本人确认一下，'+tail+'。'],ctx),'',tail);
  assert.equal(ownerConfirmationRepair([raw137],{...ctx,facts:'我在甲公司任职。'}),'');
  assert.equal(ownerConfirmationRepair([raw137],{...ctx,messages:[human('我在甲公司任职。')]}),'');
});
for(const scenario of[
  {id:'130 sourced day repair',incoming:dateInput,history:[human('先按周六记着。')],raw:raw130,expected:['行，改成周日。']},
  {id:'130 without owner agreement remains unsent',incoming:dateInput,raw:raw130,expected:[]},
  {id:'137 existing neutral confirmation',incoming:'你今天在哪家公司上班？',raw:raw137,expected:['这个得本人确认一下']},
])test('single-request production final for actual020 '+scenario.id,async t=>{
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
 t.after(async()=>{await a.close();await cleanup(root);});await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();const contact=bridge.contacts[0].id;for(const m of scenario.history||[])Object.assign(bridge.push(contact,m.direction,m.text),m);
 await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();provider.next=async()=>({action:'send',text:scenario.raw,followUp:false});Object.assign(bridge.push(contact,'other',scenario.incoming),{timestamp:ts});
 await a.tick();clock+=20000;await a.tick();assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(r=>r.text),scenario.expected);clock+=20000;await a.tick();assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(r=>r.text),scenario.expected);
 t.diagnostic(JSON.stringify({mockProviderCalls:1,fixtureSends:bridge.sent.length,actualModelCalls:0,realWechatSends:0}));
});
