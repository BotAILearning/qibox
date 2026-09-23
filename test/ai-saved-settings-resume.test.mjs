import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true; bridge.contacts[0].kind = kind;
  let now = 1700000000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.scan(); await a.configure(modelConfig);
  if (kind === 'group') await a.setGroupOptions({ contact: bridge.contacts[0].id, atMe: true });
  else await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
  await a.settings({ enabled: true }); await a.tick();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { bridge, a, profile: () => a.profiles().find(p => p.contact === bridge.contacts[0].id) };
}

test('legacy pause migration clears only obsolete states and preserves explicit stops', async t => {
  const f = await fixture(t, 'person'), profile = f.profile();
  const legacy = { ...profile, paused: true, pauseReason: 'handoff', handoffReason: 'file', handoffMessageId: 'old-message' };
  assert.equal(f.a.dropLegacyPause(legacy), true);
  assert.equal(legacy.paused, false);
  for (const reason of ['explicit', 'limit', 'stop']) {
    const deliberate = { ...profile, paused: true, pauseReason: reason, manualPause: true };
    assert.equal(f.a.dropLegacyPause(deliberate), false, `${reason} is a deliberate pause`);
    assert.equal(deliberate.paused, true);
    assert.equal(f.a.resumeForSavedReply(deliberate), false, `${reason} survives saving settings`);
    assert.equal(deliberate.paused, true);
  }
});
// 复用真实暂停形态：交接需要本人处理时写入 handoffReason，普通暂停只写 pauseReason。
const pause = (profile, reason = 'handoff') => {
  profile.paused = true; profile.pauseReason = reason; profile.pausedAt = 1700000000000;
  if (reason === 'handoff') profile.handoffReason = 'file';
};

test('person: saving settings with auto reply on preserves handoff until explicit review', async t => {
  const f = await fixture(t, 'person'), contact = f.profile().contact;
  pause(f.profile());
  await f.a.saveReplyProfile({ contact, style: f.profile().style, styleId: 'custom', replyEnabled: true, strategy: {} });
  const saved = f.profile();
  assert.equal(saved.paused, true);
  assert.equal(saved.pauseReason, 'handoff');
  assert.equal(saved.handoffReason, 'file');
  assert.equal(f.a.replySelected(saved), true);
});

test('person: saving settings with auto reply off keeps paused', async t => {
  const f = await fixture(t, 'person'), contact = f.profile().contact;
  pause(f.profile(), 'explicit');
  await f.a.saveReplyProfile({ contact, style: f.profile().style, styleId: 'custom', replyEnabled: false, strategy: {} });
  assert.equal(f.profile().paused, true);
  assert.equal(f.profile().pauseReason, 'explicit');
});

test('person: saving only style or strategy does not resume a paused contact', async t => {
  const f = await fixture(t, 'person'), contact = f.profile().contact;
  pause(f.profile());
  await f.a.saveReplyProfile({ contact, style: f.profile().style, styleId: 'custom', preserveSwitches: true, strategy: {} });
  assert.equal(f.profile().paused, true);
});

test('group: saving settings with a reply trigger on preserves handoff until explicit review', async t => {
  const f = await fixture(t, 'group'), contact = f.profile().contact;
  pause(f.profile());
  await f.a.setGroupOptions({ contact, atMe: true, atAll: false, realtime: false });
  const saved = f.profile();
  assert.equal(saved.paused, true);
  assert.equal(saved.handoffReason, 'file');
  assert.equal(f.a.replySelected(saved), true);
});

test('group: saving settings with every reply trigger off keeps paused', async t => {
  const f = await fixture(t, 'group'), contact = f.profile().contact;
  pause(f.profile());
  await f.a.setGroupOptions({ contact, atMe: false, atAll: false, realtime: false });
  assert.equal(f.profile().paused, true);
});
