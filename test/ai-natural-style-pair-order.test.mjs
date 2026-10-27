import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalStyleEvidence } from '../server/ai-natural-style.mjs';

function mixedHistory() {
  const rows = [];
  for (const [n, incomingText, replyText, quoted] of [
    [1, '纸盒找到了', '那就好', true],
    [2, '今天晚点回来', '行', false],
    [3, '说明书就在抽屉里', '知道了', true],
  ]) {
    const incoming = { id: `other-${n}`, direction: 'other', authorship: 'other', text: incomingText, timestamp: 1800000000 + n * 30 };
    const reply = { id: `self-${n}`, direction: 'self', authorship: 'human', text: replyText, timestamp: incoming.timestamp + 1,
      ...(quoted ? { quote: { verified: true, direction: 'other', messageId: incoming.id, text: incoming.text, timestamp: incoming.timestamp } } : {}) };
    rows.push(incoming, reply);
  }
  return rows;
}
const replyIds = evidence => evidence.pairedExamples.map(pair => pair.reply.id);

test('mixed verified quotes and adjacent style pairs retain source order without a query', () => {
  const rows = mixedHistory(), before = structuredClone(rows);
  const evidence = naturalStyleEvidence(rows, { kind: 'person', maxPairs: 3 });
  assert.deepEqual(replyIds(evidence), ['self-1', 'self-2', 'self-3']);
  assert.deepEqual(evidence.pairedExamples.map(pair => pair.relation), ['verified-quote', 'adjacent-context', 'verified-quote']);
  assert.deepEqual(rows, before, 'sorting examples cannot reorder or rewrite the source transcript');
});

test('a private-chat adjacency pass with no eligible additions cannot reverse verified pairs', () => {
  const rows = mixedHistory(); rows[3] = { ...rows[3], authorship: 'ai', aiGenerated: true };
  const evidence = naturalStyleEvidence(rows, { kind: 'person', maxPairs: 4 });
  assert.deepEqual(replyIds(evidence), ['self-1', 'self-3']);
  assert(evidence.pairedExamples.every(pair => pair.relation === 'verified-quote'));
  assert(!evidence.samples.some(row => row.id === 'self-2'));
});

test('query-selected private style pairs keep the same source chronology and whole text', () => {
  const rows = mixedHistory();
  const evidence = naturalStyleEvidence(rows, { kind: 'person', query: '纸盒和说明书', maxPairs: 3 });
  assert.deepEqual(replyIds(evidence), ['self-1', 'self-2', 'self-3']);
  for (const pair of evidence.pairedExamples) {
    assert.equal(pair.incoming.text, rows.find(row => row.id === pair.incoming.id).text);
    assert.equal(pair.reply.text, rows.find(row => row.id === pair.reply.id).text);
  }
});

test('group style evidence still has no inferred adjacent pairs, and zero pair budget stays empty', () => {
  const rows = mixedHistory();
  const group = naturalStyleEvidence(rows, { kind: 'group', maxPairs: 4 });
  assert.deepEqual(replyIds(group), ['self-1', 'self-3']);
  assert(group.pairedExamples.every(pair => pair.relation === 'verified-quote'));
  assert.deepEqual(replyIds(naturalStyleEvidence(rows, { maxPairs: 0 })), []);
});
