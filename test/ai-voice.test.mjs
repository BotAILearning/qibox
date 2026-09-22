import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.contacts[0].kind = kind; let now = 1700000000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.scan();
  if (kind === 'group') await a.setGroupOptions({ contact: bridge.contacts[0].id, atMe: true });
  await a.settings({ enabled: true }); await a.tick();
  const contact = bridge.contacts[0].id, p = a.profiles().find(x => x.contact === contact);
  t.after(async () => { await a.close(); await cleanup(root); });
  const voice = Object.assign(bridge.push(contact, 'other', '[语音]'), { type: 'voice', mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); now += 10000;
  return { a, bridge, provider, contact, p, voice };
}

for (const kind of ['person', 'group']) test(`${kind}: WeChat conversion feeds text and original identity to the model, exactly one reply`, async t => {
  const { a, bridge, provider, voice } = await fixture(t, kind); let conversions = 0;
  bridge.transcribe = async request => { assert.equal(request.messageId, voice.id); conversions++; return { text: '周六下午三点可以吗？', source: 'wechat' }; };
  provider.next = async input => {
    assert.equal(input.messages.at(-1).id, voice.id); assert.equal(input.messages.at(-1).text, '周六下午三点可以吗？');
    assert.equal(input.messages.at(-1).transcriptionSource, 'wechat'); assert.equal(input.conversation.latestIncomingId, voice.id);
    return { action: 'send', text: '我确认后回复你。' };
  };
  await a.tick(); await a.tick();
  assert.equal(conversions, 1); assert.equal(bridge.sent.length, 1);
});

for (const failure of ['missing', 'empty', 'error', 'stale']) test(`voice ${failure} never produces a guessed reply or calls a separate ASR provider`, async t => {
  const { a, bridge, provider, p } = await fixture(t);
  if (failure !== 'missing') bridge.transcribe = async () => {
    if (failure === 'error') throw new Error('native unavailable');
    return failure === 'stale' ? { status: 'stale' } : { text: '', source: 'wechat' };
  };
  provider.next = async input => { assert.equal(input.capabilityConcern,'voice'); return {action:'handoff',reason:'voice'}; };
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(provider.calls.length, failure === 'stale' ? 0 : 1);
  if (failure === 'stale') assert.equal(!!p.paused, false);
  else { assert.equal(p.handoffReason, 'voice'); assert.equal(p.paused, true); }
});

test('a manual reply during conversion cancels the older voice reply', async t => {
  const { a, bridge, contact, p } = await fixture(t);
  bridge.transcribe = async () => { bridge.push(contact, 'self', '我已经回复了'); return { text: '周六？', source: 'wechat' }; };
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(p.pauseReason, 'manual');
});
