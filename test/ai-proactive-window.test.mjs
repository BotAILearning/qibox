import test from 'node:test';
import assert from 'node:assert/strict';
import { proactiveOccurrenceDeadline, FIXED_GRACE_MS, RANDOM_MIN_GRACE_MS } from '../server/ai-proactive-schedule.mjs';

// All wall-clock values below are Asia/Shanghai; assertions use instants.
const at = text => Date.parse(text + '+08:00');
const day = '2026-09-21';
const fixed = { cycle: 'daily', mode: 'fixed', timezone: 'Asia/Shanghai', startDate: day, time: '09:00' };
const random = { cycle: 'daily', mode: 'random', timezone: 'Asia/Shanghai', startDate: day, start: '14:00', end: '17:00' };
const overnight = { ...random, start: '23:00', end: '01:00' };

test('a fixed occurrence keeps a full hour of grace past its scheduled time', () => {
  assert.equal(FIXED_GRACE_MS, 60 * 60000);
  assert.equal(proactiveOccurrenceDeadline(fixed, day), at(`${day}T09:00:00`) + FIXED_GRACE_MS);
});

test('a fixed occurrence whose tick only starts late still gets its full hour', () => {
  const started = at('2026-09-21T09:30:00');
  assert.equal(proactiveOccurrenceDeadline(fixed, day, started), started + FIXED_GRACE_MS);
});

test('an occurrence missed for days is not handed a fresh grace period at recovery time', () => {
  // Otherwise a restart after downtime would replay a stale proactive message.
  const anchor = at('2026-09-21T09:00:00');
  assert.equal(proactiveOccurrenceDeadline(fixed, day, at('2026-09-23T15:10:00')), anchor + FIXED_GRACE_MS);
  assert.equal(proactiveOccurrenceDeadline(random, day, at('2026-09-21T19:00:00')), at('2026-09-21T17:00:00'));
  assert.equal(proactiveOccurrenceDeadline(random, day, at('2026-09-22T03:00:00')), at('2026-09-21T17:00:00'));
});

test('a random occurrence drawn with room to spare keeps the plain window end', () => {
  const windowEnd = at('2026-09-21T17:00:00');
  assert.equal(proactiveOccurrenceDeadline(random, day, at('2026-09-21T14:20:00')), windowEnd);
  assert.equal(proactiveOccurrenceDeadline(random, day, at('2026-09-21T16:20:00')), windowEnd);
  assert.equal(proactiveOccurrenceDeadline(random, day), windowEnd);
});

test('a random draw with less room than the floor gets trigger plus fifteen minutes', () => {
  assert.equal(RANDOM_MIN_GRACE_MS, 15 * 60000);
  for (const drawn of ['2026-09-21T16:50:00', '2026-09-21T16:59:30', '2026-09-21T16:46:00']) {
    const trigger = at(drawn);
    const deadline = proactiveOccurrenceDeadline(random, day, trigger);
    assert.equal(deadline, trigger + RANDOM_MIN_GRACE_MS, drawn);
    assert.ok(deadline > at('2026-09-21T17:00:00'), `${drawn} must extend past the window end`);
  }
  const comfortable = at('2026-09-21T16:44:00');
  assert.equal(proactiveOccurrenceDeadline(random, day, comfortable), at('2026-09-21T17:00:00'));
});

test('a random window crossing midnight keeps belonging to its starting day', () => {
  const deadline = proactiveOccurrenceDeadline(overnight, day, at('2026-09-21T23:05:00'));
  assert.equal(deadline, Math.max(at('2026-09-22T01:00:00'), at('2026-09-21T23:05:00') + RANDOM_MIN_GRACE_MS));
});

test('a one-off task never expires', () => {
  assert.equal(proactiveOccurrenceDeadline({ cycle: 'once', mode: 'fixed', timezone: 'Asia/Shanghai' }, 'once', Date.now()), Infinity);
});
