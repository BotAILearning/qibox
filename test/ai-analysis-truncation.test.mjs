import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { tailWithinLimit, analysisPrompt } from '../server/ai-analysis.mjs';
import { compactReportInput } from '../server/ai-model-input.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('a report tail that loses the negation is explicitly a partial source, never a complete original', () => {
  const input = [{ id: 'cut', direction: 'other', timestamp: 100, text: '我没说她已经付款。' },
    { id: 'full', direction: 'self', timestamp: 101, text: '等她确认' }];
  const before = structuredClone(input), tail = '她已经付款。';
  const result = tailWithinLimit(input, Array.from(tail + input[1].text).length);
  assert.equal(result.messages[0].text, tail);
  assert.equal(result.messages[0].textTruncated, true);
  assert.equal(Object.hasOwn(result.messages[1], 'textTruncated'), false);
  assert.equal(result.coverage.partialMessages, 1);
  assert.deepEqual(input, before);
  assert.match(analysisPrompt('', { partialSource: true }), /textTruncated/);
  assert.doesNotMatch(analysisPrompt(''), /textTruncated/);
});

for (const protocol of ['anthropic', 'openai']) test(`${protocol}: partial-source flag survives the actual report provider wire in one request`, async t => {
  const root = await temp(), bridge = new ChatFixture(), requests = [];
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const wire = JSON.parse(body.messages.find(row => row.role === 'user').content);
    const rows = wire.messages.map(row => Object.fromEntries(wire.messageColumns.map((name, i) => [name, row[i]])));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, '她已经付款。');
    assert.equal(rows[0].textTruncated, true);
    assert.equal(rows[1].textTruncated, null);
    assert.equal(rows[1].text, '😀'.repeat(149994));
    assert.deepEqual(rows.map(row => row.speaker), ['对方', '本人']);
    const text = JSON.stringify({ report: '首条仅保留片段，付款结果无法据此确认。' });
    return Response.json(protocol === 'anthropic' ? { content: [{ type: 'text', text }] }
      : { choices: [{ message: { content: text } }] });
  } });
  provider.test = async () => {}; // Connection verification is outside this wire regression.
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider({ ...modelConfig, protocol }); await a.scan(); requests.length = 0;
  const originals = [{ id: key('partial-negation'), direction: 'other', timestamp: 1793034000, text: '我没说她已经付款。' },
    { id: key('whole-emoji'), direction: 'self', timestamp: 1793034001, text: '😀'.repeat(149994) }];
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: originals });
  const report = (await a.analyze({ contacts: [bridge.contacts[0].id], request: '' })).reports[0];
  assert.equal(report.status, 'complete'); assert.equal(report.partialMessages, 1);
  assert.equal(requests.length, 1); assert.equal(report.scope, 'truncated');
  assert.equal(Object.hasOwn(originals[0], 'textTruncated'), false);
});

test('report compaction preserves the partial marker and rejects unknown truncation shapes without dropping metadata', () => {
  const input = { messages: [{ sequence: 1, speaker: '本人', beijingTime: '2026-10-27 01:00:00', text: '原话尾段', secondsSincePrevious: null, textTruncated: true }] };
  const before = structuredClone(input), wire = compactReportInput(input);
  assert.equal(wire.messageColumns.at(-1), 'textTruncated');
  assert.equal(wire.messages[0].at(-1), true);
  assert.deepEqual(input, before);
  const unknown = { messages: [{ ...input.messages[0], textTruncated: 'future-shape' }] };
  assert.deepEqual(compactReportInput(unknown), unknown);
});
