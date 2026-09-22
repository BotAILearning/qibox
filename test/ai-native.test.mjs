import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeChatBridge } from '../server/ai-native.mjs';
import { RfbInputGate } from '../server/rfb-input.mjs';

function runtimeFixture(foregroundRequested) {
  return {
    status: 'running', desktopEnv: {}, processes: [{ name: 'wechat', process: { pid: 123 } }], foregroundRequested,
    // A rejected request must never reach child-process preparation.
    get runtimeRoot() { assert.fail('A cancelled or stale operation attempted to launch the native helper'); },
  };
}

test('native handover cancellation prevents a pending send from launching', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
  const runtime = runtimeFixture(async () => { started.resolve(); await release.promise; });
  const work = new NativeChatBridge(runtime).send({ signal: controller.signal, text: 'cancelled test' });
  await started.promise;
  controller.abort(); release.resolve();
  await assert.rejects(work, { name: 'AbortError' });
});

test('native handover refuses a request after WeChat stops or restarts', async () => {
  for (const change of [r => { r.status = 'stopped'; }, r => { r.desktopEnv = null; }, r => { r.processes[0].process.pid = 456; }]) {
    const runtime = runtimeFixture(async () => change(runtime));
    await assert.rejects(new NativeChatBridge(runtime).send({ text: 'stale test' }), /微信连接已断开/);
  }
});

test('native handover restores the owned hidden window and checks cancellation again before navigation', async () => {
  const controller = new AbortController(), calls = [];
  const runtime = runtimeFixture(async () => calls.push('handover'));
  runtime.showWindow = async () => { calls.push('restore'); controller.abort(); };
  await assert.rejects(new NativeChatBridge(runtime).send({ text: '不得发送', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, ['handover', 'restore']);
});

const account = 'a'.repeat(64), contact = 'b'.repeat(64), second = 'c'.repeat(64), changedAccount = 'd'.repeat(64);
const revision = '1'.repeat(64), nextRevision = '2'.repeat(64);
const person = { id: contact, label: '已核验对象', kind: 'person' };
const other = text => ({ direction: 'other', text });
const self = text => ({ direction: 'self', text });
const snapshot = (messages, extra = {}) => ({ account, contact, revision, messages, ...extra });
function bridgeFixture(handler = () => undefined) {
  const calls = [], runtime = runtimeFixture();
  const bridge = new NativeChatBridge(runtime, { invoke: async (action, args, context) => {
    calls.push({ action, args });
    const override = await handler(action, args, context);
    if (override !== undefined) return override;
    if (action === 'list') return { available: true, account, candidates: [person.label], current: person };
    if (action === 'resolve') return { account, contact: person };
    if (action === 'read') return snapshot([other('原始消息')]);
    throw new Error('Unexpected native request');
  } });
  return { bridge, calls, runtime };
}

test('clearing temporary context releases observations without removing verified contact bindings', async () => {
  const { bridge, calls } = bridgeFixture();
  await bridge.scan(); const before = await bridge.read({ account, contact });
  bridge.clearContext(); const count = calls.length;
  assert.deepEqual(await bridge.send({ account, contact, revision, text: '不应发送' }), { status: 'stale' });
  assert.equal(calls.length, count);
  const after = await bridge.read({ account, contact });
  assert.notEqual(after.messages[0].id, before.messages[0].id);
  assert.equal(after.contact, before.contact);
});

test('scan verifies candidates serially, skips only unsupported or groups, and restores the original conversation', async () => {
  const original = { id: second, label: '原会话', kind: 'person' };
  const { bridge, calls } = bridgeFixture((action, args) => {
    if (action === 'list') return { available: true, account, candidates: [person.label, '群聊', '未支持', person.label], current: original };
    if (action === 'resolve' && args.label === '群聊') return { account, contact: { id: 'e'.repeat(64), label: '群聊', kind: 'group' } };
    if (action === 'resolve' && args.label === '未支持') return { available: false, error: 'unsupported' };
    if (action === 'resolve' && args.label === original.label) return { account, contact: original };
  });
  assert.deepEqual(await bridge.scan(), { available: true, account, contacts: [person] });
  assert.deepEqual(calls.map(call => [call.action, call.args.label]), [['list', undefined], ['resolve', person.label], ['resolve', '群聊'], ['resolve', '未支持'], ['resolve', original.label]]);
  await assert.rejects(bridge.read({ account, contact: second }), /请先检测/);
});

test('contacts directory scans publish bounded progress and retain the route for verified reads', async () => {
  const { bridge, calls } = bridgeFixture((action, args) => {
    if (action === 'list') return { available: true, account, source: 'contacts', candidates: [person.label, '未支持'], current: null };
    if (action === 'resolve') return args.label === '未支持' ? { available: false, error: 'unsupported' } : { account, contact: person };
    if (action === 'read') return snapshot([other('原始消息')]);
    throw new Error('Unexpected operation');
  });
  const progress = [];
  assert.deepEqual(await bridge.scan({ onProgress: item => progress.push(item) }), { available: true, account, contacts: [person], unreadableCount: 1 });
  assert.deepEqual(progress.map(({ completed, total, contacts }) => [completed, total, contacts.length]), [[0, 2, 0], [1, 2, 1], [2, 2, 1]]);
  await bridge.read({ account, contact });
  assert.equal(calls.find(call => call.action === 'resolve').args.source, 'contacts');
  assert.equal(calls.at(-1).args.source, 'contacts');
});

test('directory candidate count exceeds the former visible-chat limit without accepting unbounded lists', async () => {
  const labels = Array.from({ length: 75 }, (_, i) => '对象' + i);
  const { bridge } = bridgeFixture((action, args) => {
    if (action === 'list') return { available: true, account, source: 'contacts', candidates: labels, current: null };
    if (action === 'resolve') return { account, contact: { id: labels.indexOf(args.label).toString(16).padStart(64, '0'), label: args.label, kind: 'person' } };
  });
  assert.equal((await bridge.scan()).contacts.length, 75);
  for (const list of [
    { source: 'contacts', candidates: Array(1001).fill(person.label) },
    { source: 'invented-api', candidates: [person.label] },
  ]) {
    const { bridge: invalid } = bridgeFixture(action => action === 'list' ? { available: true, account, current: null, ...list } : undefined);
    await assert.rejects(invalid.scan(), { code: 'ai_contacts_unavailable' });
  }
});

test('native directory batching resolves at most ten contacts and skips ambiguous labels', async () => {
  const labels = Array.from({ length: 23 }, (_, i) => '对象' + i);
  const people = labels.map((label, i) => ({ id: i.toString(16).padStart(64, '0'), label, kind: 'person' }));
  const { bridge, calls } = bridgeFixture((action, args) => {
    if (action === 'list') return { available: true, account, source: 'contacts', batchResolve: true, current: null, candidates: [...labels.slice(0, 4), '同名', ...labels.slice(4), '同名'] };
    if (action === 'resolve-batch') return { account, results: args.labels.map(label => ({ account, contact: people.find(p => p.label === label) })) };
    throw Error('Unexpected single-contact resolution');
  });
  const progress = [];
  const result = await bridge.scan({ onProgress: value => progress.push(value.completed) });
  assert.deepEqual(result.contacts, people);
  assert.equal(result.unreadableCount, 2);
  assert.deepEqual(calls.filter(c => c.action === 'resolve-batch').map(c => c.args.labels.length), [10, 10, 3]);
  assert.equal(progress.at(-1), 24);
});

test('malformed or mismatched batched contacts never publish bindings', async () => {
  for (const results of [[], [null], [{ account, contact: { ...person, label: '其他人' } }]]) {
    const { bridge } = bridgeFixture(action => action === 'list'
      ? { available: true, account, source: 'contacts', batchResolve: true, current: null, candidates: [person.label] }
      : { account, results });
    await assert.rejects(bridge.scan());
    assert.equal(bridge.bindings.size, 0);
  }
});

test('cancelling from contacts progress stops before another profile is opened or bindings published', async () => {
  const controller = new AbortController();
  const { bridge, calls } = bridgeFixture(action => action === 'list'
    ? { available: true, account, source: 'contacts', candidates: [person.label, '下一位'], current: null }
    : undefined);
  const progress = [];
  await assert.rejects(bridge.scan({ signal: controller.signal, onProgress: item => {
    progress.push(item.completed);
    if (item.completed === 1) controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual(progress, [0, 1]);
  assert.deepEqual(calls.map(call => call.action), ['list', 'resolve']);
  await assert.rejects(bridge.read({ account, contact }), /请先检测/);
});

test('contacts retrieval reports a contacts-specific error instead of current-conversation failure', async () => {
  const { bridge } = bridgeFixture(action => action === 'list' ? { available: false, error: 'contacts-unavailable' } : undefined);
  await assert.rejects(bridge.scan(), { code: 'ai_contacts_unavailable', message: '暂时无法获取联系人，请确认微信已登录后重试' });
});

test('unreadable directory profiles never masquerade as a successfully empty address book', async () => {
  const { bridge } = bridgeFixture(action => action === 'list'
    ? { available: true, account, source: 'contacts', candidates: [person.label], current: null }
    : action === 'resolve' ? { available: false, error: 'unsupported' } : undefined);
  await assert.rejects(bridge.scan(), { code: 'ai_contacts_unavailable' });
  await assert.rejects(bridge.read({ account, contact }), /请先检测/);
});

test('read uses verified bindings, preserves native revisions, and assigns stable temporary IDs', async () => {
  let messages = [{ ...other('原始消息'), id: 'untrusted-native-id' }], currentRevision = revision;
  const { bridge, calls } = bridgeFixture(action => action === 'read' ? snapshot(messages, { revision: currentRevision }) : undefined);
  await bridge.scan();
  const first = await bridge.read({ account, contact, label: '伪造对象' });
  assert.equal(first.revision, revision);
  assert.match(first.messages[0].id, /^temporary:/);
  assert.notEqual(first.messages[0].id, 'untrusted-native-id');
  assert.equal(calls.at(-1).args.label, person.label);
  assert.deepEqual(await bridge.read({ account, contact }), first);
  messages = [...messages, other('新增消息')]; currentRevision = nextRevision;
  const next = await bridge.read({ account, contact });
  assert.equal(next.messages[0].id, first.messages[0].id);
  assert.notEqual(next.messages[1].id, first.messages[0].id);
  assert.equal(next.revision, nextRevision);
  const count = calls.length;
  await assert.rejects(bridge.read({ account: changedAccount, contact }), /请先检测/);
  await assert.rejects(bridge.read({ account, contact: second, label: person.label }), /请先检测/);
  assert.equal(calls.length, count);
});

test('scan rejects an oversized list, conflicting IDs and a failed restoration without publishing bindings', async () => {
  const cases = [
    (action) => action === 'list' ? { available: true, account, candidates: Array(51).fill(person.label), current: null } : undefined,
    (action, args) => action === 'list' ? { available: true, account, candidates: [person.label, '另一名称'], current: null } : action === 'resolve' ? { account, contact: { ...person, label: args.label } } : undefined,
    (action, args) => action === 'list' ? { available: true, account, candidates: [person.label], current: { ...person, id: second, label: '原会话' } } : action === 'resolve' && args.label === '原会话' ? { available: false, error: 'unsupported' } : undefined,
  ];
  for (const handler of cases) {
    const { bridge } = bridgeFixture(handler);
    await assert.rejects(bridge.scan());
    await assert.rejects(bridge.read({ account, contact }), /请先检测/);
  }
});

test('scan never swallows account changes, cancellation or arbitrary native failures as an unsupported candidate', async () => {
  for (const failure of [
    { available: false, error: 'unsupported', account: changedAccount },
    { error: 'account-changed' }, { error: 'account_changed' },
    { error: 'cancelled' }, { error: 'unavailable' },
  ]) {
    const { bridge, calls } = bridgeFixture(action => action === 'resolve' ? failure : undefined);
    await assert.rejects(bridge.scan());
    assert.deepEqual(calls.map(call => call.action), ['list', 'resolve']);
    await assert.rejects(bridge.read({ account, contact }), /请先检测/);
  }
  const controller = new AbortController();
  const { bridge, calls } = bridgeFixture(action => {
    if (action === 'resolve') { controller.abort(); return { available: false, error: 'unsupported' }; }
  });
  await assert.rejects(bridge.scan({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls.map(call => call.action), ['list', 'resolve']);
});

test('the entire scan including restoration stays ahead of queued read operations', async () => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers(); let firstResolve = true;
  const { bridge, calls } = bridgeFixture(async action => {
    if (action === 'resolve' && firstResolve) { firstResolve = false; reached.resolve(); await release.promise; }
  });
  const scanning = bridge.scan(); await reached.promise;
  const reading = bridge.read({ account, contact });
  assert.deepEqual(calls.map(call => call.action), ['list', 'resolve']);
  release.resolve(); await scanning; await reading;
  assert.deepEqual(calls.map(call => call.action), ['list', 'resolve', 'resolve', 'read']);
});

test('a cancelled queued operation never reaches the native helper and does not poison the queue', async () => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController(); let firstList = true;
  const { bridge, calls } = bridgeFixture(async action => {
    if (action === 'list' && firstList) { firstList = false; reached.resolve(); await release.promise; }
  });
  const scanning = bridge.scan(); await reached.promise;
  const reading = bridge.read({ account, contact, signal: controller.signal });
  const rejected = assert.rejects(reading, { name: 'AbortError' });
  controller.abort(); release.resolve(); await scanning; await rejected;
  assert.equal(calls.some(call => call.action === 'read'), false);
  assert.equal((await bridge.read({ account, contact })).messages.length, 1);
});

test('waitForIdle does not cancel operations and waits for an aborted helper to finish', async () => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
  const { bridge } = bridgeFixture(async action => {
    if (action === 'read') { reached.resolve(); await release.promise; }
  });
  await bridge.scan();
  const reading = bridge.read({ account, contact, signal: controller.signal });
  const rejected = assert.rejects(reading, { name: 'AbortError' });
  await reached.promise;
  let idle = false;
  const barrier = bridge.waitForIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(controller.signal.aborted, false); assert.equal(idle, false);
  controller.abort(); await Promise.resolve(); assert.equal(idle, false);
  release.resolve(); await rejected; await barrier; assert.equal(idle, true);
});

test('scans and WeChat process changes discard all previous temporary IDs and verified bindings', async () => {
  const { bridge, runtime, calls } = bridgeFixture();
  await bridge.scan(); const first = await bridge.read({ account, contact });
  await bridge.scan(); const rescanned = await bridge.read({ account, contact });
  assert.notEqual(first.messages[0].id, rescanned.messages[0].id);
  runtime.processes[0].process.pid = 456;
  const count = calls.length;
  await assert.rejects(bridge.read({ account, contact }), /请先检测/);
  assert.equal(calls.length, count);
  await bridge.scan(); const restarted = await bridge.read({ account, contact });
  assert.notEqual(restarted.messages[0].id, rescanned.messages[0].id);
  runtime.processes[0].process = { pid: 456 };
  await assert.rejects(bridge.read({ account, contact }), /请先检测/);
  await bridge.scan(); const reusedPid = await bridge.read({ account, contact });
  assert.notEqual(reusedPid.messages[0].id, restarted.messages[0].id);
  runtime.status = 'stopped'; assert.deepEqual(await bridge.scan(), { available: false });
});

test('each scan request checks cancellation and the original process again after native completion', async () => {
  const { bridge, runtime, calls } = bridgeFixture(action => {
    if (action === 'resolve') runtime.processes[0].process.pid = 456;
  });
  await assert.rejects(bridge.scan(), /微信连接已断开/);
  assert.deepEqual(calls.map(call => call.action), ['list', 'resolve']);
});

test('unsupported reads and invalid snapshots fail instead of creating an empty conversation', async () => {
  for (const result of [
    { available: false, error: 'unsupported' },
    snapshot([], { account: changedAccount }), snapshot([], { contact: second }),
    snapshot([], { revision: 'invalid' }), snapshot([{ direction: 'other', text: 123 }]),
  ]) {
    const { bridge } = bridgeFixture(action => action === 'read' ? result : undefined);
    await bridge.scan(); await assert.rejects(bridge.read({ account, contact }));
  }
});

test('a confirmed send returns the newly aligned self message ID and the original after revision', async () => {
  let sent = false;
  const after = snapshot([other('原始消息'), self('确认发送')], { revision: nextRevision });
  const { bridge, calls } = bridgeFixture(action => {
    if (action === 'send') { sent = true; return { status: 'sent', snapshot: after }; }
    if (action === 'read' && sent) return after;
  });
  await bridge.scan(); const before = await bridge.read({ account, contact });
  const result = await bridge.send({ account, contact, revision, text: '确认发送', label: '伪造对象' });
  assert.equal(result.status, 'sent'); assert.equal(result.revision, nextRevision);
  assert.match(result.messageId, /^temporary:/); assert.notEqual(result.messageId, before.messages[0].id);
  assert.deepEqual(calls.find(call => call.action === 'send').args, { account, contact, label: person.label, revision, text: '确认发送' });
  const observed = await bridge.read({ account, contact });
  assert.equal(observed.messages[0].id, before.messages[0].id);
  assert.equal(observed.messages.at(-1).id, result.messageId);
});

test('send requires a matching observed baseline and preserves a native stale result', async () => {
  const { bridge, calls } = bridgeFixture(action => action === 'send' ? { status: 'stale' } : undefined);
  await bridge.scan();
  assert.deepEqual(await bridge.send({ account, contact, revision, text: '消息' }), { status: 'stale' });
  assert.equal(calls.some(call => call.action === 'send'), false);
  await bridge.read({ account, contact });
  assert.deepEqual(await bridge.send({ account, contact, revision: nextRevision, text: '消息' }), { status: 'stale' });
  assert.equal(calls.some(call => call.action === 'send'), false);
  assert.deepEqual(await bridge.send({ account, contact, revision, text: '消息' }), { status: 'stale' });
});

test('send cannot confirm missing, mismatched, preexisting or ambiguously aligned receipts', async () => {
  const cases = [
    { result: { status: 'uncertain' } },
    { result: { status: 'sent' } },
    { result: { status: 'sent', snapshot: snapshot([other('原始消息'), self('另一条')], { revision: nextRevision }) } },
    { result: { status: 'sent', snapshot: snapshot([other('原始消息'), other('确认发送')], { revision: nextRevision }) } },
    { result: { status: 'sent', snapshot: snapshot([other('原始消息'), self('确认发送')]) } },
    { result: { status: 'sent', snapshot: snapshot([self('确认发送')], { revision: nextRevision }) }, before: [self('确认发送')] },
    { result: { status: 'sent', snapshot: snapshot([other('重复'), other('重复'), self('确认发送')], { revision: nextRevision }) }, before: [other('重复'), other('重复')] },
    { result: { status: 'sent', snapshot: snapshot([other('原始消息'), self('确认发送')], { account: changedAccount, revision: nextRevision }) } },
  ];
  for (const { result, before } of cases) {
    const { bridge } = bridgeFixture(action => action === 'send' ? result : action === 'read' && before ? snapshot(before) : undefined);
    await bridge.scan(); await bridge.read({ account, contact });
    assert.deepEqual(await bridge.send({ account, contact, revision, text: '确认发送' }), { status: 'uncertain' });
  }
});

test('errors or cancellation after entering the native send are uncertain and are never retried', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const { bridge, calls } = bridgeFixture(action => {
      if (action === 'send') {
        if (cancel) { controller.abort(); return { status: 'sent', snapshot: snapshot([other('原始消息'), self('确认发送')], { revision: nextRevision }) }; }
        throw new Error('private helper failure');
      }
    });
    await bridge.scan(); await bridge.read({ account, contact });
    assert.deepEqual(await bridge.send({ account, contact, revision, text: '确认发送', signal: controller.signal }), { status: 'uncertain' });
    assert.equal(calls.filter(call => call.action === 'send').length, 1);
  }
});

for (const draftCleanup of ['cleared', 'blocked', undefined]) {
  test(`manual Enter after interrupted send requires a verified empty draft (${draftCleanup || 'missing receipt'})`, async () => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
    const { bridge } = bridgeFixture(async action => {
      if (action === 'send') { entered.resolve(); await release.promise; return { status: 'uncertain', draftCleanup }; }
    });
    await bridge.scan(); await bridge.read({ account, contact });
    const sending = bridge.send({ account, contact, revision, text: '本轮自动草稿', signal: controller.signal });
    await entered.promise;
    const writes = [], gate = new RfbInputGate({ beforeInput: async () => { controller.abort(); await bridge.waitForIdle(); },
      write: bytes => { writes.push(Buffer.from(bytes)); } });
    await gate.feed(Buffer.from('RFB 003.008\n\x01\x01'));
    writes.length = 0;
    const enter = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
    const input = gate.feed(enter);
    release.resolve();
    assert.deepEqual(await sending, { status: 'uncertain' });
    if (draftCleanup !== 'cleared') {
      await input;
      assert.deepEqual(writes, []);
      assert.equal(bridge.manualInputBlocked, true);
      bridge.clearContext(); bridge.clear();
      await assert.rejects(bridge.waitForIdle(), { code: 'ai_input_pending' });
      bridge.releaseManualBlock();
      await bridge.waitForIdle();
      assert.equal(bridge.manualInputBlocked, false);
    } else {
      await input;
      assert.deepEqual(writes, [enter]);
      assert.equal(bridge.manualInputBlocked, false);
    }
    await gate.close().catch(() => {});
  });
}

test('an unexpected send failure allows editing and automatically resolves a verified draft', async () => {
  const { bridge, runtime } = bridgeFixture(action => { if (action === 'send') throw new Error('private helper failure'); });
  await bridge.scan(); await bridge.read({ account, contact });
  assert.deepEqual(await bridge.send({ account, contact, revision, text: '草稿' }), { status: 'uncertain' });
  await assert.rejects(bridge.waitForIdle(), { code: 'ai_input_pending' });
  await bridge.waitForIdle({type:'key',down:true,submitKey:false}); // Editing remains available.
  const invoke = bridge.invoke; bridge.invoke = async (...args) => args[0] === 'input-status' ? {safe:true,resolved:true} : invoke(...args);
  await bridge.waitForIdle({type:'key',down:true,submitKey:true});
  assert.equal(bridge.manualInputBlocked,false);
  runtime.processes[0].process = { pid: 456 };
  await bridge.scan(); await bridge.waitForIdle();
  assert.equal(bridge.manualInputBlocked, false);
});

test('SIGTERM cleanup receipts are still read before the aborted process request rejects', async () => {
  for (const draftCleanup of ['cleared', 'blocked', undefined]) {
    const controller = new AbortController(), entered = Promise.withResolvers(), process = { pid: 123 };
    const runtime = { status: 'running', desktopEnv: {}, runtimeRoot: '/fixture/runtime', appRoot: '/fixture/app', processes: [{ name: 'wechat', process }] };
    const bridge = new NativeChatBridge(runtime, { spawnProcess() {
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = signal => {
        assert.equal(signal, 'SIGTERM');
        queueMicrotask(() => { child.stdout.end(JSON.stringify({ status: 'uncertain', draftCleanup })); child.emit('close', 0); });
        return true;
      };
      entered.resolve();
      return child;
    } });
    const context = { pid: process.pid, process, signal: controller.signal };
    const request = bridge.request('send', { text: 'fixture draft' }, context);
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await entered.promise; controller.abort(); await rejected;
    assert.equal(bridge.manualInputBlocked, draftCleanup !== 'cleared');
    assert.equal(context.draftSafe, draftCleanup === 'cleared');
  }
});

