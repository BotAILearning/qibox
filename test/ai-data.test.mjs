import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DataChatBridge } from '../server/ai-data.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
import { defaultStyle } from '../server/ai-schema.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const account = key('data-account'), contact = key('contact-a'), second = key('contact-b'), revision = key('r1');
const person = { id: contact, label: '同名联系人', kind: 'person', native: { account: key('native-account'), contact: key('native-contact') } };
const snapshot = { account, contact, revision, messages: [
  { id: key('m1'), direction: 'self', text: 'DATA_PRIVATE_TEXT', timestamp: 100 },
  { id: key('m2'), direction: 'other', text: 'DATA_PRIVATE_TEXT', timestamp: 101 },
] };
const dataSnapshot = { ...snapshot, label: person.label, native: person.native };
function fixture(handler) {
  const calls = [];
  const runtime = { status: 'running', desktopEnv: {}, processes: [{ name: 'wechat', process: { pid: 123 } }],
    foregroundRequested() { assert.fail('Data reads must never navigate the desktop'); } };
  const bridge = new DataChatBridge(runtime, { invoke() { assert.fail('Data reads must not use native UI'); },
    async invokeData(action, args, context) {
      calls.push({ action, args });
      const result = await handler?.(action, args, context) ?? (['contacts', 'identity'].includes(action)
        ? { available: true, account, contacts: [person, { ...person, id: second, native: { ...person.native, contact: key('native-b') } }] }
        : { ...structuredClone(snapshot), contact: args.contact });
      return ['read', 'read-range'].includes(action) ? { label: person.label, native: { ...person.native,
        contact: args.contact === second ? key('native-b') : person.native.contact }, ...result,
        ...(action === 'read-range' ? { from: args.from, to: args.to, rangeRevision: key(`range-${args.contact}`) } : {}) } : result;
    } });
  return { bridge, runtime, calls };
}

async function receiptFixture({ status = 'uncertain', response, unsafe = false, throws = false, committed = true } = {}) {
  const { bridge, runtime } = fixture();
  const text = '已发送的测试内容。', outgoing = { id: key('receipt'), direction: 'self', text, timestamp: 102 };
  const counters = { dispatches: 0, reads: 0 }; let dispatched = false;
  const read = bridge.invokeData;
  bridge.invokeData = async (action, args, context) => {
    if (action !== 'read' || !dispatched) return read(action, args, context);
    counters.reads++;
    return response ? response({ args, context, bridge, runtime, outgoing, attempt: counters.reads })
      : { ...dataSnapshot, revision: key('receipt-db'), messages: [...snapshot.messages, outgoing] };
  };
  bridge.invokePrepared = async (route, value, context, verify) => {
    assert.equal(await verify({ ...person.native, revision: key('guard') }), true);
    counters.dispatches++; dispatched = true; context.delivery.started = committed;
    if (committed) bridge.noteDraftResult({ draftCleanup: unsafe ? 'blocked' : 'not-needed' }, context);
    if (throws) throw new Error('native observation ended');
    return { status, draftCleanup: unsafe ? 'blocked' : 'not-needed' };
  };
  await bridge.scan(); await bridge.read({ account, contact });
  return { bridge, runtime, counters, text, outgoing };
}

test('contacts and history use data only, preserving duplicate labels and true message IDs', async () => {
  const { bridge, calls } = fixture();
  const result = await bridge.scan();
  assert.equal(result.contacts.length, 2); assert.equal(result.contacts[0].label, result.contacts[1].label);
  assert.notEqual(result.contacts[0].id, result.contacts[1].id);
  assert.equal('native' in result.contacts[0], false);
  assert.deepEqual(await bridge.read({ account, contact }), snapshot);
  assert.deepEqual(await bridge.read({ account, contact }), snapshot);
  assert.deepEqual(calls.map(x => x.action), ['contacts', 'read', 'read']);
  bridge.clearContext(); assert.equal(bridge.snapshots.size, 0);
});
test('an interactive read overtakes background reads already waiting on the data pipe', async () => {
  const order = []; let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const { bridge } = fixture(async (action, args) => {
    if (action !== 'read') return undefined;
    calls++; order.push(calls === 1 ? 'held' : args.contact === second ? 'background' : 'interactive');
    if (calls === 1) return await blocked.then(() => ({ ...snapshot, contact: args.contact }));
    return { ...snapshot, contact: args.contact };
  });
  await bridge.scan();
  const held = bridge.read({ account, contact });
  const background = [bridge.read({ account, contact: second }), bridge.read({ account, contact: second })];
  await Promise.resolve(); await Promise.resolve();
  // What "核对" asks for: run right after the current read, ahead of the queue.
  const interactive = bridge.read({ account, contact, priority: true });
  release();
  await interactive;
  assert.deepEqual(order, ['held', 'interactive', 'background', 'background']);
  await Promise.all([held, ...background]);
});
test('data failure never falls back to a contacts UI scan', async () => {
  const { bridge, calls } = fixture(() => ({ error: 'data-unavailable' }));
  await assert.rejects(bridge.scan(), { code: 'ai_data_unavailable' });
  assert.deepEqual(calls.map(x => x.action), ['contacts']);
  assert.equal(bridge.bindings.size, 0);
});

test('voice conversion verifies message, account, revisions and reuses only the same incoming voice', async () => {
  const voice = { id: key('voice-in'), direction: 'other', type: 'voice', text: '[语音]', timestamp: 102 };
  const { bridge, runtime } = fixture(action => action === 'read' ? { ...dataSnapshot, messages: [...snapshot.messages, voice] } : undefined);
  runtime.foregroundRequested = async () => {}; let conversions = 0;
  bridge.invoke = async (action, args) => { assert.equal(action, 'transcribe'); assert.equal(args.messageId, voice.id); conversions++; return { ...person.native, messageId: voice.id, text: '周六可以。' }; };
  await bridge.scan(); const before = await bridge.read({ account, contact });
  const request = { account, contact, revision: before.revision, messageId: voice.id };
  assert.equal((await bridge.transcribe(request)).text, '周六可以。');
  assert.equal((await bridge.transcribe(request)).source, 'wechat'); assert.equal(conversions, 1);
  assert.deepEqual(await bridge.transcribe({ ...request, revision: key('changed') }), { status: 'stale' });
  await assert.rejects(bridge.transcribe({ ...request, messageId: snapshot.messages[0].id }));
  bridge.clearContext(); bridge.invoke = async () => ({ ...person.native, messageId: key('wrong'), text: '错误对象' });
  await assert.rejects(bridge.transcribe(request));
});

test('background navigation inherits a read-only descriptor and closes it after the native child exits', async () => {
  let closed = false, child;
  const runtime = { status: 'running', desktopEnv: {}, runtimeRoot: '/runtime', appRoot: '/app', processes: [{ name: 'wechat', process: { pid: 123 } }] };
  const bridge = new DataChatBridge(runtime, { openMemory: async (file, flags) => {
    assert.equal(file, '/proc/123/mem'); assert.equal(flags, 'r'); return { fd: 17, close: async () => { closed = true; } };
  }, spawnProcess(_exe, _args, options) {
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore', 17]);
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.stdin.on('finish', () => { assert.equal(closed, false); child.stdout.end(JSON.stringify({ account: person.native.account, contact: person.native.contact, opened: true })); child.emit('close', 0); });
    return child;
  } });
  await bridge.invokeProcess('open-chat', { background: { account, contact } }, { pid: 123, process: runtime.processes[0].process });
  assert.equal(closed, true);
});

test('explicit review navigation checks the bound native identity without inserting or sending text', async () => {
  const { bridge, runtime } = fixture(); const native = [];
  runtime.foregroundRequested = async () => {};
  bridge.invoke = async (action, args) => { native.push({ action, args }); return { account: args.account, contact: args.contact, opened: true }; };
  await bridge.scan(); const read = bridge.invokeData; bridge.invokeData = (action, ...args) => { assert.notEqual(action, 'read', 'navigation must survive unreadable message bodies'); return read(action, ...args); }; await bridge.openChat({ account, contact: second });
  assert.equal(native.length, 1); assert.equal(native[0].action, 'open-chat');
  assert.equal(native[0].args.contact, key('native-b')); assert.equal(native[0].args.text, undefined);
  bridge.invoke = async () => ({ account: person.native.account, contact: key('wrong-person'), revision });
  await assert.rejects(bridge.openChat({ account, contact: second }));
});
test('verified native open returns only the open-chat result', async () => {
  const { bridge, runtime } = fixture();
  runtime.foregroundRequested = async () => {};
  await bridge.scan();
  bridge.invoke = async (action, args) => {
    assert.equal(action, 'open-chat');
    assert.equal(args.locate, undefined);
    return { account: args.account, contact: args.contact, opened: true };
  };
  assert.deepEqual(await bridge.openChat({ account, contact }), { opened: true });
});
test('native open rejects an unverified chat result', async () => {
  const { bridge, runtime } = fixture();
  runtime.foregroundRequested = async () => {};
  await bridge.scan();
  bridge.invoke = async (action, args) => {
    assert.equal(action, 'open-chat');
    return { available: false, error: 'unsupported', opened: false,
      diagnostic: { phase: 'native-navigation', code: 'controls-unavailable', detail: 'PRIVATE_CHAT_TEXT' } };
  };
  await assert.rejects(bridge.openChat({ account, contact }), { code: 'ai_data_unavailable' });
});
test('cancel, process changes and account changes discard returned data', async () => {
  for (const change of ['cancel', 'process', 'account']) {
    const controller = new AbortController();
    const { bridge, runtime } = fixture(action => {
      if (action !== 'read') return;
      if (change === 'cancel') controller.abort();
      if (change === 'process') runtime.processes[0].process = { pid: 123 };
      return { ...snapshot, ...(change === 'account' ? { account: key('other-account') } : {}) };
    });
    await bridge.scan();
    await assert.rejects(bridge.read({ account, contact, signal: controller.signal }));
    assert.equal(bridge.snapshots.size, 0);
  }
});
test('stale inconclusive UI observations do not block independently verified background reads', async () => {
  const { bridge, runtime, calls } = fixture();
  runtime.loginState = { refresh: async () => {}, state: () => 'unknown', entryAvailable: () => true };
  await bridge.scan(); await bridge.read({ account, contact });
  assert.deepEqual(calls.map(call => call.action), ['contacts', 'read']);
});

test('an inconclusive login observation keeps background reads working; an explicit logout stops them', async () => {
  // A native inspection that cannot see the WeChat window returns 'unknown'.
  // That is not a logout: the private read independently validates the process,
  // the active account and every database page, so it must still run. Blocking
  // it used to make every chat read fail for the whole window - minutes after a
  // restart - with a message that looked like a lost WeChat session.
  for (const state of ['unknown', 'logged-in']) {
    const { bridge, runtime, calls } = fixture();
    runtime.loginState = { refresh: async () => {}, state: () => state, entryAvailable: () => state === 'logged-in', loggedOut: () => false };
    await bridge.scan(); await bridge.read({ account, contact });
    assert.deepEqual(calls.map(call => call.action), ['contacts', 'read']);
  }
  for (const state of ['logged-out', 'relogin-required']) {
    const { bridge, runtime, calls } = fixture();
    runtime.loginState = { refresh: async () => {}, state: () => state, entryAvailable: () => false, loggedOut: () => true };
    await assert.rejects(bridge.scan(), { code: 'ai_wechat_logged_out' }); assert.equal(calls.length, 0);
  }
  const { bridge, runtime } = fixture(action => {
    if (action === 'read') runtime.loginState.loggedOut = () => true;
  });
  await bridge.scan();
  runtime.loginState = { refresh: async () => {}, entryAvailable: () => true, loggedOut: () => false };
  await assert.rejects(bridge.read({ account, contact }), { code: 'ai_wechat_logged_out' });
});
test('unbound contacts, duplicate message IDs and invalid senders are rejected', async () => {
  for (const invalid of [
    { ...snapshot, contact: second },
    { ...snapshot, messages: [snapshot.messages[0], snapshot.messages[0]] },
    { ...snapshot, messages: [{ ...snapshot.messages[0], direction: 'guess' }] },
  ]) {
    const { bridge } = fixture(action => action === 'read' ? invalid : undefined);
    await bridge.scan();
    await assert.rejects(bridge.read({ account, contact }));
    await assert.rejects(bridge.read({ account, contact: key('unbound') }));
  }
});
test('selected data histories are learned per contact without persisting text', async t => {
  const root = await temp(), { bridge, calls } = fixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  provider.next = async () => ({ style: { language: '口语简洁', rhythm: '回复及时', interaction: '自然提问', emotion: '温和', role: '平等交流' }, memory: { entries: [{ text: '长期事实' }] } });
  await a.learn({ contacts: [contact, second] });
  assert.equal(calls.filter(c => c.action === 'read-range').length, 2);
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls.map(call => call.input.contact), [contact, second]);
  assert.deepEqual(provider.calls[0].input.material, snapshot.messages.map(({ direction, text, timestamp }) => ({ direction, text, timestamp })));
  assert.equal((await readFile(path.join(root, 'ai-assistant.json'), 'utf8')).includes('DATA_PRIVATE_TEXT'), false);
  assert.equal(bridge.snapshots.size, 0);
});
test('data child inherits only a read-only descriptor and cancellation waits for its exit', async () => {
  const entered = Promise.withResolvers(), controller = new AbortController();
  let closed = false, child;
  const runtime = { status: 'running', desktopEnv: { HOME: '/private/profile' }, runtimeRoot: '/runtime', appRoot: '/app', processes: [{ name: 'wechat', process: { pid: 123 } }] };
  const bridge = new DataChatBridge(runtime, {
    async openMemory(file, flags) { assert.equal(file, '/proc/123/mem'); assert.equal(flags, 'r'); return { fd: 55, async close() { closed = true; } }; },
    spawnProcess(bin, args, options) {
      assert.equal(options.stdio[3], 55); assert.equal(options.stdio[2], 'ignore');
      assert.deepEqual(args, [path.join('/app', 'server/wechat-data.py'), '123', '--worker']);
      child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { assert.equal(closed, false); queueMicrotask(() => child.emit('close', 0)); return true; };
      entered.resolve(); return child;
    },
  });
  const work = bridge.scan({ signal: controller.signal }), rejected = assert.rejects(work, { name: 'AbortError' });
  await entered.promise; controller.abort(); await rejected;
  assert.equal(closed, true);
});
test('existing strategies migrate only through exact verified native identities', async t => {
  const root = await temp(), { bridge } = fixture();
  const a = new AIAssistant({ dataRoot: root, bridge }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const oldId = key(`${person.native.account}\0${person.native.contact}`);
  a.data.account = person.native.account;
  a.data.profiles[oldId] = { id: oldId, account: person.native.account, contact: person.native.contact, label: person.label,
    kind: 'person', style: defaultStyle, preparedAt: 100, replyStrategy: { replyGoal: '保留已有策略' } };
  a.data.replyTargets = [oldId];
  await a.scan();
  const migrated = a.profiles().find(p => p.contact === contact);
  assert.equal(migrated.replyStrategy.replyGoal, '保留已有策略');
  assert.deepEqual(a.data.replyTargets, [migrated.id]);
  assert.equal(a.data.settings.enabled, false);
  assert.equal(a.data.queue.status, 'idle');
});
test('send uses separate native revision and needs a newly committed database message', async () => {
  const { bridge, runtime } = fixture();
  runtime.foregroundRequested = async () => {};
  let sent = false;
  const original = bridge.invokeData;
  bridge.invokeData = async (action, args, context) => {
    if (sent && action === 'read') return { ...dataSnapshot, revision: key('r2'), messages: [...snapshot.messages,
      { id: key('m3'), direction: 'self', text: 'authorized fixture', timestamp: 102 }] };
    return original(action, args, context);
  };
  bridge.invoke = async (action, args) => {
    assert.equal(args.account, person.native.account); assert.equal(args.contact, person.native.contact);
    assert.equal('background' in args, false);
    if (action === 'read-guard') return { ...person.native, revision: key('native-r') };
    assert.equal(action, 'send-guard'); assert.equal(args.revision, key('native-r'));
    sent = true; return { status: 'submitted', draftCleanup: 'not-needed' };
  };
  await bridge.scan(); await bridge.read({ account, contact });
  assert.deepEqual(await bridge.send({ account, contact, revision: key('stale'), text: 'authorized fixture' }), { status: 'stale' });
  assert.deepEqual(await bridge.send({ account, contact, revision, text: 'authorized fixture' }), { status: 'sent', messageId: key('m3'), revision: key('r2') });
});

test('cancelling read-only send preparation does not become an uncertain dispatch', async () => {
  const { bridge, runtime } = fixture(); runtime.foregroundRequested = async () => {};
  const controller = new AbortController(), actions = [];
  bridge.invoke = async action => {
    actions.push(action); assert.equal(action, 'read-guard');
    controller.abort(); return { available: false, error: 'cancelled' };
  };
  await bridge.scan(); await bridge.read({ account, contact });
  assert.deepEqual(await bridge.send({ account, contact, revision, text: 'authorized fixture', signal: controller.signal }), { status: 'stale' });
  assert.deepEqual(actions, ['read-guard']);
  assert.equal(bridge.manualInputBlocked, false);
});

test('temporary login or native preparation failures are known not to have dispatched', async () => {
  for (const failure of ['login', 'read-guard']) {
    const { bridge, runtime } = fixture(); runtime.foregroundRequested = async () => {};
    await bridge.scan(); await bridge.read({ account, contact });
    const actions = [];
    runtime.loginState = { refresh: async () => {}, state: () => failure === 'login' ? 'logged-out' : 'logged-in',
      entryAvailable: () => failure !== 'login', loggedOut: () => failure === 'login' };
    bridge.invoke = async action => { actions.push(action); assert.equal(action, 'read-guard'); return { available: false, error: 'unsupported' }; };
    assert.deepEqual(await bridge.send({ account, contact, revision, text: 'authorized fixture' }), failure === 'login' ? { status: 'not-sent', reason: '微信当前未登录，请在应用里登录后重试' } : { status: 'not-sent', reason: '暂时无法读取微信数据，请检查当前微信会话后重试；此错误不代表微信一定未登录' });
    assert.deepEqual(actions, failure === 'login' ? [] : ['read-guard']);
    assert.equal(bridge.manualInputBlocked, false);
  }
});

test('account changes during send preparation remain an account error', async () => {
  const { bridge, runtime } = fixture(); runtime.foregroundRequested = async () => {};
  await bridge.scan(); await bridge.read({ account, contact });
  bridge.invoke = async action => { assert.equal(action, 'read-guard'); return { error: 'account-changed', account: key('changed-native-account') }; };
  await assert.rejects(bridge.send({ account, contact, revision, text: 'authorized fixture' }), { code: 'ai_account_changed' });
  assert.equal(bridge.manualInputBlocked, false);
});

test('native dispatch without a new database message never counts as sent or retries dispatch', async () => {
  const { bridge, runtime } = fixture(); runtime.foregroundRequested = async () => {};
  let dispatches = 0;
  bridge.invoke = async action => {
    if (action === 'read-guard') return { ...person.native, revision: key('guard') };
    assert.equal(action, 'send-guard'); dispatches++;
    return { status: 'submitted', draftCleanup: 'not-needed' };
  };
  await bridge.scan(); await bridge.read({ account, contact });
  assert.deepEqual(await bridge.send({ account, contact, revision, text: 'authorized fixture' }), { status: 'uncertain' });
  assert.equal(dispatches, 1);
});

test('prepared native sends still reject changed data and require a new database receipt', async () => {
  for (const changed of [false, true]) {
    const { bridge } = fixture(); let committed = false, checking = false;
    const read = bridge.invokeData;
    bridge.invokeData = async (...args) => {
      if (args[0] === 'read' && (committed || changed && checking)) return { ...dataSnapshot, revision: key('after'), messages: [...snapshot.messages,
        { id: key('new-message'), direction: committed ? 'self' : 'other', text: committed ? '测试发送。' : '新来信', timestamp: 103 }] };
      return read(...args);
    };
    bridge.invokePrepared = async (route, text, context, verify) => {
      assert.deepEqual(route, { ...person.native, label: person.label, kind: 'person', source: 'contacts', background: { account, contact } });
      checking = true;
      if (!await verify({ ...person.native, revision: key('native') })) return { status: 'stale' };
      context.delivery.started = true; committed = true; return { status: 'submitted', draftCleanup: 'not-needed' };
    };
    await bridge.scan(); await bridge.read({ account, contact });
    const result = await bridge.send({ account, contact, revision, text: '测试发送。' });
    assert.equal(result.status, changed ? 'stale' : 'sent');
    assert.equal(committed, !changed);
    if (!changed) assert.equal(result.messageId, key('new-message'));
  }
});

test('committed native uncertainty and observation errors use the same read-only receipt reconciliation', async () => {
  for (const throws of [false, true]) {
    const { bridge, counters, text, outgoing } = await receiptFixture({ throws });
    assert.deepEqual(await bridge.send({ account, contact, revision, text }),
      { status: 'sent', messageId: outgoing.id, revision: key('receipt-db') });
    assert.deepEqual(counters, { dispatches: 1, reads: 1 });
  }
});

test('transient receipt read failures retry only reads and can confirm the committed message', async () => {
  const { bridge, counters, text, outgoing } = await receiptFixture({ response: ({ attempt, outgoing }) => attempt < 3
    ? { error: 'data-unavailable' } : { ...dataSnapshot, revision: key('receipt-db'), messages: [...snapshot.messages, outgoing] } });
  assert.equal((await bridge.send({ account, contact, revision, text })).messageId, outgoing.id);
  assert.deepEqual(counters, { dispatches: 1, reads: 3 });
});

test('uncommitted uncertainty does not search for or claim an unrelated receipt', async () => {
  const { bridge, counters, text } = await receiptFixture({ committed: false });
  assert.deepEqual(await bridge.send({ account, contact, revision, text }), { status: 'uncertain' });
  assert.deepEqual(counters, { dispatches: 1, reads: 0 });
});

test('old IDs, missing history anchors, wrong bodies and multiple matching new self messages are not receipts', async () => {
  const variants = {
    old: ({ outgoing }) => [snapshot.messages[1], { ...outgoing, id: snapshot.messages[0].id }],
    missingAnchor: ({ outgoing }) => [outgoing],
    wrongBody: ({ outgoing }) => [...snapshot.messages, { ...outgoing, text: '其它发送内容。' }],
    duplicate: ({ outgoing }) => [...snapshot.messages, outgoing, { ...outgoing, id: key('second-receipt') }],
  };
  for (const [kind, messages] of Object.entries(variants)) {
    const { bridge, counters, text } = await receiptFixture({ response: value =>
      ({ ...dataSnapshot, revision: key('changed-' + kind), messages: messages(value) }) });
    assert.deepEqual(await bridge.send({ account, contact, revision, text }), { status: 'uncertain' });
    assert.equal(counters.dispatches, 1); assert.ok(counters.reads <= 5);
  }
});

test('foreign contacts/accounts, process changes and cancellation cannot supply a receipt', async () => {
  for (const change of ['contact', 'account', 'process', 'cancel']) {
    const controller = new AbortController();
    const { bridge, counters, text } = await receiptFixture({ response: ({ outgoing, runtime }) => {
      if (change === 'process') runtime.processes[0].process = { pid: 123 };
      if (change === 'cancel') controller.abort();
      return { ...dataSnapshot, ...(change === 'contact' ? { contact: second } : {}),
        ...(change === 'account' ? { account: key('foreign-account') } : {}),
        revision: key('receipt-db'), messages: [...snapshot.messages, outgoing] };
    } });
    const work = bridge.send({ account, contact, revision, text, signal: controller.signal });
    if (change === 'account') await assert.rejects(work, { code: 'ai_account_changed' });
    else assert.deepEqual(await work, { status: 'uncertain' });
    assert.equal(counters.dispatches, 1);
    if (change !== 'contact') assert.equal(counters.reads, 1);
  }
});

test('exhausted transient receipt reads never redispatch and preserve unsafe draft blocking', async () => {
  const failed = await receiptFixture({ response: () => ({ error: 'data-unavailable' }) });
  assert.equal((await failed.bridge.send({ account, contact, revision, text: failed.text })).status, 'uncertain');
  assert.deepEqual(failed.counters, { dispatches: 1, reads: 5 });
  const confirmed = await receiptFixture({ unsafe: true });
  assert.equal((await confirmed.bridge.send({ account, contact, revision, text: confirmed.text })).status, 'sent');
  assert.equal(confirmed.bridge.manualInputBlocked, true);
  assert.equal(confirmed.counters.dispatches, 1);
});

test('a later manual self message remains visible and the receipt cursor matches Python canonical hashing', async t => {
  const manual = { id: key('manual-after-receipt'), direction: 'self', text: '本人已经接手处理。', timestamp: 103 };
  const { bridge, text, outgoing } = await receiptFixture({ response: ({ outgoing }) =>
    ({ ...dataSnapshot, revision: key('full-after-manual'), messages: [...snapshot.messages, outgoing, manual] }) });
  const delivery = await bridge.send({ account, contact, revision, text });
  assert.equal(delivery.status, 'sent'); assert.equal(delivery.messageId, outgoing.id);
  // Reference produced independently by Python json.dumps(..., sort_keys=True,
  // ensure_ascii=False, separators=(',', ':')) + hashlib.sha256 for this prefix.
  assert.equal(delivery.revision, '852b828e3c3fca59401b2c0f6bdfee995cde849787177918853c075729154a39');
  const root = await temp(), assistant = new AIAssistant({ dataRoot: root, bridge }); await assistant.init();
  t.after(async () => { await assistant.close(); await cleanup(root); });
  const profile = { id: key('receipt-profile'), account, contact, paused: false };
  assistant.data.account = account; assistant.data.profiles[profile.id] = profile;
  assistant.cursors.set(profile.id, { revision: delivery.revision, last: delivery.messageId,
    own: delivery.messageId, sent: delivery.messageId, pending: false });
  const after = await bridge.read({ account, contact });
  assert.equal(after.revision, key('full-after-manual')); assert.equal(after.messages.at(-1).id, manual.id);
  await assistant.observe(profile, after);
  assert.equal(profile.paused, false); assert.equal(profile.manualWait.ownId, manual.id);
  assert.equal(assistant.cursors.get(profile.id).pending, false);
  assert.equal(assistant.data.events[0].code, 'manual');
});

test('a receipt followed by a new question keeps it pending and stops the old reply segments', async t => {
  const root = await temp(), { bridge } = fixture(), provider = new AIModelFixture();
  let now = 1000000, sequence = 0; const messages = structuredClone(snapshot.messages), sent = [];
  const fullSnapshot = () => ({ ...dataSnapshot, messages: structuredClone(messages),
    revision: key(JSON.stringify(messages, ['direction', 'id', 'text', 'timestamp'])) });
  const original = bridge.invokeData;
  bridge.invokeData = async (action, args, context) => action === 'read' && args.contact === contact ? fullSnapshot() : original(action, args, context);
  bridge.invokePrepared = async (route, text, context, verify) => {
    assert.equal(await verify({ ...person.native, revision: key('guard') }), true);
    context.delivery.started = true; sent.push(text);
    messages.push({ id: key('generated-' + ++sequence), direction: 'self', text, timestamp: Math.floor(now / 1000) });
    if (sent.length === 1) messages.push({ id: key('new-question'), direction: 'other', text: '新问题：番茄炒蛋怎么做？', timestamp: Math.floor(now / 1000) + 1 });
    bridge.noteDraftResult({ draftCleanup: 'not-needed' }, context);
    return { status: 'uncertain', draftCleanup: 'not-needed' };
  };
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await assistant.init(); t.after(async () => { await assistant.close(); await cleanup(root); });
  await assistant.configure(modelConfig); await assistant.scan();
  await assistant.saveReplyProfile({ contact, style: defaultStyle, strategy: { replyGoal: '回答当前的新问题', boundaries: '不擅自承诺' } });
  await assistant.settings({ enabled: true, replyScope: 'selected', multiTurn: true });
  await assistant.tick();
  messages.push({ id: key('old-question'), direction: 'other', text: '旧问题：出门带水还是咖啡？', timestamp: Math.floor(now / 1000) });
  await assistant.tick(); now += 20000;
  provider.next = async () => ({ action: 'send', segments: ['带水更合适。', '旧问题的第二段不应发送。'] });
  await assistant.tick();
  const profile = assistant.profiles().find(item => item.contact === contact);
  assert.deepEqual(sent, ['带水更合适。']);
  assert.equal(profile.paused, false); assert.equal(profile.delivery.status, 'sent');
  assert.equal(profile.delivery.interrupted, true); assert.equal(assistant.cursors.get(profile.id).pending, true);
  provider.next = async input => {
    assert.equal(input.messages.at(-1).text, '新问题：番茄炒蛋怎么做？');
    assert.equal(input.messages.at(-2).text, '带水更合适。');
    return { action: 'send', text: '先炒鸡蛋盛出，再炒番茄合起来。' };
  };
  now += 20000; await assistant.tick();
  assert.deepEqual(sent, ['带水更合适。', '先炒鸡蛋盛出，再炒番茄合起来。']);
  assert.equal(provider.calls.length, 2); assert.equal(assistant.cursors.get(profile.id).pending, false);
  now += 10000; await assistant.tick(); assert.equal(provider.calls.length, 2);
});

test('background data reads continue while a different contact holds the native send session', async () => {
  const { bridge } = fixture(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  await bridge.scan(); await bridge.read({ account, contact });
  bridge.invokePrepared = async () => { entered.resolve(); await gate.promise; return { status: 'stale' }; };
  const sending = bridge.send({ account, contact, revision, text: '尚未发送。' }); await entered.promise;
  let after;
  try {
    after = await Promise.race([bridge.read({ account, contact: second }), new Promise((_, reject) => setTimeout(() => reject(new Error('read blocked behind native send')), 1000))]);
    assert.equal(after.contact, second);
  } finally { gate.resolve(); }
  assert.equal((await sending).status, 'stale');
});

test('send refreshes changed remarks and native aliases while background identity remains stable', async () => {
  let reads = 0;
  const fresh = { label: '修改后的备注', native: { account: key('new-native-account-alias'), contact: key('new-native-contact-alias') } };
  const { bridge } = fixture(action => action === 'read' ? { ...snapshot, ...(++reads > 1 ? fresh : {}) } : undefined);
  await bridge.scan(); await bridge.read({ account, contact });
  const binding = bridge.bindings.get(contact);
  let prepared = 0;
  bridge.invokePrepared = async (route, text, context, verify) => {
    prepared++;
    assert.deepEqual(route, { ...fresh.native, label: fresh.label, kind: 'person', source: 'contacts', background: { account, contact } });
    assert.equal(await verify({ ...fresh.native, revision: key('fresh-native-revision') }), true);
    return { status: 'not-sent' };
  };
  assert.deepEqual(await bridge.send({ account, contact, revision, text: '测试发送。' }), { status: 'not-sent' });
  assert.equal(prepared, 1); assert.equal(reads, 3);
  assert.equal(bridge.bindings.get(contact), binding); assert.equal(binding.label, fresh.label);
  assert.deepEqual(bridge.snapshots.get(contact).revision, revision);
});

test('invalid fresh routing metadata fails before any native preparation', async () => {
  for (const invalid of [{ label: '' }, { label: undefined }, { native: undefined }, { native: { account, contact: 'guess' } }]) {
    const { bridge } = fixture();
    await bridge.scan(); await bridge.read({ account, contact });
    bridge.invokeData = async () => ({ ...dataSnapshot, ...invalid });
    bridge.invokePrepared = async () => assert.fail('Invalid routing metadata must not reach native UI');
    assert.deepEqual(await bridge.send({ account, contact, revision, text: '测试发送。' }), { status: 'not-sent', reason: '暂时无法读取微信数据，请检查当前微信会话后重试；此错误不代表微信一定未登录' });
  }
});

test('private session hints refresh before preparation and never enter public snapshots', async () => {
  const hint = { version: 1, pid: 123, processStart: '23456', buildId: 'a'.repeat(40),
    rootKey: key('active-root'), executableKey: key('executable'), manager: '0x123400', issuedAt: 0 };
  let reads = 0;
  const { bridge } = fixture(action => action === 'read' ? { ...dataSnapshot, sessionHint: { ...hint, issuedAt: ++reads } } : undefined);
  const scan = await bridge.scan();
  assert.equal(JSON.stringify(scan).includes('sessionHint'), false);
  assert.deepEqual(await bridge.read({ account, contact }), snapshot);
  bridge.invokePrepared = async (route, text, context, verify) => {
    assert.deepEqual(route.sessionHint, { ...hint, issuedAt: 2 });
    assert.equal(await verify({ ...person.native, revision: key('native') }), true);
    assert.equal(route.sessionHint.issuedAt, 2);
    assert.equal(bridge.bindings.get(contact).sessionHint.issuedAt, 3);
    return { status: 'not-sent' };
  };
  assert.equal((await bridge.send({ account, contact, revision, text: '测试发送。' })).status, 'not-sent');
  bridge.clearContext(); assert.equal(bridge.bindings.get(contact).sessionHint, undefined);
});

test('malformed and foreign-process session hints are discarded before native preparation', async () => {
  for (const hint of [{ manager: '0x1234' }, { version: 1, pid: 456, processStart: '23456', buildId: 'a'.repeat(40),
    rootKey: key('active-root'), executableKey: key('executable'), manager: '0x123400', issuedAt: 1 }]) {
    const { bridge } = fixture(action => action === 'read' ? { ...dataSnapshot, sessionHint: hint } : undefined);
    await bridge.scan(); await bridge.read({ account, contact });
    bridge.invokePrepared = async route => { assert.equal('sessionHint' in route, false); return { status: 'not-sent' }; };
    assert.equal((await bridge.send({ account, contact, revision, text: '测试发送。' })).status, 'not-sent');
  }
});
