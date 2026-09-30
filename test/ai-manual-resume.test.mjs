import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true; bridge.contacts[0].kind = kind;
  let now = 1700000000000, a;
  const create = async () => {
    a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
    await a.init(); await a.scan(); return a;
  };
  await create(); await a.configure(modelConfig);
  if (kind === 'group') await a.setGroupOptions({ contact: bridge.contacts[0].id, atMe: true });
  else await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: true });
  await a.settings({ enabled: true }); await a.tick();
  const profile = () => a.profiles().find(p => p.contact === bridge.contacts[0].id);
  const push = (direction, text = 'text', contact = bridge.contacts[0].id, ts = Math.floor(now / 1000)) => Object.assign(bridge.push(contact, direction, text), {
    timestamp: ts, mentions: { verified: true, self: true, all: false, others: false },
  });
  t.after(async () => { await a.close(); await cleanup(root); });
  return { bridge, provider, profile, get a() { return a; }, push,
    advance(ms) { now += ms; a.lastScanAt = now; },
    async restart() { await a.close(); await create(); },
  };
}

for (const kind of ['person', 'group']) test(`${kind}: manual reply waits the configured interval before replying to new incoming`, async t => {
  const f = await fixture(t, kind);
  f.push('self', '我手动回一句'); await f.a.tick();
  assert.equal(f.profile().paused, false); assert.equal(f.profile().pauseReason, undefined);
  f.advance(1000); f.push('other', '那时间怎么安排？'); await f.a.tick();
  assert.equal(f.bridge.sent.length, 0); // 未到回复延迟
  f.advance(20000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 0);
  f.advance(297000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1);
  assert.equal(f.profile().paused, false);
});

test('model skip does not pause; later incoming messages are answered without review', async t => {
  const f = await fixture(t);
  f.provider.next = async () => ({ action: 'skip' });
  f.push('other', '发个文件给我'); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.profile().paused, false);
  assert.equal(f.a.publicState().skipRecords[0].source, 'model-skip');
  f.advance(1000); f.push('other', '收到谢谢'); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1); // 只回恢复后的新消息
});

test('skip records are not review items or verification tasks', async t => {
  const f = await fixture(t);
  f.provider.next = async () => ({ action: 'skip' });
  f.push('other', '发个文件'); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.profile().paused, false);
  assert.equal(f.a.publicState().skipRecords.length, 1);
});

test('manual reply does not resume an explicitly paused profile', async t => {
  const f = await fixture(t);
  f.a.pauseProfile(f.profile(), 'explicit');
  f.push('self', '手动回复'); await f.a.tick();
  assert.equal(f.profile().paused, true); assert.equal(f.profile().pauseReason, 'explicit');
});

test('manual reply resumes limit and stop, unknown delivery does not create a pause', async t => {
  const f = await fixture(t);
  for (const reason of ['limit', 'stop']) {
    f.a.pauseProfile(f.profile(), reason);
    f.push('self', reason); await f.a.tick();
    assert.equal(f.profile().paused, false, `${reason} 应被手动回复解除`);
  }
  f.profile().delivery = { status: 'unknown' };
  f.push('self', 'uncertain'); await f.a.tick();
  assert.equal(f.profile().paused, false); assert.equal(f.profile().pauseReason, undefined);
});

test('unknown proactive send keeps safe context for auto-reply after restart without a review pause', async t => {
  const f = await fixture(t), profile = f.profile();
  const task = { id: 'proactive-test', name: '测试任务', taskType: 'custom', goal: '自然问候', requirements: '不重复已发内容' };
  f.a.recordUncertainProactive(profile, task, '可能已发出的问候', 'operation-uncertain');
  profile.proactiveDelivery = { status: 'uncertain', operationId: 'operation-uncertain' };
  f.a.pauseProfile(profile, 'uncertain');
  await f.a.save();

  await f.restart();
  assert.equal(f.profile().paused, false);
  assert.equal(f.profile().proactiveDelivery.status, 'unknown');

  f.push('other', '你刚才说的是什么？'); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1);
  const handedOff = f.provider.calls.at(-1).input.messages.find(message => message.assumedPresent === true);
  assert.equal(handedOff.text, '可能已发出的问候');
  assert.equal(handedOff.deliveryConfidence, 'unknown');
  assert.equal(handedOff.aiGenerated, true);
});

test('a manual message older than an explicit pause does not resume', async t => {
  const f = await fixture(t);
  f.a.pauseProfile(f.profile(), 'explicit');
  f.push('self', '老消息', f.bridge.contacts[0].id, Math.floor((f.a.now() - 100000) / 1000));
  await f.a.tick();
  assert.equal(f.profile().paused, true); assert.equal(f.profile().pauseReason, 'explicit');
});

test('AI-generated messages are not treated as manual replies', async t => {
  const f = await fixture(t);
  f.a.pauseProfile(f.profile(), 'explicit');
  const msg = f.push('self', 'AI 代发的消息');
  f.profile().generatedIds = [msg.id];
  await f.a.tick();
  assert.equal(f.profile().paused, true);
});

test('a delayed native voice receipt repairs false manual wait only with owned recording time and duration', async t => {
  for (const variant of ['owned', 'wrong-duration', 'old-recording', 'file', 'no-proof']) {
    const f = await fixture(t), p = f.profile();
    const baseline = f.push('other', '请语音回复'); await f.a.tick();
    const own = f.push('self', '[语音]'); Object.assign(own, { type: 'voice', voiceDurationMs: variant === 'wrong-duration' ? 15000 : 2500 });
    if (variant === 'old-recording') own.timestamp -= 30;
    if (variant === 'file') { delete own.type; own.text = '[文件] AI-generated.mp3'; }
    p.sentMessages = [{ id: 'voice-operation', operationId: 'voice-operation', source: 'reply', at: f.a.now(), baseline: baseline.id,
      body: f.a.vault.seal({ text: '[AI合成语音]' }), media: { type: 'audio' }, confirmed: false, deliveryConfidence: 'unknown',
      ...(variant === 'no-proof' ? {} : { voiceReceipt: { startAt: f.a.now() - 2500, endAt: f.a.now(), durationMs: 2500 } }) }];
    p.delivery = { operationId: 'voice-operation', status: 'unknown', segmentsTotal: 1 };
    p.manualWait = { ownId: own.id, at: f.a.now() }; p.lastManualId = own.id;
    const incoming = f.push('other', '后续问题');
    await f.a.observe(p, { revision: incoming.id, messages: [baseline, own, incoming] });
    assert.equal(p.sentMessages[0].deliveryConfidence, variant === 'owned' ? 'confirmed' : 'unknown');
    assert.equal(!!p.manualWait, variant !== 'owned');
  }
});

test('late proactive receipts are classified before manual takeover and never increment reply rounds', async t => {
  const f = await fixture(t), p = f.profile();
  const baseline = f.push('other','在吗？'); await f.a.tick();
  const own = f.push('self','AI 主动发出的问候');
  p.sentMessages = [{id:'pending-proactive',operationId:'pending-proactive',source:'proactive',at:f.a.now(),baseline:baseline.id,body:f.a.vault.seal({text:own.text}),deliveryConfidence:'unknown'}];
  p.delivery = {operationId:'pending-proactive',source:'proactive',status:'unknown',segmentsTotal:1,segmentsSent:0};
  const rounds=p.rounds;
  await f.a.tick();
  assert.equal(p.manualWait,undefined);assert.equal(p.lastManualId,undefined);
  assert.equal(p.delivery.status,'sent');assert.equal(p.rounds,rounds);
  assert.ok(p.generatedIds.includes(own.id));assert.equal(p.sentMessages[0].confirmed,true);
  await f.a.tick();assert.equal(p.rounds,rounds);
});

test('a confirmed AI reply after an older human reply removes only the obsolete wait, including after restart', async t => {
  const f=await fixture(t), p=f.profile();
  f.push('self','之前手动回复');await f.a.tick();assert.ok(p.manualWait);
  f.advance(1000);const own=f.push('self','后来 AI 主动回复');p.generatedIds=[own.id];await f.a.save();
  await f.restart();await f.a.tick();assert.equal(f.profile().manualWait,undefined);
  f.advance(1000);const human=f.push('self','现在我亲自处理');await f.a.tick();
  assert.equal(f.profile().manualWait.ownId,human.id);
});

test('a previously misclassified AI message is repaired without clearing later human takeover', async t => {
  const f=await fixture(t), p=f.profile();const own=f.push('self','AI 回复');await f.a.tick();
  assert.equal(p.manualWait.ownId,own.id);p.generatedIds=[own.id];await f.a.tick();
  assert.equal(p.manualWait,undefined);assert.equal(p.lastManualAt,undefined);
  f.advance(1000);const human=f.push('self','我来回复');await f.a.tick();
  await f.a.tick();assert.equal(p.manualWait.ownId,human.id);
});

test('same text outside the actual sending window never becomes an AI receipt', async t => {
  const f=await fixture(t),p=f.profile(),own=f.push('self','相同问候',undefined,Math.floor(f.a.now()/1000)-1801);
  p.sentMessages=[{id:'old-intent',source:'proactive',at:f.a.now(),body:f.a.vault.seal({text:own.text}),deliveryConfidence:'unknown'}];
  await f.a.tick();assert.equal(p.sentMessages[0].deliveryConfidence,'unknown');assert.equal((p.generatedIds||[]).includes(own.id),false);
});

test('normal replies and model skips do not pause or create a verification flow', async t => {
  const f = await fixture(t);
  f.push('other', '普通问题'); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1); assert.equal(f.profile().paused, false);
  f.advance(1000); f.push('other', '请务必发个文件'); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.profile().paused, false); assert.equal(f.bridge.sent.length, 2); // 未返回 handoff 就不暂停
  f.provider.next = async () => ({ action: 'skip' });
  f.push('other', '必须现在发视频'); await f.a.tick(); f.advance(20000); await f.a.tick();
  assert.equal(f.profile().paused, false); assert.equal(f.a.publicState().skipRecords.length, 1);
});

test('group: manual reply resumes a model pause', async t => {
  const f = await fixture(t, 'group');
  f.a.pauseProfile(f.profile(), 'model'); f.profile().groupPauseReason = 'model'; f.profile().groupPausedUntil = f.a.now() + 60000;
  f.push('self', '我手动处理了'); await f.a.tick();
  assert.equal(f.profile().paused, false);
  assert.equal(f.profile().groupPauseReason, undefined); assert.equal(f.profile().groupPausedUntil, undefined);
});
