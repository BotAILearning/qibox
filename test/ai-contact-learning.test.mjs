import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { defaultStyle } from '../server/ai-schema.mjs';
import { replyPresets } from '../server/ai-presets.mjs';
import { AIModelFixture, ChatFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, count = 3, { configured = true } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.contacts = Array.from({ length: count }, (_, i) => ({ id: key(`batch-${i}`), label: `联系人${i}`, kind: 'person' }));
  bridge.messages = new Map(bridge.contacts.map((c, i) => [c.id, [
    { id: `other-${i}`, direction: 'other', text: `对方-${i}` }, { id: `self-${i}`, direction: 'self', text: `本人-${i}` },
  ]]));
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  if (configured) { await a.configure(modelConfig); await a.testProvider(); }
  await a.scan();
  return { a, bridge, provider, root, contacts: bridge.contacts.map(c => c.id) };
}

test('automatic contact fetching stops after the first successful scan but manual refresh remains available', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let scans = 0;
  const scan = bridge.scan.bind(bridge);
  bridge.scan = async (...args) => { scans++; return scan(...args); };
  const a = new AIAssistant({ dataRoot: root, bridge, provider });
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.init(); await a.configure(modelConfig); await a.settings({ enabled: true });
  await a.tick();
  assert.equal(scans, 1);
  assert.equal(a.publicState().contactScanCompleted, true);
  bridge.contacts.push({ id: key('new-contact'), label: '新联系人', kind: 'person' });
  a.available = false;
  await a.tick();
  assert.equal(scans, 1);
  await a.scan();
  assert.equal(scans, 2);
  assert.equal(a.contacts.has(key('new-contact')), true);
});

test('ten selected contacts use one bounded model request and keyed results preserve correspondence', async t => {
  const { a, bridge, provider, root, contacts } = await fixture(t, 12);
  let reads = 0; const read = bridge.read.bind(bridge);
  bridge.read = async value => { reads++; return read(value); };
  provider.next = async input => ({ profiles: input.conversations.map(({ contact }, i) => ({ contact, style: { ...defaultStyle, warmth: i % 2 ? '克制' : '亲切' } })).reverse() });
  await a.learn({ contacts: contacts.slice(0, 10) });
  assert.equal(reads, 10); assert.equal(provider.calls.length, 1);
  const { input, system } = provider.calls[0];
  assert.equal(input.styleOwner, 'self'); assert.match(system, /不能混用不同联系人的关系和风格/);
  assert.deepEqual(input.conversations.map(c => c.contact), contacts.slice(0, 10));
  for (const [i, conversation] of input.conversations.entries()) {
    assert.deepEqual(conversation.material, [{ direction: 'other', text: `对方-${i}`, timestamp: null }, { direction: 'self', text: `本人-${i}`, timestamp: null }]);
    assert.equal(a.profiles().find(p => p.contact === conversation.contact).style.warmth, i % 2 ? '克制' : '亲切');
  }
  assert.equal(a.profiles().length, 10); assert.equal(a.operation, null); assert.equal(bridge.sent.length, 0);
  const saved = await readFile(path.join(root, 'ai-assistant.json'), 'utf8');
  assert.equal(/本人-|对方-/.test(saved), false); assert.deepEqual(a.data.replyTargets, []);
});

test('an eleventh distinct contact is rejected before reading or calling the model', async t => {
  const { a, bridge, provider, contacts } = await fixture(t, 11);
  bridge.read = async () => assert.fail('oversized batch read chats');
  await assert.rejects(a.learn({ contacts }), /最多学习 10/);
  assert.equal(provider.calls.length, 0); assert.equal(a.operation, null);
});

test('duplicate selections are deduplicated and an individual contact can learn alone', async t => {
  const { a, provider, contacts } = await fixture(t);
  await a.learn({ contacts: Array(12).fill(contacts[0]) });
  assert.equal(provider.calls.length, 1); assert.ok(provider.calls[0].input.material);
  assert.equal(a.profiles().length, 1); assert.equal(a.profiles()[0].contact, contacts[0]);
});

for (const variant of ['missing', 'duplicate', 'unknown', 'invalid-style']) test(`invalid batch result ${variant} cannot partially apply styles`, async t => {
  const { a, provider, contacts } = await fixture(t);
  await a.learn({ contacts: [contacts[0]] });
  const before = structuredClone(a.data.profiles);
  provider.next = async input => {
    const profiles = input.conversations.map(({ contact }) => ({ contact, style: { ...defaultStyle, warmth: '克制' } }));
    if (variant === 'missing') profiles.pop();
    if (variant === 'duplicate') profiles[1].contact = profiles[0].contact;
    if (variant === 'unknown') profiles[1].contact = key('not-selected');
    if (variant === 'invalid-style') profiles[1].style = { category: 'made-up' };
    return { profiles };
  };
  await assert.rejects(a.learn({ contacts }));
  assert.deepEqual(a.data.profiles, before); assert.equal(a.operation, null);
});

test('batch learning retains each contact manual corrections and reply strategy', async t => {
  const { a, contacts } = await fixture(t);
  await a.learn({ contacts }); const first = a.profiles()[0];
  await a.editProfile(first.id, { style: { ...first.style, warmth: '克制', customTone: '简洁直接' } });
  await a.saveStrategy(strategy, first.id, 'reply');
  await a.learn({ contacts });
  assert.equal(a.profile(first.id).style.warmth, '克制'); assert.equal(a.profile(first.id).style.customTone, '简洁直接');
  assert.equal(a.profile(first.id).replyStrategy.replyGoal, strategy.replyGoal);
});

test('large multi-contact histories are limited to recent whole messages before the one model request', async t => {
  const { a, bridge, provider, contacts } = await fixture(t, 10);
  for (const c of contacts) bridge.messages.set(c, Array.from({ length: 80 }, (_, i) => ({ id: `${c}-${i}`, direction: i % 2 ? 'self' : 'other', text: `${i}:` + '正文'.repeat(400) })));
  await a.learn({ contacts });
  const input = provider.calls[0].input;
  assert.ok(JSON.stringify(input).length < 90000);
  assert.ok(input.conversations.every(c => c.material.length < 80 && c.material.at(-1).text.startsWith('79:') && c.material.some(m => m.direction === 'self')));
});

test('cancellation during chat reading prevents a later model request', async t => {
  const { a, bridge, provider, contacts } = await fixture(t);
  const read = bridge.read.bind(bridge), entered = Promise.withResolvers(), release = Promise.withResolvers();
  bridge.read = async args => { const snapshot = await read(args); entered.resolve(); await release.promise; return snapshot; };
  const work = a.learn({ contacts }); const rejected = assert.rejects(work);
  await entered.promise; await a.cancel(); release.resolve(); await rejected;
  assert.equal(provider.calls.length, 0); assert.equal(a.profiles().length, 0); assert.equal(a.operation, null);
});

test('cancellation during the merged model request discards every result', async t => {
  const { a, provider, contacts } = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  provider.next = async input => { entered.resolve(); await release.promise; return { profiles: input.conversations.map(({ contact }) => ({ contact, style: defaultStyle })) }; };
  const work = a.learn({ contacts }); const rejected = assert.rejects(work);
  await entered.promise; assert.equal(a.operation.phase, 'model'); await a.cancel(); release.resolve(); await rejected;
  assert.equal(a.profiles().length, 0); assert.equal(a.operation, null);
});

test('failed or invalid rescans cannot leave previously loaded contacts selectable', async t => {
  const { a, bridge, contacts } = await fixture(t);
  bridge.scan = async () => ({ available: false }); await assert.rejects(a.scan(), /获取联系人/);
  assert.equal(a.available, false); assert.deepEqual(a.publicState().contacts, []);
  await assert.rejects(a.prepareTargets({ contacts }));
  bridge.scan = async () => { throw new Error('disconnected'); };
  await assert.rejects(a.scan(), /disconnected/); assert.equal(a.contacts.size, 0);
  bridge.scan = async () => ({ available: true, account: bridge.account, contacts: [bridge.contacts[0], { id: 'invalid' }] });
  await assert.rejects(a.scan()); assert.equal(a.contacts.size, 0);
});

test('proactive target preparation accepts groups without enabling automatic group replies', async t => {
  const { a, bridge, contacts } = await fixture(t);
  bridge.contacts[0].kind = 'group'; await a.scan();
  await a.prepareTargets({ contacts: [contacts[0]] });
  assert.equal(a.replySelected(a.profiles()[0]), false);
  await a.learn({ contacts: [contacts[0]] });
  await a.prepareTargets({ contacts: contacts.slice(1) });
  assert.deepEqual(a.data.proactiveTargets.map(id => a.profile(id).contact), contacts.slice(1));
  assert.deepEqual(a.data.replyTargets, []); assert.equal(bridge.sent.length, 0);
});

test('manual reply selection is saved without a model, chat reading, learning or sending', async t => {
  const { a, bridge, provider, contacts } = await fixture(t, 3, { configured: false });
  bridge.read = () => assert.fail('manual strategy selection must not read chat');
  const preset = replyPresets[1];
  const result = await a.saveReplyProfile({ contact: contacts[0], style: preset.style, strategy: preset.strategy });
  const profile = result.profiles[0];
  assert.equal(profile.source, 'manual'); assert.equal(profile.learnedAt, null); assert.ok(profile.replyConfiguredAt);
  assert.deepEqual(profile.style, preset.style); assert.equal(profile.replyStrategy.replyGoal, preset.strategy.replyGoal);
  assert.deepEqual(result.replyTargets, [profile.id]); assert.deepEqual(result.proactiveTargets, []);
  assert.equal(result.settings.enabled, false); assert.equal(result.settings.reply, true);
  assert.equal(provider.calls.length, 0); assert.equal(bridge.sent.length, 0);
  await assert.rejects(a.settings({ enabled: true }), /配置模型/);
});

test('a reply profile stays off until its per-contact switch is saved on', async t => {
  const { a, bridge, contacts } = await fixture(t, 1);
  const off = await a.saveReplyProfile({ contact: contacts[0], ...replyPresets[0], preserveSwitches: true, replyEnabled: false });
  const profile = a.profiles()[0];
  assert.equal(profile.replyOptions.enabled, false); assert.deepEqual(off.replyTargets, []);
  const on = await a.saveReplyProfile({ contact: contacts[0], ...replyPresets[0], preserveSwitches: true, replyEnabled: true });
  assert.equal(on.replyTargets[0], profile.id); assert.equal(a.replySelected(profile), true);
});

test('saving the auto-reply switch does not require reading chat history', async t => {
  const { a, bridge, contacts } = await fixture(t, 1);
  bridge.read = async () => { throw new Error('chat history unavailable'); };
  const result = await a.saveReplyProfile({ contact: contacts[0], ...replyPresets[0], preserveSwitches: true, replyEnabled: true });
  const profile = result.profiles[0];
  assert.equal(profile.replyOptions.enabled, true);
  assert.deepEqual(result.replyTargets, [profile.id]);
});

test('saving reply switches directly does not require reading chat history', async t => {
  const { a, bridge, contacts } = await fixture(t, 1);
  bridge.read = async () => { throw new Error('chat history unavailable'); };
  const result = await a.setReplyOptions({ contact: contacts[0], enabled: true });
  const profile = result.profiles[0];
  assert.equal(profile.replyOptions.enabled, true);
  assert.deepEqual(result.replyTargets, [profile.id]);
});

test('manual reply profiles can auto reply without ever learning and preserve separate proactive settings', async t => {
  const { a, bridge, provider, contacts } = await fixture(t);
  let now = Date.now(); a.now = () => now;
  await a.prepareTargets({ contacts: [contacts[1]] }); await a.saveStrategy(strategy);
  const proactive = structuredClone(a.data.strategy), proactiveTargets = [...a.data.proactiveTargets];
  await a.saveReplyProfile({ contact: contacts[0], ...replyPresets[2] });
  const profile = a.profiles().find(p => p.contact === contacts[0]);
  assert.equal(a.prerequisites('reply'), '');
  await a.settings({ enabled: true }); await a.tick(); assert.equal(bridge.sent.length, 0);
  bridge.push(contacts[0], 'other', '你好，请说明具体步骤'); await a.tick(); now += 9000; await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(bridge.sent[0].contact, contacts[0]);
  assert.deepEqual(provider.calls[0].input.style, replyPresets[2].style);
  assert.equal(provider.calls[0].input.strategy.replyGoal, replyPresets[2].strategy.replyGoal);
  assert.equal(profile.learnedAt, null); assert.deepEqual(a.data.strategy, proactive); assert.deepEqual(a.data.proactiveTargets, proactiveTargets);
});

test('manual strategy changes retain all other contacts and survive restart after a fresh contact scan', async t => {
  const { a, bridge, provider, root, contacts } = await fixture(t);
  await a.learn({ contacts: [contacts[0]] }); await a.saveStrategy(strategy, a.profiles()[0].id, 'reply'); await a.targets([a.profiles()[0].id], 'reply');
  const learned = structuredClone(a.profiles()[0]);
  await a.saveReplyProfile({ contact: contacts[1], ...replyPresets[0] });
  await a.saveReplyProfile({ contact: contacts[2], ...replyPresets[1] });
  await a.saveReplyProfile({ contact: contacts[1], ...replyPresets[3] });
  assert.deepEqual(a.profile(learned.id), learned); assert.equal(a.data.replyTargets.length, 3);
  const restarted = new AIAssistant({ dataRoot: root, bridge, provider }); await restarted.init();
  try {
    assert.equal(restarted.data.settings.enabled, false); await restarted.scan();
    assert.equal(restarted.prerequisites('reply'), '');
    assert.equal(restarted.profiles().find(p => p.contact === contacts[1]).style.length, '详细');
  } finally { await restarted.close(); }
});

test('manual configuration rejects stale contacts and malformed styles, and preserves disabled group triggers', async t => {
  const { a, bridge, contacts } = await fixture(t);
  await a.saveReplyProfile({ contact: contacts[0], ...replyPresets[0] });
  const before = structuredClone(a.data);
  for (const value of [{ contact: key('not-listed'), ...replyPresets[0] }, { contact: contacts[1], style: {}, strategy }]) await assert.rejects(a.saveReplyProfile(value));
  assert.deepEqual(a.data, before);
  bridge.contacts[1].kind = 'group'; await a.scan();
  await a.saveReplyProfile({ contact: contacts[1], ...replyPresets[0] });
  assert.equal(a.replySelected(a.profiles().find(p => p.contact === contacts[1])), false);
  a.available = false; await assert.rejects(a.saveReplyProfile({ contact: contacts[0], ...replyPresets[0] }));
});

for (const reason of ['manual', 'handoff', 'uncertain']) test(`changing a manual reply strategy preserves existing ${reason} takeover until explicitly resumed`, async t => {
  const { a, contacts } = await fixture(t);
  await a.saveReplyProfile({ contact: contacts[0], ...replyPresets[0] });
  const profile = a.profiles()[0]; profile.paused = true; profile.rounds = 3;
  if (reason === 'handoff') profile.handoffReason = 'external';
  if (reason === 'uncertain') profile.delivery = { status: 'uncertain' };
  await a.saveReplyProfile({ contact: contacts[0], ...replyPresets[1] });
  const updated = a.profile(profile.id);
  assert.equal(updated.paused, true); assert.equal(updated.rounds, 3);
  assert.equal(updated.handoffReason, profile.handoffReason); assert.deepEqual(updated.delivery, profile.delivery);
  // uncertain 只是【待核验】标记，不再阻断手动恢复；handoff 仍需核对后恢复。
  if (reason !== 'handoff') await a.editProfile(updated.id, { style: updated.style, paused: false });
  else { await assert.rejects(a.editProfile(updated.id, { style: updated.style, paused: false }), /先核对/); const view = await a.review(updated.id); await a.review(updated.id, { resolve: true, revision: view.revision }); }
  assert.equal(a.profile(profile.id).paused, false); assert.equal(a.profile(profile.id).rounds, 0);
});

test('contact scan progress is observable, contains no chat data and disappears on cancellation', async t => {
  const { a, bridge } = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  bridge.scan = async ({ onProgress }) => { onProgress({ completed: 2, total: 7 }); entered.resolve(); await release.promise; return { available: true, account: bridge.account, contacts: bridge.contacts }; };
  const work = a.scan(); const rejected = assert.rejects(work, /取消/);
  await entered.promise; assert.deepEqual(a.publicState().operation, { phase: 'contacts', completed: 2, total: 7 });
  await a.cancel(); assert.equal(a.publicState().operation, null); release.resolve(); await rejected;
  assert.equal(a.available, true); assert.equal(a.contacts.size, bridge.contacts.length);
});

test('an output budget is reserved for ten separate styles and for single-message replies', async () => {
  const bodies = [], provider = new AIProvider({ fetcher: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ content: [{ type: 'text', text: '{"profiles":[]}' }], stop_reason: 'end_turn' });
  } });
  const config = { ...modelConfig, protocol: 'anthropic' };
  await provider.complete(config, 'test', { conversations: Array.from({ length: 10 }, (_, i) => ({ contact: key(String(i)), material: [] })) });
  await provider.complete(config, 'test', { material: [] });
  assert.equal(bodies[0].max_tokens, 16384); assert.equal(bodies[1].max_tokens, 8192);
});
