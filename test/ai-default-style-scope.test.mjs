import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key, learnedStyle } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const options = { dataRoot, bridge, provider }, instances = [];
  const create = async () => { const a = new AIAssistant(options); instances.push(a); await a.init(); return a; };
  const a = await create(); await a.configure(modelConfig); await a.scan(); await a.settings({ replyScope: 'all', enabled: true });
  assert.equal(a.profiles().length, 3);
  const first = bridge.account, second = key('style-account-two');
  const switchTo = async account => { bridge.account = account; await a.scan(); };
  t.after(async () => { for (const instance of instances) await instance.close(); await cleanup(dataRoot); });
  return { a, bridge, provider, first, second, switchTo, create };
}

test('legacy default belongs only to its recorded account, both accounts restore their own default after restart', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'STYLE_ACCOUNT_A' });
  const firstStyle = structuredClone(f.a.publicState().learnedDefaultStyle);
  await f.switchTo(f.second); assert.equal(f.a.publicState().learnedDefaultStyle, null);
  assert.ok(f.a.profiles().every(p => f.a.effectiveStyle(p).summary !== 'STYLE_ACCOUNT_A'));
  await f.a.commitDefaultStyle({ summary: 'STYLE_ACCOUNT_B' });
  await f.switchTo(f.first); assert.deepEqual(f.a.publicState().learnedDefaultStyle, firstStyle);
  const restarted = await f.create();
  assert.equal(restarted.publicState().learnedDefaultStyle.style.summary, 'STYLE_ACCOUNT_A');
  f.bridge.account = f.second; await restarted.scan();
  assert.equal(restarted.publicState().learnedDefaultStyle.style.summary, 'STYLE_ACCOUNT_B');
  const saved = JSON.parse(await readFile(restarted.file, 'utf8'));
  assert.doesNotMatch(JSON.stringify(saved.accountDefaultStyles), /STYLE_ACCOUNT_A|STYLE_ACCOUNT_B/, 'account default archive is encrypted');
  assert.doesNotMatch(JSON.stringify(restarted.publicState()), /STYLE_ACCOUNT_A/, 'inactive account default and object styles stay out of public state');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('default learning undo and clear affect only their account and keep a manual object style', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'DEFAULT_A_OLD' });
  await f.a.saveReplyProfile({ contact: f.bridge.contacts[0].id, styleId: 'new-custom', style: { summary: 'OBJECT_A_MANUAL' }, strategy: {}, preserveSwitches: true });
  await f.a.learn({ contacts: [f.bridge.contacts[0].id], asDefault: true });
  assert.equal(f.a.publicState().defaultStyleUndoable, true);
  await f.switchTo(f.second); assert.equal(f.a.publicState().defaultStyleUndoable, false);
  await f.a.commitDefaultStyle({ summary: 'DEFAULT_B' }); await f.a.clearDefaultStyle();
  await f.switchTo(f.first); assert.equal(f.a.publicState().defaultStyleUndoable, true);
  await f.a.cancelDefaultStyle(); assert.equal(f.a.publicState().learnedDefaultStyle.style.summary, 'DEFAULT_A_OLD');
  assert.ok(f.a.profiles().some(p => f.a.effectiveStyle(p).summary === 'OBJECT_A_MANUAL'));
  assert.equal(f.bridge.sent.length, 0);
});

test('old-account delayed default commands and a real account change without scan are rejected before mutation', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'FIRST_DEFAULT' });
  await f.switchTo(f.second); const before = structuredClone(f.a.data);
  const methods = ['saveDefaultStyle','commitDefaultStyle','clearDefaultStyle','applyDefaultStyle','cancelDefaultStyle'];
  for (const method of methods) await assert.rejects(f.a[method]({ account: f.first, summary: 'STALE_DEFAULT' }), e => e.code === 'ai_account_changed');
  await assert.rejects(f.a.learn({ account: f.first, contacts: [f.bridge.contacts[0].id], asDefault: true }), e => e.code === 'ai_account_changed');
  assert.deepEqual(f.a.data, before); assert.equal(f.provider.calls.length, 0);
  f.bridge.account = f.first;
  await assert.rejects(f.a.commitDefaultStyle({ account: f.second, summary: 'WRONG_ACCOUNT' }), e => e.code === 'ai_account_changed');
  assert.deepEqual(f.a.data, before);
});

test('a queued old-account style save cannot run after a contact scan changes the account', async t => {
  const f = await fixture(t); let release;
  f.a.actions = new Promise(resolve => { release = resolve; });
  const pending = f.a.commitDefaultStyle({ summary: 'OLD_QUEUED_DEFAULT' });
  await f.switchTo(f.second); release();
  await assert.rejects(pending, e => e.code === 'ai_account_changed');
  assert.equal(f.a.publicState().learnedDefaultStyle, null); assert.equal(f.provider.calls.length, 0);
});

test('verified legacy identity migration preserves its default while same-label accounts do not', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'MIGRATED_DEFAULT' });
  const previousContact = f.bridge.contacts[0].id, newContact = key('new-contact-key');
  f.bridge.account = f.second; f.bridge.contacts = [{ id: newContact, label: '测试对象甲', kind: 'person' }];
  f.bridge.scan = async () => ({ available: true, account: f.second, contacts: f.bridge.contacts, identities: [{ id: newContact, previous: { account: f.first, contact: previousContact } }] });
  await f.a.scan(); assert.equal(f.a.publicState().learnedDefaultStyle.style.summary, 'MIGRATED_DEFAULT');
});

test('a failed default commit retains the effective style and object state, with no candidate becoming active', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'EFFECTIVE_OLD_DEFAULT' });
  const before = structuredClone(f.a.publicState()), save = f.a.save;
  f.a.save = async () => { throw Error('fixture disk full'); };
  await assert.rejects(f.a.commitDefaultStyle({ summary: 'UNSAVED_DEFAULT' }), /fixture disk full/);
  f.a.save = save;
  assert.deepEqual(f.a.publicState().learnedDefaultStyle, before.learnedDefaultStyle);
  assert.deepEqual(f.a.publicState().profiles, before.profiles);
});

for (const method of ['saveDefaultStyle','clearDefaultStyle','applyDefaultStyle','cancelDefaultStyle']) test(`failed ${method} restores the account default, undo and object styles`, async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'OLD_SAVED_DEFAULT' });
  if (method === 'cancelDefaultStyle') await f.a.learn({ contacts: [f.bridge.contacts[0].id], asDefault: true });
  const before = structuredClone(f.a.publicState()), save = f.a.save;
  f.a.save = async () => { throw Error('fixture unavailable disk'); };
  await assert.rejects(f.a[method]({ summary: 'UNSAVED_CANDIDATE' }), /fixture unavailable disk/); f.a.save = save;
  assert.deepEqual(f.a.publicState().learnedDefaultStyle, before.learnedDefaultStyle);
  assert.equal(f.a.publicState().defaultStyleUndoable, before.defaultStyleUndoable);
  assert.deepEqual(f.a.publicState().profiles, before.profiles);
});

test('old-account write failure cannot restore its defaults into the newly connected account', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'FIRST_SAVED_DEFAULT' });
  const save = f.a.save; let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  f.a.save = async () => { entered(); await new Promise(resolve => { release = resolve; }); throw Error('fixture old write failed'); };
  const pending = f.a.commitDefaultStyle({ summary: 'FIRST_PENDING_DEFAULT' }); await started;
  f.a.save = save; await f.switchTo(f.second); release();
  await assert.rejects(pending, /fixture old write failed/);
  assert.equal(f.a.publicState().learnedDefaultStyle, null);
  await f.a.commitDefaultStyle({ summary: 'SECOND_SAVED_DEFAULT' }); await f.switchTo(f.first);
  assert.equal(f.a.publicState().learnedDefaultStyle.style.summary, 'FIRST_SAVED_DEFAULT');
  await f.switchTo(f.second); assert.equal(f.a.publicState().learnedDefaultStyle.style.summary, 'SECOND_SAVED_DEFAULT');
});

test('an account change while default learning waits for a model discards the late result', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'FIRST_SAVED_DEFAULT' });
  let entered, release; const started = new Promise(resolve => { entered = resolve; });
  f.provider.next = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { style: learnedStyle('迟到的风格候选') }; };
  const pending = f.a.learn({ contacts: [f.bridge.contacts[0].id], asDefault: true }); await started;
  f.bridge.account = f.second; release(); await assert.rejects(pending, e => e.code === 'ai_account_changed');
  assert.equal(f.a.publicState().learnedDefaultStyle.style.summary, 'FIRST_SAVED_DEFAULT');
  await f.a.scan(); assert.equal(f.a.publicState().learnedDefaultStyle, null);
});

test('failed default learning persistence keeps the previous default and undo', async t => {
  const f = await fixture(t); await f.a.commitDefaultStyle({ summary: 'PREVIOUS_SAVED_DEFAULT' });
  const before = structuredClone(f.a.publicState()), save = f.a.save;
  f.provider.next = async () => {
    f.a.save = async () => { throw Error('fixture learning storage failed'); };
    return { style: learnedStyle('无法保存的学习结果') };
  };
  await assert.rejects(f.a.learn({ contacts: [f.bridge.contacts[0].id], asDefault: true }), /fixture learning storage failed/);
  f.a.save = save;
  assert.deepEqual(f.a.publicState().learnedDefaultStyle, before.learnedDefaultStyle);
  assert.equal(f.a.publicState().defaultStyleUndoable, before.defaultStyleUndoable);
  assert.deepEqual(f.a.publicState().profiles, before.profiles);
});
