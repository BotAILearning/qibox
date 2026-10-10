import test from 'node:test';
import assert from 'node:assert/strict';
import {unsupportedPersonalAnswer, unsupportedChatTime} from '../server/ai-personal-answer.mjs';

test('unknown live presence and employment denials are not invented for natural chat',()=>{
  for(const text of ['怎么突然问这个，我在家呢。','我现在在办公室忙。','我没有在哪家公司上班。','我没在任何公司工作'])assert.equal(unsupportedPersonalAnswer([text]),'personal-fact',text);
  for(const text of ['这个这会儿说不准，找我是有什么事？','我在想怎么安排。','你在家就好。','他说“我在家”。','如果我在家就方便了。'])assert.equal(unsupportedPersonalAnswer([text]),'',text);
});
test('only recent human first-person evidence or explicit user facts establish live presence',()=>{
  const now=1700000000000,m={direction:'self',authorship:'human',text:'我在家呢。',timestamp:Math.floor(now/1000)-60};
  assert.equal(unsupportedPersonalAnswer(['我在家呢'],{messages:[m],now}),'');
  for(const bad of [{...m,aiGenerated:true},{...m,direction:'other'},{...m,authorship:'unknown'},{...m,timestamp:m.timestamp-86400},{...m,text:'他说“我在家”。'}])assert.equal(unsupportedPersonalAnswer(['我在家呢'],{messages:[bad],now}),'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['我在家呢'],{facts:'我本人在家。',now}),'');
  assert.equal(unsupportedPersonalAnswer(['我在家呢'],{facts:'对方说我在家。',now}),'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['我没有在哪家公司上班。'],{facts:'我没有在哪家公司上班。',now}),'');
});
test('topic prefixes and segment boundaries cannot create an unsupported callback',()=>{
  for(const texts of [['具体几点等我确认一下再跟你说。'],['剩下的等我确定了通知你。'],['具体几点等我确认','一下再跟你说'],['行，改成周日。我确认下时间再回你。']])assert.equal(unsupportedPersonalAnswer(texts),'future-notice');
  for(const text of ['等你确定了告诉我。','等他确认后再说吧。','不用等我确认再跟你说。','他说“等我确认一下再跟你说”。'])assert.equal(unsupportedPersonalAnswer([text]),'',text);
});

test('confirming and agreeing a time later is still an unsupported callback',()=>{
  for(const texts of [['行，那就周日。具体几点我确认下再跟你定。'],['具体几点等我确认以后和你定时间。'],['我确认下再跟你','定']])assert.equal(unsupportedPersonalAnswer(texts),'future-notice');
  for(const text of ['等你确认后我们再定。','他说“我确认下再跟你定”。','我不确认时间，也不定时间。'])assert.equal(unsupportedPersonalAnswer([text]),'',text);
});

test('a single pending AI question cannot get a bare false denial',()=>{
  const context={identityAsked:true,pendingMessages:[{direction:'other',text:'你是AI在代回复吗？'}]};
  for(const text of ['不是的，有什么事你说','并不是呀','我不是AI'])assert.equal(unsupportedPersonalAnswer([text],context),'identity-rule');
  for(const text of ['哪里听着不自然？','他说“不是的”。','不是说AI没有用。'])assert.equal(unsupportedPersonalAnswer([text],context),'');
  assert.equal(unsupportedPersonalAnswer(['不是的']), '');
  assert.equal(unsupportedPersonalAnswer(['不是的'],{...context,pendingMessages:[{direction:'other',text:'是不是退款到账了？'}]}),'');
  assert.equal(unsupportedPersonalAnswer(['不是的'],{...context,pendingMessages:[...context.pendingMessages,{direction:'other',text:'退款到账了吗？'}]}),'');
});

test('an unknown location cannot invent privacy as the reason for withholding it',()=>{
  const context={pendingMessages:[{direction:'other',text:'你现在具体在哪个地方？'}]};
  assert.equal(unsupportedPersonalAnswer(['我这边位置不太方便说'],context),'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['我这边位置不太方便说'],{...context,boundaries:'不透露位置'}),'');
  assert.equal(unsupportedPersonalAnswer(['他说“位置不方便说”。'],context),'');
  assert.equal(unsupportedPersonalAnswer(['这个不方便说'],{pendingMessages:[{direction:'other',text:'你银行卡密码多少？'}]}),'');
});

test('a conversational preference does not authorize a new physical delivery promise',()=>{
  const text='哦哦记错了，是喜欢茶，那下次给你带点茶。';
  assert.equal(unsupportedPersonalAnswer([text],{messages:[{direction:'other',text:'我只说喜欢茶'}]}),'future-notice');
  assert.equal(unsupportedPersonalAnswer(['那下次给你带点茶'],{facts:'我下次给你带点茶'}),'');
  assert.equal(unsupportedPersonalAnswer(['那下次给你带点茶'],{facts:'他说“我下次给你带点茶”'}),'future-notice');
  assert.equal(unsupportedPersonalAnswer(['那下次给你带点茶'],{facts:'我明天给你带点茶'}),'future-notice');
  assert.equal(unsupportedPersonalAnswer(['他说“下次给你带点茶”。']), '');
});

test('a vague yesterday event cannot be made a night event or an invented earlier message',()=>{
  const now=Date.parse('2026-10-10T13:00:00Z'),m={direction:'other',text:'昨天胃疼',timestamp:Math.floor(now/1000)-1200};
  assert.equal(unsupportedChatTime(['昨天听你说胃疼。'],{messages:[m],now}),'time-fact');
  assert.equal(unsupportedChatTime(['昨晚的事翻篇就好。'],{messages:[{...m,text:'昨天下雨那事已经过去了'}],now}),'time-fact');
  assert.equal(unsupportedChatTime(['昨晚的事翻篇就好。'],{messages:[{...m,text:'昨晚下雨了'}],now}),'');
  assert.equal(unsupportedChatTime(['昨天听你说胃疼。'],{messages:[{...m,timestamp:m.timestamp-86400}],now}),'');
  assert.equal(unsupportedChatTime(['昨天听你说胃疼。'],{messages:[{...m,timestamp:m.timestamp-86400,direction:'self'}],now}),'time-fact');
  assert.equal(unsupportedChatTime(['整理一年前的照片挺费劲的吧'],{messages:[{...m,text:'去年旅行拍的照片今天才整理'}],now}),'time-fact');
  assert.equal(unsupportedChatTime(['整理一年前的照片'],{messages:[{...m,text:'一年前的照片今天才整理'}],now}),'');
  for(const text of ['他说“昨晚的事翻篇”。','昨天的事翻篇就好。','你昨晚睡得好吗？'])assert.equal(unsupportedChatTime([text],{messages:[m],now}),'');
});
