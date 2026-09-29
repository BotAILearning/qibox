import test from 'node:test';
import assert from 'node:assert/strict';
import { guardFinancialCommitment } from '../server/ai-commitment-guard.mjs';

test('an unapproved payment request cannot turn a short yes into a financial promise', () => {
  assert.deepEqual(guardFinancialCommitment('你明天能帮我垫付五百块吗？', { action: 'send', text: '可以啊，怎么了' }),
    { action: 'send', text: '这事我得先确认一下，暂时不能答应你', followUp: false });
  assert.deepEqual(guardFinancialCommitment('能借我五百吗？', { action: 'send', segments: ['没问题', '明天给你'] }),
    { action: 'send', text: '这事我得先确认一下，暂时不能答应你', followUp: false });
});

test('the guard leaves ordinary replies and explicit user authorization alone', () => {
  const reply = { action: 'send', text: '可以啊，怎么了' };
  assert.equal(guardFinancialCommitment('明天有空聊天吗？', reply), reply);
  assert.equal(guardFinancialCommitment('能帮我垫付吗？', reply, { facts: '我已经同意垫付这笔钱' }), reply);
  const cautious = { action: 'send', text: '这个我得先确认下' };
  assert.equal(guardFinancialCommitment('能帮我付款吗？', cautious), cautious);
});
