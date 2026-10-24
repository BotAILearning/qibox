import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('production wire ends with full long incoming turns once, including middle corrections and verified quote authors', async t => {
  const root = await temp(), bridge = new ChatFixture(), wires = [];
  let clock = Date.parse('2026-10-24T10:00:00+08:00');
  bridge.stableMessageIds = true;
  const contact = bridge.contacts[0].id;
  const original = { id: key('long-turn-self-original'), direction: 'self', authorship: 'human', text: '我那一笔已经提交了，其他人的进度我没有问过。', timestamp: clock / 1000 - 60 };
  const history = [original,
    { id: key('style-incoming-1'), direction: 'other', authorship: 'other', text: '绕一圈又回来了', timestamp: clock / 1000 - 50 },
    { id: key('style-reply-1'), direction: 'self', authorship: 'human', text: '服了', timestamp: clock / 1000 - 49 },
    { id: key('style-announcement'), direction: 'self', authorship: 'human', text: '那场活动我还没确认，前面那份材料已经提交了。', timestamp: clock / 1000 - 40 },
    { id: key('style-incoming-2'), direction: 'other', authorship: 'other', text: '这回总算拆开了', timestamp: clock / 1000 - 30 },
    { id: key('style-reply-2'), direction: 'self', authorship: 'human', text: '是啊', timestamp: clock / 1000 - 29 },
  ];
  bridge.messages.set(contact, history);
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    wires.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'send', text: '原来是混在一页了。', followUp: false }) }, finish_reason: 'stop' }] });
  } });
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => clock, delay: async () => {}, random: min => min });
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  await a.configure(modelConfig); await a.scan();
  await a.saveReplyProfile({ contact, style: { summary: '保留我的手动风格，自然接话。' }, strategy: {}, replyEnabled: true });
  await a.settings({ enabled: true, autoLearning: false, segmentReplies: false, followUpEnabled: false }); await a.tick();
  const first = '开头的旧单子和老照片混到同一个目录里，大家各翻各的。'.repeat(15)
    + '中间更正：绿勾只是对方收到附件，不是本人审核通过，也没有否定本人已经提交。他又聊起以前怎么把纸箱塞进去的，那是在说旧事。'
    + '后面又夹着一些旧文件名，整理完才发现不是同一件事。'.repeat(15);
  const second = '另一个群里同名的人又转了一份旧通知。'.repeat(18)
    + '另一条中间事实：店员把教室从B2改成B3，旧图日期不证明今天有活动。'
    + '几张图分开放回去，光看缩略图确实容易绕。'.repeat(18);
  const incoming = [bridge.push(contact, 'other', first), bridge.push(contact, 'other', second)];
  incoming.forEach((row, i) => { row.timestamp = clock / 1000 + i; });
  incoming[0].quote = { verified: true, messageId: original.id, direction: 'self', text: original.text, timestamp: original.timestamp };
  await a.tick(); clock += 61000; await a.tick();
  assert.equal(wires.length, 1, 'One production generation, no added audit or retry');
  const system = wires[0].messages.find(m => m.role === 'system').content;
  assert.doesNotMatch(system, /本轮来信包含明确问题/, 'A keyword match must not be asserted to the model as a confirmed question');
  assert.match(system, /关键词或转述不等于对方在提问/);
  const input = JSON.parse(wires[0].messages.find(m => m.role === 'user').content);
  assert.equal(input.contextualStyle.samplesSource, 'paired-human-replies');
  const styleTexts = input.contextualStyle.samples.map(sample => input.messages.find(m => m.id === sample.id)?.text ?? sample.text);
  assert.deepEqual(styleTexts, ['服了', '是啊']);
  for (const message of [original, history[3]]) assert(input.messages.some(m => m.text === message.text), 'Full factual declarations remain in history even when not used as expression examples');
  const pending = input.conversation.pendingIncomingMessages;
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(m => m.text), [first, second], 'Middle and complete bodies remain readable at the current turn');
  assert(pending.every(m => m.direction === 'other' && m.pending && !m.excerpt && !m.textTruncated));
  assert.equal(pending[0].quote.direction, 'self');
  assert.equal(pending[0].quote.verified, true);
  assert(input.messages.filter(m => pending.some(p => p.id === m.id)).every(m => !Object.hasOwn(m, 'text') && m.textRef === m.id));
  assert.equal(input.conversation.latestIncoming.textRef, pending[1].id);
  for (const text of [first, second]) assert.equal(JSON.stringify(input).split(JSON.stringify(text).slice(1, -1)).length - 1, 1, 'Full body appears once on the actual provider wire');
  assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0].text, '原来是混在一页了。', 'No post-generation rewrite');
});
