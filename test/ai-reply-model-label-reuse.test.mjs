import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AIAssistant } from '../server/ai-service.mjs';
import { providerFingerprint } from '../server/ai-provider.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const oldKey = (a, profile, version) => {
  // Frozen v1/v2 protocol: the full model object, including display fields and
  // its original key order, was hashed before the surrounding material.
  const material = { ...a.preparedReplyKeyMaterial(profile, a.strategy(profile, 'reply')), model: providerFingerprint(a.modelFor('chat')) };
  return hash(version === 2 ? canonical(material) : material);
};
const notSent = { status: 'not-sent', diagnostic: { phase: 'native-prepare', code: 'fixture-label-reuse' } };

async function fixture(t) {
  const root = await temp(), provider = new AIModelFixture(), bridge = new ChatFixture(); bridge.stableMessageIds = true;
  let now = Date.parse('2026-10-22T10:00:00+08:00'), a;
  const create = async () => { a = new AIAssistant({ dataRoot: root, provider, bridge, now: () => now, delay: async () => {}, random: min => min }); await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer); };
  await create();
  const model = { ...modelConfig, id: 'label-review-model', label: 'Before display label' };
  await a.saveModels({ models: [model], assignments: { chat: model.id, learningAnalysis: model.id } }); await a.scan();
  const contact = bridge.contacts[0].id;
  await a.setReplyOptions({ contact, enabled: true, judgeReply: false }); await a.settings({ enabled: true, autoLearning: false }); await a.tick();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { get a() { return a; }, get p() { return a.profiles().find(row => row.contact === contact); }, bridge, provider, model,
    advance: ms => { now += ms; },
    async incoming(text = 'Synthetic request for a short reply') { const message = bridge.push(contact, 'other', text); message.timestamp = Math.floor(now / 1000); await a.tick(); },
    async prepare() { await this.incoming(); bridge.send = () => notSent; provider.next = async () => ({ action: 'send', text: 'Reuse this exact generated answer.' }); this.advance(20000); await a.tick(); assert.equal(provider.calls.length, 1); assert.equal(this.p.preparedReply.state, 'retry'); },
    async rename(label = 'After display label') { await a.saveModels({ models: [{ ...model, label }], assignments: { chat: model.id, learningAnalysis: model.id } }); },
    async restart() { await a.close(); await create(); await a.scan(); },
  };
}

for (const restart of [false, true]) test(`label-only save ${restart ? 'and restart' : 'without restart'} reuses the actual definite-not-sent answer`, async t => {
  const f = await fixture(t), send = f.bridge.send.bind(f.bridge); await f.prepare();
  const before = structuredClone(f.p.preparedReply), revision = f.a.revision;
  await f.rename(); assert.equal(f.a.revision, revision, 'A display-label edit does not change the effective model');
  assert.deepEqual(f.p.preparedReply, before);
  if (restart) await f.restart();
  f.bridge.send = send; f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1, 'Changing the display label must not buy another model generation');
  assert.deepEqual(f.bridge.sent.map(row => row.text), ['Reuse this exact generated answer.']);
});

test('equivalent provider key reordering reuses the actual answer without another generation', async t => {
  const f = await fixture(t), send = f.bridge.send.bind(f.bridge); await f.prepare();
  const retryStartedAt = f.p.preparedReply.retryStartedAt;
  f.a.models[0] = Object.fromEntries(Object.entries(f.a.models[0]).reverse());
  f.bridge.send = send; f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.deepEqual(f.bridge.sent.map(row => row.text), ['Reuse this exact generated answer.']);
  assert.equal(f.p.delivery.timing.completedAt, retryStartedAt + 30000);
});

for (const version of [2, undefined]) test(`exact ${version === 2 ? 'canonical v2' : 'unversioned v1'} answer upgrades safely without another generation or a new retry window`, async t => {
  const f = await fixture(t), send = f.bridge.send.bind(f.bridge); await f.prepare();
  const row = f.p.preparedReply, createdAt = row.createdAt, retryStartedAt = row.retryStartedAt;
  row.key = oldKey(f.a, f.p, version); if (version === undefined) delete row.keyVersion; else row.keyVersion = version;
  await f.a.save(); if (version === 2) await f.restart();
  let submitted;
  f.bridge.send = request => { const cache = f.p.preparedReply; submitted = { version: cache.keyVersion, createdAt: cache.createdAt, retryStartedAt: cache.retryStartedAt }; return send(request); };
  f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.deepEqual(f.bridge.sent.map(item => item.text), ['Reuse this exact generated answer.']);
  assert.deepEqual(submitted, { version: 3, createdAt, retryStartedAt });
  assert.equal(row.createdAt, createdAt); assert.equal(row.retryStartedAt, retryStartedAt);
});

for (const version of [2, undefined]) test(`unverifiable ${version === 2 ? 'v2' : 'v1'} same-context answer retires without replay or regeneration, then handles a new incoming message`, async t => {
  const f = await fixture(t), send = f.bridge.send.bind(f.bridge); await f.prepare();
  f.p.preparedReply.key = 'old-signature-cannot-be-authenticated'; if (version === undefined) delete f.p.preparedReply.keyVersion; else f.p.preparedReply.keyVersion = version;
  f.bridge.send = send; f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0); assert.equal(f.p.preparedReply, undefined);
  assert.ok(f.a.data.errorLog.some(event => event.context?.errorCode === 'ai_reply_cache_unverified'));
  f.provider.next = async () => ({ action: 'send', text: 'Only for the new incoming message.' });
  await f.incoming('A different synthetic incoming question'); f.advance(20000); await f.a.tick();
  assert.equal(f.provider.calls.length, 2); assert.deepEqual(f.bridge.sent.map(row => row.text), ['Only for the new incoming message.']);
});

test('an older v2 answer whose original label cannot be authenticated never regenerates the same incoming message', async t => {
  const f = await fixture(t), send = f.bridge.send.bind(f.bridge); await f.prepare();
  f.p.preparedReply.key = oldKey(f.a, f.p, 2); f.p.preparedReply.keyVersion = 2;
  await f.rename(); f.bridge.send = send; f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0);
  assert.ok(f.a.data.errorLog.some(event => event.context?.errorCode === 'ai_reply_cache_unverified'));
});

test('prepared model signature ignores id, label and object key order but includes every effective provider field', async t => {
  const f = await fixture(t), strategy = f.a.strategy(f.p, 'reply'), original = f.a.models[0];
  const before = f.a.preparedReplyKey(f.p, strategy);
  f.a.models[0] = Object.fromEntries(Object.entries({ ...original, id: 'presentation-id-only', label: 'Presentation label only' }).reverse());
  assert.equal(f.a.preparedReplyKey(f.p, strategy), before, 'Equivalent provider parameters have the same cache signature');
  const variants = { apiKey: 'different-fixture-key', baseUrl: 'https://different.example.test/v1', model: 'different-fixture-model', timeout: 60, consent: false, protocol: 'anthropic' };
  for (const [field, value] of Object.entries(variants)) {
    f.a.models[0] = { ...original, [field]: value };
    assert.notEqual(f.a.preparedReplyKey(f.p, strategy), before, `Effective ${field} changes must never reuse a cache from the previous provider configuration`);
  }
  f.a.models[0] = original; assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});
