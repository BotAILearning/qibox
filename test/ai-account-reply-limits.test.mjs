import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const accountA = key('reply-limits-account-A'), accountB = key('reply-limits-account-B');
async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), calls = { model: 0, read: 0, send: 0 };
  bridge.account = accountA;
  bridge.contacts = [{ id: key('same-contact-in-both-accounts'), label: '相同名称', kind },
    { id: key('explicit-contact-in-both-accounts'), label: '独立上限', kind },
    { id: key('other-kind-in-both-accounts'), label: '另一类型', kind: kind === 'person' ? 'group' : 'person' }];
  bridge.read = async () => { calls.read++; throw Error('No chat reads in reply-limit tests'); };
  bridge.send = async () => { calls.send++; throw Error('No message sends in reply-limit tests'); };
  const provider = Object.fromEntries(['complete', 'test', 'models'].map(name => [name, async () => { calls.model++; throw Error('No model requests in reply-limit tests'); }]));
  const options = { dataRoot: root, bridge, provider, delay: async () => {} };
  let a;
  const open = async () => { a = new AIAssistant(options); await a.init(); return a; };
  await open(); await a.scan();
  t.after(async () => { if (a && !a.closed) await a.close(); assert.deepEqual(calls, { model: 0, read: 0, send: 0 }); await cleanup(root); });
  return { bridge, calls, options, get a() { return a; },
    async switch(account) { bridge.account = account; await a.scan(); assert.equal(a.data.settings.enabled, false); },
    async restart() { await a.close(); await open(); await a.scan(); },
    async seedLegacy(account, limits) {
      await a.close(); const stored = JSON.parse(await readFile(a.file, 'utf8'));
      delete stored.accountReplyRoundLimits;
      if (account === undefined) delete stored.account; else stored.account = account;
      stored.replyRoundLimits = structuredClone(limits); stored.contacts = []; stored.lastScanAt = null;
      await writeFile(a.file, JSON.stringify(stored)); await open();
    },
    async ensure(target) {
      if (target.kind === 'person') await a.setReplyOptions({ contact: target.id, enabled: false });
      else await a.setGroupOptions({ contact: target.id, atMe: false, atAll: false, realtime: false });
      return a.profiles().find(profile => profile.contact === target.id);
    },
    global(maxRounds) { return a.configuration({ type: 'global-reply-strategy', strategy: { replyGoal: `账号${a.data.account}的目标`, facts: '', boundaries: '不能编造承诺', maxRounds } }); },
    bulk(value, scope = { account: a.data.account, contacts: bridge.contacts.filter(contact => contact.kind === kind).map(contact => contact.id) }) { return a.applyReplyLimitToKind(kind, value, scope); },
  };
}

for (const kind of ['person', 'group']) test(`bulk ${kind} defaults stay with their account through both directions, same IDs and restart`, async t => {
  const f = await fixture(t, kind), aTargets = f.bridge.contacts;
  await f.global(37);
  const aProfile = await f.ensure(aTargets[0]); aProfile.rounds = 3; aProfile.paused = true;
  const aOther = await f.ensure(aTargets[2]);
  await f.switch(accountB); await f.global(19);
  const bProfile = await f.ensure(aTargets[0]), bExplicit = await f.ensure(aTargets[1]);
  await f.a.saveReplyProfile({ contact: bExplicit.contact, style: f.a.publicState().schema.defaultStyle,
    strategy: { replyGoal: '独立目标', facts: '已确认事实', boundaries: '独立边界', maxRounds: 7 }, replyEnabled: false });
  assert.notEqual(aProfile.id, bProfile.id, 'Identical contact IDs must remain account-scoped');
  await f.switch(accountA); await f.bulk(13);
  assert.equal(f.a.strategy(aProfile, 'reply').maxRounds, 13);
  assert.equal(aProfile.rounds, 3); assert.equal(aProfile.paused, true);
  assert.equal(f.a.strategy(aOther, 'reply').maxRounds, 37);
  await f.switch(accountB);
  assert.equal(f.a.strategy(bProfile, 'reply').maxRounds, 19, 'An A-only bulk operation must not change B inherited limits');
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  assert.equal(f.a.strategy(bExplicit, 'reply').maxRounds, 7, 'Another account bulk action must preserve B explicit settings');
  assert.equal(bExplicit.replyStrategy.replyGoal, '独立目标'); assert.equal(bExplicit.replyStrategy.boundaries, '独立边界');
  await f.bulk(17); await f.restart();
  assert.equal(f.a.publicState().replyRoundLimits[kind], 17);
  await f.switch(accountA); await f.restart();
  assert.equal(f.a.publicState().replyRoundLimits[kind], 13);
  assert.equal(f.a.globalReplyStrategy().maxRounds, 37);
  assert.equal(f.a.strategy(f.a.profiles().find(p => p.id === aProfile.id), 'reply').maxRounds, 13);
  const future = { id: key(`future-${kind}`), kind, label: '未来新增同类' };
  f.bridge.contacts.push(future); await f.a.scan();
  assert.equal(f.a.strategy(await f.ensure(future), 'reply').maxRounds, 13);
  await f.switch(accountB);
  assert.equal(f.a.globalReplyStrategy().maxRounds, 19);
  assert.equal(f.a.strategy(await f.ensure(future), 'reply').maxRounds, 17);
});

test('person and group defaults remain independent and do not change global strategy precedence', async t => {
  const f = await fixture(t); await f.global(31);
  await f.bulk(13);
  const groups = f.bridge.contacts.filter(row => row.kind === 'group').map(row => row.id);
  await f.a.applyReplyLimitToKind('group', 8, { account: accountA, contacts: groups });
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: 13, group: 8 });
  assert.equal(f.a.globalReplyStrategy().maxRounds, 31);
  assert.equal(f.a.strategy({ kind: 'person' }, 'reply').maxRounds, 13);
  assert.equal(f.a.strategy({ kind: 'group' }, 'reply').maxRounds, 8);
  assert.equal(f.a.strategy({ kind: 'person', replyStrategy: { maxRounds: 5 } }, 'reply').maxRounds, 5);
  await f.switch(accountB);
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  assert.equal(f.a.strategy({ kind: 'person' }, 'reply').maxRounds, 50);
  assert.equal(f.a.strategy({ kind: 'group' }, 'reply').maxRounds, 50);
});

test('stale account or contact-snapshot confirmation returns 409 without changing either account', async t => {
  const f = await fixture(t); await f.bulk(13);
  const scope = { account: accountA, contacts: f.bridge.contacts.filter(row => row.kind === 'person').map(row => row.id) };
  const before = await readFile(f.a.file, 'utf8'), dataBefore = structuredClone(f.a.data);
  f.bridge.account = accountB;
  await assert.rejects(f.bulk(17, scope), error => error.status === 409 && error.code === 'AI_SCOPE_CHANGED');
  assert.deepEqual(f.a.data, dataBefore); assert.equal(await readFile(f.a.file, 'utf8'), before);
  f.bridge.account = accountA; f.bridge.contacts.push({ id: key('late-contact'), kind: 'person', label: '迟到新增' }); await f.a.scan();
  const changedBefore = structuredClone(f.a.data);
  await assert.rejects(f.bulk(17, scope), error => error.status === 409 && error.code === 'AI_SCOPE_CHANGED');
  assert.deepEqual(f.a.data, changedBefore);
  await f.switch(accountB);
  await assert.rejects(f.bulk(17, scope), error => error.status === 409 && error.code === 'AI_SCOPE_CHANGED');
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
});

test('legacy type defaults bind only to the account recorded in the saved file, even if native identity differs', async t => {
  const f = await fixture(t), legacy = { person: 13, group: 17 };
  f.bridge.account = accountB;
  await f.seedLegacy(accountA, legacy);
  assert.deepEqual(f.a.publicState().replyRoundLimits, legacy, 'Startup migration uses the recorded account, never native identity');
  await f.a.scan();
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  await f.restart(); assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  await f.switch(accountA); assert.deepEqual(f.a.publicState().replyRoundLimits, legacy);
});

for (const recorded of [undefined, null, 'not-a-verifiable-account']) test(`unattributed legacy limits stay preserved and never attach after first scan or restart (${String(recorded)})`, async t => {
  const f = await fixture(t), legacy = { person: 'unlimited', group: 99999, legacyNote: 'retain-orphan-exactly' };
  await f.seedLegacy(recorded, legacy);
  assert.deepEqual(f.a.data.replyRoundLimits, legacy);
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  await f.a.scan(); await f.restart();
  assert.deepEqual(f.a.data.replyRoundLimits, legacy, 'Unowned historical raw data must remain recoverable');
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  await f.switch(accountB); await f.bulk(7); await f.restart(); await f.switch(accountA);
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  assert.deepEqual(JSON.parse(await readFile(f.a.file, 'utf8')).replyRoundLimits, legacy);
});

test('legacy invalid defaults remain unconfirmed for their own account and never gate another account', async t => {
  const f = await fixture(t), legacy = { person: 'unlimited', group: 2001 };
  await f.seedLegacy(accountA, legacy); await f.a.scan();
  const person = await f.ensure(f.bridge.contacts[0]), group = await f.ensure(f.bridge.contacts[2]);
  assert.equal(f.a.strategy(person, 'reply').maxRounds, 'unlimited'); assert.equal(f.a.strategy(group, 'reply').maxRounds, 2001);
  assert.ok(f.a.publicState().profiles.every(profile => profile.replyLimitNeedsReview));
  await f.a.settings({ acknowledgeAI: true }); await f.restart();
  assert.deepEqual(f.a.publicState().replyRoundLimits, legacy);
  await f.switch(accountB); assert.deepEqual(f.a.publicState().replyRoundLimits, { person: null, group: null });
  await f.switch(accountA); await f.bulk(13);
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: 13, group: 2001 });
  assert.deepEqual(f.a.data.replyRoundLimits, legacy, 'Historical invalid values stay retained, not silently normalized');
  await f.restart();
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: 13, group: 2001 }, 'The existing account map must win over the retained legacy field');
});

test('failed bulk persistence restores both account defaults and object settings', async t => {
  const f = await fixture(t), target = await f.ensure(f.bridge.contacts[0]);
  await f.bulk(13);
  const dataBefore = structuredClone(f.a.data), fileBefore = await readFile(f.a.file, 'utf8');
  const failure = Object.assign(new Error('Controlled storage failure'), { code: 'ENOSPC' });
  const mock = t.mock.method(f.a, 'save', async () => { throw failure; });
  await assert.rejects(f.bulk(17), error => error === failure);
  assert.deepEqual(f.a.data, dataBefore); assert.equal(await readFile(f.a.file, 'utf8'), fileBefore);
  assert.equal(f.a.strategy(target, 'reply').maxRounds, 13);
  mock.mock.restore(); await f.restart();
  assert.equal(f.a.publicState().replyRoundLimits.person, 13);
});

test('malformed account-limit storage fails explicitly without replacing the saved file', async t => {
  const f = await fixture(t); await f.a.close();
  const saved = JSON.parse(await readFile(f.a.file, 'utf8')); saved.accountReplyRoundLimits[accountA] = null;
  const raw = JSON.stringify(saved); await writeFile(f.a.file, raw);
  const isolated = new AIAssistant(f.options);
  await assert.rejects(isolated.init(), error => error.code === 'ai_reply_limits_unreadable');
  await assert.rejects(isolated.save(), error => error.code === 'ai_reply_limits_unreadable');
  assert.equal(await readFile(f.a.file, 'utf8'), raw);
});

for (const existing of [undefined, {}, { person: 21, group: null }]) test(`verified native-to-data identity migration carries defaults only to an absent destination (${JSON.stringify(existing)})`, async t => {
  const f = await fixture(t), oldContact = f.bridge.contacts[0].id;
  await f.ensure(f.bridge.contacts[0]); await f.bulk(13);
  await f.a.applyReplyLimitToKind('group', 8);
  if (existing !== undefined) { f.a.data.accountReplyRoundLimits[accountB] = structuredClone(existing); await f.a.save(); }
  const source = structuredClone(f.a.data.accountReplyRoundLimits[accountA]);
  const migrated = { id: key('verified-new-contact-id'), label: '身份已核实', kind: 'person' };
  f.bridge.contacts = [migrated];
  f.bridge.scan = async () => ({ available: true, account: f.bridge.account, contacts: f.bridge.contacts,
    identities: [{ id: migrated.id, previous: { account: accountA, contact: oldContact } }] });
  await f.switch(accountB);
  const expected = existing === undefined ? source : { person: null, group: null, ...existing };
  assert.deepEqual(f.a.publicState().replyRoundLimits, expected);
  assert.deepEqual(f.a.data.accountReplyRoundLimits[accountA], source);
  assert.equal(f.a.profiles().find(profile => profile.contact === migrated.id).replyStrategy.maxRounds, 13);
  const future = { id: key('verified-future-contact'), kind: 'person', label: '迁移后新对象' };
  f.bridge.contacts.push(future); await f.a.scan();
  assert.equal(f.a.strategy(await f.ensure(future), 'reply').maxRounds, expected.person ?? 50);
  await f.restart(); assert.deepEqual(f.a.publicState().replyRoundLimits, expected);
});

test('failed verified identity migration restores its source and retries safely on a new scan', async t => {
  const f = await fixture(t), oldContact = f.bridge.contacts[0].id;
  await f.ensure(f.bridge.contacts[0]); await f.bulk(13);
  await f.a.commitDefaultStyle({ summary: '旧身份的已确认默认风格' });
  const fileBefore = await readFile(f.a.file, 'utf8');
  const migrated = { id: key('failed-migration-new-contact'), label: '身份已核实', kind: 'person' };
  f.bridge.contacts = [migrated];
  f.bridge.scan = async () => ({ available: true, account: f.bridge.account, contacts: f.bridge.contacts,
    identities: [{ id: migrated.id, previous: { account: accountA, contact: oldContact } }] });
  const original = f.a.save.bind(f.a), failure = new Error('Controlled migration persistence failure');
  let fail = true;
  t.mock.method(f.a, 'save', async () => { if (fail) { fail = false; throw failure; } return original(); });
  await assert.rejects(f.switch(accountB), error => error === failure);
  assert.equal(f.a.data.account, accountA); assert.equal(f.a.available, false); assert.equal(f.a.contacts.size, 0);
  assert.equal(Object.hasOwn(f.a.data.accountReplyRoundLimits, accountB), false);
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: 13, group: null });
  assert.equal(f.a.data.defaultStyleAccount, accountA);
  assert.equal(f.a.data.learnedDefaultStyle.style.summary, '旧身份的已确认默认风格');
  assert.equal(await readFile(f.a.file, 'utf8'), fileBefore);
  await f.a.scan();
  assert.equal(f.a.data.account, accountB); assert.equal(f.a.available, true);
  assert.deepEqual(f.a.publicState().replyRoundLimits, { person: 13, group: null });
  await f.restart(); assert.deepEqual(f.a.publicState().replyRoundLimits, { person: 13, group: null });
});
