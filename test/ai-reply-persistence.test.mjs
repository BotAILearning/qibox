import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AppError } from '../server/files.mjs';
import { replyPresets } from '../server/ai-presets.mjs';
import { AIModelFixture, ChatFixture, modelConfig, learnedStyle } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true;
  let now = 1800000000000, ready = true;
  const options = { dataRoot: root, bridge, provider, now: () => now, ready: () => ready };
  const a = new AIAssistant(options); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  await a.saveReplyProfile({ contact: bridge.contacts[0].id, ...replyPresets[0] });
  const incoming = () => Object.assign(bridge.push(bridge.contacts[0].id, 'other'), { timestamp: Math.floor(now / 1000) });
  return { a, options, bridge, provider, incoming, advance: ms => now += ms, ready: value => ready = value };
}

test('first poll handles a message received after strategy configuration without replying to older history', async t => {
  const { a, bridge, incoming, advance } = await fixture(t);
  const profile = a.profiles()[0];
  const old = incoming(); old.timestamp -= 100;
  await a.settings({ enabled: true }); await a.tick(); advance(9000); await a.tick();
  assert.equal(bridge.sent.length, 0);
  a.cursors.clear(); advance(1000); incoming();
  await a.tick(); assert.equal(bridge.sent.length, 0);
  advance(9000); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(profile.rounds, 1);
  await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('refresh and strategy edits preserve enabled state and a pending reply uses the latest strategy once', async t => {
  const { a, bridge, provider, incoming, advance } = await fixture(t);
  await a.settings({ enabled: true }); await a.tick(); advance(1000); incoming(); await a.tick();
  const profile = a.profiles()[0]; assert.equal(a.cursors.get(profile.id).pending, true);
  await a.scan();
  await a.saveReplyProfile({ contact: profile.contact, ...replyPresets[1] });
  await a.editProfile(profile.id, { style: profile.style });
  await a.saveStrategy({ ...profile.replyStrategy, replyGoal: '最新回复目标' }, profile.id, 'reply');
  await a.targets([profile.id], 'reply');
  assert.equal(a.data.settings.enabled, true); assert.equal(a.cursors.get(profile.id).pending, true);
  advance(9000); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(provider.calls.at(-1).input.strategy.replyGoal, '最新回复目标');
  await a.scan(); await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('service restart restores the switch and pending cursor, verifies contacts, then never repeats a confirmed reply', async t => {
  const { a, options, bridge, incoming, advance, ready } = await fixture(t);
  await a.settings({ enabled: true }); await a.tick(); incoming(); await a.tick(); await a.close();
  ready(false);
  const restarted = new AIAssistant(options); await restarted.init();
  try {
    assert.equal(restarted.data.settings.enabled, true); await restarted.tick();
    assert.equal(restarted.data.settings.enabled, true); assert.equal(restarted.publicState().waiting, true); assert.equal(bridge.sent.length, 0);
    ready(true); await restarted.tick(); assert.equal(restarted.available, true); assert.equal(bridge.sent.length, 0);
    advance(9000); await restarted.tick(); assert.equal(bridge.sent.length, 1);
    await restarted.close();
    const again = new AIAssistant(options); await again.init();
    try { await again.tick(); await again.tick(); assert.equal(bridge.sent.length, 1); }
    finally { await again.close(); }
    const saved = await readFile(restarted.file, 'utf8');
    assert.doesNotMatch(saved, /CHAT_NEW_MARKER|CHAT_PRIVATE_MARKER|GENERATED_PRIVATE_MARKER/);
  } finally { await restarted.close(); }
});

test('a restart keeps the previous contact list usable without asking for a contact refresh', async t => {
  const { a, options, bridge } = await fixture(t);
  const labels = a.publicState().contacts.map(c => c.label);
  let scans = 0; const scan = bridge.scan.bind(bridge); bridge.scan = async (...args) => { scans++; return scan(...args); };
  await a.settings({ enabled: true }); await a.close();
  const restarted = new AIAssistant(options); await restarted.init();
  try {
    assert.deepEqual(restarted.publicState().contacts.map(c => c.label), labels);
    assert.equal(restarted.available, true);
    await restarted.tick();
    assert.equal(scans, 0);
  } finally { await restarted.close(); }
});

test('temporary data failure keeps the switch and pending reply while account changes disable it', async t => {
  const { a, bridge, incoming, advance } = await fixture(t);
  await a.settings({ enabled: true }); await a.tick(); incoming(); await a.tick();
  const read = bridge.read.bind(bridge);
  bridge.read = async () => { throw new AppError('暂时无法读取微信数据'); };
  advance(9000); await a.tick(); assert.equal(a.data.settings.enabled, true); assert.equal(a.available, true); assert.ok(a.profiles().some(p => p.readError));
  bridge.read = read; advance(30000); await a.tick(); await a.tick(); assert.equal(bridge.sent.length, 1);
  bridge.read = async () => { throw new AppError('微信账号已变化', 409, 'ai_account_changed'); };
  await a.tick(); assert.equal(a.data.settings.enabled, false); assert.equal(a.available, false);
});

test('a failed read-only send preparation retries the pending reply without pausing the contact', async t => {
  const { a, bridge, incoming, advance } = await fixture(t);
  await a.settings({ enabled: true }); await a.tick(); incoming(); await a.tick(); advance(9000);
  const send = bridge.send.bind(bridge); bridge.send = async () => ({ status: 'not-sent' });
  await a.tick(); const profile = a.profiles()[0];
  assert.equal(profile.paused, false); assert.equal(profile.delivery.status, 'cancelled');
  assert.equal(a.data.settings.enabled, true); assert.equal(a.publicState().waiting, true);
  assert.equal(a.cursors.get(profile.id).pending, true); assert.equal(bridge.sent.length, 0);
  bridge.send = send; advance(30000); await a.tick(); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(profile.paused, false);
  await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('learning while enabled pauses generation without changing the master preference', async t => {
  const { a, provider, bridge } = await fixture(t);
  await a.settings({ enabled: true });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  provider.next = async () => { entered.resolve(); await release.promise; return { style: learnedStyle(), memory: { entries: [] } }; };
  const learning = a.learn({ contacts: [bridge.contacts[0].id] }); await entered.promise;
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(a.data.settings.enabled, true);
  release.resolve(); await learning; assert.equal(a.data.settings.enabled, true);
});

test('turning the master off and back on does not retry an already skipped incoming message', async t => {
  const { a, provider, bridge, incoming, advance } = await fixture(t);
  await a.settings({ enabled: true }); await a.tick(); incoming(); await a.tick(); advance(9000);
  provider.next = async () => ({ action: 'skip' }); await a.tick();
  assert.equal(provider.calls.length, 1);
  await a.settings({ enabled: false }); await a.settings({ enabled: true }); await a.tick();
  assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 0);
});
