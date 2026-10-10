import test from 'node:test';
import assert from 'node:assert/strict';
import {unsupportedPersonalAnswer, unsupportedChatTime, personalQuestionClarification, knownDateCorrection} from '../server/ai-personal-answer.mjs';

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

test('split callback promises and new invitations stay blocked without changing quoted or already authorized plans',()=>{
  for (const text of ['行，那改周日。具体几点我再确认一下，到时候跟你说。', '我确认下时间', '到时候跟你说', '那回头选茶的时候叫上你'])
    assert.equal(unsupportedPersonalAnswer([text]), 'future-notice', text);
  for (const text of ['我已经确认过时间了', '我不确认时间', '不用我再确认一下', '他说“到时候跟你说”', '你回头选茶的时候叫上他'])
    assert.equal(unsupportedPersonalAnswer([text]), '', text);
  assert.equal(unsupportedPersonalAnswer(['那回头选茶的时候叫上你'], { facts: '我回头选茶的时候叫上你' }), '');
  assert.equal(unsupportedPersonalAnswer(['那回头选茶的时候叫上你'], { facts: '我明天选茶的时候叫上你' }), 'future-notice');
});

test('a counterpart who declined planning assistance does not receive a newly finalized arrangement',()=>{
  const context = {pendingMessages: [{direction: 'other', text: '我周日想买书，其余再看，不用帮我确定计划。'}]};
  assert.equal(unsupportedPersonalAnswer(['行，那就定周日，按天气看着办就好'], context), 'future-notice');
  for (const text of ['你想周日去，其他的看天气', '先看天气，书店想去就去', '他说“那就定周日”']) assert.equal(unsupportedPersonalAnswer([text], context), '');
  assert.equal(unsupportedPersonalAnswer(['行，那就定周日'], {pendingMessages: [{direction: 'other', text: '确定周日，就这样定吧。'}]}), '');
});

test('an implicit later agreement is still an added future action',()=>{
  assert.equal(unsupportedPersonalAnswer(['行，那就改周日，具体几点到时候再定。']), 'future-notice');
  for (const text of ['行，那就改周日，具体时间到时候再对一下。', '具体时间回头再核对', '到时再确认一下']) assert.equal(unsupportedPersonalAnswer([text]), 'future-notice', text);
  for(const text of ['到时候看天气', '你到时候再定时间', '他说“到时候再定”'])assert.equal(unsupportedPersonalAnswer([text]), '',text);
  for(const text of ['具体时间不用到时候再对一下', '你到时候再核对时间', '他说“具体时间到时候再对一下”'])assert.equal(unsupportedPersonalAnswer([text]), '',text);
});

test('a relative moving does not establish that the counterpart helped',()=>{
  const text='原来是你哥要搬，辛苦你帮忙整理啦';
  const context={messages:[{direction:'other',text:'哥哥在整理东西。'},{direction:'other',text:'我哥哥要搬家，这不是我本人要搬。'}]};
  assert.equal(unsupportedPersonalAnswer([text],context),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer(['辛苦你帮忙','整理啦'],context),'recipient-fact');
  for(const source of ['我帮哥哥整理了', '我正在帮忙整理']) assert.equal(unsupportedPersonalAnswer([text],{messages:[{direction:'other',text:source}]}),'');
  for(const source of ['我没有帮忙整理','我准备帮忙整理','我明天帮哥哥整理','我可能帮忙整理','我哥帮忙整理','我说“我帮忙整理”']) assert.equal(unsupportedPersonalAnswer([text],{messages:[{direction:'other',text:source}]}),'recipient-fact',source);
  assert.equal(unsupportedPersonalAnswer([text],{messages:[{direction:'other',text:'我帮忙整理',aiGenerated:true}]}),'recipient-fact');
  assert.equal(unsupportedPersonalAnswer([text],{messages:[{direction:'self',authorship:'human',text:'你帮忙整理了'}]}),'');
  assert.equal(unsupportedPersonalAnswer([text],{facts:'对方帮哥哥整理了'}),'');
  for(const allowed of ['辛苦你了','辛苦你等了','如果你帮忙整理就辛苦你了','他说“辛苦你帮忙整理啦”','你帮得上忙吗？','麻烦你帮忙整理一下']) assert.equal(unsupportedPersonalAnswer([allowed],context),'',allowed);
});

test('unknown personal questions can be clarified without inventing ignorance or losing additional questions',()=>{
  for(const [question,text] of [['你今天在哪家公司上班？','这个我暂时说不上来，你找我有什么事吗？'],['你现在具体在哪个地方？','你问我位置是想问什么事呀？我这边具体情况说不太上']]){
    const pendingMessages=[{direction:'other',text:question}];
    assert.equal(unsupportedPersonalAnswer([text],{pendingMessages}),'unknown-self');
    assert.equal(personalQuestionClarification(pendingMessages),'怎么了，找我有事吗？');
    assert.equal(personalQuestionClarification([...pendingMessages,{direction:'other',text:'你能解释一下这个问题吗'}]),'');
  }
  assert.equal(personalQuestionClarification([{direction:'other',text:'你现在具体在哪个地方？顺便回答今天几号'}]),'');
  assert.equal(unsupportedPersonalAnswer(['这个我说不上来'],{pendingMessages:[{direction:'other',text:'你知道猫为什么这么睡吗？'}]}),'');
});

test('date corrections repeat only a recent human-approved plan and only the provided day',()=>{
 const now=1700000000000, pendingMessages=[{direction:'other',text:'改成周日吧，周六我不行。'}],human={direction:'self',authorship:'human',text:'先按周六记着。',timestamp:Math.floor(now/1000)-60};
 assert.equal(knownDateCorrection({pendingMessages,messages:[human],now}),'行，改成周日。');
 for(const bad of [{...human,aiGenerated:true},{...human,direction:'other'},{...human,authorship:'unknown'},{...human,timestamp:human.timestamp-86400},{...human,text:'他说“我们周六见面”。'}])assert.equal(knownDateCorrection({pendingMessages,messages:[bad],now}),'');
 assert.equal(knownDateCorrection({pendingMessages:[...pendingMessages,{direction:'other',text:'还要确认一下另外一件事'}],messages:[human],now}),'');
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

test('a refund result cannot create an unsolicited future notice',()=>{
  for(const texts of [['等钱真回来了我再跟你说一声。'],['等退款到账了，我再通知你。'],['等结果出来了再告诉你'],['等钱真回来了我再','跟你说一声']])
    assert.equal(unsupportedPersonalAnswer(texts),'future-notice');
  for(const text of ['等钱到了你再告诉我','等你确认后告诉我','他说“等钱回来了我再通知你”','不用等钱回来了我再通知你','钱到账才算完成，先等一下吧'])
    assert.equal(unsupportedPersonalAnswer([text]),'',text);
});

test('meeting friends today does not prove a full day of activity',()=>{
  const message={direction:'other',text:'今天见了两个朋友，其中一个下周搬家，另一个开始学游泳。'};
  for(const texts of [['见了一天朋友，挺充实的'],['你今天见了一整天朋友'],['见了一天','朋友']])
    assert.equal(unsupportedChatTime(texts,{messages:[message]}),'time-fact');
  for(const text of ['今天见了两个朋友','他说“见了一天朋友”','如果见了一天朋友，那会挺累'])
    assert.equal(unsupportedChatTime([text],{messages:[message]}),'',text);
  assert.equal(unsupportedChatTime(['见了一天朋友'],{messages:[{...message,text:'我今天见了一天朋友'}]}),'');
  for(const text of ['哥哥今天见了一天朋友','我明天见一天朋友','我没有见一天朋友','他说“我见了一天朋友”'])
    assert.equal(unsupportedChatTime(['见了一天朋友'],{messages:[{...message,text}]}),'time-fact',text);
});
