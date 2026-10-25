import test from 'node:test';
import assert from 'node:assert/strict';
import { compactReplyWire, replyWireReferencePrompt } from '../server/ai-reply-wire.mjs';
import { encodeModelRequest } from '../server/ai-model-input.mjs';
import { key } from './ai-fixtures.mjs';
import { readableReplyWire } from './ai-wire-fixtures.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { replyFixedRules } from '../server/ai-reply-prompt.mjs';
import { replyRoleAnchor, replyCompositionPrompt } from '../server/ai-reply-role.mjs';
import { replyPerspective } from '../server/ai-speakers.mjs';
import { modelConfig } from './ai-fixtures.mjs';
const account = key('wire-account'), contact = key('wire-contact');
function fixture() {
  const messages = Array.from({ length: 16 }, (_, index) => {
    const direction = index % 2 ? 'other' : 'self', sourceDate = index < 8 ? '2026-10-24' : '2026-10-25';
    return { id: key('wire-message-' + index), direction,
      speaker: { role: direction, id: direction === 'self' ? account : contact, label: direction === 'self' ? '本人' : '对方' },
      authorship: direction === 'self' ? index % 4 ? 'ai' : 'human' : 'other',
      aiGenerated: direction === 'self' && index % 4 !== 0, timestamp: 1792776600 + index * 30, sourceDate,
      temporal: { known: true, timezone: 'Asia/Shanghai', calendarBasis: 'viewer-timezone', sourceDate,
        localTime: sourceDate + 'T01:30:00', ageSeconds: 10000 - index * 30, daysAgo: index < 8 ? 1 : 0, relation: index < 8 ? 'yesterday' : 'today' },
      pending: index === 15, text: '完整中文原文🙂\n这里没有说款项到账，也没有把夹子指明挂在空袋。' + index };
  });
  messages[2].quote = { verified: true, messageId: messages[0].id, direction: 'self', text: messages[0].text, excerpt: false };
  messages[3].type = 'image'; messages[3].text = '[图片]';
  Object.assign(messages[4], { unresolved: true, deliveryConfidence: 'unknown', excerpt: true, textTruncated: true });
  return { mode: 'reply', kind: 'person', sourceIndexVersion: 2,
    roleAnchor: { author: { id: account }, recipient: { id: contact } }, messages,
    images: [{ messageId: messages[3].id, mime: 'image/png', data: 'UNCHANGED_SYNTHETIC_IMAGE' }],
    conversation: { pendingIncomingMessages: [structuredClone(messages[15])], pendingIncomingIds: [messages[15].id] },
    style: { summary: '保留我明确设置的详细正式表达' }, writeNextMessage: '原有最终任务和输出协议' };
}
test('reply table restores complete original facts, mixed authorship, media, quotes and uncertain delivery', () => {
  const input = fixture(), original = structuredClone(input), packed = compactReplyWire(input);
  assert.notStrictEqual(packed, input); assert.deepEqual(readableReplyWire(packed), original);
  assert.deepEqual(input, original); assert.deepEqual(packed.conversation, original.conversation);
  assert.deepEqual(packed.style, original.style); assert.deepEqual(packed.images, original.images);
  assert.equal(Object.keys(packed).at(-1), 'writeNextMessage');
  assert(JSON.stringify(packed).length + replyWireReferencePrompt.length < JSON.stringify(input).length);
  const uncertain = readableReplyWire(packed).messages[4];
  assert(uncertain.unresolved && uncertain.excerpt && uncertain.textTruncated && uncertain.deliveryConfidence === 'unknown');
});
test('unsupported groups, actors, dates, metadata and occupied schema retain the original DTO', () => {
  const variants = [
    input => { input.kind = 'group'; }, input => { input.mode = 'proactive'; },
    input => { input.messageEncoding = { external: true }; },
    input => { input.messages[0].temporal.known = false; },
    input => { input.messages[0].temporal.sourceDate = '2026-10-01'; },
    input => { input.messages[0].temporal.futureMeaning = 'preserve'; },
    input => { input.messages[0].futureSafetyFlag = true; },
    input => { input.messages[0].speaker.id = key('another-account'); },
    input => { delete input.messages[0].authorship; },
  ];
  for (const alter of variants) {
    const input = fixture(); alter(input); const before = structuredClone(input);
    assert.strictEqual(compactReplyWire(input), input); assert.deepEqual(input, before);
  }
});
test('post-identity encoding preserves native quote, image and returned evidence references', () => {
  const input = fixture(), before = structuredClone(input), encoded = encodeModelRequest('原协议及原生ID ' + account, input);
  const packed = compactReplyWire(encoded.input), restored = readableReplyWire(packed);
  assert(packed.messageEncoding); assert.deepEqual(restored, encoded.input);
  const source = input.messages[0].id, image = input.messages[3].id;
  assert.deepEqual(encoded.decode({ evidence: [encoded.id(source)], messageId: encoded.id(image), subjectId: encoded.id(account) }),
    { evidence: [source], messageId: image, subjectId: account });
  assert.equal(restored.messages[2].quote.messageId, encoded.id(source));
  assert.equal(packed.images[0].messageId, encoded.id(image)); assert.deepEqual(input, before);
});
test('tiny or empty contexts avoid dictionary overhead', () => {
  const empty = { ...fixture(), messages: [] }; assert.strictEqual(compactReplyWire(empty), empty);
  const tiny = fixture(); tiny.messages = [tiny.messages[0]]; assert.strictEqual(compactReplyWire(tiny), tiny);
});
test('provider retains table contract across an existing format retry and decodes evidence before local validation', async () => {
  const input = fixture(), profile = { account, contact, kind: 'person' }, anchor = replyRoleAnchor(profile);
  input.roleAnchor = anchor; input.replyPerspective = replyPerspective(profile);
  for (const message of input.messages) {
    message.speaker = { ...(message.direction === 'self' ? anchor.author : anchor.recipient) };
    if (message.quote) message.quote.speaker = { ...anchor.author };
  }
  input.conversation.pendingIncomingMessages = [structuredClone(input.messages.at(-1))];
  const before = structuredClone(input), requests = [];
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    const body = JSON.parse(options.body), content = body.messages[1].content;
    const packed = JSON.parse(Array.isArray(content) ? content[0].text : content);
    assert(content.some(part => part.type === 'image_url' && part.image_url.url.endsWith('UNCHANGED_SYNTHETIC_IMAGE')));
    requests.push(body); assert(packed.messageEncoding); assert.equal(body.max_tokens, 4096);
    const restored = readableReplyWire(packed);
    assert.equal(restored.messages[2].quote.messageId, restored.messages[0].id);
    assert.equal(body.messages[0].content.split(replyWireReferencePrompt).length - 1, 1);
    if (requests.length === 1) {
      assert(body.messages[0].content.endsWith(replyCompositionPrompt));
      return Response.json({ choices: [{ message: { content: 'not-valid-json' } }] });
    }
    assert(body.messages[0].content.includes('上一次返回未通过格式或业务结构校验'));
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      action: 'send', text: '这几件事终于分开了', evidence: [restored.messages[0].id],
    }) } }] });
  } });
  let validated = 0;
  const result = await provider.complete(modelConfig, replyFixedRules, input, undefined, { budget: 4096,
    validate(value) { validated++; assert.equal(value.evidence[0], input.messages[0].id); assert.deepEqual(input, before); return value; } });
  assert.equal(requests.length, 2, 'one existing format retry, no separate review/generation');
  assert.equal(validated, 1); assert.equal(result.text, '这几件事终于分开了'); assert.deepEqual(input, before);
});
