import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateSourceDates } from '../server/ai-time-context.mjs';

test('learning receives server calculated dates for relative time without changing the chat text', () => {
  const timestamp = Math.floor(Date.parse('2026-09-29T14:00:00+08:00') / 1000);
  const source = [{ id: 'one', direction: 'other', timestamp, text: '昨天感冒了，去年也请过假' }];
  const [annotated] = annotateSourceDates(source);
  assert.equal(annotated.text, source[0].text);
  assert.equal(annotated.sourceDate, '2026-09-29');
  assert.deepEqual(annotated.relativeDates, { 昨天: '2026-09-28', 去年: '2025-09-29' });
  assert.equal(source[0].relativeDates, undefined);
});
