import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup, runtimeFactory } from './fixtures.mjs';
import { Instances } from '../server/instances.mjs';
import { messageSegments } from '../server/ai-prompts.mjs';
import { desktopReconnect } from '../web/desktop-reconnect.mjs';
import { desktopSocket } from '../server/desktop-socket.mjs';
import { EventEmitter } from 'node:events';

async function fixture(t, delay = async () => {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let now = Date.now();
  const options = { dataRoot: root, bridge, provider, now: () => now, delay, random: min => min };
  const a = new AIAssistant(options); await a.init(); await a.configure(modelConfig); await a.scan();
  await a.prepareTargets({ contacts: [bridge.contacts[0].id] });
  await a.targets([a.profiles()[0].id], 'reply');
  await a.settings({ enabled: true }); await a.tick();
  const p = a.profiles()[0];
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, p, bridge, provider, root, options, advance: ms => { now += ms; },
    async task(sendMode = 'segments') {
      await a.settings({ reply: false });
      await a.proactiveTaskAction({ command: 'create', name: '分段回归', goal: '邀请周末参加活动', requirements: '不要编造时间', contacts: [p.contact], schedule: { cycle: 'once' }, sendMode });
      return a.data.proactiveTasks.at(-1);
    } };
}

test('generation protocol rejects ambiguous, empty, excessive or disallowed segments without sending', () => {
  // 双载体（text+segments）不再作废，按发送方式挽救一种；其余歧义/越界仍拒绝。
  for (const result of [{ action: 'send', segments: [] }, { action: 'send', segments: [' '] }, { action: 'send', segments: ['1','2','3','4'] }, { action: 'skip', text: '不要发' }, { action: 'wait', waitSeconds: 1 }]) assert.throws(() => messageSegments(result, { multiTurn: true }));
  assert.deepEqual(messageSegments({ action: 'send', text: '甲', segments: ['乙'] }, { multiTurn: true }), ['乙']);
  assert.throws(() => messageSegments({ action: 'send', segments: ['一段'] }));
  assert.deepEqual(messageSegments({ action: 'send', segments: ['第一段', '第二段？'] }, { multiTurn: true }), ['第一段', '第二段？']);
});
test('single and multi-contact learning request style plus independent memory per person', async t => {
  const f = await fixture(t);
  await f.a.learn({ contacts: [f.p.contact] });
  let prompt = f.provider.calls.at(-1).system;
  // 风格按五个层次输出，memory 由追加的记忆规则在同一个 JSON 中返回。
  assert.match(prompt, /"style":\{"language":"语言层","rhythm":"节奏层","interaction":"互动层","emotion":"情感层","role":"角色层"\}/);
  assert.match(prompt, /在同一个 JSON 中返回 memory:\{"entries":\[\{"id":"修改旧条目时原样引用其id，新增时省略","field":"必填的字段类型，无法分类时为other","calendar":"日期字段可选 solar 或 lunar","degree":"学历字段可选","text":"一条有事实依据的记忆"\}\]\}/);
  assert.match(prompt, /其他日期明确区分 calendar=solar\/lunar/);
  const before = f.provider.calls.length;
  await f.a.learn({ contacts: f.bridge.contacts.slice(0, 2).map(c => c.id) });
  const calls = f.provider.calls.slice(before);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.input.contact), f.bridge.contacts.slice(0, 2).map(c => c.id));
  assert.ok(calls.every(call => /"style"/.test(call.system) && /"memory"/.test(call.system) && !/"profiles"/.test(call.system)));
});
test('independent proactive sends every segment with encrypted confirmed receipts and shared task protocol', async t => {
  const delays = [], f = await fixture(t, async ms => delays.push(ms)); const task = await f.task();
  f.provider.next = async () => ({ action: 'send', segments: ['首段秘密', '第二段秘密', '第三段秘密'], followUp: true });
  await f.a.tick();
  assert.deepEqual(f.bridge.sent.map(m => m.text), ['首段秘密', '第二段秘密', '第三段秘密']);
  assert.deepEqual(delays, [2000, 2000]); assert.equal(task.status, 'ended');
  const item = task.run.items[0], record = f.a.proactiveRecords({}).records[0];
  assert.equal(item.segmentsSent, 3); assert.equal(record.segmentsTotal, 3); assert.equal(record.segmentsSent, 3);
  assert.ok(record.segments.every(s => s.status === 'sent' && s.messageId));
  assert.equal(new Set(record.segments.map(s => s.operationId)).size, 3);
  assert.equal(f.a.followUps.size, 0); assert.equal(f.p.continuation, undefined);
  assert.ok(f.p.sentMessages.every(m => f.a.vault.open(m.body).text));
  assert.doesNotMatch(await readFile(f.a.file, 'utf8'), /首段秘密|第二段秘密|第三段秘密/);
  const call = f.provider.calls.at(-1); assert.equal(call.input.multiTurn, true); assert.equal(call.input.followUpAllowed, false);
  assert.match(call.system, /不是继续回答聊天历史里的旧问题/); assert.doesNotMatch(call.system, /可同时返回 memoryUpdates/);
});
for (const interruption of ['incoming', 'manual', 'pause', 'account', 'not-sent', 'uncertain']) test(`proactive ${interruption} after confirmed prefix never retries prefix or remaining suffix`, async t => {
  let f, task, once = false;
  f = await fixture(t, async () => {
    if (once) return; once = true;
    if (interruption === 'incoming') f.bridge.push(f.p.contact, 'other', '等等');
    if (interruption === 'manual') f.bridge.push(f.p.contact, 'self', '我来处理');
    if (interruption === 'pause') await f.a.proactiveTaskAction({ command: 'pause', id: task.id });
    if (interruption === 'account') { f.a.invalidate(); f.a.data.account = 'another-account'; }
    if (['not-sent', 'uncertain'].includes(interruption)) f.bridge.delivery = async () => ({ status: interruption });
  });
  // 对方在段落之间回了话不算打断：本次发起还没完成，会结合这条回复重新生成剩余内容。
  const regen = interruption === 'incoming' ? 1 : 0;
  task = await f.task(); f.provider.next = async () => ({ action: 'send', segments: ['已发前段', '待发后段'] });
  await f.a.tick(); assert.equal(f.bridge.sent.length, 1 + regen);
  const item = task.run.items[0];
  assert.equal(item.status, interruption === 'uncertain' ? 'uncertain' : 'sent');
  assert.equal(item.segmentsSent, 1 + regen);
  if (interruption === 'uncertain') { assert.equal(f.p.proactiveDelivery.status, 'uncertain'); await assert.rejects(f.a.proactiveTaskAction({ command: 'retry', id: task.id })); }
  if (interruption === 'pause') await f.a.proactiveTaskAction({ command: 'resume', id: task.id });
  f.advance(50000); await f.a.tick(); assert.equal(f.bridge.sent.length, 1 + regen);
  await f.a.close(); const restarted = new AIAssistant(f.options); await restarted.init(); await restarted.scan(); await restarted.tick(); await restarted.close();
  assert.equal(f.bridge.sent.length, 1 + regen);
});
test('review preview is read-only, explicit resolve consumes current history and preserves settings', async t => {
  const f = await fixture(t); const style = structuredClone(f.p.style), options = structuredClone(f.p.replyOptions);
  const old = f.bridge.push(f.p.contact, 'other', '旧问题');
  f.a.pauseProfile(f.p, 'handoff'); f.p.handoffReason = 'file'; f.p.handoffMessageId = old.id;
  const before = f.a.revision, view = await f.a.review(f.p.id);
  assert.equal(f.a.revision, before); assert.equal(f.p.pauseReason, 'handoff');
  f.bridge.push(f.p.contact, 'other', '变化'); await assert.rejects(f.a.review(f.p.id, { resolve: true, revision: view.revision }), /新变化/);
  const latest = await f.a.review(f.p.id); await f.a.review(f.p.id, { resolve: true, revision: latest.revision });
  assert.equal(f.p.paused, false); assert.deepEqual(f.p.style, style); assert.deepEqual(f.p.replyOptions, options);
  await f.a.tick(); f.advance(6000); await f.a.tick(); assert.equal(f.bridge.sent.length, 0);
  f.bridge.push(f.p.contact, 'other', '新问题'); await f.a.tick(); f.advance(6000); await f.a.tick(); assert.equal(f.bridge.sent.length, 1);
});
test('explicit pauses survive manual messages and uncertain delivery stays protected', async t => {
  const f = await fixture(t); f.a.pauseProfile(f.p, 'explicit');
  f.bridge.push(f.p.contact, 'other', '仍在等'); await f.a.tick(); assert.equal(f.p.pauseReason, 'explicit');
  const auto = f.bridge.push(f.p.contact, 'self', 'AI旧消息'); f.p.generatedIds = [auto.id]; await f.a.tick(); assert.equal(f.p.pauseReason, 'explicit');
  f.bridge.push(f.p.contact, 'self', '本人已提供'); await f.a.tick();
  assert.equal(f.p.paused, true); assert.equal(f.p.pauseReason, 'explicit');
  f.a.pauseProfile(f.p, 'uncertain'); f.p.delivery = { status: 'uncertain' };
  f.bridge.push(f.p.contact, 'self', '人工发送'); await f.a.tick(); assert.equal(f.p.pauseReason, 'uncertain');
  await assert.rejects(f.a.editProfile(f.p.id, { style: f.p.style, paused: false }), /先核对/);
});
test('ordinary paused contact resumes at latest baseline without changing saved style', async t => {
  const f = await fixture(t); f.a.pauseProfile(f.p, 'explicit'); f.bridge.push(f.p.contact, 'other', '暂停期间');
  await f.a.editProfile(f.p.id, { style: f.p.style, paused: false }); await f.a.tick(); f.advance(6000); await f.a.tick();
  assert.equal(f.p.paused, false); assert.equal(f.bridge.sent.length, 0);
});
test('clean app restart restores only previously running instances, preserving homes and login confirmation scope', async t => {
  const root = await temp(); let confirmations = 0;
  const options = { dataRoot: root, appRoot: root, library: { installed: () => ({ version: '4.1.13.9' }) }, runtimeFactory: (...args) => ({ ...runtimeFactory(...args), confirmScheduledLogin: async () => { confirmations++; return { status: 'logged-in' }; } }) };
  let users = new Instances(options);
  t.after(async () => { await users.close(); await cleanup(root); });
  await users.init(); let space = await users.get('1001'); await space.setConsent(true);
  const a = await space.add('原登录会话'), b = await space.add('主动停止'), c = await space.add('未登录会话');
  const home = space.get(a.id).home; await writeFile(path.join(home, 'login-sentinel'), 'private-session');
  await space.start(a.id); space.get(a.id).runtime.loginStatus = 'logged-in'; await space.start(c.id);
  await users.close(); users = new Instances(options); await users.init(); space = await users.get('1001');
  assert.equal(space.get(a.id).runtime.status, 'running'); assert.equal(space.get(b.id).runtime.status, 'stopped'); assert.equal(space.get(c.id).runtime.status, 'running');
  assert.equal(confirmations, 1); assert.equal(space.get(a.id).home, home); assert.equal(await readFile(path.join(home, 'login-sentinel'), 'utf8'), 'private-session');
  await space.stop(a.id); await users.close(); users = new Instances(options); await users.init(); space = await users.get('1001');
  assert.equal(space.get(a.id).runtime.status, 'stopped'); assert.equal(confirmations, 1);
});
test('reconnect uses bounded backoff and leaving the desktop cancels queued reconnect', async () => {
  const jobs = new Map(), waits = []; let calls = 0, seq = 0;
  const r = desktopReconnect({ notify() {}, reconnect: async () => { calls++; throw Error('offline'); }, schedule: (cb, ms) => { const id = ++seq; jobs.set(id, cb); waits.push(ms); return id; }, cancel: id => jobs.delete(id) });
  const run = async () => { const [id, fn] = jobs.entries().next().value; jobs.delete(id); await fn(); };
  r.lost(); await run(); await run(); await run(); assert.equal(calls, 3); assert.equal(jobs.size, 0); assert.deepEqual(waits, [1000, 3000, 8000]);
  r.stop(); r.lost(); r.stop(); assert.equal(jobs.size, 0);
});
test('desktop frame flow pauses upstream until websocket callback, heartbeat closes silent peer', async () => {
  const ws = new EventEmitter(), upstream = new EventEmitter(); let paused = 0, resumed = 0, callback, ping = 0;
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, send: (_bytes, cb) => { callback = cb; }, ping: () => ping++, terminate: () => ws.emit('close') });
  Object.assign(upstream, { pause: () => paused++, resume: () => resumed++, destroy() {} });
  const closed = new Promise(resolve => ws.once('close', resolve)); desktopSocket(ws, upstream, { heartbeatMs: 5 });
  upstream.emit('data', Buffer.from('frame')); assert.equal(paused, 1); assert.equal(resumed, 0); callback(); assert.equal(resumed, 1);
  const keepAlive = setTimeout(() => {}, 100); await closed; clearTimeout(keepAlive); assert.equal(ping, 1);
  assert.equal(upstream.listenerCount('data'), 0);
});
