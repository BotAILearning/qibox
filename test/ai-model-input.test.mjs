import test from 'node:test';
import assert from 'node:assert/strict';
import { compactModelInput, encodeModelRequest } from '../server/ai-model-input.mjs';

test('reply wire sends each complete fact once and leaves the original guards untouched', () => {
  const message = { id: 'a', text: '完整来信'.repeat(50), direction: 'other', speaker: { role: 'other', id: 'c' }, quote: { text: '引用的我', speaker: { role: 'self' } } };
  const input = { mode: 'reply', messages: [message], conversation: { pendingIncomingMessages: [message], latestIncoming: message }, memory: { summary: '长期事实', entries: [{ text: '长期事实', field: 'city', contextRole: 'lastKnown' }] } };
  const wire = compactModelInput(input);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(input).length);
  assert.equal(JSON.stringify(wire).split(message.text).length - 1, 1);
  assert.equal(wire.messages[0].text, message.text);
  assert.deepEqual(wire.conversation.latestIncoming.quote, message.quote);
  assert.equal(wire.conversation.pendingIncomingMessages[0].excerpt, true);
  assert.equal(input.conversation.latestIncoming.text, message.text);
  assert.equal(input.memory.summary, '长期事实');
  assert.equal(wire.memory.entries[0].contextRole, 'lastKnown');
});

test('request-local references retain every actor, quote and fact and restore evidence IDs', () => {
  const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
  const input={mode:'reply',messages:[{id:a,sender:b,speaker:{id:'member:'+b,role:'group_member'},text:'qref1 是原话，事实哈希 '+a,quote:{messageId:c,text:'我周日去过'}}],conversation:{pendingIncomingIds:[a]},memory:{entries:[{text:'原始事实 '+b,evidence:[c]}]}};
  const original=structuredClone(input),wire=encodeModelRequest('只回应成员 '+b+' 的消息 '+a,input);
  assert.deepEqual(input,original);assert.deepEqual(wire.decode(wire.input),input);
  assert.equal(wire.input.messages[0].text,input.messages[0].text);
  assert.equal(wire.input.messages[0].quote.text,'我周日去过');
  assert.equal(wire.input.messages[0].speaker.role,'group_member');
  assert.equal(wire.id(a),wire.input.messages[0].id);
  assert.equal(wire.input.conversation.pendingIncomingIds[0],wire.id(a));
  assert.doesNotMatch(wire.system,new RegExp(a));
  assert.deepEqual(wire.decode({selfMemorySuggestions:[{evidence:[wire.id(a)]}]}),{selfMemorySuggestions:[{evidence:[a]}]});
  assert.ok(JSON.stringify(wire.input).length<JSON.stringify(input).length);
  assert.deepEqual(encodeModelRequest('分析', {...input,mode:'analysis'}).input,{...input,mode:'analysis'});
});

test('different speakers, quotes, duplicate IDs and additional summaries are preserved', () => {
  const message = { id: 'a', text: '我已付款', direction: 'other', speaker: { id: 'c' } };
  for (const row of [{ ...message, speaker: { id: 'self' } }, { ...message, quote: { text: '旧消息' } }, { ...message, text: '另一条原话' }]) {
    const input = { mode: 'reply', messages: [message], conversation: { pendingIncomingMessages: [row] }, memory: { summary: '额外事实', entries: [{ text: '不同的事实' }] } };
    assert.equal(compactModelInput(input).conversation.pendingIncomingMessages[0].text, row.text);
    assert.equal(compactModelInput(input).memory.summary, '额外事实');
  }
  assert.equal(compactModelInput({ mode: 'reply', messages: [message, message], conversation: { latestIncoming: message } }).conversation.latestIncoming.text, message.text);
});

test('automatic style sample references match the compacted transcript', () => {
  const ids = ['a','b','c'].map(value => value.repeat(64));
  for (const mode of ['reply','memory-monitor']) {
    const input = {mode, messages:ids.map(id=>({id,direction:'self',authorship:'human',text:'好的呀'})),styleLearningMessageIds:ids,newMessageIds:[ids[2]]};
    const wire = encodeModelRequest('学习',input);
    assert.deepEqual(wire.input.styleLearningMessageIds,wire.input.messages.map(row=>row.id));
    assert.deepEqual(wire.decode(wire.input),input);
  }
});

test('human interaction examples retain paired bodies and the same request-local IDs as the original transcript',()=>{
  const incoming={id:'b'.repeat(64),direction:'other',text:'这是你的原话吗？'},reply={id:'c'.repeat(64),direction:'self',authorship:'human',text:'对，我说的。'};
  const input={mode:'reply',messages:[incoming,reply],contextualStyle:{samples:[reply],pairedExamples:[{relation:'adjacent-context',incoming:{id:incoming.id,text:incoming.text},reply:{id:reply.id,text:reply.text}}]}};
  const original=structuredClone(input),compact=compactModelInput(input),wire=encodeModelRequest('当前聊天',compact),pair=wire.input.contextualStyle.pairedExamples[0];
  assert.equal(pair.incoming.id,wire.input.messages[0].id);assert.equal(pair.reply.id,wire.input.messages[1].id);
  assert.equal(wire.input.messages.find(row=>row.id===pair.incoming.textRef).text,incoming.text);assert.equal(wire.input.messages.find(row=>row.id===pair.reply.textRef).text,reply.text);
  assert.equal(wire.input.messages.find(row=>row.id===pair.reply.textRef).authorship,'human');assert.deepEqual(wire.decode(wire.input),compact);assert.deepEqual(input,original);
});

test('subjectId values use the same request-local opaque reference and decode losslessly',()=>{
  const subjectId='contact:'+'d'.repeat(64),messageId='e'.repeat(64);
  const input={mode:'reply',messages:[{id:messageId,direction:'other',text:'合成来信'}],memory:{entries:[{text:'合成事实',subjectId,evidence:[messageId]}]},memoryEvidence:[{subjectId}]};
  const wire=encodeModelRequest('合成',input);
  assert.notEqual(wire.input.memory.entries[0].subjectId,subjectId);
  assert.equal(wire.input.memory.entries[0].subjectId,wire.input.memoryEvidence[0].subjectId);
  assert.equal(wire.input.memory.entries[0].subjectId,wire.id(subjectId));
  assert.deepEqual(wire.decode(wire.input),input);
});

test('current-chat human interaction examples stay readable in a bounded wire view before the current turn',()=>{
  const messages=[{id:'in',direction:'other',text:'折腾一圈总算拆开了'},
    {id:'self',direction:'self',authorship:'human',text:'可算理顺了'},
    {id:'ai',direction:'self',authorship:'ai',aiGenerated:true,text:'不可当真人'},
    {id:'unknown',direction:'self',authorship:'unknown',text:'来源未知'},
    {id:'large',direction:'other',text:'完整长背景'.repeat(400)},
    {id:'now',direction:'other',text:'当前来信'}];
  const pair=(a,b)=>({relation:'adjacent-context',incoming:{id:a.id,text:a.text},reply:{id:b.id,text:b.text}});
  const input={mode:'reply',messages,contextualStyle:{source:'current-chat-human',pairedExamples:[pair(messages[0],messages[1]),pair(messages[0],messages[2]),pair(messages[0],messages[3]),pair(messages[4],messages[1])]},conversation:{latestIncoming:messages[5],pendingIncomingMessages:[messages[5]]}};
  const before=structuredClone(input),wire=compactModelInput(input),pairs=wire.contextualStyle.pairedExamples;
  assert.equal(pairs[0].incoming.text,messages[0].text);assert.equal(pairs[0].reply.text,messages[1].text);
  for(const p of pairs.slice(1)){assert.equal(p.incoming.text,undefined);assert.equal(p.reply.text,undefined);}
  assert.deepEqual(wire.messages,messages);assert.equal(Object.keys(wire).at(-1),'conversation');
  assert.equal(wire.conversation.latestIncoming.textRef,'now');assert.deepEqual(input,before);
  const encoded=encodeModelRequest('当前回复',wire);assert.deepEqual(encoded.decode(encoded.input),wire);
});

test('inline style view preserves conflicting evidence, unknown receipt, and unique actor requirements',()=>{
  for(const change of [{authorship:'unknown'},{authorship:'human',deliveryConfidence:'unknown'},{authorship:'human',assumedPresent:true},{authorship:'human',unresolved:true}]){
    const source={id:'self',direction:'self',text:'原话',...change},incoming={id:'other',direction:'other',text:'对方原话'};
    const input={mode:'reply',messages:[incoming,source],contextualStyle:{source:'current-chat-human',pairedExamples:[{relation:'adjacent-context',incoming:{id:'other',text:'对方原话'},reply:{id:'self',text:'原话'}}]}};
    assert.equal(compactModelInput(input).contextualStyle.pairedExamples[0].reply.text,undefined);
  }
  const source={id:'self',direction:'self',authorship:'human',text:'原话'},incoming={id:'other',direction:'other',text:'对方原话'};
  const pair={relation:'adjacent-context',incoming,reply:{...source,speaker:{id:'wrong-actor'}}};
  const input={mode:'reply',messages:[incoming,source],contextualStyle:{source:'current-chat-human',pairedExamples:[pair]}};
  assert.deepEqual(compactModelInput(input).contextualStyle.pairedExamples[0].reply,pair.reply);
});

test('inline interaction view caps complete examples and retains duplicate-id ambiguity without source rewriting',()=>{
  const messages=Array.from({length:8},(_,i)=>({id:'m'+i,direction:i%2?'self':'other',...(i%2?{authorship:'human'}:{}),text:('原话'+i).repeat(30)}));
  const pairs=[0,2,4,6].map(i=>({relation:'adjacent-context',incoming:{id:messages[i].id,text:messages[i].text},reply:{id:messages[i+1].id,text:messages[i+1].text}}));
  const input={mode:'reply',messages,contextualStyle:{source:'current-chat-human',pairedExamples:pairs}},before=structuredClone(input),wire=compactModelInput(input),inline=wire.contextualStyle.pairedExamples.filter(p=>typeof p.reply.text==='string');
  assert.equal(inline.length,2);assert(inline.reduce((n,p)=>n+p.incoming.text.length+p.reply.text.length,0)<=900);assert.deepEqual(wire.messages,messages);assert.deepEqual(input,before);
  const ambiguous={...input,messages:[...messages,messages[7]]},duplicate=compactModelInput(ambiguous).contextualStyle.pairedExamples.at(-1);
  assert.deepEqual(duplicate.reply,pairs.at(-1).reply);assert.equal(duplicate.reply.textRef,undefined);
  assert.doesNotThrow(()=>compactModelInput({mode:'reply',contextualStyle:{source:'current-chat-human',pairedExamples:'invalid'}}));
});
