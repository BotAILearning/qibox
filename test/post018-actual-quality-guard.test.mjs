import test from 'node:test';
import assert from 'node:assert/strict';
import {unsupportedPersonalAnswer,ownerConfirmationRepair} from '../server/ai-personal-answer.mjs';
const now=Date.parse('2026-10-22T18:00:00+08:00');
const human=(text,extra={})=>({direction:'self',authorship:'human',timestamp:Math.floor(now/1000)-60,text,...extra});
const context={now,messages:[human('那今天好点没？')],pendingMessages:[{direction:'other',text:'你记错了，胃疼的是我，不是你。'}]};
const actual101='对，是你说昨天胃疼，我刚才没弄清楚。';
test('actual018 missing-understanding admission needs independent past owner evidence',()=>{
  for(const text of [actual101,'我刚才没搞清楚。','刚才没弄明白。','抱歉，之前没听明白。','我当时没能看明白。',
    '我刚才没弄清楚，你现在好点没？','我刚才没弄清楚，胃疼的是你？'])
    assert.equal(unsupportedPersonalAnswer([text],context),'personal-fact',text);
  assert.equal(unsupportedPersonalAnswer(['对，是你说昨天胃疼。','我刚才没弄','清楚。'],context),'personal-fact');
});
test('current clarification, questions, quotes, other actors and genuine conditions remain allowed',()=>{
  for(const text of ['我还没弄清楚你问的是哪件事，能说具体些吗？','我没弄明白你的问题。','我刚才没弄清楚吗？','你刚才没弄清楚。',
    '他说我刚才没弄清楚。','你说“我刚才没弄清楚”。','如果我刚才没弄清楚，你可以再说明。','刚才没弄清楚吗？'])
    assert.equal(unsupportedPersonalAnswer([text],context),'',text);
});
test('past understanding sources keep actor, authorship, timing and exact detail constraints',()=>{
  assert.equal(unsupportedPersonalAnswer([actual101],{...context,messages:[human('我刚才没弄清楚。')]}),'');
  assert.equal(unsupportedPersonalAnswer([actual101],{...context,facts:'我刚才没弄清楚。'}),'');
  for(const source of [human('我刚才没弄清楚。',{aiGenerated:true}),human('我刚才没弄清楚。',{authorship:'unknown'}),
    human('他刚才没弄清楚。'),human('“我刚才没弄清楚。”'),human('我刚才没弄清楚。',{timestamp:Math.floor(now/1000)+60}),
    human('我刚才没弄清楚。',{timestamp:Math.floor(now/1000)-86401}),human('我刚才没弄清楚路线。')])
    assert.equal(unsupportedPersonalAnswer([actual101],{...context,messages:[source]}),'personal-fact',JSON.stringify(source));
});
test('actual018 direct-confirmation uncertainty keeps only the already generated neutral clause',()=>{
  const ctx={pendingMessages:[{direction:'other',text:'你现在具体在哪个地方？'}]};
  for(const tail of ['我这边现在没法直接确认','我现在无法确认','我目前不能直接确定']){
    const raw='具体位置需要本人确认一下，'+tail+'。';
    assert.equal(ownerConfirmationRepair([raw],ctx),'具体位置需要本人确认一下',raw);
    assert.equal(unsupportedPersonalAnswer(['具体位置需要本人确认一下'],ctx),'');
  }
  for(const tail of ['我现在没法直接确认但我在家','我现在没法直接确认你在哪里','我现在没法直接确认后通知你','我现在没法直接确认，明天告诉你','他现在没法直接确认','我刚才没弄清楚'])
    assert.equal(ownerConfirmationRepair(['具体位置需要本人确认一下，'+tail+'。'],ctx),'',tail);
});
