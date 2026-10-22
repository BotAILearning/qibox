import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitTurnRepair} from '../server/ai-personal-answer.mjs';
import {effectiveTiming} from '../server/ai-timing.mjs';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
const now=Date.parse('2026-10-22T12:00:00+08:00');
const correction='你记错了，胃疼的是我，不是你。';
const human=(text,extra={})=>({direction:'self',authorship:'human',text,timestamp:Math.floor(now/1000)-60,...extra});
const context=(incoming=correction,last=human('那今天好点没？'))=>({now,pendingMessages:[{direction:'other',text:incoming}],messages:[last]});

test('009 raw comma acknowledgement retains its content while removing only the equivalent trailing question',()=>{
  assert.equal(explicitTurnRepair(['哦对，是你胃疼，今天好点没？'],context()),'哦对，是你胃疼');
  assert.equal(explicitTurnRepair(['明白，是你胃疼,那今天好点没?'],context()),'明白，是你胃疼');
  assert.equal(explicitTurnRepair(['是你胃疼，今天好点没？'],context()),'是你胃疼');
  assert.equal(explicitTurnRepair(['明白了，今天好点没？'],context()),'明白了');
  assert.equal(explicitTurnRepair(['对，是你胃疼。今天好点没？'],context()),'对，是你胃疼。');
});

test('comma-tail correction repair does not remove quoted, conditional, negated, compound or newly informative questions',()=>{
  for(const reply of [
    '哦对，是你胃疼，他问“今天好点没？”',
    "'是你胃疼'，今天好点没？",
    '『是你胃疼』，今天好点没？',
    '哦对，是你胃疼，如果今天好点没？',
    '哦对，是你胃疼，不是问今天好点没？',
    '哦对，不是你胃疼，今天好点没？',
    '没说是你胃疼，今天好点没？',
    '哦对，是你胃疼，今天好点没，还是更疼了？',
    '哦对，是你胃疼，是不是更疼了，今天好点没？',
    '哦对，是你胃疼，昨晚吃过药了，今天好点没？',
    '哦对，是你胃疼，今天好点没？还要继续吃药吗？',
    '今天好点没？',
    '，今天好点没？',
  ])assert.equal(explicitTurnRepair([reply],context()),'',reply);
  const reply=['哦对，是你胃疼，今天好点没？'];
  for(const incoming of ['不是说胃疼的是我，不是你。','如果胃疼的是我，不是你呢？','他说“胃疼的是我，不是你”。','『胃疼』的是我，不是你。','你记错了，胃疼的是我，不是你。今天更疼了。'])
    assert.equal(explicitTurnRepair(reply,context(incoming)),'',incoming);
  for(const last of [human('今天好点没，还是更疼了？'),human('他说“今天好点没？”'),human('那今天好点没？',{aiGenerated:true}),human('那今天好点没？',{authorship:'unknown'}),human('那今天好点没？',{timestamp:Math.floor(now/1000)+60})])
    assert.equal(explicitTurnRepair(reply,context(correction,last)),'');
  assert.equal(explicitTurnRepair(reply,{...context(),pendingMessages:[...context().pendingMessages,{direction:'other',text:'还有别的事情。'}]}),'');
});

test('009 raw final production reply uses one mock request and sends only the original acknowledgement',async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;
  bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  Object.assign(bridge.push(contact,'self','那今天好点没？'),human('那今天好点没？'));
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:'哦对，是你胃疼，今天好点没？',followUp:false});
  Object.assign(bridge.push(contact,'other',correction),{timestamp:Math.floor(clock/1000)});
  await a.tick();const timing=effectiveTiming(a.data.settings,a.profiles().find(profile=>profile.contact===contact));
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  t.diagnostic(JSON.stringify({mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text),realProviderCalls:0,realWechatSends:0}));
  assert.equal(provider.calls.length,1);
  assert.deepEqual(bridge.sent.map(row=>row.text),['哦对，是你胃疼']);
});
