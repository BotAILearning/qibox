import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000;
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now });
  await assistant.init(); await assistant.configure(modelConfig); await assistant.scan();
  const contact = bridge.contacts[0].id;
  await assistant.setReplyOptions({ contact, enabled: true });
  await assistant.settings({ enabled: true }); await assistant.tick();
  t.after(async () => { await assistant.close(); await cleanup(root); });
  return { assistant, bridge, provider, contact, advance: ms => { now += ms; } };
}

test('reply records wait, context, model, send and confirmed delivery stages', async t => {
  const f = await fixture(t), modelEntered = gate(), modelRelease = gate(), sendEntered = gate(), sendRelease = gate();
  f.bridge.push(f.contact, 'other', '请回复'); await f.assistant.tick();
  assert.equal(f.assistant.liveStates().find(row => row.id === f.assistant.profiles()[0].id)?.phase, 'waiting');
  f.provider.next = async () => { modelEntered.open(); await modelRelease.promise; return { action: 'send', text: '测试回复' }; };
  const originalSend = f.bridge.send.bind(f.bridge);
  f.bridge.send = async request => { sendEntered.open(); await sendRelease.promise; return originalSend(request); };
  f.advance(20000); const running = f.assistant.tick();
  await modelEntered.promise;
  const profile = f.assistant.profiles()[0];
  assert.equal(profile.replyFlow.phase, 'requesting');
  assert.ok(profile.replyFlow.steps.summarizing);
  modelRelease.open(); await sendEntered.promise;
  assert.equal(profile.replyFlow.phase, 'sending');
  sendRelease.open(); await running;
  assert.equal(profile.replyFlow.phase, 'sent');
  assert.ok(profile.replyFlow.steps.sent >= profile.replyFlow.steps.sending);
  assert.equal(f.bridge.sent.length, 1);
});

test('unsubmitted reply is shown as failure while the incoming remains pending', async t => {
  const f = await fixture(t);
  f.bridge.push(f.contact, 'other', '请回复'); await f.assistant.tick();
  f.bridge.delivery = async () => ({ status: 'not-sent', diagnostic: { phase: 'native-prepare', code: 'controls-unavailable' } });
  f.advance(20000); await f.assistant.tick();
  const profile = f.assistant.profiles()[0];
  assert.equal(profile.replyFlow.phase, 'failed');
  assert.equal(f.assistant.cursors.get(profile.id).pending, true);
  assert.equal(profile.delivery.segmentsSent, 0);
  assert.deepEqual(profile.delivery.diagnostic, { phase: 'native-prepare', code: 'controls-unavailable' });
  assert.match(profile.replyFlow.detail, /准备微信输入区微信控件不可用/);
  assert.ok(f.assistant.liveStates().some(row => row.id === profile.id && row.reason === '发送失败，等待重试'));
});
