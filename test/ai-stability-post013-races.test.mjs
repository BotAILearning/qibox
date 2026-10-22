import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { DataChatBridge } from '../server/ai-data.mjs';
import { AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

// Only the process pipe and database source are simulated. AIAssistant,
// DataChatBridge's identity/revision/receipt checks and preparedSend all run
// their production paths. No HTTP, child process, WeChat or real data is used.
async function fixture(t, { segments = false, stopAt = 1, unknown = false } = {}) {
  const root = await temp(), provider = new AIModelFixture();
  let now = Date.parse('2026-10-22T11:00:00+08:00'), sequence = 0, a;
  const account = key('post013-account-A'), contact = key('post013-contact');
  const native = { account: key('post013-native-A'), contact: key('post013-native-contact') };
  const state = { account, native, messages: [{ id: key('initial'), direction: 'self', text: '合成历史问候', timestamp: Math.floor(now / 1000) - 60 }] };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const protocol = [], nativeStages = [], observed = [], children = [], memory = [];
  const runtime = { status: 'running', desktopEnv: {}, runtimeRoot: '/unused-test-runtime', appRoot: '/unused-test-app', processes: [{ name: 'wechat', process: { pid: 123 } }] };
  const snapshot = () => ({ available: true, account: state.account, contact, label: '合成测试对象', native: state.native,
    revision: key(JSON.stringify(state.messages)), messages: structuredClone(state.messages) });
  const push = (direction, text) => { const message = { id: key(`message-${++sequence}`), direction, text, timestamp: Math.floor(now / 1000) }; state.messages.push(message); return message; };
  let prepares = 0;
  const bridge = new DataChatBridge(runtime, {
    receiptDelay: async () => {},
    async invokeData(action) {
      if (['account', 'keys'].includes(action)) return { available: true, account: state.account };
      if (action === 'contacts') return { available: true, account: state.account, contacts: [{ id: contact, label: '合成测试对象', kind: 'person', native: state.native }] };
      if (action === 'sessions') return { available: true, account: state.account, sessions: [{ id: contact, at: Math.floor(now / 1000), unread: 1, last: state.messages.length, hidden: 0 }] };
      assert.equal(action, 'read'); return snapshot();
    },
    async openMemory(file, flags) {
      assert.equal(file, '/proc/123/mem'); assert.equal(flags, 'r');
      const handle = { fd: 55, closed: 0, async close() { this.closed++; } }; memory.push(handle); return handle;
    },
    spawnProcess() {
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); children.push(child);
      let exited = false, terminated = false, reportedPrepared = false;
      const finish = value => { if (exited) return; exited = true; child.stdout.write(JSON.stringify(value) + '\n'); child.emit('close', 0); };
      const emitPrepared = index => {
        reportedPrepared = true; nativeStages.push(terminated ? 'prepared-after-kill' : 'prepared');
        child.stdout.write(JSON.stringify({ stage: 'prepared', ...state.native, revision: key(`native-guard-${index}`) }) + '\n');
      };
      child.kill = signal => {
        protocol.push({ action: 'kill', signal }); terminated = true;
        void (async () => {
          // A helper can finish an in-flight prepare after SIGTERM. Deliberately
          // deliver that late event before its final safe cleanup report.
          if (!reportedPrepared) { await release.promise; if (!exited) emitPrepared(prepares); }
          finish({ status: 'stale', sendPressed: false, draftCleanup: 'not-needed' });
        })();
        return true;
      };
      child.stdin.on('data', chunk => {
        const request = JSON.parse(chunk.toString()); protocol.push(request);
        if (request.action === 'prepare-send') {
          const index = ++prepares;
          void (async () => {
            if (index === stopAt) { entered.resolve(); await release.promise; }
            if (!exited && !terminated) emitPrepared(index);
          })();
        } else if (request.action === 'commit') {
          observed.push({ contact, text: request.text });
          if (!unknown) push('self', request.text);
          queueMicrotask(() => finish({ status: unknown ? 'uncertain' : 'submitted', draftCleanup: 'not-needed' }));
        } else { assert.equal(request.action, 'cancel'); queueMicrotask(() => finish({ status: 'stale', draftCleanup: 'not-needed' })); }
      });
      return child;
    },
  });
  const options = { dataRoot: root, bridge, provider, now: () => now, delay: async () => {}, random: min => min };
  const create = async () => { a = new AIAssistant(options); await a.init(); };
  await create(); await a.configure(modelConfig); await a.scan();
  await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true, autoLearning: false, segmentReplies: segments }); await a.tick();
  t.after(async () => { release.resolve(); await a.close(); assert.ok(memory.every(handle => handle.closed === 1)); await cleanup(root); });
  return { get a() { return a; }, get p() { return a.profiles().find(row => row.contact === contact); }, root, contact, account, state, provider, bridge, protocol, nativeStages, observed, memory,
    entered: entered.promise, release: () => release.resolve(), advance: ms => { now += ms; },
    async start() { push('other', '请确认收到这条合成消息'); await a.tick(); now += 20000; return a.tick(); },
    async restart() { await a.close(); await create(); },
  };
}

for (const action of ['object-off', 'delete']) test(`post013: ${action} before native preparation completes forbids commit, including a late helper result`, { timeout: 5000 }, async t => {
  const f = await fixture(t); f.provider.next = async () => ({ action: 'send', text: '这条旧答复不能发出' });
  const sending = f.start(); await f.entered; const id = f.p.id;
  if (action === 'object-off') await f.a.setReplyOptions({ contact: f.contact, enabled: false });
  else await f.a.editProfile(id, { delete: true });
  f.release(); await sending; f.advance(30000); await f.a.tick();
  assert.equal(f.provider.calls.length, 1); assert.equal(f.observed.length, 0);
  assert.equal(f.protocol.filter(row => row.action === 'commit').length, 0);
  assert.equal(f.protocol.filter(row => row.action === 'prepare-send').length, 1);
  assert.deepEqual(f.nativeStages, ['prepared-after-kill'], 'The helper must actually emit a late prepared result after cancellation');
  const durable = JSON.parse(await readFile(f.a.file, 'utf8'));
  if (action === 'object-off') { assert.equal(f.a.replySelected(f.p), false); assert.equal(durable.replyTargets.includes(id), false); }
  else { assert.equal(f.a.data.profiles[id], undefined); assert.equal(durable.profiles[id], undefined); }
  t.diagnostic('Production AIAssistant + DataChatBridge + preparedSend; mock model=1; native commit=0; real requests=0; real WeChat=0');
});

test('post013: a second-segment native account change preserves only the confirmed prefix and disables AI', { timeout: 5000 }, async t => {
  const f = await fixture(t, { segments: true, stopAt: 2 });
  f.provider.next = async () => ({ action: 'send', segments: ['确认前缀', '账号变化后禁止发送的尾段'], followUp: true });
  const sending = f.start(); await f.entered;
  assert.deepEqual(f.observed.map(row => row.text), ['确认前缀']);
  f.state.account = key('post013-account-B'); f.state.native = { ...f.state.native, account: key('post013-native-B') };
  f.release(); await sending;
  assert.deepEqual(f.observed.map(row => row.text), ['确认前缀']);
  assert.equal(f.protocol.filter(row => row.action === 'commit').length, 1);
  assert.equal(f.a.data.settings.enabled, false); assert.equal(f.a.followUps.size, 0); assert.equal(f.provider.calls.length, 1);
  assert.equal(JSON.parse(await readFile(f.a.file, 'utf8')).settings.enabled, false);
  t.diagnostic('First segment receipt confirmed by production DB path; second prepare identity changed; mock model=1; native commit=1; real requests=0; real WeChat=0');
});

test('post013: a committed unknown native result remains receipt-only after restart through the production data bridge', { timeout: 5000 }, async t => {
  const f = await fixture(t, { unknown: true });
  f.provider.next = async () => ({ action: 'send', text: '结果未知的合成提交' });
  const sending = f.start(); await f.entered; f.release(); await sending;
  assert.equal(f.protocol.filter(row => row.action === 'commit').length, 1);
  assert.equal(f.p.delivery.status, 'unknown'); assert.equal(f.p.preparedReply, undefined);
  await f.restart();
  for (let i = 0; i < 4; i++) { f.advance(30000); await f.a.tick(); }
  assert.equal(f.provider.calls.length, 1, 'Unknown commit cannot generate a replacement for the same incoming message');
  assert.equal(f.protocol.filter(row => row.action === 'commit').length, 1, 'Only read-only reconciliation is allowed after unknown commit');
  assert.equal(f.observed.length, 1);
  assert.equal(f.p.sentMessages.filter(row => row.confirmed === false).length, 1);
  t.diagnostic('Unknown native submission + no DB receipt + restart; mock model=1; native commit stays1; real requests=0; real WeChat=0');
});
