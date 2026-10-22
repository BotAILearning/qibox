import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { currentAccountIdentity, currentAccountState, verifyAccountScope, unverifiedAccountState, accountStopAction, accountRequestScope, withAccountRequestScope } from '../server/ai-account-scope.mjs';
import { ChatFixture, key, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture();
  const counts = { identity: 0, scan: 0, model: 0, send: 0 };
  bridge.stableMessageIds = true; bridge.contacts[0].kind = kind;
  const oldAccount = bridge.account, newAccount = key('native-switch-before-ai-scan');
  const identity = bridge.currentAccount.bind(bridge), scan = bridge.scan.bind(bridge);
  bridge.currentAccount = async () => { counts.identity++; return identity(); };
  bridge.scan = async (...args) => { counts.scan++; return scan(...args); };
  bridge.send = async () => { counts.send++; throw Error('No fixture send expected'); };
  const provider = Object.fromEntries(['complete','test','models'].map(name => [name, async () => { counts.model++; throw Error('No model requests expected'); }]));
  const a = new AIAssistant({ dataRoot: root, bridge, provider });
  await a.init(); await a.configure(modelConfig); await a.scan();
  if (kind === 'group') await a.setGroupOptions({ contact: bridge.contacts[0].id, atMe: false, atAll: false, realtime: false });
  else await a.setReplyOptions({ contact: bridge.contacts[0].id, enabled: false });
  await a.configuration({ type: 'personal-information', account: oldAccount, entries: [{ field: 'city', text: 'OLD_ACCOUNT_PRIVATE_CITY' }] });
  counts.identity = 0; counts.scan = 0;
  t.after(async () => { await a.close(); assert.equal(counts.model, 0); assert.equal(counts.send, 0); await cleanup(root); });
  return { a, bridge, counts, oldAccount, newAccount, contact: bridge.contacts[0].id };
}

for (const kind of ['person', 'group']) test(`${kind}: native identity changes before a scan reject cached object edits without persistence`, async t => {
  const f = await fixture(t, kind), before = await readFile(f.a.file, 'utf8');
  f.bridge.account = f.newAccount;
  await assert.rejects(kind === 'person' ? f.a.setReplyOptions({ contact: f.contact, enabled: true }) : f.a.setGroupOptions({ contact: f.contact, atMe: true }), { code: 'AI_SCOPE_CHANGED' });
  assert.equal(await readFile(f.a.file, 'utf8'), before);
  assert.equal(f.a.data.account, f.oldAccount); assert.equal(f.counts.scan, 0); assert.equal(f.counts.identity, 1);
});

for (const action of ['master', 'learning', 'personal', 'global']) test(`${action}: native identity changes before a scan reject old-account configuration`, async t => {
  const f = await fixture(t), before = await readFile(f.a.file, 'utf8'); f.bridge.account = f.newAccount;
  const actions = {
    master: () => f.a.settings({ enabled: true }), learning: () => f.a.settings({ autoLearning: true }),
    personal: () => f.a.configuration({ type: 'personal-information', account: f.oldAccount, entries: [{ field: 'city', text: 'WRONG_ACCOUNT_CHANGE' }] }),
    global: () => f.a.configuration({ type: 'global-reply-strategy', account: f.oldAccount, changes: { facts: 'WRONG_ACCOUNT_CHANGE' }, expected: { facts: f.a.globalReplyStrategy().facts || '' } }),
  };
  await assert.rejects(actions[action](), { code: 'AI_SCOPE_CHANGED' });
  assert.equal(await readFile(f.a.file, 'utf8'), before); assert.equal(f.counts.scan, 0); assert.equal(f.counts.identity, 1);
});

test('concurrent live/full reads share only an in-flight identity, scan once on a real switch, and never return old private fields', async t => {
  const f = await fixture(t); f.bridge.account = f.newAccount;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.bridge.currentAccount = async () => { f.counts.identity++; entered.resolve(); await release.promise; return { account: f.bridge.account }; };
  const reads = [currentAccountState(f.a), currentAccountState(f.a, { live: true }), currentAccountState(f.a)];
  await entered.promise; release.resolve();
  for (const state of await Promise.all(reads)) {
    assert.equal(state.account, f.newAccount); assert.equal(state.settings.enabled, false);
    assert.equal(JSON.stringify(state).includes('OLD_ACCOUNT_PRIVATE_CITY'), false);
  }
  assert.equal(f.counts.identity, 1); assert.equal(f.counts.scan, 1);
  const last = await currentAccountState(f.a, { live: true });
  assert.equal(last.compact, true); assert.equal(f.counts.identity, 2); assert.equal(f.counts.scan, 1);
});

test('unknown or stopped identity cannot expose cached private state; stopped state retains instance model settings', async t => {
  const f = await fixture(t);
  f.bridge.currentAccount = async () => { throw Error('synthetic identity read unavailable'); };
  await assert.rejects(currentAccountState(f.a), { code: 'AI_ACCOUNT_UNVERIFIED' });
  f.a.ready = () => false;
  const state = await currentAccountState(f.a);
  assert.equal(state.scopeUnknown, true); assert.equal(state.settings.enabled, false); assert.equal(state.provider.hasKey, true);
  assert.equal(state.account, null); assert.deepEqual(state.profiles, []); assert.deepEqual(state.personalInformation.entries, []);
  assert.equal(JSON.stringify(state).includes('OLD_ACCOUNT_PRIVATE_CITY'), false);
});

test('a state read joins an existing account scan without cancelling it or starting another scan', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.bridge.account = f.newAccount;
  f.bridge.scan = async ({ signal }) => { f.counts.scan++; entered.resolve(); await release.promise; signal.throwIfAborted(); return { available: true, account: f.bridge.account, contacts: f.bridge.contacts }; };
  const scan = f.a.scan(); await entered.promise;
  const state = currentAccountState(f.a); await new Promise(resolve => setImmediate(resolve));
  release.resolve(); await scan;
  assert.equal((await state).account, f.newAccount); assert.equal(f.counts.scan, 1);
});

test('failed switch scans release the shared refresh and retry without exposing old state or re-enabling the master', async t => {
  const f = await fixture(t); f.bridge.account = f.newAccount;
  const scan = f.bridge.scan; let fail = true;
  f.bridge.scan = async (...args) => { if (fail) throw Error('synthetic unavailable contact snapshot'); return scan(...args); };
  await assert.rejects(currentAccountState(f.a), /synthetic unavailable contact snapshot/);
  assert.equal(f.a.accountStateRefresh, null); assert.equal(f.a.data.settings.enabled, false);
  fail = false; const result = await currentAccountState(f.a);
  assert.equal(result.account, f.newAccount); assert.equal(result.settings.enabled, false);
  assert.equal(JSON.stringify(result).includes('OLD_ACCOUNT_PRIVATE_CITY'), false); assert.equal(f.a.accountStateRefresh, null);
});

test('a slow identity request never holds cancel or a later master close; the older enable cannot revive it', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.a.data.settings.enabled = true;
  f.bridge.currentAccount = async () => { entered.resolve(); await release.promise; return { account: f.oldAccount }; };
  const oldSignal = f.a.controller.signal;
  const opening = f.a.settings({ enabled: true }); const rejected = assert.rejects(opening, { code: 'AI_SETTINGS_CHANGED' });
  await entered.promise;
  await f.a.settings({ enabled: false });
  assert.equal(f.a.data.settings.enabled, false); assert.equal(oldSignal.aborted, true);
  await f.a.cancel(); assert.equal(f.a.data.settings.enabled, false);
  release.resolve(); await rejected;
  assert.equal(f.a.data.settings.enabled, false);
});

test('a slow object identity check does not hold the parent master close', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.a.data.settings.enabled = true;
  f.bridge.currentAccount = async () => { entered.resolve(); await release.promise; return { account: f.oldAccount }; };
  const pending = f.a.setReplyOptions({ contact: f.contact, enabled: true }); await entered.promise;
  await f.a.settings({ enabled: false }); assert.equal(f.a.data.settings.enabled, false);
  release.resolve(); await pending; assert.equal(f.a.data.settings.enabled, false);
});

test('closing during a held object persistence aborts running work immediately and commits after that transaction', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.a.data.settings.enabled = true;
  const save = f.a.save;
  f.a.save = async function (...args) { entered.resolve(); await release.promise; return save.apply(this, args); };
  const signal = f.a.controller.signal;
  const pending = f.a.setReplyOptions({ contact: f.contact, enabled: true }); await entered.promise;
  const closing = f.a.settings({ enabled: false });
  assert.equal(signal.aborted, true); assert.ok(f.a.pendingSettingsStop);
  await f.a.tick(); assert.equal(f.counts.model, 0); assert.equal(f.counts.send, 0);
  release.resolve(); await pending; await closing; f.a.save = save;
  assert.equal(f.a.data.settings.enabled, false); assert.equal(f.a.pendingSettingsStop, null);
  assert.equal(JSON.parse(await readFile(f.a.file, 'utf8')).settings.enabled, false);
});

test('an older object identity result joins a still-persisting urgent close instead of nesting transactions', async t => {
  const f = await fixture(t), identityEntered = Promise.withResolvers(), identityRelease = Promise.withResolvers();
  const writeEntered = Promise.withResolvers(), writeRelease = Promise.withResolvers();
  f.a.data.settings.enabled = true;
  f.bridge.currentAccount = async () => { identityEntered.resolve(); await identityRelease.promise; return { account: f.oldAccount }; };
  const save = f.a.save;
  f.a.save = async function (...args) { writeEntered.resolve(); await writeRelease.promise; return save.apply(this, args); };
  const object = f.a.setReplyOptions({ contact: f.contact, enabled: true }); await identityEntered.promise;
  const closing = f.a.settings({ enabled: false }); await writeEntered.promise;
  assert.ok(f.a.urgentSettingsStop); identityRelease.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.a.data.settings.enabled, false); assert.equal(f.a.profiles()[0].replyOptions.enabled, false);
  writeRelease.resolve(); await closing; await object; f.a.save = save;
  assert.equal(f.a.data.settings.enabled, false); assert.equal(f.a.urgentSettingsStop, null);
  assert.equal(f.a.profiles()[0].replyOptions.enabled, true);
});

test('stop exceptions contain only explicit closes; mixed enables still require identity', () => {
  assert.equal(accountStopAction({ action: 'settings', value: { enabled: false } }), true);
  assert.equal(accountStopAction({ action: 'settings', value: { enabled: true, reply: false } }), false);
  assert.equal(accountStopAction({ action: 'settings', value: { enabled: false, autoLearning: true } }), false);
  assert.equal(accountStopAction({ action: 'cancel' }), true);
  assert.equal(accountStopAction({ action: 'targets', ids: [] }), false);
  assert.equal(accountStopAction({ action: 'proactive-task', value: { command: 'end' } }), false);
  assert.equal(accountStopAction({ action: 'proactive-task', value: { command: 'pause' } }), true);
});

for (const wait of ['queue','writes']) for (const action of ['personal','global','object',...(wait==='queue'?['master','learning']:['group','targets','end'])]) {
  test(`${wait} wait: ${action} rechecks native account after the wait and cannot persist old-account edits`, async t=>{
    const f=await fixture(t,action==='group'?'group':'person'),release=Promise.withResolvers(),entered=Promise.withResolvers();
    let taskId;
    if(action==='targets')await f.a.targets([f.a.profiles()[0].id]);
    if(action==='end'){
      const created=await f.a.proactiveTaskAction({command:'create',name:'排队门禁任务',taskType:'custom',contacts:[f.contact],goal:'不调用模型',schedule:{cycle:'weekly',mode:'fixed',time:'14:40',weekdays:[5]}});
      taskId=created.proactiveTasks[0].id;await f.a.settings({enabled:false,proactive:false});
    }
    const before=await readFile(f.a.file,'utf8');
    let held;
    if(wait==='queue'){held=f.a.exclusive(async()=>{entered.resolve();await release.promise;});await entered.promise;}
    else {await f.a.writes;f.a.writes=release.promise;}
    const actions={
      personal:()=>f.a.configuration({type:'personal-information',account:f.oldAccount,entries:[{field:'city',text:'WRONG_QUEUED_NATIVE_ACCOUNT'}]}),
      global:()=>f.a.configuration({type:'global-reply-strategy',account:f.oldAccount,changes:{facts:'WRONG_QUEUED_NATIVE_ACCOUNT'},expected:{facts:f.a.globalReplyStrategy().facts||''}}),
      object:()=>f.a.setReplyOptions({contact:f.contact,enabled:true}),group:()=>f.a.setGroupOptions({contact:f.contact,atMe:true}),
      master:()=>f.a.settings({enabled:true}),learning:()=>f.a.settings({autoLearning:true}),
      targets:()=>f.a.targets([], 'reply'),end:()=>f.a.proactiveTaskAction({command:'end',id:taskId}),
    };
    const operation=actions[action](),rejected=assert.rejects(operation,{code:'AI_SCOPE_CHANGED'});
    await new Promise(resolve=>setImmediate(resolve));f.bridge.account=f.newAccount;release.resolve();await held;await rejected;
    assert.equal(await readFile(f.a.file,'utf8'),before);assert.equal(f.a.data.account,f.oldAccount);assert.equal(f.counts.scan,0);
  });
}

test('a close overtakes a slow second identity verification at the commit boundary and prevents revival', async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();let reads=0;
  f.a.data.settings.enabled=true;
  f.bridge.currentAccount=async()=>{if(++reads===2){entered.resolve();await release.promise;}return {account:f.oldAccount};};
  const operation=f.a.settings({enabled:true}),rejected=assert.rejects(operation,{code:'AI_SETTINGS_CHANGED'});
  await entered.promise;await f.a.settings({enabled:false});assert.equal(f.a.data.settings.enabled,false);
  release.resolve();await rejected;assert.equal(f.a.data.settings.enabled,false);
});

test('request account context is assistant-local and expires for callbacks inherited after the request completes', async t=>{
  const f=await fixture(t),release=Promise.withResolvers();let deferred;
  await withAccountRequestScope(f.a,f.oldAccount,async()=>{
    assert.equal(accountRequestScope(f.a),f.oldAccount);assert.equal(accountRequestScope({}),null);
    deferred=(async()=>{await release.promise;assert.equal(accountRequestScope(f.a),null);return f.a.exclusive(()=>verifyAccountScope(f.a));})();
  });
  f.bridge.account=f.newAccount;await f.a.scan();release.resolve();assert.equal(await deferred,f.newAccount);
  await assert.rejects(withAccountRequestScope(f.a,f.oldAccount,()=>verifyAccountScope(f.a)),{code:'AI_SCOPE_CHANGED'});
  assert.equal(accountRequestScope(f.a),null);
});
