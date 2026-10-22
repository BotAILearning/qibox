import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitStyleTendencyRound, learnStyleTendency, planStyleTendency, scopeStyleTendencyKey,
  styleTendencyContextFromMessages,
} from '../server/ai-style-tendency.mjs';

const account = 'a'.repeat(64), contact = 'b'.repeat(64), otherContact = 'c'.repeat(64);
const sample = (id, text, extra = {}) => ({ id, direction: 'self', authorship: 'human', text, timestamp: 1800000000, ...extra });
const confirmed = (id, text, at) => ({ id, operationId: id, source: 'reply', confirmed: true, deliveryConfidence: 'confirmed', text, at });

function learned(samples, recentSends = [], existing, now = 1800000000000) {
  return learnStyleTendency({ account, contact, samples, recentSends, existing, now });
}

test('only explicit trusted human samples train tendencies; confirmed AI replies are separate usage history', () => {
  const samples = [
    sample('h1', '哈哈，这个可以🙂'), sample('h2', '笑死我了😂'), sample('h3', '哈哈，真会说🙂'),
    sample('ai', '哈哈🙂', { authorship: 'ai', aiGenerated: true }),
    sample('other', '哈哈🙂', { direction: 'other' }),
    sample('unknown', '哈哈🙂', { authorship: 'unknown' }),
    sample('assumed', '哈哈🙂', { assumedPresent: true }),
    sample('untrusted', '哈哈🙂', { trusted: false }),
  ];
  const state = learned(samples, [
    { ...confirmed('send-ok', '哈哈🙂', 1799999999000), styleRoundId: 22, replyRoundVersion: 2 },
    { ...confirmed('send-ok-segment-2', '再见', 1799999999500), styleRoundId: 22, replyRoundVersion: 9 },
    { ...confirmed('send-unknown', '哈哈🙂', 1799999998000), deliveryConfidence: 'unknown' },
    { ...confirmed('send-failed', '哈哈🙂', 1799999997000), confirmed: false },
  ]);
  assert.equal(state.sampleCount, 3);
  assert.equal(state.confirmedSendCount, 1);
  assert.equal(state.traits.laughter.evidenceCount, 3);
  assert.equal(state.traits.emoji.evidenceCount, 3);
  assert.equal(state.recentUsage.traits.laughter.rounds, 1);
  assert.equal(state.recentUsage.traits.emoji.rounds, 1);
  assert.equal(JSON.stringify(state).includes('真会说'), false);
  assert.equal(state.scopeKey, scopeStyleTendencyKey(account, contact));
});

test('AI-only history reports usage but cannot create human confidence or observed source', () => {
  const sends = Array.from({ length: 12 }, (_, i) => ({ ...confirmed(`ai-${i}`, '哈哈🙂', 1799999999000 + i), styleRoundId: i + 1 }));
  const state = learned([], sends);
  const { plan } = planStyleTendency({ state, account, contact, styleRoundId: 0 });
  assert.equal(state.sampleCount, 0);
  assert.equal(state.confirmedSendCount, 12);
  assert.equal(state.traits.laughter.confidence, 'unclear');
  assert.equal(state.traits.laughter.preference, 'neutral');
  assert.equal(state.recentUsage.roundCount, 8);
  assert.equal(state.recentUsage.traits.laughter.rounds, 8);
  assert.equal(state.recentUsage.traits.laughter.consecutiveRounds, 8);
  assert.equal(plan.source, 'neutral');
  assert.match(plan.traits.laughter.guidance, /真人样本不足/u);
  assert.match(plan.traits.laughter.guidance, /最近连续8轮实际用过/u);
});

test('known native WeChat emoji names count while arbitrary bracketed words do not', () => {
  const state = learned([
    sample('wx1', '[捂脸]'), sample('wx2', '[旺柴]'), sample('wx3', '[破涕为笑]'), sample('plain', '[自定义词]'),
  ]);
  assert.equal(state.traits.emoji.evidenceCount, 3);
  assert.equal(state.traits.emoji.sampleCount, 4);
});

test('recent use describes the latest eight rounds and actual consecutive use, not a 30-day total', () => {
  const now = 1800000000000;
  const sends = [
    { ...confirmed('r1', '哈哈', now - 5000), styleRoundId: 1 },
    { ...confirmed('r2', '普通', now - 4000), styleRoundId: 2 },
    { ...confirmed('r3', '哈哈', now - 3000), styleRoundId: 3 },
    { ...confirmed('r4', '普通', now - 2000), styleRoundId: 4 },
    { ...confirmed('r5', '哈哈', now - 1000), styleRoundId: 5 },
  ];
  const state = learned([sample('h1', '哈哈'), sample('h2', '哈哈'), sample('h3', '哈哈')], sends, undefined, now);
  assert.equal(state.recentUsage.traits.laughter.rounds, 3);
  assert.equal(state.recentUsage.traits.laughter.latestUsed, true);
  assert.equal(state.recentUsage.traits.laughter.consecutiveRounds, 1);
  const latest = planStyleTendency({ state, account, contact, styleRoundId: 0, now }).plan;
  assert.match(latest.traits.laughter.guidance, /上一轮实际用过/u);
  assert.doesNotMatch(latest.traits.laughter.guidance, /连续/u);

  const withGap = learned([sample('h1', '哈哈'), sample('h2', '哈哈'), sample('h3', '哈哈')], sends.slice(0, 4), undefined, now);
  assert.equal(withGap.recentUsage.traits.laughter.latestUsed, false);
  assert.equal(withGap.recentUsage.traits.laughter.consecutiveRounds, 0);
  const gapPlan = planStyleTendency({ state: withGap, account, contact, styleRoundId: 1, now }).plan;
  assert.doesNotMatch(gapPlan.traits.laughter.guidance, /上一轮实际用过|连续/u);

  const consecutive = learned([sample('h1', '哈哈'), sample('h2', '哈哈'), sample('h3', '哈哈')], [
    { ...confirmed('c1', '哈哈', now - 3000), styleRoundId: 10 },
    { ...confirmed('c2', '普通', now - 2000), styleRoundId: 11 },
    { ...confirmed('c3', '哈哈', now - 1000), styleRoundId: 12 },
    { ...confirmed('c4', '哈哈', now), styleRoundId: 13 },
  ], undefined, now);
  assert.equal(consecutive.recentUsage.traits.laughter.consecutiveRounds, 2);
  const consecutivePlan = planStyleTendency({ state: consecutive, account, contact, styleRoundId: 2, now }).plan;
  assert.match(consecutivePlan.traits.laughter.guidance, /最近连续2轮实际用过/u);
});

test('human multi-segment messages count as one observation per explicit styleRoundId; future history is ignored', () => {
  const samples = [
    sample('a1', '哈哈🙂', { styleRoundId: 'human-a' }),
    sample('a2', '再补一条😂', { styleRoundId: 'human-a' }),
    sample('b1', '哈哈😄', { styleRoundId: 'human-b' }),
    sample('future', '哈哈😄', { styleRoundId: 'human-c', timestamp: 1800000001 }),
  ];
  const state = learned(samples);
  assert.equal(state.sampleCount, 2);
  assert.equal(state.traits.laughter.sampleCount, 2);
  assert.equal(state.traits.laughter.evidenceCount, 2);
  assert.equal(state.traits.laughter.confidence, 'unclear');
});

test('sparse and unsupported signals remain neutral instead of guessing voice or names', () => {
  const state = learned([
    sample('one', '小林哈哈'),
    sample('two', '你今天怎么不来？'),
    sample('bad', '宝贝🙂', { authorship: 'unknown' }),
  ]);
  const { plan } = planStyleTendency({ state, account, contact, styleRoundId: 0, context: { relationshipConfirmed: false, questionNeeded: false } });
  for (const name of ['emoji', 'laughter', 'addressing', 'rhetorical', 'teasing']) {
    assert.equal(plan.traits[name].preference, 'neutral', name);
    assert.equal(plan.traits[name].confidence, 'unclear', name);
  }
  assert.equal(plan.traits.addressing.guidance, '真人样本不足或倾向不明确，保持自然中性，不刻意加入');
  assert.equal(plan.manualStylePriority, true);
  assert.match(plan.instruction, /不必每轮体现|不要为体现倾向添加/u);
});

test('ordinary questions do not imply rhetorical style; contextual restraint does not force or block decoration', () => {
  const state = learned([
    sample('r1', '难道这还不明显吗🙂'), sample('r2', '不是已经说过了吗'), sample('r3', '这不就是你想要的吗'),
    sample('q1', '你今天忙吗？'), sample('q2', '你想吃什么？'), sample('q3', '几点出发？'),
    sample('t1', '逗你呢哈哈'), sample('t2', '少来，真会说'), sample('t3', '服了你，笑死'),
  ]);
  assert.equal(state.traits.rhetorical.evidenceCount, 3);
  assert.equal(state.traits.teasing.evidenceCount, 3);
  const serious = planStyleTendency({ state, account, contact, styleRoundId: 1, now: 1800000000000, context: { serious: true } }).plan;
  assert.match(serious.traits.teasing.guidance, /语境偏严肃.*只有确实合适时才使用/u);
  assert.match(serious.traits.laughter.guidance, /语境偏严肃/u);
  assert.equal(serious.traits.rhetorical.preference, 'sometimes');
  assert.match(serious.instruction, /不是配额或必须项/u);
});

test('current pending-message tone uses explicit signals only and keeps manual style priority', () => {
  const serious = styleTendencyContextFromMessages([
    { direction: 'self', text: '别把这条旧消息算成本轮语气' },
    { direction: 'other', text: '这件事请认真说，别开玩笑。' },
  ]);
  assert.deepEqual(serious, { serious: true, sensitive: false, banter: false, relationshipConfirmed: false, questionNeeded: false });
  const seriousPlan = planStyleTendency({ state: learned([sample('h1', '逗你呢哈哈'), sample('h2', '逗你呢哈哈'), sample('h3', '逗你呢哈哈')]), account, contact, styleRoundId: 20, context: serious }).plan;
  assert.match(seriousPlan.traits.teasing.guidance, /语境偏严肃/u);
  assert.equal(seriousPlan.manualStylePriority, true);

  const playful = styleTendencyContextFromMessages([{ direction: 'other', text: '刚才逗你呢，开个玩笑。' }]);
  assert.equal(playful.banter, true);
  assert.equal(playful.serious, false);
  assert.equal(playful.relationshipConfirmed, false);
  assert.equal(playful.questionNeeded, false);

  const neutral = styleTendencyContextFromMessages([
    { direction: 'other', text: '小王说安排还没定，你今天有空吗？' },
    { direction: 'self', text: '请认真点' },
  ]);
  assert.deepEqual(neutral, { serious: false, sensitive: false, banter: false, relationshipConfirmed: false, questionNeeded: false });
  const privateTopic = styleTendencyContextFromMessages([{ direction: 'other', text: '这件事请保密，不要外传。' }]);
  assert.equal(privateTopic.sensitive, true);
  assert.equal(privateTopic.banter, false);
});

test('the same round reuses its original prepared plan even when new context or learning arrives', () => {
  const state = learned([sample('h1', '哈哈🙂'), sample('h2', '哈哈😄'), sample('h3', '哈哈😂')]);
  const first = planStyleTendency({ state, account, contact, styleRoundId: 4, context: { banter: true }, now: 1000 });
  const updatedLearning = learned([sample('h1', '普通回复'), sample('h2', '普通回复'), sample('h3', '普通回复')], [], first.state, 2000);
  const retry = planStyleTendency({ state: updatedLearning, account, contact, styleRoundId: 4, context: { serious: true }, now: 3000 });
  assert.deepEqual(retry.plan, first.plan);
  assert.equal(retry.state.plans['4'].createdAt, 1000);
});

test('failed and unknown sends do not count; repeated and segmented confirmed receipts count one round', () => {
  const state = learned([sample('h1', '普通'), sample('h2', '普通'), sample('h3', '普通')]);
  let current = planStyleTendency({ state, account, contact, styleRoundId: 7 }).state;
  const before = structuredClone(current);
  for (const status of ['failed', 'unknown', 'unconfirmed', undefined]) {
    current = commitStyleTendencyRound(current, { account, contact, styleRoundId: 7, operationId: `op-${status}`, status });
    assert.deepEqual(current, before);
  }
  current = commitStyleTendencyRound(current, { account, contact, styleRoundId: 7, operationId: 'segment-1', status: 'confirmed', at: 5000 });
  current = commitStyleTendencyRound(current, { account, contact, styleRoundId: 7, operationId: 'segment-2', status: 'confirmed', at: 5001 });
  current = commitStyleTendencyRound(current, { account, contact, styleRoundId: 7, operationId: 'segment-1', status: 'confirmed', at: 5002 });
  assert.equal(current.roundCount, 1);
  assert.deepEqual(current.roundLedger['7'].operationIds, ['segment-1', 'segment-2']);
});

test('receipt reconciliation after restart remains idempotent and requires a planned round', () => {
  const state = learned([sample('h1', '普通'), sample('h2', '普通'), sample('h3', '普通')]);
  const prepared = planStyleTendency({ state, account, contact, styleRoundId: 8 });
  let committed = commitStyleTendencyRound(prepared.state, { account, contact, styleRoundId: 8, operationId: 'receipt-8', status: 'confirmed', at: 10 });
  committed = JSON.parse(JSON.stringify(committed));
  committed = commitStyleTendencyRound(committed, { account, contact, styleRoundId: 8, operationId: 'receipt-8', status: 'confirmed', at: 11 });
  committed = commitStyleTendencyRound(committed, { account, contact, styleRoundId: 8, operationId: 'late-segment', status: 'confirmed', at: 12 });
  committed = commitStyleTendencyRound(committed, { account, contact, styleRoundId: 9, operationId: 'no-plan', status: 'confirmed', at: 13 });
  assert.equal(committed.roundCount, 1);
  assert.deepEqual(committed.roundLedger['8'].operationIds, ['receipt-8', 'late-segment']);
  assert.equal(committed.roundLedger['9'], undefined);
});

test('concurrent acknowledgments are safe when callers serialize the profile state update', async () => {
  let state = learned([sample('h1', '普通'), sample('h2', '普通'), sample('h3', '普通')]);
  state = planStyleTendency({ state, account, contact, styleRoundId: 10 }).state;
  let queue = Promise.resolve();
  const acknowledge = operationId => {
    queue = queue.then(() => { state = commitStyleTendencyRound(state, { account, contact, styleRoundId: 10, operationId, status: 'confirmed' }); });
    return queue;
  };
  await Promise.all([acknowledge('seg-a'), acknowledge('seg-b'), acknowledge('seg-a')]);
  assert.equal(state.roundCount, 1);
  assert.deepEqual(state.roundLedger['10'].operationIds, ['seg-a', 'seg-b']);
});

test('plans and receipts cannot cross account or contact scope', () => {
  const state = learned([sample('h1', '哈哈'), sample('h2', '哈哈'), sample('h3', '哈哈')]);
  const other = planStyleTendency({ state, account, contact: otherContact, styleRoundId: 2 });
  assert.equal(other.plan.scopeKey, scopeStyleTendencyKey(account, otherContact));
  assert.notEqual(other.plan.scopeKey, state.scopeKey);
  const noLeak = commitStyleTendencyRound(state, { account, contact: otherContact, styleRoundId: 0, operationId: 'foreign', status: 'confirmed' });
  assert.equal(noLeak.roundCount, 0);
  assert.equal(noLeak.scopeKey, scopeStyleTendencyKey(account, otherContact));
});

test('untrusted persisted map keys cannot cross into plans or alter object prototypes', () => {
  const state = learned([sample('__proto__', '哈哈'), sample('constructor', '哈哈'), sample('safe', '哈哈')]);
  const poisoned = JSON.parse(JSON.stringify({ ...state,
    plans: Object.fromEntries([['__proto__', { scopeKey: state.scopeKey, instruction: 'foreign-plan' }], ['constructor', { scopeKey: state.scopeKey, instruction: 'foreign-plan' }]]),
    roundLedger: Object.fromEntries([['__proto__', { operationIds: ['foreign'] }]]),
  }));
  const result = planStyleTendency({ state: poisoned, account, contact, styleRoundId: 3 });
  assert.equal(result.plan.styleRoundId, 3);
  assert.notEqual(result.plan.instruction, 'foreign-plan');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(result.state.plans), Object.prototype);
});

test('round history and plan cache stay bounded and old duplicate receipts cannot recount', () => {
  let state = learned([sample('h1', '普通'), sample('h2', '普通'), sample('h3', '普通')]);
  for (let styleRoundId = 0; styleRoundId < 160; styleRoundId++) {
    state = planStyleTendency({ state, account, contact, styleRoundId }).state;
    state = commitStyleTendencyRound(state, { account, contact, styleRoundId, operationId: `op-${styleRoundId}`, status: 'confirmed' });
  }
  const count = state.roundCount;
  const oldDuplicate = commitStyleTendencyRound(state, { account, contact, styleRoundId: 0, operationId: 'op-0', status: 'confirmed' });
  assert.equal(oldDuplicate.roundCount, count);
  assert.ok(Object.keys(state.plans).length <= 128);
  assert.ok(Object.keys(state.roundLedger).length <= 128);
});
