import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, { segments = false, group = false, delay = async () => {}, startAt = '2026-10-21T10:00:00+08:00' } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true;
  if (group) bridge.contacts[0].kind = 'group';
  let now = Date.parse(startAt), a;
  const options = { dataRoot: root, bridge, provider, now: () => now, delay, random: min => min };
  const create = async () => { a = new AIAssistant(options); await a.init(); };
  await create(); await a.configure(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id;
  if (group) await a.setGroupOptions({ contact, atMe: true });
  else await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true, autoLearning: false, segmentReplies: segments }); await a.tick();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { bridge, provider, get a() { return a; }, get p() { return a.profiles().find(p => p.contact === contact); },
    advance: ms => now += ms,
    async incoming(text = '这条测试来信请回应') {
      const m = bridge.push(contact, 'other', text); m.timestamp = Math.floor(now / 1000);
      if (group) Object.assign(m, { sender: key('member-one'), mentions: { verified: true, self: true, all: false, others: false } });
      await a.tick(); return m;
    },
    async restart() { await a.close(); await create(); },
  };
}
const notSent = { status: 'not-sent', diagnostic: { phase: 'native-prepare', code: 'controls-unavailable' } };

test('definite pre-submit failure reuses the encrypted answer without a second generation', async t => {
  const f = await fixture(t); await f.incoming();
  const send = f.bridge.send.bind(f.bridge); let attempts = 0;
  f.bridge.send = request => ++attempts === 1 ? notSent : send(request);
  f.provider.next = async () => ({ action: 'send', text: '保留这份已经生成的答复🙂' });
  f.advance(20000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.p.preparedReply.state, 'retry');
  assert.ok(!(await readFile(f.a.file, 'utf8')).includes('保留这份已经生成的答复'));
  assert.equal(f.a.publicProfile(f.p).preparedReply, undefined);
  f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 1);
  assert.equal(f.bridge.sent[0].text, '保留这份已经生成的答复🙂');
  assert.equal(f.p.preparedReply, undefined); assert.equal(f.p.rounds, 1);
});

test('six definite failures use one generation and a later restart still reuses it', async t => {
  const f = await fixture(t); await f.incoming();
  const send = f.bridge.send.bind(f.bridge); let attempts = 0;
  f.bridge.send = () => { attempts++; return notSent; };
  f.advance(20000);
  for (let i = 0; i < 6; i++) { await f.a.tick(); f.advance(30000); }
  assert.equal(attempts, 6); assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0);
  await f.restart(); f.bridge.send = send; await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 1);
});

test('new incoming content retires the old answer and generates against the new conversation', async t => {
  const f = await fixture(t); await f.incoming();
  const send = f.bridge.send.bind(f.bridge); f.bridge.send = () => notSent;
  f.provider.next = async () => ({ action: 'send', text: '旧答案不应发送' });
  f.advance(20000); await f.a.tick();
  f.advance(30000); await f.incoming('更正一下，我的问题变了'); f.advance(20000);
  f.bridge.send = send; f.provider.next = async () => ({ action: 'send', text: '按更正后的问题回复' }); await f.a.tick();
  assert.equal(f.provider.calls.length, 2); assert.deepEqual(f.bridge.sent.map(x => x.text), ['按更正后的问题回复']);
});

for (const action of ['master-off', 'object-off', 'cancel', 'manual-input', 'model-change', 'account-change']) {
  test(`a retained answer cannot survive ${action}`, async t => {
    const f = await fixture(t); await f.incoming();
    const send = f.bridge.send.bind(f.bridge); f.bridge.send = () => notSent;
    f.advance(20000); await f.a.tick(); assert.ok(f.p.preparedReply);
    const profile = f.p;
    if (action === 'master-off') await f.a.settings({ enabled: false });
    if (action === 'object-off') await f.a.setReplyOptions({ contact: profile.contact, enabled: false });
    if (action === 'cancel') await f.a.cancel();
    if (action === 'manual-input') await f.a.manualInput({ source: 'reuse-test', type: 'pointer', held: true });
    if (action === 'model-change') await f.a.configure({ ...modelConfig, model: 'another-model' });
    if (action === 'account-change') { f.bridge.account = key('other-account'); await f.a.scan(); }
    assert.equal(profile.preparedReply, undefined);
    f.bridge.send = send; f.advance(30000);
    if (!['cancel', 'model-change'].includes(action)) { await f.a.tick(); assert.equal(f.bridge.sent.length, 0); }
  });
}

test('an unknown submission is reconciled rather than replayed after restart', async t => {
  const f = await fixture(t); await f.incoming(); let attempts = 0;
  f.bridge.send = () => { attempts++; return { status: 'uncertain' }; };
  f.advance(20000); await f.a.tick(); assert.equal(f.p.preparedReply, undefined);
  await f.restart();
  for (let n = 0; n < 20; n++) { f.advance(10000); await f.a.tick(); }
  assert.equal(attempts, 1); assert.equal(f.provider.calls.length, 1);
});

test('group retries preserve their exact pending member batch and do not generate it again', async t => {
  const f = await fixture(t, { group: true }); const incoming = await f.incoming();
  const send = f.bridge.send.bind(f.bridge); f.bridge.send = () => notSent;
  f.provider.next = async () => ({ action: 'send', text: '这是一份给当前群成员的答复' });
  f.advance(20000); await f.a.tick(); assert.equal(f.p.preparedReply.state, 'retry');
  f.advance(30000); f.bridge.send = send; await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 1);
  assert.deepEqual(f.p.sentMessages[0].replyTo, [incoming.id]);
});

test('a failed preparation followed by a user draft retires the cached reply without touching that draft', async t => {
  const f = await fixture(t); await f.incoming();
  f.bridge.send = () => notSent; f.advance(20000); await f.a.tick();
  f.bridge.send = () => ({ status: 'not-sent', diagnostic: { phase: 'native-prepare', reason: 'existing-draft' } });
  f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0); assert.equal(f.p.preparedReply, undefined);
  f.advance(30000); await f.a.tick(); assert.equal(f.provider.calls.length, 1);
});

test('changing enabled group policy retires a cached answer from the old policy', async t => {
  const f = await fixture(t, { group: true }); await f.incoming();
  f.bridge.send = () => notSent; f.advance(20000); await f.a.tick();
  assert.ok(f.p.preparedReply);
  await f.a.setGroupOptions({ contact: f.p.contact, realtimeMode: 'proactive' });
  assert.equal(f.p.preparedReply, undefined);
  assert.equal(f.provider.calls.length, 1);
});

test('a retained answer with an outdated explicit current date is retired without a new generation', async t => {
  const f = await fixture(t, { startAt: '2026-10-21T23:58:00+08:00' }); await f.incoming('今天几号？');
  const send = f.bridge.send.bind(f.bridge); f.bridge.send = () => notSent;
  f.provider.next = async () => ({ action: 'send', text: '今天是2026年10月21日，星期三。' });
  f.advance(20000); await f.a.tick(); assert.ok(f.p.preparedReply);
  await f.restart(); f.advance(3 * 60000); f.bridge.send = send; await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0); assert.equal(f.p.preparedReply, undefined);
  assert.match(f.p.replyFlow.detail, /日期已失效/);
  f.advance(30000); await f.a.tick(); assert.equal(f.provider.calls.length, 1);
});

for (const group of [false, true]) test(`definite failures stop at five minutes across restart (${group ? 'group' : 'person'})`, async t => {
  const f = await fixture(t, { group }); await f.incoming();
  const send = f.bridge.send.bind(f.bridge); let attempts = 0;
  f.bridge.send = () => { attempts++; return notSent; };
  f.advance(20000); await f.a.tick(); f.advance(299000); await f.a.tick();
  assert.equal(attempts, 2); assert.equal(f.provider.calls.length, 1);
  await f.restart(); f.advance(1000); f.bridge.send = send; await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0);
  assert.match(f.p.replyFlow.detail, /5分钟/); assert.equal(f.p.preparedReply, undefined);
  f.advance(30000); await f.a.tick(); assert.equal(f.provider.calls.length, 1);
  await f.incoming('新的问题，请正常回答'); f.advance(20000); await f.a.tick();
  assert.equal(f.provider.calls.length, 2); assert.equal(f.bridge.sent.length, 1);
});

test('clock rollback cannot extend the definite-unsent retry window', async t => {
  const f = await fixture(t); await f.incoming();
  f.bridge.send = () => notSent; f.advance(20000); await f.a.tick();
  // Simulate a restored clock while the user explicitly retries the pending send.
  f.advance(-60000); f.p.sendRetryAt = 0; await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0); assert.equal(f.p.preparedReply, undefined);
  assert.match(f.p.replyFlow.detail, /时效无法确认/);
});

test('a retry cannot submit after its remaining five-minute budget is exhausted in native preparation', async t => {
  const f = await fixture(t); await f.incoming();
  f.bridge.send = () => notSent; f.advance(20000); await f.a.tick();
  f.advance(30000); f.p.preparedReply.retryStartedAt = f.a.now() - 299995;
  let aborted = false;
  f.bridge.send = async request => {
    await new Promise(resolve => setTimeout(resolve, 20));
    aborted = request.signal.aborted; request.signal.throwIfAborted();
    assert.fail('A native commit after the retry deadline must be blocked');
  };
  await f.a.tick();
  assert.equal(aborted, true); assert.equal(f.bridge.sent.length, 0); assert.equal(f.provider.calls.length, 1);
  assert.equal(f.p.delivery.status, 'unknown', 'an unclassified thrown submission error must remain receipt-only');
  assert.equal(f.p.preparedReply, undefined);
});

test('a confirmed segment prefix is never replayed when a later segment is definitely not sent', async t => {
  const f = await fixture(t, { segments: true }); await f.incoming();
  f.provider.next = async () => ({ action: 'send', segments: ['第一段已发送', '第二段确定未发送'] });
  const send = f.bridge.send.bind(f.bridge); let attempts = 0;
  f.bridge.send = request => ++attempts === 2 ? notSent : send(request);
  f.advance(20000); await f.a.tick();
  assert.deepEqual(f.bridge.sent.map(x => x.text), ['第一段已发送']); assert.equal(f.p.preparedReply, undefined);
  await f.restart(); f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.deepEqual(f.bridge.sent.map(x => x.text), ['第一段已发送']);
});
