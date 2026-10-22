import test from 'node:test';
import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIProvider} from '../server/ai-provider.mjs';
import {unsupportedPersonalAnswer} from '../server/ai-personal-answer.mjs';
import {effectiveTiming} from '../server/ai-timing.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';

const now=Date.parse('2026-10-22T12:00:00+08:00');
const correction='你记错了，胃疼的是我，不是你。';
// The original synthetic M3/016 draft reached the fixture sink unchanged.
const actual97='嗯，记混了。胃疼的是你。';
const commaVariant='嗯，记混了，胃疼的是你。';
const retrospectiveTails=['嗯，记混了，再次抱歉。胃疼的是你。','嗯，记混了，他就提醒过我。胃疼的是你。','嗯，记混了，他就提醒我了。胃疼的是你。'];
const human=(text,extra={})=>({direction:'self',authorship:'human',aiGenerated:false,timestamp:Math.floor(now/1000)-60,text,...extra});
const context=(extra={})=>({now,messages:[human('那今天好点没？')],pendingMessages:[{direction:'other',text:correction}],...extra});

test('a completed elided owner-fault declaration needs an independent owner source',()=>{
  for(const raw of [actual97,commaVariant,...retrospectiveTails,'嗯，记混了，他就提醒了我。','嗯，记混了，他就纠正我的说法了。',
    '嗯，记混了，我就再核对一遍了。','嗯，记混了，他就提醒我了呀。','嗯，记混了；胃疼的是你。','记混了。','嗯，认错了。','哦，理解反了。','对，记错了。','明白了，弄错了。','记混过。','记混了呀。'])
    assert.equal(unsupportedPersonalAnswer([raw],context()),'personal-fact',raw);
});

test('questions, other actors, reported or conditional faults and general reassurance do not become owner admissions',()=>{
  for(const raw of ['嗯，胃疼的是你。','抱歉，是你胃疼。','他记混了。','小王说，记混了。','你说“记混了”。','“记混了”是他原话。',
    '你记混了吗？','记混了吗？','嗯，记混了？','记混了，是吗？','如果记混了，你可以纠正。','记混了的话，再确认就好。','记混了就再核对。',
    '记混了也正常。','记混了没关系。','记混了，也正常。','记混了，没关系。','记混了，就再核对。','记混了，我就再核对。',
    '嗯，记混了，你就提醒我。','嗯，记混了，他就会提醒我。','嗯，记混了也没关系。','嗯，记混了，也正常。','他说记混了，胃疼的是你。',
    '记混了，我就再核对一遍。','记混了，你就纠正我。','记混了，就确认一下。',
    '记混了，他就要提醒我了。','记混了，就要提醒我了。','记混了，你就提醒我过年回家。','记混了，你就提醒我好了。',
    '记混了，你就提醒我别错过。','记混了，我就再确认是否通过。','记混了，你就提醒我不要难过。',
    '不是我记混了。','是他记混了，不是我。','这两个名字容易记混。','说的是他记混了。'])
    assert.equal(unsupportedPersonalAnswer([raw],context()),'',raw);
});

test('elided declarations keep real human-source support without promoting AI, unknown, future, quoted or other-actor text',()=>{
  for(const raw of [actual97,'记混了。']){
    for(const text of ['我记混了。','记混了。'])assert.equal(unsupportedPersonalAnswer([raw],context({messages:[human(text)]})),'',text);
    assert.equal(unsupportedPersonalAnswer([raw],context({facts:'我记混了。'})),'');
    for(const source of [human('我记混了。',{aiGenerated:true}),human('我记混了。',{authorship:'unknown'}),human('他记混了。'),human('“我记混了”。'),human('我记混了。',{timestamp:Math.floor(now/1000)+60})])
      assert.equal(unsupportedPersonalAnswer([raw],context({messages:[source]})),'personal-fact',JSON.stringify(source));
  }
});

test('the existing single generation request carries correction-source self-checks without a reviewer request',async()=>{
  const requests=[];
  const provider=new AIProvider({fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    return Response.json({choices:[{message:{content:JSON.stringify({action:'send',text:'明白，胃疼的是你。',followUp:false})}}]});
  }});
  const result=await provider.complete(modelConfig,'按当前设置正常回应',{mode:'reply',messages:[]});
  assert.equal(result.text,'明白，胃疼的是你。');assert.equal(requests.length,1);
  assert.match(requests[0].messages[0].content,/对方的更正或指责不能证明本人/);
  assert.match(requests[0].messages[0].content,/省略主语的已完成认错/);
  // This proves request composition/count only; a mock cannot prove AI quality.
});

for(const [label,raw] of [['actual97',actual97],['comma variant',commaVariant],...retrospectiveTails.map((raw,i)=>['retrospective tail '+(i+1),raw])])test(`production reply flow rejects ${label} after one mock generation and does not regenerate on the next tick`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  Object.assign(bridge.push(contact,'self','那今天好点没？'),human('那今天好点没？'));
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:raw,followUp:false});
  Object.assign(bridge.push(contact,'other',correction),{timestamp:Math.floor(clock/1000)});
  await a.tick();const timing=effectiveTiming(a.data.settings,a.profiles().find(profile=>profile.contact===contact));
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  const afterFirst={mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text)};
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  const afterSecond={mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text)};
  t.diagnostic(JSON.stringify({afterFirst,afterSecond,realProviderCalls:0,realWechatSends:0}));
  assert.equal(afterFirst.mockProviderCalls,1);assert.equal(afterSecond.mockProviderCalls,1);
  assert.equal(afterFirst.fixtureSends,0,'an unsupported elided historical owner fault must not reach the bridge');assert.equal(afterSecond.fixtureSends,0);
  assert.ok(a.data.skipLog.some(row=>row.reasonCode==='unverified-personal-fact'));
});
