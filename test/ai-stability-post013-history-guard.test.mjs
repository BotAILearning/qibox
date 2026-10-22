import test from 'node:test';
import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {unsupportedPersonalAnswer} from '../server/ai-personal-answer.mjs';
import {effectiveTiming} from '../server/ai-timing.mjs';
import {AIModelFixture,ChatFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';

const now=Date.parse('2026-10-22T12:00:00+08:00');
const human=(text,extra={})=>({direction:'self',authorship:'human',aiGenerated:false,timestamp:Math.floor(now/1000)-60,text,...extra});
const correction='你记错了，胃疼的是我，不是你。';
const context=(extra={})=>({now,messages:[human('那今天好点没？')],pendingMessages:[{direction:'other',text:correction}],...extra});

test('an unsupported first-person mixing-up claim remains a fact claim with or without its subject',()=>{
  for(const raw of ['我弄混了。','抱歉，弄混了。','不好意思，弄混了。','对不起，弄混了。'])
    assert.equal(unsupportedPersonalAnswer([raw],context()),'personal-fact',raw);
});

test('mixing-up claims retain independent human-source and explicit owner-fact support',()=>{
  for(const raw of ['我弄混了。','抱歉，弄混了。']){
    assert.equal(unsupportedPersonalAnswer([raw],context({messages:[human('我弄混了。')]})),'',raw);
    assert.equal(unsupportedPersonalAnswer([raw],context({facts:'我弄混了。'})),'',raw);
    for(const source of [human('我弄混了。',{aiGenerated:true}),human('我弄混了。',{authorship:'unknown'}),human('他弄混了。'),human('我弄混了。',{timestamp:Math.floor(now/1000)+60})])
      assert.equal(unsupportedPersonalAnswer([raw],context({messages:[source]})),'personal-fact',JSON.stringify(source));
  }
});

test('pure apologies, other actors, quotations, questions and conditional scope remain unchanged',()=>{
  for(const raw of ['抱歉。','不好意思，是你胃疼。','他弄混了。','小王说，我弄混了。','你说“我弄混了”。','如果我弄混了，你可以纠正。','我弄混了吗？','不是说我弄混了。'])
    assert.equal(unsupportedPersonalAnswer([raw],context()),'',raw);
});

test('production reply flow blocks an unsupported mixing-up claim after one mock generation and does not regenerate on the next tick',async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  Object.assign(bridge.push(contact,'self','那今天好点没？'),human('那今天好点没？'));
  await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
  provider.next=async()=>({action:'send',text:'抱歉，弄混了。',followUp:false});
  Object.assign(bridge.push(contact,'other',correction),{timestamp:Math.floor(clock/1000)});
  await a.tick();const timing=effectiveTiming(a.data.settings,a.profiles().find(profile=>profile.contact===contact));clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  const afterFirst={mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text)};
  clock+=(Math.max(timing.replyDelay,timing.replyMaxWait)+1)*1000;await a.tick();
  const afterSecond={mockProviderCalls:provider.calls.length,fixtureSends:bridge.sent.length,texts:bridge.sent.map(row=>row.text)};
  t.diagnostic(JSON.stringify({afterFirst,afterSecond,realProviderCalls:0,realWechatSends:0}));
  assert.equal(afterFirst.mockProviderCalls,1);assert.equal(afterSecond.mockProviderCalls,1,'a handled rejected draft must not be generated again');
  assert.equal(afterFirst.fixtureSends,0,'unsupported historical self-fault must not reach the send bridge');assert.equal(afterSecond.fixtureSends,0);
});
