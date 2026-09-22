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

for (const kind of ['person', 'group']) test(`${kind}: manual reply does not pause and AI keeps replying to new incoming`, async t => {
  const f = await fixture(t, kind);
  f.push('self', '我手动回一句'); await f.a.tick();
  assert.equal(f.profile().paused, false); assert.equal(f.profile().pauseReason, undefined);
  f.advance(1000); f.push('other', '那时间怎么安排？'); await f.a.tick();
  assert.equal(f.bridge.sent.length, 0); // 未到回复延迟
  f.advance(3000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1); // AI 继续回复新消息
  assert.equal(f.profile().paused, false);
});

test('model handoff pauses; manual reply resumes and only new messages are answered', async t => {
  const f = await fixture(t);
  f.provider.next = async () => ({ action: 'handoff', reason: 'file' });
  f.push('other', '发个文件给我'); await f.a.tick(); f.advance(3000); await f.a.tick();
  assert.equal(f.profile().paused, true); assert.equal(f.profile().pauseReason, 'handoff');
  assert.equal(f.profile().handoffReason, 'file');
  f.push('self', '文件我手动发了'); await f.a.tick();
  assert.equal(f.profile().paused, false); assert.equal(f.profile().handoffReason, undefined);
  f.advance(1000); f.push('other', '收到谢谢'); await f.a.tick(); f.advance(3000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1); // 只回恢复后的新消息
});

test('review endpoint exposes the reason and messages, and resolve clears the model pause', async t => {
  const f = await fixture(t);
  f.provider.next = async () => ({ action: 'handoff', reason: 'file' });
  f.push('other', '发个文件'); await f.a.tick(); f.advance(3000); await f.a.tick();
  assert.equal(f.profile().paused, true);
  const info = await f.a.review(f.profile().id);
  assert.equal(info.reason, '需要你发送或查看文件'); assert.ok(Array.isArray(info.messages));
  await f.a.review(f.profile().id, { resolve: true, revision: info.revision });
  assert.equal(f.profile().paused, false); assert.equal(f.profile().handoffReason, undefined);
  f.advance(1000); f.push('other', '新消息'); await f.a.tick(); f.advance(3000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1);
});

test('manual reply does not resume an explicitly paused profile', async t => {
  const f = await fixture(t);
  f.a.pauseProfile(f.profile(), 'explicit');
  f.push('self', '手动回复'); await f.a.tick();
  assert.equal(f.profile().paused, true); assert.equal(f.profile().pauseReason, 'explicit');
});

test('manual reply resumes limit and stop pauses but not an uncertain delivery', async t => {
  const f = await fixture(t);
  for (const reason of ['limit', 'stop']) {
    f.a.pauseProfile(f.profile(), reason);
    f.push('self', reason); await f.a.tick();
    assert.equal(f.profile().paused, false, `${reason} 应被手动回复解除`);
  }
  f.a.pauseProfile(f.profile(), 'uncertain'); f.profile().delivery = { status: 'uncertain' };
  f.push('self', 'uncertain'); await f.a.tick();
  assert.equal(f.profile().paused, true); assert.equal(f.profile().pauseReason, 'uncertain');
});

test('a manual message older than the pause does not resume', async t => {
  const f = await fixture(t);
  f.a.pauseProfile(f.profile(), 'handoff');
  f.push('self', '老消息', f.bridge.contacts[0].id, Math.floor((f.a.now() - 100000) / 1000));
  await f.a.tick();
  assert.equal(f.profile().paused, true); assert.equal(f.profile().pauseReason, 'handoff');
});

test('AI-generated messages are not treated as manual replies', async t => {
  const f = await fixture(t);
  f.a.pauseProfile(f.profile(), 'handoff');
  const msg = f.push('self', 'AI 代发的消息');
  f.profile().generatedIds = [msg.id];
  await f.a.tick();
  assert.equal(f.profile().paused, true);
});

test('pause is triggered only by the model handoff field; normal replies never pause', async t => {
  const f = await fixture(t);
  f.push('other', '普通问题'); await f.a.tick(); f.advance(3000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 1); assert.equal(f.profile().paused, false);
  f.advance(1000); f.push('other', '请务必发个文件'); await f.a.tick(); f.advance(3000); await f.a.tick();
  assert.equal(f.profile().paused, false); assert.equal(f.bridge.sent.length, 2); // 未返回 handoff 就不暂停
  f.provider.next = async () => ({ action: 'handoff', reason: 'media' });
  f.push('other', '必须现在发视频'); await f.a.tick(); f.advance(3000); await f.a.tick();
  assert.equal(f.profile().paused, true); assert.equal(f.profile().pauseReason, 'handoff'); assert.equal(f.profile().handoffReason, 'media');
});

test('group: manual reply resumes a model pause', async t => {
  const f = await fixture(t, 'group');
  f.a.pauseProfile(f.profile(), 'model'); f.profile().groupPauseReason = 'model'; f.profile().groupPausedUntil = f.a.now() + 60000;
  f.push('self', '我手动处理了'); await f.a.tick();
  assert.equal(f.profile().paused, false);
  assert.equal(f.profile().groupPauseReason, undefined); assert.equal(f.profile().groupPausedUntil, undefined);
});
