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
  else await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
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
  let calls=0;provider.complete=async(config,system,input)=>{calls++;assert.equal(input.capabilityConcern,'voice');return {action:'skip'};};
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(calls, failure === 'stale' ? 0 : 2);
  if (failure === 'stale') assert.equal(!!p.paused, false);
  else { assert.equal(p.paused, false); assert.equal(a.publicState().skipRecords.length,0);assert.ok(a.publicState().events.some(e=>e.code==='error')); }
});

test('a manual reply during conversion cancels the older voice reply', async t => {
  const { a, bridge, contact, p } = await fixture(t);
  bridge.transcribe = async () => { bridge.push(contact, 'self', '我已经回复了'); return { text: '周六？', source: 'wechat' }; };
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(p.pauseReason, undefined);
  assert.equal(p.manualWait.ownId, bridge.messages.get(contact).at(-1).id);
});

test('two pending WeChat voice transcripts reach the model together beside explicitly unreadable old voice placeholders', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000;
  const contact = bridge.contacts[0].id;
  const oldVoice = Object.assign(bridge.push(contact, 'other', '[语音]'), { type: 'voice' });
  bridge.push(contact, 'self', '听不到语音，转文字没成功，能打字再说一遍吗');
  Object.assign(bridge.push(contact, 'self', '[语音]'), { type: 'voice' });
  Object.assign(bridge.push(contact, 'self', '[语音]'), { type: 'voice' });
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.scan();
  await a.setReplyOptions({ contact, enabled: true }); await a.settings({ enabled: true }); await a.tick();
  t.after(async () => { await a.close(); await cleanup(root); });

  const first = Object.assign(bridge.push(contact, 'other', '[语音]'), { type: 'voice' });
  const second = Object.assign(bridge.push(contact, 'other', '[语音]'), { type: 'voice' });
  const transcripts = new Map([
    [first.id, '这次测试的四位数字是7、6、2、4，先记住下一条语音会提问。'],
    [second.id, '刚才告诉你的4位数字是什么？请只回复这4个数字。']
  ]);
  const converted = [];
  bridge.transcribe = async ({ messageId }) => { converted.push(messageId); return { text: transcripts.get(messageId), source: 'wechat' }; };
  provider.next = async input => {
    const old = input.messages.find(message => message.id === oldVoice.id);
    assert.equal(old.unresolved, true);
    const one = input.messages.find(message => message.id === first.id);
    const two = input.messages.find(message => message.id === second.id);
    assert.equal(one.text, transcripts.get(first.id)); assert.equal(one.transcriptionSource, 'wechat'); assert.equal(one.unresolved, undefined);
    assert.equal(two.text, transcripts.get(second.id)); assert.equal(two.transcriptionSource, 'wechat'); assert.equal(two.unresolved, undefined);
    assert.deepEqual(input.conversation.pendingIncomingIds, [first.id, second.id]);
    assert.equal(input.capabilityConcern, null);
    assert.match(provider.calls.at(-1).system, /transcriptionSource=wechat/);
    return { action: 'send', text: '7624' };
  };
  await a.tick(); now += 10000; await a.tick();
  assert.deepEqual(converted, [first.id, second.id]);
  assert.deepEqual(bridge.sent.map(message => message.text), ['7624']);
});
