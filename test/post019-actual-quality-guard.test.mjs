import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitTurnRepair,unsupportedPersonalAnswer} from '../server/ai-personal-answer.mjs';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
const now=Date.parse('2026-10-22T18:00:00+08:00');
const human=(text,extra={})=>({direction:'self',authorship:'human',timestamp:Math.floor(now/1000)-60,text,...extra});
const other=(text,extra={})=>({direction:'other',timestamp:Math.floor(now/1000)-30,text,...extra});
const correction='你记错了，胃疼的是我，不是你。';
const turn=(extra={})=>({now,messages:[human('那今天好点没？')],pendingMessages:[other(correction)],...extra});
const location='我去年旅行拍的照片今天才整理，别以为我现在在外地。';
const loc=(extra={})=>({now,pendingMessages:[other(location)],...extra});

test('actual019 state-question particles do not create a new question on the same day',()=>{
  for(const tail of ['现在好点了吗？','那现在好点没？','今天好点没有？'])
    assert.equal(explicitTurnRepair(['嗯，胃疼的是你。'+tail],turn()),'嗯，胃疼的是你。',tail);
  for(const old of ['今天好点了吗？','今天好点没有？','今天好点没？'])
    assert.equal(explicitTurnRepair(['胃疼的是你。现在好点没？'],turn({messages:[human(old)]})),'胃疼的是你。',old);
  for(const [old,tail] of [['今天好些没？','现在好些了吗？'],['今天舒服点没？','现在舒服点了吗？']])
    assert.equal(explicitTurnRepair(['胃疼的是你。'+tail],turn({messages:[human(old)]})),'胃疼的是你。');
});

test('question equivalence keeps predicate, author, date, compound and quotation boundaries',()=>{
  for(const [old,reply] of [
    ['今天好点没？','胃疼的是你。现在舒服点了吗？'],
    ['今天好点没？','胃疼的是你。现在好点了吗，还是更疼了？'],
    ['今天好点没，吃过药没？','胃疼的是你。现在好点了吗？'],
    ['今天好点没？','胃疼的是你。他问“现在好点了吗？”'],
    ['今天好点没？','胃疼的是你。如果现在好点了吗？'],
    ['今天开会没？','胃疼的是你。现在开会了吗？'],
  ])assert.equal(explicitTurnRepair([reply],turn({messages:[human(old)]})),'',reply);
  for(const last of [human('今天好点没？',{aiGenerated:true}),human('今天好点没？',{authorship:'unknown'}),human('今天好点没？',{timestamp:Math.floor(now/1000)+60}),human('今天好点没？',{timestamp:Math.floor(now/1000)-86400})])
    assert.equal(explicitTurnRepair(['胃疼的是你。现在好点了吗？'],turn({messages:[last]})),'');
  assert.equal(explicitTurnRepair(['胃疼的是你。现在好点了吗？'],turn({pendingMessages:[other(correction),other('另外有个新问题。')]})),'');
});

test('actual019 do-not-infer scope cannot become an opposite current location',()=>{
  for(const text of ['知道，是去年的照片，不是你现在人在外地。','你现在在外地。','你现在不在外地。','你现在不是在外地。','不是你现在在外地。'])
    assert.equal(unsupportedPersonalAnswer([text],loc()),'recipient-fact',text);
  for(const incoming of ['别以为我现在在外地。','不要认定我现在在外地。','别推断我现在在外地。'])
    assert.equal(unsupportedPersonalAnswer(['你现在不在外地。'],loc({pendingMessages:[other(incoming)]})),'recipient-fact',incoming);
});

test('non-inference check preserves literal acknowledgement, questions, other actors and actual matching facts',()=>{
  for(const text of ['知道，是去年的照片，不能据此判断你现在在哪。','旧照片不代表你现在在外地。','你没说你现在在哪。','如果你现在在外地，之后再聊。','你现在在外地吗？','他说“你现在不在外地”。','他现在不在外地。'])
    assert.equal(unsupportedPersonalAnswer([text],loc()),'',text);
  for(const source of [other('我现在不在外地。'),human('你现在不在外地。')])
    assert.equal(unsupportedPersonalAnswer(['不是你现在人在外地。'],loc({messages:[source]})),'',source.text);
  assert.equal(unsupportedPersonalAnswer(['你现在不在外地。'],loc({facts:'对方现在不在外地。'})),'');
  for(const source of [other('我现在在外地。'),other('我现在不在外地。',{aiGenerated:true}),other('我现在不在外地。',{unresolved:true}),other('我现在不在外地。',{speaker:{identified:false}}),other('我现在不在外地。',{timestamp:Math.floor(now/1000)+60}),other('他说“我现在不在外地”。'),other('如果我现在不在外地，就晚点聊。'),human('我现在不在外地。'),other('我昨天不在外地。'),other('我现在不在外地。',{speaker:{id:'another'}})])
    assert.equal(unsupportedPersonalAnswer(['你现在不在外地。'],loc({messages:[source]})),'recipient-fact',JSON.stringify(source));
  assert.equal(unsupportedPersonalAnswer(['你现在不在外地。'],loc({pendingMessages:[other('我现在不在外地。')]})),'');
  assert.equal(unsupportedPersonalAnswer(['你现在不在外地。'],loc({kind:'group',pendingMessages:[other(location,{speaker:{id:'unknown-A',identified:false}})],messages:[other('我现在不在外地。',{speaker:{id:'unknown-A',identified:false}})],facts:'对方现在不在外地。'})),'recipient-fact');
});

test('yesterday today cannot support the same word on the next viewer day',()=>{
  const context={now,timezone:'Asia/Shanghai',pendingMessages:[other('别以为我今天在外地。')]};
  const source=other('我今天不在外地。',{timestamp:Math.floor(Date.parse('2026-10-21T23:00:00+08:00')/1000)});
  assert.equal(unsupportedPersonalAnswer(['你今天不在外地。'],{...context,messages:[source]}),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer(['你今天不在外地。'],{...context,messages:[other('我今天不在外地。')]}),'');
  const boundaryNow=Date.parse('2026-10-22T00:30:00Z'),boundarySource=other('我今天不在外地。',{timestamp:Math.floor((boundaryNow-3600000)/1000)});
  assert.equal(unsupportedPersonalAnswer(['你今天不在外地。'],{...context,now:boundaryNow,messages:[boundarySource]}),'');
  assert.equal(unsupportedPersonalAnswer(['你今天不在外地。'],{...context,now:boundaryNow,timezone:'UTC',messages:[boundarySource]}),'recipient-fact');
});

for(const scenario of [
  {id:'113 repeated question',incoming:correction,history:[human('那今天好点没？')],candidate:'嗯，胃疼的是你。现在好点了吗？',expected:['嗯，胃疼的是你。']},
  {id:'118 inferred opposite location',incoming:location,candidate:'知道，是去年的照片，不是你现在人在外地。',expected:[]},
  {id:'118 neutral location source acknowledgement',incoming:location,candidate:'知道，是去年的照片，不能据此判断你现在在哪。',expected:['知道，是去年的照片，不能据此判断你现在在哪。']},
  {id:'117 invented intermediary state',incoming:'东西已经退了，钱还没到账，客服说需要三天。我不急，只是怕你把“退款到账”和“申请成功”当成一回事。',candidate:'明白，退款申请成功不等于钱已经到账。现在就是还在等银行处理，不是已经退到你账上了，对吧？',expected:[],processViolation:true},
])test(`one-request production boundary for actual019 ${scenario.id}`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();const contact=bridge.contacts[0].id;
  for(const m of scenario.history||[])Object.assign(bridge.push(contact,m.direction,m.text),m);
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:scenario.candidate,followUp:false});Object.assign(bridge.push(contact,'other',scenario.incoming),{timestamp:Math.floor(clock/1000)});
  await a.tick();clock+=20000;await a.tick();assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(r=>r.text),scenario.expected);
  clock+=20000;await a.tick();assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(r=>r.text),scenario.expected);
  if(scenario.processViolation)assert.ok(a.data.skipLog.some(row=>row.reasonCode==='unverified-process-fact'&&row.detail.includes('办理状态')));
  t.diagnostic(JSON.stringify({mockProviderCalls:1,fixtureSends:bridge.sent.length,realProviderCalls:0,realWechatSends:0}));
});
