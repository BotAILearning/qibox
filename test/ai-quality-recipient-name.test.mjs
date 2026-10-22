import test from 'node:test';
import assert from 'node:assert/strict';
import {unsupportedPersonalAnswer,ownerConfirmationRepair} from '../server/ai-personal-answer.mjs';
import {effectiveTiming} from '../server/ai-timing.mjs';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
const now=Date.parse('2026-10-22T12:00:00+08:00');
const incoming='我不是阿海，别把另一个人的安排套到我这里。';
const candidate='明白，你是阿涛，不是阿海。不会把别人的安排套到你这里。';
const other=(text,extra={})=>({direction:'other',text,timestamp:Math.floor(now/1000)-30,speaker:{id:'target-A'},...extra});
const context=(extra={})=>({now,pendingMessages:[other(incoming)],...extra});

test('010 raw invented recipient name requires a source rather than a denied alternative',()=>{
  assert.equal(unsupportedPersonalAnswer([candidate],context()),'recipient-fact');
});

test('only this actor independent name declaration can prove the positive name',()=>{
  for(const source of ['我叫阿涛。','我是阿涛。','我的名字是阿涛。','以后叫我阿涛。'])
    assert.equal(unsupportedPersonalAnswer([candidate],context({messages:[other(source)]})),'',source);
  assert.equal(unsupportedPersonalAnswer([candidate],context({pendingMessages:[other('我不是阿海，我叫阿涛。')]})),'');
  for(const source of [other('我叫阿涛。',{speaker:{id:'target-B'}}),other('我叫阿涛。',{aiGenerated:true}),other('我叫阿涛。',{unresolved:true}),other('我叫阿涛。',{timestamp:Math.floor(now/1000)+60}),other('他说“我叫阿涛”。'),other('如果我叫阿涛，那只是个假设。'),other('我叫阿涛吗？'),{direction:'self',authorship:'human',text:'你叫阿涛。',timestamp:Math.floor(now/1000)-60}])
    assert.equal(unsupportedPersonalAnswer([candidate],context({messages:[source]})),'recipient-fact');
  const unknown=other(incoming);delete unknown.speaker;
  for(const speaker of [{id:'target-B'},{label:'another named actor'}])
    assert.equal(unsupportedPersonalAnswer([candidate],context({pendingMessages:[unknown],messages:[other('我叫阿涛。',{speaker})]})),'recipient-fact');
  const unlabelled=other('我叫阿涛。');delete unlabelled.speaker;
  assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'person',pendingMessages:[unknown],messages:[unlabelled]})),'');
});

test('the latest explicit name denial defeats old same-actor declarations and facts',()=>{
  for(const source of ['我叫阿海。','我是阿海。'])
    assert.equal(unsupportedPersonalAnswer(['你是阿海。'],context({messages:[other(source)]})),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer(['你是阿海。'],context({kind:'person',facts:'对方叫阿海。'})),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer([candidate],context({messages:[other('我叫阿海。'),other('我叫阿涛。')]})),'');
});

test('group names require the current identified speaker and never generic counterpart facts',()=>{
  assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'group',messages:[other('我叫阿涛。')]})),'');
  assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'group',facts:'联系人事实：对方叫阿涛。'})),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'group',messages:[other('我叫阿涛。',{speaker:{id:'target-B'}})]})),'recipient-fact');
  const pending=other(incoming);delete pending.speaker;
  const source=other('我叫阿涛。');delete source.speaker;
  assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'group',pendingMessages:[pending],messages:[source]})),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'group',pendingMessages:[other(incoming,{speaker:{id:'unknown-member:A',identified:false}})],messages:[other('我叫阿涛。',{speaker:{id:'unknown-member:A',identified:false}})]})),'recipient-fact');
  for(const facts of ['对方叫阿涛。','联系人事实：对方叫阿涛。','对方的姓名是阿涛。'])
    assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'person',facts})),'',facts);
  for(const facts of ['他叫阿涛。','小王叫阿涛。','如果对方叫阿涛就这样。','“对方叫阿涛”。'])
    assert.equal(unsupportedPersonalAnswer([candidate],context({kind:'person',facts})),'recipient-fact');
});

test('explicit name fields are checked without treating occupations, adjectives or quoted questions as names',()=>{
  for(const text of ['你的名字是玛丽。','你名叫玛丽。']){
    assert.equal(unsupportedPersonalAnswer([text],{...context(),pendingMessages:[other('你好。')]}),'recipient-fact');
    assert.equal(unsupportedPersonalAnswer([text],{...context(),pendingMessages:[other('你好。')],messages:[other('我叫玛丽。')]}),'');
  }
  for(const text of ['你是医生。','你是司机。','你是老师。','你是工程师。','你是认真的。','你是好人。','你是阿姨。','你叫外卖。','你叫我一下。','你不是阿海。','你是阿涛吗？','他说“你是阿涛”。','他说，你是阿涛。','小王说，你是阿涛。','如果你是阿涛，就用这个称呼。','不是说你是阿涛。'])
    assert.equal(unsupportedPersonalAnswer([text],context()),'',text);
});

test('010 raw cannot-determine tail keeps only the existing owner confirmation',()=>{
  const pendingMessages=[other('你现在具体在哪个地方？')];
  assert.equal(ownerConfirmationRepair(['具体位置需要本人确认一下，我现在还不能确定。'],{pendingMessages}),'具体位置需要本人确认一下');
});

test('cannot-determine synonym keeps all existing field, fact, promise and attribution boundaries',()=>{
  const ctx={pendingMessages:[other('你现在具体在哪个地方？')]};
  for(const text of ['具体位置需要本人确认一下，我不能确定。','具体位置需要本人确认一下，我这边暂时不能确定具体位置。'])
    assert.equal(ownerConfirmationRepair([text],ctx),'具体位置需要本人确认一下');
  assert.equal(ownerConfirmationRepair(['这个得本人确认一下，我现在还不能确定在哪家公司上班。'],{pendingMessages:[other('你今天在哪家公司上班？')]}),'这个得本人确认一下');
  for(const text of ['具体位置需要本人确认一下，我还不能确定是不是在家。','具体位置需要本人确认一下，我不能确定我不在外地。','具体位置需要本人确认一下，我现在不能确定，但我在家。','具体位置需要本人确认一下，我现在还不能确定，明天告诉你。','具体位置需要本人确认一下，如果我不能确定。','具体位置需要本人确认一下，他不能确定。','具体位置需要本人确认一下，“我现在不能确定”。','具体位置需要本人确认一下，我现在不能确定？','具体位置需要本人确认一下，我不能确定在哪家公司上班。'])
    assert.equal(ownerConfirmationRepair([text],ctx),'',text);
});

for(const scenario of [
  {name:'010 raw invented name',incoming,candidate,expected:[]},
  {name:'010 raw cannot determine',incoming:'你现在具体在哪个地方？',candidate:'具体位置需要本人确认一下，我现在还不能确定。',expected:['具体位置需要本人确认一下']},
  {name:'independent same-contact name source',incoming,candidate,history:'我叫阿涛。',expected:[candidate]},
  {name:'latest denied name beats earlier declaration',incoming,candidate:'你是阿海。',history:'我叫阿海。',expected:[]},
])test(`one-request final production pipeline: ${scenario.name}`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  if(scenario.history)Object.assign(bridge.push(contact,'other',scenario.history),{timestamp:Math.floor(clock/1000)-60});
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:scenario.candidate,followUp:false});
  Object.assign(bridge.push(contact,'other',scenario.incoming),{timestamp:Math.floor(clock/1000)});
  await a.tick();const timing=effectiveTiming(a.data.settings,a.profiles().find(profile=>profile.contact===contact));clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  t.diagnostic(JSON.stringify({mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text),realProviderCalls:0,realWechatSends:0}));
  assert.equal(provider.calls.length,1);
  assert.deepEqual(bridge.sent.map(row=>row.text),scenario.expected);
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  assert.equal(provider.calls.length,1,'a final safe skip or cached sent result must not generate the same incoming again');
  assert.deepEqual(bridge.sent.map(row=>row.text),scenario.expected);
  if(!scenario.expected.length)assert.ok(a.data.events.some(row=>row.reasonCode==='unverified-recipient-fact'));
});
