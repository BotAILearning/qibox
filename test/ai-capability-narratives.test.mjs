import test from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedTextAction, promisesMedia } from '../server/ai-capabilities.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('completed third-party narration is text, not a request for the assistant to act', () => {
  for (const text of [
    '小贺只负责印海报，晚上只是把文件传给了打印店，并没有再替我们改时间。',
    '他昨天把附件发给了打印店。',
    '老师刚才已经上传了文档。',
    '她昨晚给店里打了电话。',
    '他昨天发了语音消息。',
  ]) assert.equal(unsupportedTextAction(text), null, text);
  assert.equal(promisesMedia('他昨天已经发了照片。'), false);
});

test('third-party wording never authorizes self actions, requests, future promises or uncertain completion', () => {
  for (const text of [
    '小贺只负责印海报，晚上我把文件传给了打印店。',
    '小贺让我把文件传给打印店。',
    '他说我已经发了文件。',
    '小贺说他明天会发文件。',
    '他可能已经发了文件。',
    '他把文件传给打印店了吗？',
    '请给我发送文件。',
    '文件发来给我看一下。',
    '老子已经发了文件。',
    '小贺只负责印海报；我这就打开文件。',
    '他昨天回了电话，我马上给你打电话。',
    '小贺昨天把文件传给了打印店，我看一下。',
    `小贺昨天传了文件，我${'需要先核对其他内容再决定，'.repeat(5).replaceAll('，', '')}查看文档。`,
  ]) assert.ok(unsupportedTextAction(text), text);
  for (const text of ['我已经发了照片。', '他说我马上发照片。', '他昨天发了照片，我这就发图片。'])
    assert.equal(promisesMedia(text), true, text);
  assert.equal(promisesMedia('他明天会发照片。'), false, 'Keep the existing detector scope; this fix adds no new kind of sending block');
});

test('completed third-party narration retains actor across time prefixes, object-first wording and recipients', () => {
  for (const text of [
    '昨晚是小贺把文件传给了打印店。',
    '昨晚，小贺把文件传给了打印店。',
    '昨天是同事把附件发给了打印店。',
    '文件是小贺昨晚传给打印店的。',
    '这份文件由他昨天发给了打印店。',
    '昨晚是她给店里打了电话。',
    '刚才，老师已经上传了文档。',
    '他昨天把文件发给你了。',
    '昨晚是小贺把文件传给我了。',
  ]) assert.equal(unsupportedTextAction(text), null, text);
  assert.equal(promisesMedia('昨晚是他已经发了照片。'), false);
});

test('time and object prefixes cannot hide self actions, incoming requests or conditional third-party actions', () => {
  for (const text of [
    '昨晚是我把文件传给了打印店。',
    '文件是我昨晚传给打印店的。',
    '文件是老子已经发给打印店的。',
    '昨晚是小贺叫我把文件传给打印店。',
    '昨晚，小贺说文件发来给我看一下。',
    '文件是小贺明天会发给打印店的。',
    '昨晚是小贺说文件可能已经发给打印店了。',
    '昨晚，小贺把文件传给了打印店，我这就打开附件。',
    '如果昨晚是小贺发了文件，今天你发来给我看一下。',
    '昨晚是小贺把文件传给打印店了吗？',
  ]) assert.ok(unsupportedTextAction(text), text);
  assert.equal(promisesMedia('昨晚是他发了照片，我现在发图片给你。'), true);
});

test('instructions to open the recipient own table do not imply file access by the assistant', () => {
  for (const text of ['你先打开群里的表格填一格。', '请你自行下载这份文档保存。', '您可以查看手里的PDF。'])
    assert.equal(unsupportedTextAction(text), null, text);
  for (const text of ['你打开文件给我看。', '你先打开表格，然后发给我。', '你打开文件后我来查看。', '你先打开表格；我这就打开文件。', '你先查看文档，再给我打电话。', '你先打开附件然后提交到网站。'])
    assert.ok(unsupportedTextAction(text), text);
});

// This complete answer came from a real provider run on synthetic material.
// Replaying its text isolates the application guard from model sampling.
const realAnswer = '放映定在2026年11月6日19:30，地点是东桥路18号3层，场地那边已经收到确认。18:30是旧版海报上的时间，最新时间是19:30；小贺只负责印海报，晚上只是把文件传给了打印店，并没有再替我们改时间。\n\n场地费一共480元，我们四个人均摊，每人120元；现在先不用转账。你当前先在原来的群文件里打开选片表，把片名缩写填进右边那个小格，明天再跟另外两位把完整安排说清楚。';

async function replay(t, { group = false, text = realAnswer, pastNight = false } = {}) {
  const root = await temp(), bridge = new ChatFixture();
  bridge.stableMessageIds = true;
  if (group) bridge.contacts[0].kind = 'group';
  const contact = bridge.contacts[0].id;
  let now = Date.parse('2026-10-27T19:15:00+08:00'), requests = 0;
  bridge.messages.set(contact, [{ id: key('capability-history'), direction: 'self', authorship: 'human', timestamp: now / 1000 - 60,
    text: '放映定在11月6日19:30，东桥路18号3层，场地已经收到确认。场地费480元咱们四人均摊，先不用转账；先在群里原来的选片表填一格。18:30是旧版，小贺只负责印海报。' }]);
  const provider = new AIProvider({ fetcher: async () => {
    requests++;
    return Response.json({ content: [{ type: 'text', text: JSON.stringify({ action: 'send', text, followUp: false }) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 100 } });
  } });
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {}, random: min => min });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure({ ...modelConfig, protocol: 'anthropic' }); await a.scan();
  if (group) await a.setGroupOptions({ contact, atMe: true });
  else await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true, autoLearning: false, segmentReplies: false }); await a.tick();
  const incoming = bridge.push(contact, 'other', `小贺说打印店要明天才开门，他${pastNight ? '昨晚' : '晚上'}只是把文件传过去，没再替我们改时间。选片表里大家填的都是片名缩写，不是收款码。请按两段详细说明完整日期时间地址、为什么不是18:30，以及每人均摊多少、现在要不要转账、我先做哪一步；明天我会跟另外两位说清楚。`);
  incoming.timestamp = now / 1000;
  if (group) Object.assign(incoming, { sender: key('capability-member'), mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); now += 20000; await a.tick();
  return { a, bridge, requests };
}

for (const group of [false, true]) test(`${group ? 'group' : 'private'} complete provider answer survives historical file narration unchanged`, async t => {
  const f = await replay(t, { group });
  assert.equal(f.requests, 1, 'No replacement model or extra review');
  assert.equal(f.bridge.sent.length, 1);
  assert.equal(f.bridge.sent[0].text, realAnswer, 'Do not rewrite pronouns, prose or media words to pass');
  assert(!f.a.data.events.some(x => x.reasonCode === 'unsupported-media'));
});

for (const group of [false, true]) test(`${group ? 'group' : 'private'} full application retains time-prefixed historical third-party file prose`, async t => {
  const text = realAnswer.replace('小贺只负责印海报，晚上只是把文件传给了打印店，并没有再替我们改时间。',
    '昨晚是小贺把最终排版文件传给了打印店，小贺没替我们改时间。');
  const f = await replay(t, { group, text, pastNight: true });
  assert.equal(f.requests, 1); assert.equal(f.bridge.sent.length, 1);
  assert.equal(f.bridge.sent[0].text, text);
  assert(!f.a.data.events.some(x => x.reasonCode === 'unsupported-media'));
});

test('normal application still refuses an unsupported self file promise', async t => {
  const f = await replay(t, { text: '我马上发文件给你。' });
  assert.equal(f.requests, 1); assert.equal(f.bridge.sent.length, 0);
  assert(f.a.data.events.some(x => x.reasonCode === 'unsupported-media'));
});
