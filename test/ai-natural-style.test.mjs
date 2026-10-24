import test from 'node:test';
import assert from 'node:assert/strict';
import { authoredMessages, contextualReplyStyle, contextualStylePrompt, replyStyleOrigin } from '../server/ai-context-learning.mjs';

const other = (id, text, timestamp, extra = {}) => ({ id, direction: 'other', authorship: 'other', type: 'text', text, timestamp, ...extra });
const self = (id, text, timestamp, extra = {}) => ({ id, direction: 'self', authorship: 'human', type: 'text', text, timestamp, ...extra });

test('reply rhythm uses multiple human interaction replies without making long self announcements an answer-length target', () => {
  const rows = [self('announcement-1', '我把几件事情的前后情况完整说一遍。'.repeat(30), 100),
    other('o1', '折腾一圈又回来了', 110), self('s1', '服了', 111),
    self('announcement-2', '另外还有几个历史安排需要先说明。'.repeat(35), 120),
    other('o2', '这回总算弄清楚了', 130), self('s2', '是啊', 131),
    other('o3', '后来呢', 140), self('ai', '来源不属于真人'.repeat(20), 141, { aiGenerated: true })];
  const before = structuredClone(rows), result = contextualReplyStyle(rows, { preferReplySamples: true });
  assert.equal(result.rhythm.source, 'paired-human-replies');
  assert.equal(result.rhythm.sampleCount, 2); assert.equal(result.rhythm.medianChars, 2);
  assert.deepEqual(result.pairedExamples.map(p => p.reply.id), ['s1', 's2']);
  assert.deepEqual(result.samples.map(s => s.id), ['s1', 's2'], 'Reply wording uses the selected human interactions, not factual announcements');
  assert.equal(result.samplesSource, 'paired-human-replies');
  assert(contextualReplyStyle(rows).samples.some(s => s.id === 'announcement-1'), 'Learning keeps the broader human source collection');
  assert.deepEqual(rows, before);
  const onePair = contextualReplyStyle(rows.slice(0, 4), { preferReplySamples: true });
  assert.equal(onePair.rhythm.source, undefined, 'One reply cannot replace the broader weak distribution');
  assert(onePair.rhythm.medianChars > 2);
  assert.equal(onePair.samplesSource, undefined, 'One interaction does not replace broader weak wording evidence');
  const smallBudget = contextualReplyStyle(rows, { preferReplySamples: true, maxSamples: 1 });
  assert.equal(smallBudget.samples.length, 1); assert.equal(smallBudget.samplesSource, undefined);
  const group = contextualReplyStyle(rows, { kind: 'group' });
  assert.equal(group.rhythm.source, undefined); assert.deepEqual(group.pairedExamples, []);
});

test('learned observation provenance never overrides edited, locked or legacy manual style', () => {
  const profile={learnedStyle:{summary:'已观察到的表达'},locked:[]};
  const style={summary:'已观察到的表达',customTone:'用户明确补充',customAvoid:'用户明确禁用'};
  const before=structuredClone({profile,style});
  assert.equal(replyStyleOrigin(profile,style).summary,'learned-observation');
  assert.deepEqual(replyStyleOrigin(profile,style).explicitFields,['customTone','customAvoid']);
  assert.equal(replyStyleOrigin(profile,{...style,summary:style.summary+'\n用户追加：保持详细'}).summary,'user-setting');
  assert.equal(replyStyleOrigin({...profile,locked:['summary']},style).summary,'user-setting');
  assert.equal(replyStyleOrigin({},style).summary,'user-setting','old styles without exact learned provenance remain user settings');
  assert.equal(replyStyleOrigin(profile,style,{reference:true}).summary,'reference-style');
  assert.deepEqual({profile,style},before,'classification does not rewrite any saved requirement');
});

test('a zero pair budget collects no quoted or adjacent example while retaining genuine human samples',()=>{
  const rows=[other('q','合成来信',100),self('r','合成真人接话',110,{quote:{verified:true,messageId:'q',direction:'other'}})];
  const result=contextualReplyStyle(rows,{maxPairs:0});assert.equal(result.pairedExamples.length,0);assert.equal(result.samples.length,1);
});

test('only native verified quote links form cross-turn examples, and generated or unclear text never enters style samples', () => {
  const messages = [
    other('incoming-1', '最近忙吗？', 100),
    self('reply-1', '还行，最近在忙手头的事。', 110, { quote: { verified: true, messageId: 'incoming-1', direction: 'other' } }),
    self('ai', '亲爱的朋友您好。', 120, { aiGenerated: true }),
    self('unknown', '来源不明的回复', 130, { authorship: 'unknown' }),
    self('bad-quote', '看起来像有回应的句子', 140, { quote: { verified: false, messageId: 'incoming-1', direction: 'other', text: '不要读取这段引用内容' } }),
    other('untrusted-incoming', '引用源作者不明', 150, { authorship: 'unknown' }),
    self('bad-pair', '不应进入配对', 160, { quote: { verified: true, messageId: 'untrusted-incoming', direction: 'other' } }),
  ];
  const before = structuredClone(messages);
  const result = contextualReplyStyle(messages);

  assert.deepEqual(result.pairedExamples, [{
    relation: 'verified-quote',
    incoming: { id: 'incoming-1', text: '最近忙吗？' },
    reply: { id: 'reply-1', text: '还行，最近在忙手头的事。', timestamp: 110 },
  }]);
  assert.deepEqual(result.samples.map(row => row.id), ['reply-1', 'bad-pair'], 'self authorship supports style even if the referenced other row is unusable as a pair');
  assert.equal(JSON.stringify(result).includes('不要读取这段引用内容'), false);
  assert.deepEqual(messages, before, 'learning is read-only and does not rewrite saved or manual style');
});

test('private chat adjacent examples require literal single incoming-to-human adjacency, ordered short timestamps and same day', () => {
  const messages = [
    other('o1', '晚上吃什么？', 100), self('s1', '随便吃点就行。', 105),
    other('o2', '周末有空吗？', 200), self('ai', '周末都可以。', 201, { aiGenerated: true }),
    other('o3', '那明天呢？', 300), self('unknown', '我有空。', 301, { authorship: 'unknown' }),
    other('o4', '刚才那件事？', 400), { id: 'intervening', direction: 'system', authorship: 'unknown', text: '系统消息', timestamp: 401 }, self('s4', '你接着说。', 402),
    other('o5', '明天见？', 86390), self('s5', '我再确认下。', 86401),
    other('o6', '现在方便吗？', 90000), self('s6', '等我一会儿。', 90000 + 301),
  ];
  const result = contextualReplyStyle(messages);
  assert.deepEqual(result.pairedExamples, [{
    relation: 'adjacent-context', incoming: { id: 'o1', text: '晚上吃什么？' },
    reply: { id: 's1', text: '随便吃点就行。', timestamp: 105 },
  }]);
});

test('group contexts do not infer adjacent pairs and style instructions avoid fixed conversational filler', () => {
  const messages = [other('o', '几点？', 100), self('s', '七点。', 101)];
  assert.deepEqual(contextualReplyStyle(messages, { kind: 'group' }).pairedExamples, []);
  assert.match(contextualStylePrompt, /不要机械改变人称/);
  assert.match(contextualStylePrompt, /不改写已保存风格/);
  assert.doesNotMatch(contextualStylePrompt, /每条回复都要共情|必须以提问结尾/);
});

test('pair evidence is limited to three examples and 1,200 combined characters', () => {
  const messages = [];
  for (let index = 0; index < 5; index++) {
    const timestamp = 1000 + index * 10;
    messages.push(other(`o${index}`, '问'.repeat(200), timestamp));
    messages.push(self(`s${index}`, '答'.repeat(200), timestamp + 1));
  }
  const pairs = contextualReplyStyle(messages).pairedExamples;
  assert.equal(pairs.length, 3);
  assert.equal(pairs.reduce((total, pair) => total + pair.incoming.text.length + pair.reply.text.length, 0), 1200);
  assert.deepEqual(pairs.map(pair => pair.reply.id), ['s2', 's3', 's4']);
});

test('explicit AI authorship and unresolved send receipts never become human learning samples', () => {
  const raw = [
    self('marked-ai', '明确是AI代发。', 1000, { authorship: 'ai' }),
    self('marked-unknown', '来源未知。', 2000, { authorship: 'unknown' }),
    self('not-confirmed', '发送未确认。', 3000),
    self('delivery-unknown', '送达状态未知。', 4000),
    self('generated-id', '已知AI记录。', 5000),
    self('human', '这句是本人手动发的。', 6000),
  ];
  const profile = {
    generatedIds: ['generated-id'],
    sentMessages: [
      { id: 'not-confirmed', confirmed: false },
      { id: 'delivery-unknown', confirmed: true, deliveryConfidence: 'unknown', baseline: 'not-confirmed', at: 4000000, body: { text: '送达状态未知。' } },
    ],
  };
  const authored = authoredMessages({ open: body => body }, profile, raw);
  assert.deepEqual(authored.map(row => row.authorship), ['ai', 'unknown', 'unknown', 'unknown', 'ai', 'human']);
  assert.deepEqual(contextualReplyStyle(authored).samples.map(row => row.id), ['human']);
});

test('duplicate message IDs are excluded from style samples and verified quote pairing', () => {
  const messages = [
    other('duplicate-incoming', '可能是同一条记录。', 100),
    other('duplicate-incoming', '也可能是另一条记录。', 101),
    self('linked-reply', '不应强行关联。', 102, { quote: { verified: true, messageId: 'duplicate-incoming', direction: 'other' } }),
    self('duplicate-self', '重复ID一。', 103),
    self('duplicate-self', '重复ID二。', 104),
  ];
  const result = contextualReplyStyle(messages);
  assert.deepEqual(result.pairedExamples, []);
  assert.deepEqual(result.samples.map(row => row.id), ['linked-reply']);
});
