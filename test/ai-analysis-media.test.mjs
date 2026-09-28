import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { analysisOptions } from '../server/ai-analysis.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('media options require explicit booleans and default to off', () => {
  const plain = analysisOptions({ contacts: ['one'] });
  assert.equal(plain.includeVoice, false);
  assert.equal(plain.includeVisual, false);
  assert.throws(() => analysisOptions({ contacts: ['one'], includeVoice: 'yes' }), /选项无效/);
});

test('selected media is tied to message ids, failures are skipped, and history stores no media bytes', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider });
  await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id;
  const base = 1780000000;
  const rows = [
    { id: key('voice'), direction: 'other', type: 'voice', text: '[语音]', timestamp: base },
    { id: key('image'), direction: 'other', type: 'image', text: '[图片]', timestamp: base + 1 },
    { id: key('video'), direction: 'other', type: 'video', text: '[视频]', timestamp: base + 2 },
    { id: key('text'), direction: 'self', text: '明天见', timestamp: base + 3 },
  ];
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: structuredClone(rows) });
  bridge.read = async args => ({ account: args.account, contact: args.contact, revision: key('recent'), messages: structuredClone(rows) });
  bridge.transcribe = async args => ({ source: 'wechat', text: args.messageId === rows[0].id ? '下午三点见' : '' });
  bridge.readImage = async args => ({ messageId: args.messageId, mime: 'image/png', data: 'aGVsbG8=' });
  bridge.readVideoFrames = async () => null;
  const calls = [];
  provider.complete = async (_config, _prompt, input) => {
    calls.push(input);
    return input.images ? { captions: [{ id: rows[1].id, text: '一张车站照片' }] } : { report: '依据文字和图片生成的报告' };
  };
  const report = (await a.analyze({ contacts: [contact], includeVoice: true, includeVisual: true })).reports[0];
  assert.equal(report.status, 'complete', JSON.stringify(report));
  assert.deepEqual(report.mediaCoverage.voice, { selected: true, total: 1, analyzed: 1, skipped: 0, limited: 0 });
  assert.equal(report.mediaCoverage.image.analyzed, 1);
  assert.equal(report.mediaCoverage.video.skipped, 1);
  assert.equal(report.contentParsedCount, 3);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.at(-1).messages.map(row => row[2]), ['下午三点见', '[图片识别] 一张车站照片', '[视频]', '明天见']);
  const saved = a.analysisReport(report.historyId);
  assert.deepEqual(saved.mediaCoverage, report.mediaCoverage);
  assert.equal(saved.contentParsedCount, 3);
  assert.equal(JSON.stringify(saved).includes('aGVsbG8='), false);
});

test('video frames reach the vision model with source ids and join the report in message order', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id, id = key('video-frames');
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [
    { id, direction: 'other', type: 'video', text: '[视频]', timestamp: 1788307200 },
    { id: key('after-video'), direction: 'self', text: '看到了', timestamp: 1788307201 },
  ] });
  bridge.readVideoFrames = async () => [1, 2, 3].map((_, index) => ({ mime: 'image/jpeg', data: '/9j/', at: index + 1 }));
  provider.complete = async (_config, _prompt, input) => input.images
    ? { captions: input.items.map(item => ({ id: item.id, text: `第${item.at}秒画面` })) }
    : { report: '依据视频画面生成的报告' };
  let finalInput;
  const complete = provider.complete;
  provider.complete = async (...args) => { const result = await complete(...args); if (!args[2].images) finalInput = args[2]; return result; };
  const result = (await a.analyze({ contacts: [contact], includeVisual: true })).reports[0];
  assert.equal(result.status, 'complete');
  assert.equal(result.mediaCoverage.video.analyzed, 1);
  assert.deepEqual(finalInput.messages.map(item => item[2]), ['[视频画面识别] 第1秒画面；第2秒画面；第3秒画面', '看到了']);
});

test('unsupported vision model skips media and still produces a text report', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id;
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [
    { id: key('photo'), direction: 'other', type: 'image', text: '[图片]', timestamp: 1788307200 },
    { id: key('words'), direction: 'other', text: '这张图片说明什么？', timestamp: 1788307201 },
  ] });
  bridge.readImage = async args => ({ messageId: args.messageId, mime: 'image/png', data: 'aGVsbG8=' });
  let visionCalls = 0;
  provider.complete = async (_config, _prompt, input) => {
    if (input.images) { visionCalls++; throw Object.assign(new Error('不支持图片'), { code: 'ai_model_vision_unsupported' }); }
    assert.deepEqual(input.messages.map(row => row[2]), ['[图片]', '这张图片说明什么？']);
    return { report: '图片未能解析，只能依据文字说明。' };
  };
  const result = (await a.analyze({ contacts: [contact], includeVisual: true })).reports[0];
  assert.equal(result.status, 'complete');
  assert.equal(result.mediaCoverage.image.skipped, 1);
  assert.equal(visionCalls, 1);
});
