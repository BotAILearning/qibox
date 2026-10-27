import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { tailWithinLimit, analysisPrompt } from '../server/ai-analysis.mjs';
import { compactReportInput } from '../server/ai-model-input.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('a report budget never manufactures an affirmative tail from a whole negated source', () => {
  const input = [{ id: 'cut', direction: 'other', timestamp: 100, text: '我没说她已经付款。' },
    { id: 'full', direction: 'self', timestamp: 101, text: '等她确认' }];
  const before = structuredClone(input), tail = '她已经付款。';
  const result = tailWithinLimit(input, Array.from(tail + input[1].text).length);
  assert.deepEqual(result.messages, [input[1]]);
  assert.equal(Object.hasOwn(result.messages[0], 'textTruncated'), false);
  assert.equal(result.coverage.partialMessages, 0);
  assert.equal(result.coverage.omittedBudgetMessages, 1);
  assert.equal(result.coverage.analyzedChars, Array.from(input[1].text).length);
  assert.deepEqual(input, before);
  assert.match(analysisPrompt('', { partialSource: true }), /textTruncated/);
  assert.doesNotMatch(analysisPrompt(''), /textTruncated/);
});

for (const protocol of ['anthropic', 'openai']) test(`${protocol}: budget omission preserves the last whole source and never forwards a lost-negation tail`, async t => {
  const root = await temp(), bridge = new ChatFixture(), requests = [];
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const wire = JSON.parse(body.messages.find(row => row.role === 'user').content);
    const rows = wire.messages.map(row => Object.fromEntries(wire.messageColumns.map((name, i) => [name, row[i]])));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '😀'.repeat(149994));
    assert.equal(Object.hasOwn(rows[0], 'textTruncated'), false);
    assert.deepEqual(rows.map(row => row.speaker), ['本人']);
    assert.equal(wire.coverage.omittedBudgetMessages, 1);
    assert.equal(wire.analyzedCount, 1); assert.equal(wire.readableCount, 2);
    assert.equal(JSON.stringify(wire).includes('她已经付款。'), false);
    const text = JSON.stringify({ report: '仅有完整的最后一条消息纳入分析，较早一条未纳入。' });
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
  assert.equal(report.status, 'complete'); assert.equal(report.partialMessages, 0);
  assert.equal(report.omittedBudgetMessages, 1); assert.equal(report.analyzedCount, 1); assert.equal(report.readableCount, 2);
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
