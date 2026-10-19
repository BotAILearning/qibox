import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, strategy } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const legacyTiming = { replyDelay: 24, replyMaxWait: 75, segmentDelayMin: 4, segmentDelayMax: 8, followUpDelayMin: 11, followUpDelayMax: 19 };
const customRhythm = {
  timing: { replyDelay: 31, replyMaxWait: 90, segmentDelayMin: 2, segmentDelayMax: 5, followUpDelayMin: 7, followUpDelayMax: 13 },
  takeover: { enabled: true, minutes: 9 }, segmentReplies: true, followUpEnabled: true,
};

async function fixture(t, { saved } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000;
  const options = { dataRoot: root, bridge, provider, now: () => now, delay: async () => {}, random: min => min };
  let a = new AIAssistant(options); await a.init(); await a.configure(modelConfig); await a.scan();
  await a.learn({ contacts: [bridge.contacts[0].id] });
  let profile = a.profiles().find(row => row.contact === bridge.contacts[0].id);
  await a.targets([profile.id]); await a.saveStrategy(strategy); await a.saveStrategy(strategy, undefined, 'reply');
  await a.setReplyOptions({ contact: profile.contact, enabled: true });
  if (saved) {
    Object.assign(a.data.settings, structuredClone(saved.settings));
    Object.assign(profile, structuredClone(saved.profile));
    await a.save(); await a.close();
    a = new AIAssistant(options); await a.init(); await a.scan();
    profile = a.profiles().find(row => row.contact === bridge.contacts[0].id);
  }
  t.after(async () => { await a.close(); await cleanup(root); });
  return { root, bridge, provider, options, get a() { return a; }, get profile() { return profile; }, now: () => now, advance: ms => { now += ms; } };
}

test('mixed legacy timing, takeover, and replyOptions.multiTurn read through unchanged across unrelated settings saves', async t => {
  const fixture0970 = JSON.parse(await readFile(new URL('./fixtures/upgrade-0.9.70.json', import.meta.url)));
  assert.equal(fixture0970.provenance.version, '0.9.70');
  const legacyProfile = fixture0970.before.profiles[Object.keys(fixture0970.before.profiles)[0]];
  const f = await fixture(t, { saved: {
    settings: structuredClone(fixture0970.before.settings),
    profile: { ...structuredClone(legacyProfile), timing: { replyDelay: 37, segmentDelayMin: 3 } },
  } });
  const { a, profile } = f;
  assert.deepEqual(a.publicState().settings.takeover, { enabled: true, minutes: 7 });
  assert.equal(a.data.settings.replyDelay, 20);
  assert.deepEqual(a.publicState().profiles.find(row => row.id === profile.id).effectiveTiming,
    { replyDelay: 37, replyMaxWait: 60, segmentDelayMin: 3, segmentDelayMax: 60, followUpDelayMin: 45, followUpDelayMax: 120 });
  assert.deepEqual(profile.takeover, { enabled: true, minutes: 9 });
  assert.equal(a.replyOptions(profile).multiTurn, false);

  const legacy = JSON.parse(await readFile(a.file, 'utf8'));
  await a.settings({ acknowledgeAI: true });
  await a.saveReplyProfile({ contact: profile.contact, style: profile.style, strategy, preserveSwitches: true });
  assert.deepEqual(JSON.parse(await readFile(a.file, 'utf8')).settings, { ...legacy.settings, acknowledgeAI: true });
  const persisted = JSON.parse(await readFile(a.file, 'utf8')).profiles[profile.id];
  assert.deepEqual(persisted.timing, legacy.profiles[profile.id].timing);
  assert.deepEqual(persisted.takeover, legacy.profiles[profile.id].takeover);
  assert.deepEqual(persisted.replyOptions, legacy.profiles[profile.id].replyOptions);
  assert.equal(persisted.rhythm, undefined, 'read-through and unrelated saves must not silently migrate the profile');
});

test('legacy profile with multiTurn false still permits split replies and makes no follow-up request', async t => {
  const f = await fixture(t, { saved: {
    settings: { ...legacyTiming, takeover: { enabled: true, minutes: 7 }, multiTurn: true },
    profile: { timing: { replyDelay: 20 }, takeover: { enabled: true, minutes: 9 }, replyOptions: { enabled: true, multiTurn: false, judgeReply: true } },
  } });
  const { a, bridge, provider, profile } = f;
  await a.settings({ enabled: true, reply: true });
  await a.tick();
  bridge.push(profile.contact, 'other', '请分成两句回复');
  provider.next = async input => ({ action: 'send', segments: ['第一段。', '第二段。'], followUp: true });
  const before = provider.calls.length;
  await a.tick(); f.advance(a.data.settings.replyDelay * 1000); await a.tick();
  assert.deepEqual(bridge.sent.map(row => row.text), ['第一段。', '第二段。']);
  assert.equal(provider.calls.length, before + 1);
  assert.equal(provider.calls.at(-1).input.multiTurn, false);
  assert.equal(provider.calls.at(-1).input.allowSegments, true);
  assert.equal(a.followUps.size, 0);
  const calls = provider.calls.length; f.advance(1000000); await a.tick();
  assert.equal(provider.calls.length, calls, 'multiTurn false must not create a later continuation request');
});

test('new rhythm values validate, switch inheritance without losing personal values, persist across restart, and save idempotently', async t => {
  const f = await fixture(t), { root, bridge, provider, options } = f;
  let { a, profile } = f;
  await a.settings({ replyDelay: 28, takeover: { enabled: true, minutes: 6 }, segmentReplies: false, followUpEnabled: false });
  const draft = { inherit: false, personal: structuredClone(customRhythm) };
  await a.saveReplyProfile({ contact: profile.contact, style: profile.style, strategy, preserveSwitches: true, rhythm: draft });
  assert.deepEqual(profile.rhythm, draft);
  assert.deepEqual(a.publicState().profiles.find(row => row.id === profile.id).effectiveTiming, customRhythm.timing);
  assert.deepEqual(a.publicState().profiles.find(row => row.id === profile.id).effectiveTakeover, customRhythm.takeover);

  const privateBefore = structuredClone(profile.rhythm.personal);
  await a.saveReplyProfile({ contact: profile.contact, style: profile.style, strategy, preserveSwitches: true,
    rhythm: { ...profile.rhythm, inherit: true } });
  assert.deepEqual(profile.rhythm.personal, privateBefore);
  assert.deepEqual(a.publicState().profiles.find(row => row.id === profile.id).effectiveTiming, {
    replyDelay: 28, replyMaxWait: 60, segmentDelayMin: 15, segmentDelayMax: 60, followUpDelayMin: 45, followUpDelayMax: 120,
  });
  await a.saveReplyProfile({ contact: profile.contact, style: profile.style, strategy, preserveSwitches: true,
    rhythm: { ...profile.rhythm, inherit: false } });
  assert.deepEqual(profile.rhythm.personal, privateBefore);

  await assert.rejects(a.settings({ replyMaxWait: 0 }), /等待时间|最长等待/);
  await assert.rejects(a.saveReplyProfile({ contact: profile.contact, style: profile.style, strategy, preserveSwitches: true,
    rhythm: { inherit: false, personal: { ...customRhythm, timing: { ...customRhythm.timing, segmentDelayMin: 99 } } } }));
  const savedRhythm = structuredClone(profile.rhythm);
  await a.saveReplyProfile({ contact: profile.contact, style: profile.style, strategy, preserveSwitches: true, rhythm: profile.rhythm });
  assert.deepEqual(profile.rhythm, savedRhythm, 'saving the same rhythm twice should preserve exactly the same rhythm');
  assert.deepEqual(JSON.parse(await readFile(a.file, 'utf8')).profiles[profile.id].rhythm, savedRhythm);

  await a.close(); a = new AIAssistant(options); await a.init();
  profile = a.profiles().find(row => row.contact === bridge.contacts[0].id);
  assert.deepEqual(profile.rhythm.personal, privateBefore);
  assert.equal(profile.rhythm.inherit, false);
  assert.deepEqual(a.publicState().profiles.find(row => row.id === profile.id).effectiveTiming, privateBefore.timing);
  await a.close();
});

test('enabled follow-up is a separate model request only after its configured delay', async t => {
  const f = await fixture(t), { a, bridge, provider, profile } = f;
  await a.settings({ enabled: true, reply: true, followUpDelayMin: 11, followUpDelayMax: 11, followUpEnabled: true });
  await a.tick();
  await a.saveReplyProfile({ contact: profile.contact, style: profile.style, strategy, preserveSwitches: true,
    rhythm: { inherit: false, personal: { ...customRhythm, timing: { ...customRhythm.timing, replyDelay: 20, followUpDelayMin: 11, followUpDelayMax: 11 }, followUpEnabled: true } } });
  bridge.push(profile.contact, 'other', '普通回复后安排续聊');
  provider.next = async () => ({ action: 'send', text: '第一轮。', followUp: true });
  const before = provider.calls.length;
  await a.tick(); f.advance(profile.rhythm.personal.timing.replyDelay * 1000); await a.tick();
  assert.equal(provider.calls.length, before + 1);
  assert.equal(a.followUps.size, 1);
  f.advance(10999); await a.tick(); assert.equal(provider.calls.length, before + 1);
  provider.next = async input => { assert.equal(input.followUp, true); return { action: 'send', text: '續聊。' }; };
  f.advance(1); await a.tick();
  assert.equal(provider.calls.length, before + 2);
  assert.equal(a.followUps.size, 0);
});
