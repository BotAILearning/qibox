import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitTurnRepair,ownerConfirmationRepair,unsupportedPersonalAnswer} from '../server/ai-personal-answer.mjs';
import {effectiveTiming} from '../server/ai-timing.mjs';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';

const now=Date.parse('2026-10-22T12:00:00+08:00'),correction='你记错了，胃疼的是我，不是你。';
const raw='哈哈不好意思，胃疼的是你，那今天好点没？',expected='哈哈不好意思，胃疼的是你';
const human=(text,at=now-60000)=>({direction:'self',authorship:'human',timestamp:Math.floor(at/1000),text});
const context=(extra={})=>({now,timezone:'Asia/Shanghai',pendingMessages:[{direction:'other',text:correction}],messages:[human('那今天好点没？')],...extra});

test('012 raw 17 removes only the repeated tail after a current apology and actor confirmation',()=>{
  assert.equal(explicitTurnRepair([raw],context()),expected);
});

test('finite current apologies still require the original literal actor confirmation',()=>{
  for(const [reply,prefix] of [
    ['不好意思，胃疼的是你，那今天好点没？','不好意思，胃疼的是你'],
    ['抱歉，胃疼是你，那现在好点没？','抱歉，胃疼是你'],
    ['对不起，是你胃疼，那今天好点没？','对不起，是你胃疼'],
  ])assert.equal(explicitTurnRepair([reply],context()),prefix,reply);
  for(const reply of ['哈哈不好意思，那今天好点没？','不好意思，那今天好点没？','抱歉，那今天好点没？','对不起，那今天好点没？','呵呵不好意思，胃疼的是你，那今天好点没？','哈哈哈哈不好意思，胃疼的是你，那今天好点没？','嗯不好意思，胃疼的是你，那今天好点没？','不好意思，胃疼也是你，那今天好点没？','不好意思，是你记错了，那今天好点没？'])
    assert.equal(explicitTurnRepair([reply],context()),'',reply);
});

test('apology recognition never removes historical faults, added facts or promises',()=>{
  for(const reply of [
    '哈哈不好意思，我记错了，胃疼的是你，那今天好点没？',
    '抱歉，之前是我搞混了，胃疼的是你，那今天好点没？',
    '对不起，胃疼的是你，你刚吃过药，那今天好点没？',
    '哈哈不好意思，胃疼的是你，我会提醒你吃药，那今天好点没？',
    '哈哈不好意思，胃疼的是他，那今天好点没？',
    '哈哈不好意思，胃疼的不是你，那今天好点没？',
    '哈哈不好意思，并不是胃疼的是你，那今天好点没？',
    '哈哈不好意思，我只是说胃疼的是你，那今天好点没？',
  ])assert.equal(explicitTurnRepair([reply],context()),'',reply);
  assert.equal(unsupportedPersonalAnswer(['哈哈不好意思，我记错了，胃疼的是你，那今天好点没？'],context()),'personal-fact');
});

test('current apology keeps quote, condition, compound question and source/date boundaries',()=>{
  for(const reply of [
    '“哈哈不好意思，胃疼的是你”，那今天好点没？',
    '哈哈不好意思，如果胃疼的是你，那今天好点没？',
    '哈哈不好意思，胃疼的是你，那今天好点没，还是更疼了？',
    '哈哈不好意思，胃疼的是你，那今天好点没，明天能出门吗？',
    '哈哈不好意思，胃疼的是你，不是问那今天好点没？',
  ])assert.equal(explicitTurnRepair([reply],context()),'',reply);
  for(const pendingMessages of [
    [{direction:'other',text:'如果胃疼的是我，不是你。'}],
    [{direction:'other',text:'你记错了，胃疼的是我，不是你。我刚吃药了。'}],
    [{direction:'other',text:'你记错了，胃疼的是我，不是你。'},{direction:'other',text:'我刚吃药了。'}],
  ])assert.equal(explicitTurnRepair([raw],context({pendingMessages})),'');
  for(const last of [{...human('那今天好点没？'),aiGenerated:true},{...human('那今天好点没？'),authorship:'unknown'},human('那今天好点没？',now+60000),human('那今天好点没，还是更疼了？')])
    assert.equal(explicitTurnRepair([raw],context({messages:[last]})),'');
  const acrossMidnight=Date.parse('2026-10-22T00:01:00+08:00');
  assert.equal(explicitTurnRepair([raw],context({now:acrossMidnight,messages:[human('那今天好点没？',acrossMidnight-120000)]})), '');
});

test('012 raw 15 inability to disclose is not treated as a pure uncertainty tail',()=>{
  const draft='具体位置需要本人确认一下，我现在没法直接告诉你。',ctx={pendingMessages:[{direction:'other',text:'你现在具体在哪个地方？'}]};
  assert.equal(ownerConfirmationRepair([draft],ctx),'');
  assert.equal(unsupportedPersonalAnswer([draft],ctx),'personal-fact');
});

test('single-request production boundary sends the original apology confirmation without repeating the question',async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  Object.assign(bridge.push(contact,'self','那今天好点没？'),human('那今天好点没？'));
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:raw,followUp:false});
  Object.assign(bridge.push(contact,'other',correction),{timestamp:Math.floor(clock/1000)});
  await a.tick();const timing=effectiveTiming(a.data.settings,a.profiles().find(profile=>profile.contact===contact));clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  t.diagnostic(JSON.stringify({mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text),realProviderCalls:0,realWechatSends:0}));
  assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(row=>row.text),[expected]);
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  assert.equal(provider.calls.length,1,'no repeated generation after the repaired result');assert.deepEqual(bridge.sent.map(row=>row.text),[expected]);
});
