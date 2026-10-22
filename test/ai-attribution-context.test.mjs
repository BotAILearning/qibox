import test from 'node:test';
import assert from 'node:assert/strict';
import { attributionContextPrompt, buildAttributionContext } from '../server/ai-attribution-context.mjs';

const author = { role: 'self', id: 'account:test' };
const contact = { role: 'other', id: 'contact:test' };

test('attribution index keeps sender, quoted author, image source, and explicit memory subject distinct', () => {
  const messages = [
    { id: 'self-image', direction: 'self', speaker: author, text: '我看了账户截图' },
    { id: 'contact-comment', direction: 'other', speaker: contact, pending: true, text: '你这个月用得不少啊',
      quote: { verified: true, messageId: 'self-image', direction: 'self', speaker: author, text: '我看了账户截图' } },
  ];
  const context = buildAttributionContext({
    messages,
    images: [{ messageId: 'self-image', mime: 'image/png', data: 'private-bytes' }],
    memory: { entries: [
      { field: 'usage', scope: 'contact', subjectId: 'account:test', evidence: ['self-image'], contextRole: 'current' },
      { field: 'legacy', scope: 'contact', text: '旧记忆原文不复制' },
    ] },
  });

  assert.deepEqual(context.quoteEvidence, [{ messageId: 'contact-comment', speaker: contact,
    quote: { messageId: 'self-image', speaker: author, direction: 'self' } }]);
  assert.deepEqual(context.imageEvidence, [{ messageId: 'self-image', speaker: author }]);
  assert.equal(context.memoryEvidence[0].subjectId, author.id);
  assert.equal(context.memoryEvidence[0].scope, 'contact');
  assert.equal(context.memoryEvidence[1].scope, 'contact');
  assert.equal('subjectId' in context.memoryEvidence[1], false);
  assert.doesNotMatch(JSON.stringify(context), /private-bytes|旧记忆原文|看了账户截图|用得不少/);
  assert.match(attributionContextPrompt, /旧记忆缺少这些字段时仍可结合原始聊天理解/);
});

test('missing subject metadata remains compatible and does not relabel messages or require a subject guess', () => {
  const legacy = { field: 'residence', scope: 'contact', text: '曾住在某地' };
  const input = { messages: [{ id: 'm1', direction: 'other', speaker: contact, text: '我之前住过这里' }], memory: { entries: [legacy] } };
  const before = structuredClone(input);
  const context = buildAttributionContext(input);
  assert.deepEqual(context.memoryEvidence, [{ field: 'residence', scope: 'contact' }]);
  assert.deepEqual(input, before);
  assert.doesNotMatch(JSON.stringify(context), /m1|曾住在某地|之前住过这里/);
  assert.match(attributionContextPrompt, /不要因归属不确定而改写或阻止正常回应/);
});

test('only verified quote relations enter the compact attribution index', () => {
  const context = buildAttributionContext({ messages: [
    { id: 'broken', speaker: contact, quote: { verified: false, messageId: 'counterfeit', speaker: author } },
    { id: 'plain', speaker: contact, text: '正常原话' },
  ], images: [{ mime: 'image/png' }] });
  assert.deepEqual(context.quoteEvidence, []);
  assert.deepEqual(context.imageEvidence, []);
  assert.deepEqual(context.memoryEvidence, []);
});

test('image amounts and ratios do not establish elapsed time, period progress, or usage speed', () => {
  assert.match(attributionContextPrompt, /比例、余额或消耗量本身不证明经过时长、统计周期进度或消耗速度/);
  assert.match(attributionContextPrompt, /起止时间或比较基准/);
  assert.match(attributionContextPrompt, /不补造月初、月末等时间背景/);
});
