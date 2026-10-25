import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('chronological analysis uses one smaller dedicated prompt while preserving the source sequence and custom format', async t => {
  const root = await temp(), bridge = new ChatFixture(), wires = [];
  const first = Date.parse('2026-10-21T08:00:00Z') / 1000;
  const texts = ['培训还没确认。', '地点改为三楼。', '只参加培训，不参加晚餐。', '小说里的“我付款了”不是付款记录。'];
  const contact = bridge.contacts[0].id;
  bridge.messages.set(contact, texts.map((text, i) => ({ id: key('layout-' + i), direction: i % 2 ? 'self' : 'other', text, timestamp: first + i * 30 })));
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    wires.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ report: '资料依次涉及培训意向、地点更正、参加范围及小说引用；实际付款状态未知。' }) }, finish_reason: 'stop' }] });
  } });
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  const request = '按时间顺序用表格保留关键更正和引用';
  const result = await a.analyze({ contacts: [contact], from: '2026-10-21', to: '2026-10-21', request });
  assert.equal(result.reports[0].status, 'complete'); assert.equal(wires.length, 1);
  const chronological = wires[0].messages.find(m => m.role === 'system').content;
  const input = JSON.parse(wires[0].messages.find(m => m.role === 'user').content);
  assert.equal(input.userRequest, request);
  assert.deepEqual(input.messageColumns, ['sequence', 'speaker', 'beijingTime', 'text', 'secondsSincePrevious']);
  assert.deepEqual(input.messages.map(m => [m[0], m[1], m[3], m[4]]), texts.map((text, i) => [i + 1, i % 2 ? '本人' : '对方', text, i ? 30 : null]));
  assert.equal(input.coverage.truncated, false); assert.equal(input.analyzedCount, 4);
  assert.doesNotMatch(chronological, /默认按音乐回顾方式|每章固定两行/);
  assert.match(chronological, /用户指定表格、列表等格式时仍保持此顺序/);
  await a.analyze({ contacts: [contact], from: '2026-10-21', to: '2026-10-21', request: '回顾主要话题' });
  assert.equal(wires.length, 2, 'One HTTP request for each explicit analysis; no review or automatic extra request');
  const ordinary = wires[1].messages.find(m => m.role === 'system').content;
  assert.match(ordinary, /默认按音乐回顾方式/); assert(chronological.length < ordinary.length);
  assert.equal(bridge.sent.length, 0); assert.equal(a.analysisHistory().length, 2);
});
