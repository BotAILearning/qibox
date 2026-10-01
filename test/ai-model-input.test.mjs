import test from 'node:test';
import assert from 'node:assert/strict';
import { compactModelInput } from '../server/ai-model-input.mjs';

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

test('different speakers, quotes, duplicate IDs and additional summaries are preserved', () => {
  const message = { id: 'a', text: '我已付款', direction: 'other', speaker: { id: 'c' } };
  for (const row of [{ ...message, speaker: { id: 'self' } }, { ...message, quote: { text: '旧消息' } }, { ...message, text: '另一条原话' }]) {
    const input = { mode: 'reply', messages: [message], conversation: { pendingIncomingMessages: [row] }, memory: { summary: '额外事实', entries: [{ text: '不同的事实' }] } };
    assert.equal(compactModelInput(input).conversation.pendingIncomingMessages[0].text, row.text);
    assert.equal(compactModelInput(input).memory.summary, '额外事实');
  }
  assert.equal(compactModelInput({ mode: 'reply', messages: [message, message], conversation: { latestIncoming: message } }).conversation.latestIncoming.text, message.text);
});
