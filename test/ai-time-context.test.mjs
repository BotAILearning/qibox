import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateSourceDates, staleTemporaryProactive } from '../server/ai-time-context.mjs';

test('learning receives server calculated dates for relative time without changing the chat text', () => {
  const timestamp = Math.floor(Date.parse('2026-09-29T14:00:00+08:00') / 1000);
  const source = [{ id: 'one', direction: 'other', timestamp, text: '昨天感冒了，去年也请过假' }];
  const [annotated] = annotateSourceDates(source);
  assert.equal(annotated.text, source[0].text);
  assert.equal(annotated.sourceDate, '2026-09-29');
  assert.deepEqual(annotated.relativeDates, { 昨天: '2026-09-28', 去年: '2025-09-29' });
  assert.equal(source[0].relativeDates, undefined);
});

test('a generic greeting cannot ask if a two-week-old illness is better', () => {
  const now = Date.parse('2026-09-30T10:00:00+08:00');
  const old = { direction: 'other', timestamp: Math.floor((now - 15 * 86400000) / 1000), text: '我感冒了' };
  const output = { action: 'send', text: '最近怎么样，好点了吗' };
  assert.equal(staleTemporaryProactive(output, [old], now, '自然地问候对方'), true);
  assert.equal(staleTemporaryProactive(output, [old], now, '问问感冒是否好转'), false);
  assert.equal(staleTemporaryProactive(output, [old, { ...old, timestamp: Math.floor(now / 1000) }], now, '自然地问候对方'), false);
  assert.equal(staleTemporaryProactive({ action: 'send', text: '最近怎么样' }, [old], now, '自然地问候对方'), false);
});
