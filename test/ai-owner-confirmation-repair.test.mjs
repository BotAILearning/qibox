import test from 'node:test';
import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
import {ownerConfirmationRepair,unsupportedPersonalAnswer} from '../server/ai-personal-answer.mjs';
import {effectiveTiming} from '../server/ai-timing.mjs';

const now=Date.parse('2026-10-22T12:00:00+08:00');
const cases=[
  {name:'008 raw unknown workplace',incoming:'你今天在哪家公司上班？',candidate:'这个得本人确认一下，我这边还没确认今天在哪家公司。',expected:['这个得本人确认一下']},
  {name:'008 raw unknown location',incoming:'你现在具体在哪个地方？',candidate:'具体位置需要本人确认一下，我现在没法确定。',expected:['具体位置需要本人确认一下']},
  {name:'018 raw direct-confirmation uncertainty',incoming:'你现在具体在哪个地方？',candidate:'具体位置需要本人确认一下，我这边现在没法直接确认。',expected:['具体位置需要本人确认一下']},
  {name:'a location assertion is still blocked',incoming:'你现在具体在哪个地方？',candidate:'具体位置需要本人确认一下，我现在在家。',expected:[]},
  {name:'an extra callback promise is still blocked',incoming:'你现在具体在哪个地方？',candidate:'具体位置需要本人确认一下，我现在没法确定，明天告诉你。',expected:[]},
  {name:'mismatched owner-confirmation field is not repaired',incoming:'你现在具体在哪个地方？',candidate:'具体工作情况需要本人确认一下，我现在没法确定。',expected:[]},
  {name:'a possible known owner location prevents repair',incoming:'你现在具体在哪个地方？',history:'我现在在家。',candidate:'具体位置需要本人确认一下，我现在没法确定。',expected:[]},
  {name:'an existing neutral confirmation remains unchanged',incoming:'你今天在哪家公司上班？',candidate:'这个得本人确认一下。',expected:['这个得本人确认一下。']},
];
for(const scenario of cases)test(`one-request final production boundary: ${scenario.name}`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;
  bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);
  await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  if(scenario.history)Object.assign(bridge.push(contact,'self',scenario.history),{authorship:'human',timestamp:Math.floor(clock/1000)-60});
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:scenario.candidate,followUp:false});
  Object.assign(bridge.push(contact,'other',scenario.incoming),{timestamp:Math.floor(clock/1000)});
  await a.tick();
  const timing=effectiveTiming(a.data.settings,a.profiles().find(profile=>profile.contact===contact));
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;
  await a.tick();
  t.diagnostic(JSON.stringify({mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,realProviderCalls:0,realWechatSends:0}));
  assert.equal(provider.calls.length,1,'no extra model generation or review');
  assert.deepEqual(bridge.sent.map(row=>row.text),scenario.expected);
  if(!scenario.expected.length)assert.ok(a.data.events.some(row=>row.reasonCode==='unverified-personal-fact'),'the unchanged final guard must still block unsupported drafts');
});

const context=question=>({pendingMessages:[{direction:'other',text:question}]});
test('only the existing neutral clause survives pure uncertainty about the same unknown field',()=>{
  for(const [question,draft,expected,reason] of [
    ['你今天在哪家公司上班？','这个得本人确认一下，我这边还没确认今天在哪家公司。','这个得本人确认一下','personal-fact'],
    ['你现在具体在哪个地方？','具体位置需要本人确认一下，我现在没法确定。','具体位置需要本人确认一下','personal-fact'],
    ['您目前在哪里？','这事需要由本人来确认下。我不知道具体位置。','这事需要由本人来确认下','unknown-self'],
    ['你在哪个单位工作？','具体工作情况得本人确认一下，我还不知道在哪个单位工作。','具体工作情况得本人确认一下','unknown-self'],
  ]){
    const ctx=context(question);
    assert.equal(unsupportedPersonalAnswer([draft],ctx),reason,'original full draft remains rejected with its original reason');
    const repaired=ownerConfirmationRepair([draft],ctx);
    assert.equal(repaired,expected);
    assert.ok(draft.startsWith(repaired),'no new answer is invented');
    assert.equal(unsupportedPersonalAnswer([repaired],ctx),'','final guard still accepts only the retained neutral clause');
  }
});

test('negated facts, promises, quotations, conditions, other actors and compound replies are never deleted',()=>{
  const ctx=context('你现在具体在哪个地方？');
  for(const draft of [
    '具体位置需要本人确认一下，我现在在家。',
    '具体位置需要本人确认一下，我不在公司。',
    '具体位置需要本人确认一下，我不知道是不是没上班。',
    '具体位置需要本人确认一下，我现在没法确定，明天告诉你。',
    '具体位置需要本人确认一下，我不知道。你找我什么事？',
    '具体位置需要本人确认一下，我没法确定但我在家。',
    '具体位置需要本人确认一下，如果我不知道具体位置。',
    '具体位置需要本人确认一下，我现在没法确定？',
    '具体位置需要本人确认一下，他现在没法确定。',
    '具体位置需要本人确认一下，我不知道你在哪。',
    '具体位置需要本人确认一下，我不知道是否需要报警。',
    '具体位置需要本人确认一下，我没确认后通知你。',
    '具体位置需要本人确认一下，“我现在没法确定”。',
    '“具体位置需要本人确认一下”，我现在没法确定。',
    '具体位置需要本人确认一下，我不知道，真的。',
    '我先确认一下，我现在没法确定。',
    '具体位置需要本人确认一下。',
  ])assert.equal(ownerConfirmationRepair([draft],ctx),'',draft);
});

test('different fields, additional questions, multiple pending turns or texts and possible known sources prevent repair',()=>{
  const location='具体位置需要本人确认一下，我现在没法确定。',work='这个得本人确认一下，我还没确认在哪家公司上班。';
  assert.equal(ownerConfirmationRepair([location],context('你今天在哪家公司上班？')),'');
  assert.equal(ownerConfirmationRepair([work],context('你现在具体在哪个地方？')),'');
  assert.equal(ownerConfirmationRepair(['具体工作情况需要本人确认一下，我现在没法确定。'],context('你现在具体在哪个地方？')),'');
  assert.equal(ownerConfirmationRepair([location],context('你现在具体在哪个地方？顺便说一下今天几号。')),'');
  assert.equal(ownerConfirmationRepair([location],context('如果我问“你现在具体在哪个地方”，你会怎么回答？')),'');
  assert.equal(ownerConfirmationRepair([location],{pendingMessages:[...context('你现在具体在哪个地方？').pendingMessages,{direction:'other',text:'还有别的事'}]}),'');
  assert.equal(ownerConfirmationRepair(['具体位置需要本人确认一下，','我现在没法确定。'],context('你现在具体在哪个地方？')),'');
  for(const extra of [{facts:'我目前在家。'},{facts:'本人有已保存的资料。'},{messages:[{direction:'self',authorship:'human',text:'我现在在家。'}]},{messages:[{direction:'self',authorship:'unknown',text:'我的位置在公司。'}]}])
    assert.equal(ownerConfirmationRepair([location],{...context('你现在具体在哪个地方？'),...extra}),'');
  assert.equal(ownerConfirmationRepair([work],{...context('你今天在哪家公司上班？'),messages:[{direction:'self',authorship:'human',text:'我在甲公司上班。'}]}),'');
});
