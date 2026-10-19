import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { replyLimitValue } from '../server/ai-schema.mjs';
import { parseReplyLimit, replyLimitControl } from '../web/ai-reply-limit.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('both mutation boundaries reject unlimited and out-of-range values without changing the separate warning threshold', () => {
  for (const value of ['unlimited', 0, 2001, 99999, 100000, 1.1]) {
    assert.throws(() => replyLimitValue(value), /2000/);
    assert.throws(() => parseReplyLimit(value), /2000/);
  }
  for (const value of [1, 50, 2000]) assert.equal(replyLimitValue(value), parseReplyLimit(String(value)));
  const legacy = replyLimitControl('unlimited', 'test-limit');
  assert.match(legacy, /旧上限：不限/); assert.match(legacy, /name="maxRounds" value="unlimited"/);
  assert.doesNotMatch(legacy, /option value="unlimited"/);
});

for (const kind of ['person', 'group']) for (const limit of ['unlimited', 2001, 99999]) {
  test(`${kind} legacy ${limit} survives restart and unrelated save; no generation/delivery until explicit valid save`, async t => {
    const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
    bridge.contacts[0].kind = kind; bridge.stableMessageIds = true;
    const options = { dataRoot: root, bridge, provider, now: () => 1800000000000, delay: async () => {} };
    const a = new AIAssistant(options); await a.init();
    let restarted;
    t.after(async () => { await restarted?.close(); await a.close(); await cleanup(root); });
    await a.configure(modelConfig); await a.scan();
    if (kind === 'person') await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
    else await a.setGroupOptions({ contact: bridge.contacts[0].id, atMe: true });
    await a.settings({ enabled: true, autoLearning: false });
    const profile = a.profiles()[0];
    assert.equal(a.canDeliver(profile, 'reply', a.revision, a.controller.signal), true, 'Fixture has an active deliverable target before migration');
    profile.replyStrategy = { ...profile.replyStrategy, maxRounds: limit }; profile.rounds = 13;
    await a.save(); await a.close();
    restarted = new AIAssistant(options); await restarted.init(); await restarted.scan();
    const old = restarted.profiles()[0], calls = provider.calls.length;
    assert.equal(old.replyStrategy.maxRounds, limit); assert.equal(old.rounds, 13);
    assert.equal(restarted.publicState().profiles[0].replyLimitNeedsReview, true);
    assert.equal(restarted.canDeliver(old, 'reply', restarted.revision, restarted.controller.signal), false);
    await restarted.settings({ acknowledgeAI: true });
    assert.equal(old.replyStrategy.maxRounds, limit); assert.equal(old.rounds, 13);
    bridge.push(old.contact, 'other', '迁移边界测试'); await restarted.tick();
    assert.equal(provider.calls.length, calls); assert.equal(bridge.sent.length, 0);
    await restarted.saveReplyProfile({ contact: old.contact, style: restarted.publicState().schema.defaultStyle, strategy: { maxRounds: 2000 }, preserveSwitches: true });
    assert.equal(old.replyStrategy.maxRounds, 2000); assert.equal(old.rounds, 13, 'Ordinary strategy save does not reset already-confirmed sends');
    assert.equal(restarted.publicState().profiles[0].replyLimitNeedsReview, false);
    assert.equal(restarted.canDeliver(old, 'reply', restarted.revision, restarted.controller.signal), true);
  });
}

test('invalid inherited type and global limits are preserved instead of falling back to 50', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan(); await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true }); await a.settings({ enabled: true });
  const p = a.profiles()[0]; delete p.replyStrategy;
  a.data.replyRoundLimits.person = 'unlimited';
  assert.equal(a.strategy(p, 'reply').maxRounds, 'unlimited');
  assert.equal(a.canDeliver(p, 'reply', a.revision, a.controller.signal), false);
  a.data.replyRoundLimits.person = null; a.data.replyStrategy.maxRounds = 99999;
  assert.equal(a.strategy(p, 'reply').maxRounds, 99999);
  assert.equal(a.canDeliver(p, 'reply', a.revision, a.controller.signal), false);
  await a.configuration({ type: 'global-reply-strategy', strategy: { ...a.globalReplyStrategy(), replyGoal: '只更新要求，不确认上限' } });
  assert.equal(a.globalReplyStrategy().maxRounds, 99999);
  assert.equal(a.canDeliver(p, 'reply', a.revision, a.controller.signal), false);
  await assert.rejects(a.configuration({ type: 'global-reply-strategy', strategy: { ...a.globalReplyStrategy(), maxRounds: 'unlimited' } }), /2000/);
});
