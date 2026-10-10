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

test('a vague yesterday event cannot be made a night event or an invented earlier message',()=>{
  const now=Date.parse('2026-10-10T13:00:00Z'),m={direction:'other',text:'昨天胃疼',timestamp:Math.floor(now/1000)-1200};
  assert.equal(unsupportedChatTime(['昨天听你说胃疼。'],{messages:[m],now}),'time-fact');
  assert.equal(unsupportedChatTime(['昨晚的事翻篇就好。'],{messages:[{...m,text:'昨天下雨那事已经过去了'}],now}),'time-fact');
  assert.equal(unsupportedChatTime(['昨晚的事翻篇就好。'],{messages:[{...m,text:'昨晚下雨了'}],now}),'');
  assert.equal(unsupportedChatTime(['昨天听你说胃疼。'],{messages:[{...m,timestamp:m.timestamp-86400}],now}),'');
  assert.equal(unsupportedChatTime(['昨天听你说胃疼。'],{messages:[{...m,timestamp:m.timestamp-86400,direction:'self'}],now}),'time-fact');
  for(const text of ['他说“昨晚的事翻篇”。','昨天的事翻篇就好。','你昨晚睡得好吗？'])assert.equal(unsupportedChatTime([text],{messages:[m],now}),'');
});
