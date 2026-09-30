import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider, MODEL_RETRY_LIMIT } from '../server/ai-provider.mjs';
import { currentChatTime, currentTimeAnchor, validateCurrentTimeReply } from '../server/ai-chat-context.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const context = currentChatTime(Date.parse('2026-09-30T20:20:30+08:00'));
const send = text => ({ action: 'send', text });

test('explicit assertions of the current date and weekday reject the observed wrong MiniMax answer', () => {
  for (const text of ['现在是周六·1月3号·晚上好～', '今天是2026-09-29，星期三', '现在这边是2025年9月30号周三', '今天是九月二十九号', '今天星期四'])
    assert.throws(() => validateCurrentTimeReply(send(text), context), error => error.code === 'ai_model_time');
  for (const text of ['现在这边是2026年9月30号，周三晚上～', '今天是九月三十日', '今日是2026-09-30，星期三'])
    assert.equal(validateCurrentTimeReply(send(text), context).text, text);
  assert.throws(() => validateCurrentTimeReply({ action: 'send', segments: ['晚上好', '今天是2026-01-03'] }, context), /真实时间/);
  assert.match(currentTimeAnchor(context), /2026-09-30T20:20:30.*星期三.*晚上/);
});

test('time validation preserves quoted claims, historical dates, future plans and another timezone', () => {
  for (const text of ['你说“今天是周六”，我确认一下。', '昨天是9月29号', '周六1月3号的事已经过去了', '今天讨论周六的聚会', '现在是周三，明天10月1号去看看', '现在是2026年9月30号，我们约10月3号再聊', '现在是周四，你那边当地已经过了午夜'])
    assert.equal(validateCurrentTimeReply(send(text), context).text, text);
  assert.deepEqual(validateCurrentTimeReply({ action: 'wait' }, context), { action: 'wait' });
});

for (const protocol of ['openai', 'anthropic']) test(`${protocol}: a wrong current date retries with the correct date before returning a deliverable reply`, async () => {
  const requests = [];
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const content = JSON.stringify(send(requests.length === 1 ? '现在是周六·1月3号' : '现在是2026年9月30号，星期三'));
    return Response.json(protocol === 'anthropic' ? { content: [{ type: 'text', text: content }], stop_reason: 'end_turn' } : { choices: [{ message: { content }, finish_reason: 'stop' }] });
  } });
  provider.backoff = async () => {};
  const result = await provider.complete({ ...modelConfig, protocol }, currentTimeAnchor(context), context, undefined,
    { validate: value => validateCurrentTimeReply(value, context) });
  assert.equal(requests.length, 2); assert.match(result.text, /9月30号/);
  assert.match(protocol === 'anthropic' ? requests[1].system : requests[1].messages[0].content, /应依据2026-09-30 星期三/);
});

test('repeated wrong date answers remain bounded and fail before any reply can be sent', async () => {
  let calls = 0;
  const provider = new AIProvider({ fetcher: async () => {
    calls++; return Response.json({ choices: [{ message: { content: JSON.stringify(send('今天是2026-01-03')) } }] });
  } }); provider.backoff = async () => {};
  await assert.rejects(provider.complete(modelConfig, 'system', context, undefined, { validate: value => validateCurrentTimeReply(value, context) }), error => error.code === 'ai_model_time');
  assert.equal(calls, MODEL_RETRY_LIMIT + 1);
});

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.supportsMediaOutput = true;
  let now = Date.parse('2026-09-30T20:20:30+08:00');
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure({ ...modelConfig, baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3', protocol: 'anthropic' }); await a.scan();
  const contact = bridge.contacts[0].id;
  await a.setReplyOptions({ contact, enabled: true, multiTurn: false, judgeReply: false, sendImages: true, sendAudio: true });
  await a.settings({ enabled: true }); await a.tick();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, bridge, provider, contact, advance: ms => now += ms };
}

test('a new topic is surfaced explicitly while the answered question stays background, with consistent media capability', async t => {
  const { a, bridge, provider, contact, advance } = await fixture(t);
  const first = bridge.push(contact, 'other', '今天是几月几号？');
  await a.tick(); advance(20000); provider.next = async () => send('现在是2026年9月30号，星期三'); await a.tick();
  assert.equal(bridge.sent.length, 1);
  const second = bridge.push(contact, 'other', '请画一个蓝色陶瓷杯');
  await a.tick(); advance(20000);
  provider.next = async input => {
    assert.deepEqual(input.conversation.pendingIncomingIds, [second.id]);
    assert.equal(input.conversation.latestIncoming.text, second.text);
    assert.deepEqual(input.conversation.pendingIncomingMessages.map(m => m.text), [second.text]);
    assert.equal(input.messages.find(m => m.id === first.id).pending, false);
    assert.equal(input.messages.find(m => m.id === second.id).pending, true);
    assert.equal(input.capabilities.sendImages, true); assert.equal(input.capabilities.sendAudio, true);
    assert.equal(input.capabilities.sendMedia, true); assert.equal(input.capabilities.files, false);
    assert.match(provider.calls.at(-1).system, /本轮只回应conversation.pendingIncomingMessages/);
    return send('蓝色杯子的构图可以用白色背景。');
  };
  await a.tick(); assert.equal(bridge.sent.length, 2);
});

test('the surfaced pending message uses the actual WeChat transcript and preserves unreadable voice markers', async t => {
  const { a, bridge, provider, contact, advance } = await fixture(t);
  const voice = Object.assign(bridge.push(contact, 'other', '[语音]'), { type: 'voice' });
  bridge.transcribe = async () => ({ text: '请给我画一个杯子', source: 'wechat' });
  await a.tick(); advance(20000);
  provider.next = async input => {
    assert.equal(input.conversation.latestIncoming.text, '请给我画一个杯子');
    assert.equal(input.conversation.latestIncoming.transcriptionSource, 'wechat');
    assert.equal(input.conversation.latestIncoming.unresolved, undefined);
    assert.equal(input.conversation.latestIncoming.id, voice.id);
    return send('我理解的是蓝色杯子的构图。');
  };
  await a.tick();
  const missing = Object.assign(bridge.push(contact, 'other', '[语音]'), { type: 'voice' });
  bridge.transcribe = async () => ({ text: '', source: 'wechat' });
  await a.tick(); advance(20000);
  provider.next = async input => {
    assert.equal(input.conversation.latestIncoming.id, missing.id);
    assert.equal(input.conversation.latestIncoming.unresolved, true);
    return send('没能读到这段语音，可以转成文字吗？');
  };
  await a.tick(); assert.equal(bridge.sent.length, 2);
});

test('a generated audio reply discloses synthesis in text and delivers one portable MP3 segment', async t => {
  const { a, bridge, provider, contact, advance } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ base_resp:{status_code:0},data:{audio:Buffer.from('ID3 test audio').toString('hex')} }));
  const calls=[], original=bridge.send.bind(bridge);
  bridge.send=async request=>{calls.push(request);return original(request);};
  bridge.push(contact,'other','请生成普通合成声音的 MP3 问候。');
  await a.tick(); advance(20000);
  provider.next=async()=>({action:'send',text:'给你一段问候。',media:[{type:'audio',text:'晚上好'}]});
  await a.tick();
  assert.equal(calls.length,2); assert.match(calls[0].text,/^（AI 合成音频）/); assert.equal(calls[0].mediaFile,undefined);
  assert.equal(calls[1].mediaFile.type,'audio/mpeg'); assert.match(calls[1].mediaFile.name,/^AI-generated-[a-f0-9-]{36}\.mp3$/);
  assert.equal(Object.values(a.data.profiles).find(profile=>profile.contact===contact).rounds,2);
});
