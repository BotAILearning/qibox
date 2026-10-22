import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitTurnRepair,ownerConfirmationRepair,unsupportedPersonalAnswer} from '../server/ai-personal-answer.mjs';
import {effectiveTiming} from '../server/ai-timing.mjs';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
const now=Date.parse('2026-10-22T12:00:00+08:00'),correction='你记错了，胃疼的是我，不是你。';
const human=(text,at=now-60000)=>({direction:'self',authorship:'human',timestamp:Math.floor(at/1000),text});
const context=(extra={})=>({now,timezone:'Asia/Shanghai',pendingMessages:[{direction:'other',text:correction}],messages:[human('那今天好点没？')],...extra});
const rawCases=[
  {id:'17',incoming:correction,history:'那今天好点没？',text:'哦对，胃疼是你，那现在好点没？',expected:'哦对，胃疼是你'},
  {id:'15',incoming:'你现在具体在哪个地方？',text:'这个得本人确认一下，我这边也拿不准。',segments:true,expected:'这个得本人确认一下'},
  {id:'13',incoming:'你今天在哪家公司上班？',text:'这个得本人确认一下，我这边暂时不清楚。',expected:'这个得本人确认一下'},
];
for(const scenario of rawCases)test(`011 raw ${scenario.id} preserves only the already generated confirmation`,()=>{
  const ctx=scenario.id==='17'?context():{pendingMessages:[{direction:'other',text:scenario.incoming}]};
  assert.equal((scenario.id==='17'?explicitTurnRepair:ownerConfirmationRepair)([scenario.text],ctx),scenario.expected);
});

test('current-state wording is equivalent only on the same viewer calendar date',()=>{
  const reply=['哦对，胃疼是你，那现在好点没？'];
  assert.equal(explicitTurnRepair(reply,context()),'哦对，胃疼是你');
  for(const core of ['好些了吗','感觉怎么样'])
    assert.equal(explicitTurnRepair([`明白，胃疼是你，现在${core}？`],context({messages:[human(`今天${core}？`)]})),'明白，胃疼是你');
  const acrossMidnight=Date.parse('2026-10-22T00:01:00+08:00');
  const previous=human('那今天好点没？',acrossMidnight-120000);
  assert.equal(explicitTurnRepair(reply,context({now:acrossMidnight,messages:[previous]})),'');
  assert.equal(explicitTurnRepair(['对，是你胃疼。今天好点没？'],context({now:acrossMidnight,messages:[previous]})),'');
  const utcBoundary=Date.parse('2026-10-22T00:30:00Z'),last=human('那今天好点没？',utcBoundary-3600000);
  assert.equal(explicitTurnRepair(reply,context({now:utcBoundary,timezone:'Asia/Shanghai',messages:[last]})),'哦对，胃疼是你');
  assert.equal(explicitTurnRepair(reply,context({now:utcBoundary,timezone:'UTC',messages:[last]})),'');
});

test('state wording repair never changes activities, new information, negation, quotes or compound questions',()=>{
  for(const [reply,last] of [
    ['哦对，胃疼是你，那现在开会吗？','那今天开会吗？'],
    ['哦对，胃疼是你，那现在怎么样？','那今天怎么样？'],
    ['哦对，胃疼是你，那现在好点没，还是更疼了？','那今天好点没？'],
    ['哦对，胃疼是你，那现在好点没？','那今天好点没，还是更疼了？'],
    ['哦对，胃疼是他，那现在好点没？','那今天好点没？'],
    ['哦对，胃疼是你，刚吃药了，那现在好点没？','那今天好点没？'],
    ['哦对，胃疼是你，不是问现在好点没？','那今天好点没？'],
    ['哦对，胃疼是你，他问“那现在好点没？”','那今天好点没？'],
    ['如果胃疼是你，那现在好点没？','那今天好点没？'],
    ['对，是你胃疼。『那现在好点没』？','那今天好点没？'],
    ['对，是你胃疼。现在好点没？',"'那今天好点没'？"],
  ])assert.equal(explicitTurnRepair([reply],context({messages:[human(last)]})),'',reply);
  for(const last of [{...human('那今天好点没？'),aiGenerated:true},{...human('那今天好点没？'),authorship:'unknown'},human('那今天好点没？',now+60000)])
    assert.equal(explicitTurnRepair(['哦对，胃疼是你，那现在好点没？'],context({messages:[last]})),'');
  assert.equal(explicitTurnRepair(['对，是你胃疼。现在好点没？'],context({pendingMessages:[{direction:'other',text:'『胃疼』的是我，不是你。'}]})),'');
});

test('finite uncertainty tails preserve the existing field and no-facts gates',()=>{
  const ctx={pendingMessages:[{direction:'other',text:'你现在具体在哪个地方？'}]};
  for(const word of ['拿不准','不清楚','不太清楚','不确定','说不准'])for(const prefix of ['我这边也','我这边还','我这边暂时也还']){
    const draft=`这个得本人确认一下，${prefix}${word}。`,repaired=ownerConfirmationRepair([draft],ctx);
    assert.equal(repaired,'这个得本人确认一下',draft);
    assert.equal(unsupportedPersonalAnswer([repaired],ctx),'');
  }
  for(const draft of ['这个得本人确认一下，我不清楚是不是在家。','这个得本人确认一下，我也不确定我不在公司。','这个得本人确认一下，我也拿不准明天能不能去。','这个得本人确认一下，我这边说不准，但我在外地。','这个得本人确认一下，如果我也拿不准。','这个得本人确认一下，他也拿不准。','这个得本人确认一下，“我也拿不准”。','这个得本人确认一下，我也拿不准？'])
    assert.equal(ownerConfirmationRepair([draft],ctx),'',draft);
  assert.equal(ownerConfirmationRepair(['这个得本人确认一下，我这边也拿不准。'],{...ctx,facts:'已有资料。'}),'');
});

for(const scenario of rawCases)test(`single-request final production boundary for 011 raw ${scenario.id}`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  if(scenario.history)Object.assign(bridge.push(contact,'self',scenario.history),human(scenario.history));
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:scenario.text,...(scenario.segments?{segments:[scenario.text]}:{}),followUp:false});
  Object.assign(bridge.push(contact,'other',scenario.incoming),{timestamp:Math.floor(clock/1000)});
  await a.tick();const timing=effectiveTiming(a.data.settings,a.profiles().find(profile=>profile.contact===contact));clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  t.diagnostic(JSON.stringify({mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text),realProviderCalls:0,realWechatSends:0}));
  assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(row=>row.text),[scenario.expected]);
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  assert.equal(provider.calls.length,1,'no repeated generation after final processing');assert.deepEqual(bridge.sent.map(row=>row.text),[scenario.expected]);
});
