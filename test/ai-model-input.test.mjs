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
