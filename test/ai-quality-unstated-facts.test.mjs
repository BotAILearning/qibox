import test from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedPersonalAnswer } from '../server/ai-personal-answer.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
const now=Date.parse('2026-10-22T12:00:00+08:00');
const human=(text,extra={})=>({direction:'self',authorship:'human',timestamp:Math.floor(now/1000)-60,text,...extra});
const other=(text,extra={})=>({direction:'other',authorship:'other',timestamp:Math.floor(now/1000)-30,text,...extra});
const incoming='我只说喜欢茶，没说我每天都喝咖啡。';
const context=(extra={})=>({now,pendingMessages:[other(incoming)],...extra});

test('original007 omitted-subject apology is a sourced historical claim rather than a free acknowledgement',()=>{
  assert.equal(unsupportedPersonalAnswer(['抱歉搞混了，那我先不动你的。'],{now}),'personal-fact');
  for(const text of ['抱歉搞混了。','不好意思，记错了。','对不起，弄错了。','抱歉，理解错你的意思了。']){
    assert.equal(unsupportedPersonalAnswer([text],{now}),'personal-fact',text);
    assert.equal(unsupportedPersonalAnswer([text],{now,messages:[human(text)]}),'',text);
  }
  assert.equal(unsupportedPersonalAnswer(['抱歉搞混了。'],{now,messages:[human('我搞混了。')]}),'');
  for(const source of [other('你搞混了。'),human('我搞混了。',{authorship:'unknown'}),human('我搞混了。',{aiGenerated:true}),human('我今天喝茶。'),human('我搞混了。',{timestamp:Math.floor(now/1000)+60})])
    assert.equal(unsupportedPersonalAnswer(['抱歉搞混了。'],{now,messages:[source]}),'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['抱歉搞','混了。'],{now}),'personal-fact');
});

test('ordinary present apologies, third-person reports, conditions, questions and denials do not become owner mistake claims',()=>{
  for(const text of ['抱歉让你误会了。','抱歉让你担心了。','明白，胃疼的是你。','抱歉，他搞混了。','他说“抱歉搞混了”。','他说，抱歉搞混了。','小王说，抱歉搞混了。','如果搞混了，请你纠正。','如果抱歉搞混了是他的原话，就按引用看。','抱歉，搞混了吗？','不是说抱歉搞混了。','抱歉，没搞混。','抱歉。','不好意思。','对不起。','抱歉，胃疼的是你。'])
    assert.equal(unsupportedPersonalAnswer([text],{now}),'',text);
});

test('a bare completed owner mistake requires independent evidence even when the subject is omitted',()=>{
  // This old008 ordinary-example assertion now follows the confirmed017
  // history rule: a present apology and an admission of a prior fault differ.
  const text='搞混了。';
  assert.equal(unsupportedPersonalAnswer([text],{now}),'personal-fact');
  for(const source of ['我搞混了。',text])assert.equal(unsupportedPersonalAnswer([text],{now,messages:[human(source)]}),'',source);
  assert.equal(unsupportedPersonalAnswer([text],{now,facts:'我搞混了。'}),'');
  for(const source of [other('你搞混了。'),human('我搞混了。',{authorship:'unknown'}),human('我搞混了。',{aiGenerated:true}),human('我今天喝茶。'),human('我搞混了。',{timestamp:Math.floor(now/1000)+60})])
    assert.equal(unsupportedPersonalAnswer([text],{now,messages:[source]}),'personal-fact',JSON.stringify(source));
});

test('original007 unstated frequency must not become either a negative or positive recipient fact',()=>{
  assert.equal(unsupportedPersonalAnswer(['嗯，明白，你只是喜欢茶，不是每天都喝咖啡。'],context()),'recipient-fact');
  for(const text of ['你不是每天喝咖啡。','你每天都喝咖啡。','不是每天都喝咖啡。'])
    assert.equal(unsupportedPersonalAnswer([text],context()),'recipient-fact',text);
  assert.equal(unsupportedPersonalAnswer(['你喝咖啡。'],{now,pendingMessages:[other('我没说我不喝咖啡。')]}),'recipient-fact');
  for(const input of ['我未确认我每天喝咖啡。','我没提过我每天都喝咖啡。'])
    assert.equal(unsupportedPersonalAnswer(['你不是每天喝咖啡。'],{now,pendingMessages:[other(input)]}),'recipient-fact',input);
});

test('metalinguistic acknowledgement, different actors/frequencies, quotations, conditionals and questions remain intact',()=>{
  for(const text of ['对，你只说喜欢茶，没说每天都喝咖啡。','喜欢茶不代表每天喝咖啡。','你没说每天喝咖啡，不等于你不喝。','他不是每天都喝咖啡。','你不是每周都喝咖啡。','他说“不是每天都喝咖啡”。','他说，不是每天都喝咖啡。','如果不是每天喝咖啡，就按自己的习惯来。','你不是每天都喝咖啡吗？','我不是每天都喝咖啡。'])
    assert.equal(unsupportedPersonalAnswer([text],context()),'',text);
  for(const text of ['不是每天都喝咖啡。','你每天都喝咖啡。'])
    assert.equal(unsupportedPersonalAnswer([text],{now,pendingMessages:[other('我不是每天都喝咖啡。')]}),'',text);
  assert.equal(unsupportedPersonalAnswer(['你不是每天都喝咖啡。'],{now,pendingMessages:[other('他说“我没说我每天都喝咖啡”。')]}),'');
});

test('independent matching actor-authoritative declarations can establish that exact proposition and polarity',()=>{
  const draft='你不是每天喝咖啡。';
  for(const messages of [[other('我不是每天都喝咖啡。')],[human('你不是每天都喝咖啡。')]])
    assert.equal(unsupportedPersonalAnswer([draft],context({messages})),'');
  assert.equal(unsupportedPersonalAnswer([draft],context({facts:'对方不是每天都喝咖啡。'})),'');
  assert.equal(unsupportedPersonalAnswer([draft],context({messages:[other('其实我确实不是每天都喝咖啡。')]})),'');
  assert.equal(unsupportedPersonalAnswer([draft],context({pendingMessages:[other('我没说我每天喝咖啡。我确实不是每天都喝咖啡。')],messages:[other('我没说我每天喝咖啡。我确实不是每天都喝咖啡。')]})),'');
  assert.equal(unsupportedPersonalAnswer(['你每天都喝咖啡。'],context({messages:[other('我每天都喝咖啡。')]})),'');
  for(const source of [other('我每天都喝咖啡。'),other('我不是每天都喝咖啡。',{aiGenerated:true}),other('我不是每天都喝咖啡。',{timestamp:Math.floor(now/1000)+60}),other('他说“我不是每天喝咖啡”。'),other('如果我不是每天喝咖啡，那也正常。'),human('我不是每天都喝咖啡。')])
    assert.equal(unsupportedPersonalAnswer([draft],context({messages:[source]})),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer([draft],context({pendingMessages:[other(incoming,{speaker:{id:'A'}})],messages:[other('我不是每天都喝咖啡。',{speaker:{id:'B'}})]})),'recipient-fact');
  for(const speaker of [{id:'B'},{label:'another named actor'}])
    assert.equal(unsupportedPersonalAnswer([draft],context({messages:[other('我不是每天都喝咖啡。',{speaker})]})),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer([draft],context({pendingMessages:[other(incoming,{speaker:{id:'A'}})],messages:[other('我不是每天都喝咖啡。',{speaker:{id:'A'}})]})), '');
});

for(const scenario of [
  {name:'007 raw apology',incoming:'我不是阿海，别把另一个人的安排套到我这里。',candidate:'抱歉搞混了，那我先不动你的。',expected:[]},
  {name:'007 raw unstated frequency',incoming,candidate:'嗯，明白，你只是喜欢茶，不是每天都喝咖啡。',expected:[]},
  {name:'literal same-turn acknowledgement',incoming,candidate:'对，你只说喜欢茶，没说每天都喝咖啡。',expected:['对，你只说喜欢茶，没说每天都喝咖啡。']},
  {name:'independent recipient declaration',incoming,history:[other('我不是每天都喝咖啡。')],candidate:'你不是每天喝咖啡。',expected:['你不是每天喝咖啡。']},
  {name:'bare completed owner mistake without a source',incoming:'你记错了，胃疼的是我，不是你。',history:[human('那今天好点没？')],candidate:'搞混了。',expected:[]},
  {name:'pure current apology with actor confirmation',incoming:'你记错了，胃疼的是我，不是你。',history:[human('那今天好点没？')],candidate:'抱歉，胃疼的是你。',expected:['抱歉，胃疼的是你。']},
  {name:'bare owner mistake with independent human support',incoming:'你记错了，胃疼的是我，不是你。',history:[human('我搞混了。')],candidate:'搞混了。',expected:['搞混了。']},
])test(`one-request production pipeline: ${scenario.name}`,async t=>{
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let clock=now;bridge.stableMessageIds=true;const contact=bridge.contacts[0].id;
 const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>clock,delay:async()=>{},random:min=>min});
 t.after(async()=>{await a.close();await cleanup(root);});
 await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
 for(const message of scenario.history||[])Object.assign(bridge.push(contact,message.direction,message.text),message);
 await a.setReplyOptions({contact,enabled:true,judgeReply:false});await a.settings({enabled:true});await a.tick();
 provider.next=async()=>({action:'send',text:scenario.candidate,followUp:false});Object.assign(bridge.push(contact,'other',scenario.incoming),{timestamp:Math.floor(clock/1000)});
 await a.tick();clock+=20000;await a.tick();assert.equal(provider.calls.length,1);assert.deepEqual(bridge.sent.map(row=>row.text),scenario.expected);
 t.diagnostic(JSON.stringify({mockProviderCalls:1,fixtureSends:bridge.sent.length,realProviderCalls:0,realWechatSends:0}));
});
