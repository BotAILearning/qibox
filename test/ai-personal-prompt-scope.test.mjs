import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { personalInformation, stageSelfSuggestions } from '../server/ai-account-configuration.mjs';
import { authoredMessages } from '../server/ai-context-learning.mjs';
import { unsupportedPersonalAnswer } from '../server/ai-personal-answer.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function replyFixture(t, learning) {
  const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-10-27T10:00:00+08:00');
  const contact = bridge.contacts[0].id;
  bridge.messages.set(contact, [{id:key('scope-before'),direction:'self',text:'早上那份材料已经发给你了。',timestamp:now/1000-3600}]);
  const a = new AIAssistant({dataRoot,bridge,provider,now:()=>now,delay:async()=>{},random:min=>min});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);
  t.after(async()=>{await a.close();await cleanup(dataRoot);});
  await a.configure(modelConfig);await a.scan();
  await a.saveReplyProfile({contact,style:{summary:'自然接话，不复述材料'},strategy:{replyGoal:'自然聊天',facts:'',boundaries:'不擅自承诺',maxRounds:30},replyEnabled:true});
  await a.settings({enabled:true,autoLearning:learning,proactive:false});await a.tick();
  now+=1000;
  const incoming=Object.assign(bridge.push(contact,'other','你那份材料最后是阿文替你打印的，我只是帮着装订。他看到你的那摞纸还说这回挺费墨，我自己的那份倒还没开始弄，整张桌子先被你们占满了。'),{timestamp:now/1000});
  provider.next=async()=>({action:'send',text:'桌子先替打印机加了个班。',followUp:false});
  await a.tick();now+=20000;await a.tick();
  const replies=provider.calls.filter(call=>call.input.mode==='reply');
  assert.equal(replies.length,1,'This prompt change must not add a reply reviewer or retry');
  assert.equal(bridge.sent.length,1);
  return {a,bridge,provider,contact,incoming,call:replies[0]};
}

test('ordinary reply with learning disabled does not request persistent personal-information extraction',async t=>{
  const {a,call}=await replyFixture(t,false);
  assert.equal(call.input.mode,'reply');
  assert.doesNotMatch(call.system,/可返回\s*selfMemorySuggestions/u,'A disabled learning feature must not still tell the reply generator it may return personal extraction');
  assert.match(call.system,/自动学习已关闭/u);
  assert.equal(personalInformation(a).suggestions.length,0);
});

test('reply policy distinguishes the other speaker from an event explicitly concerning self',async t=>{
  const {call,incoming}=await replyFixture(t,false);
  assert.doesNotMatch(call.system,/不把对方的话或\s*AI\s*代发内容写成本人事实/u,'The persistence-only prohibition must not ambiguously reject all counterpart statements about self');
  const source=call.input.messages.find(row=>row.id===incoming.id);
  assert.equal(source.direction,'other');assert.equal(source.speaker.role,'other');assert.equal(source.text,incoming.text);
  assert.equal(call.input.replyPerspective.author.role,'self');
  assert.match(call.system,/对方(?:明确)?(?:谈到|谈及|评论)本人事项/u);
});

test('enabled learning keeps its explicit self-only extraction, evidence IDs and per-round limit',async t=>{
  const {call}=await replyFixture(t,true);
  assert.match(call.system,/selfMemorySuggestions/u);
  assert.match(call.system,/真实用户self消息的ID/u);
  assert.match(call.system,/每轮最多3条/u);
  assert.match(call.system,/自动学习已获授权/u);
});

test('understanding counterpart comments never grants personal-information persistence or overwrites manual facts',()=>{
  const account=key('scope-owner'),contact=key('scope-contact'),a={data:{account,settings:{autoLearning:true},personalInformation:{}},vault:{open:value=>structuredClone(value),seal:value=>structuredClone(value)},profiles:()=>[],now:()=>10000};
  const raw=[{id:key('self-real-city'),direction:'self',text:'我住杭州。',timestamp:9},{id:key('peer-city'),direction:'other',text:'你住苏州。',timestamp:10},{id:key('generated-city'),direction:'self',text:'我住南京。',authorship:'ai',timestamp:10}];
  const messages=authoredMessages(a.vault,{account,contact,generatedIds:[raw[2].id]},raw);
  const bad=[{field:'city',text:'住苏州',messageId:raw[1].id},{field:'city',text:'住南京',messageId:raw[2].id}];
  assert.equal(stageSelfSuggestions(a,bad,messages),false);assert.equal(personalInformation(a).suggestions.length,0);
  assert.equal(stageSelfSuggestions(a,[{field:'city',text:'住杭州',messageId:raw[0].id}],messages),true);
  assert.equal(personalInformation(a).entries.length,1);
  assert.equal(personalInformation(a).entries[0].text,'住杭州');
  a.data.personalInformation[account]={entries:[{id:'manual',field:'city',text:'用户手填城市',source:'manual',allowGroup:false}],suggestions:[],history:[]};
  const before=structuredClone(a.data.personalInformation);
  assert.equal(stageSelfSuggestions(a,[{field:'city',text:'住杭州',messageId:raw[0].id}],messages),false);
  assert.deepEqual(a.data.personalInformation,before);
  a.data.settings.autoLearning=false;
  assert.equal(stageSelfSuggestions(a,[{field:'interests',text:'喜欢摄影',messageId:raw[0].id}],messages),false);
  assert.deepEqual(a.data.personalInformation,before);
});

test('counterpart claims cannot establish the owners unverified current location',()=>{
  const now=Date.parse('2026-10-27T10:00:00+08:00'),message={id:key('claimed-location'),direction:'other',authorship:'other',text:'你在家呢。',timestamp:now/1000};
  assert.equal(unsupportedPersonalAnswer(['我在家呢'],{messages:[message],now}),'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['我没有在哪家公司上班。'],{messages:[message],now}),'personal-fact');
});
