import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { withAccountRequestScope } from '../server/ai-account-scope.mjs';
import { ChatFixture, AIModelFixture, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const options = { dataRoot: root, bridge, provider, now: () => 1792647000000 };
  const a = new AIAssistant(options); await a.init();
  clearInterval(a.timer); clearInterval(a.warmupTimer); await a.scan();
  for (const contact of bridge.contacts) await a.saveReplyProfile({ contact: contact.id, style: { summary: '合成简洁风格' }, strategy: { replyGoal: '合成目标', boundaries: '不作承诺' } });
  const save = a.save;
  t.after(async () => { a.save = save; await a.close(); await cleanup(root); });
  return { root, bridge, provider, options, a, save };
}
async function gateNextSave(f, { fail = true } = {}) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), originalFile = f.a.file;
  const blocked = path.join(f.root, 'real-atomic-rename-target-directory'); await mkdir(blocked);
  let first = true;
  f.a.save = function (...args) {
    if (!first) return f.save.apply(this, args);
    first = false; entered.resolve();
    return released.promise.then(async () => {
      if (fail) this.file = blocked;
      try { return await f.save.apply(this, args); } finally { this.file = originalFile; }
    });
  };
  return { entered: entered.promise, release: () => released.resolve(), file: originalFile };
}
const isFilesystemError = error => ['EISDIR', 'EPERM', 'EACCES', 'ENOTDIR', 'EEXIST'].includes(error.code);
const project = data => ({ skipIds: (data.skipLog || []).map(({ account, id }) => ({ account, id })), eventIds: (data.events || []).filter(row => row.code === 'skip').map(({ account, id }) => ({ account, id })), proactiveIds: (data.proactiveRecords || []).map(({ account, id }) => ({ account, id })), tombstones: (data.deletedActivityRecords || []).map(({ account, source, id }) => ({ account, source, id })) });
async function restartedProjection(f) {
  const a = new AIAssistant(f.options); await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  try { return project(a.data); } finally { await a.close(); }
}

for (const source of ['skip', 'reply', 'proactive', 'unknown']) test(`failed single ${source} record deletion cannot be published by overlapping saves or survive restart`, async t => {
  const f = await fixture(t), profile = f.a.profiles()[0]; let id;
  if (source === 'skip') id = f.a.event('skip', profile.id, 'system-skip', '合成未回记录', { messageId: key('post014-incoming'), reasonCode: 'model-no-reply' }).id;
  else if (source === 'proactive') { id = key('post014-proactive-record'); f.a.data.proactiveRecords = [{ id, account: f.a.data.account, profileId: profile.id, at: f.a.now(), status: 'sent' }]; }
  else { id = key('post014-confirmed-reply'); profile.sentMessages = [{ id, source: source === 'unknown' ? 'legacy' : 'reply', at: f.a.now(), body: f.a.vault.seal({ text: '合成确认发送记录' }) }]; }
  await f.a.save(); const before = project(f.a.data), gate = await gateNextSave(f);
  const deletion = f.a.deleteActivityRecord({ source, id });
  const rejected = assert.rejects(deletion, isFilesystemError); await gate.entered;
  f.a.data.post014IndependentProgress = 'must-survive'; const background = f.a.save();
  await new Promise(resolve => setImmediate(resolve)); gate.release();
  await rejected; await background;
  const disk = JSON.parse(await readFile(gate.file, 'utf8')), restarted = await restartedProjection(f);
  const observation = { source, id, before, memory: project(f.a.data), disk: project(disk), restarted, independentProgress: disk.post014IndependentProgress, simulatedModelRequests: f.provider.calls.length, fixtureWechatSends: f.bridge.sent.length, actualModelRequests: 0, actualWechatSends: 0, actualNetwork: 0 };
  t.diagnostic(JSON.stringify(observation));
  assert.deepEqual(project(f.a.data), before, 'failed deletion rolls back current memory');
  assert.deepEqual(project(disk), before, 'ordinary save cannot publish a rejected deletion');
  assert.deepEqual(restarted, before, 'restart must retain record after a rejected deletion');
  assert.equal(disk.post014IndependentProgress, 'must-survive');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

for (const source of ['skip', 'reply']) for (const scanReplacement of [false, true]) test(`scoped A single ${source} deletion rejects native B ${scanReplacement ? 'after real scan switches cached identity' : 'while cached identity is still A'} without private response or marker residue`, async t => {
  const f = await fixture(t), accountA = f.a.data.account, pA = f.a.profiles()[0];
  const removed = f.a.event('skip', pA.id, 'system-skip', 'A可删除合成记录', { messageId: key('post014-scope-a') });
  const targetId = source === 'skip' ? removed.id : key('post014-scope-reply');
  if (source === 'reply') pA.sentMessages = [{ id: targetId, source, at: f.a.now(), body: f.a.vault.seal({ text: '合成A回复记录' }) }];
  await f.a.save();
  const accountB = key('post014-private-account-B'); f.bridge.account = accountB; await f.a.scan();
  await f.a.saveDefaultStyle({ summary: 'B_ONLY_PRIVATE_STYLE_DO_NOT_RETURN_TO_A' });
  f.bridge.account = accountA; await f.a.scan();
  const gate = await gateNextSave(f, { fail: false });
  const deletion = withAccountRequestScope(f.a, accountA, () => f.a.deleteActivityRecord({ source, id: targetId }));
  const outcome = deletion.then(value => ({ value }), error => ({ error: { name: error.name, message: error.message, status: error.status, code: error.code } }));
  await gate.entered; f.bridge.account = accountB; const scan = scanReplacement ? f.a.scan() : Promise.resolve();
  if (scanReplacement) for (let i = 0; i < 1000 && f.a.data.account !== accountB; i++) await new Promise(resolve => setImmediate(resolve));
  const scanChangedBeforeRelease = f.a.data.account === (scanReplacement ? accountB : accountA);
  gate.release(); const response = await outcome; await scan; await f.a.writes;
  const returnedPrivateB = JSON.stringify(response.value || null).includes('B_ONLY_PRIVATE_STYLE_DO_NOT_RETURN_TO_A');
  t.diagnostic(JSON.stringify({ accountA, accountB, scanReplacement, scanChangedBeforeRelease, responseStatus: response.error?.status, responseCode: response.error?.code, returnedAccount: response.value?.account, returnedPrivateB, responseKeys: Object.keys(response.value || {}), simulatedModelRequests: f.provider.calls.length, fixtureWechatSends: f.bridge.sent.length, actualModelRequests: 0, actualWechatSends: 0, actualNetwork: 0 }));
  assert.equal(scanChangedBeforeRelease, true, 'native and cached identities reached the declared independent timing');
  assert.equal(response.error?.status, 409, 'old A request must reject after verified native/cache replacement');
  assert.equal(response.value, undefined, 'old A request must return no private state');
  for (const row of f.a.data.deletedActivityRecords || []) assert.equal(Object.getOwnPropertySymbols(row).length, 0, 'post-persist native409 must clear this transaction marker');
  assert.equal(returnedPrivateB, false); assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

for (const source of ['skip', 'proactive', 'reply', 'unknown']) test(`successful single ${source} deletion touches only its current-account record and survives restart`, async t => {
  const f = await fixture(t), account = f.a.data.account, profile = f.a.profiles()[0], otherAccount = key('post014-other-record-owner');
  const id = key('post014-delete-target'), kept = key('post014-delete-kept');
  if (source === 'skip') {
    f.a.data.skipLog = [{ id, account, target: profile.id, at: f.a.now() }, { id: kept, account, target: profile.id, at: f.a.now() }, { id, account: otherAccount, target: 'other-profile', at: f.a.now() }];
    f.a.data.events = f.a.data.skipLog.map(row => ({ ...row, code: 'skip' }));
  } else if (source === 'proactive') f.a.data.proactiveRecords = [{ id, account, profileId: profile.id, at: f.a.now() }, { id: kept, account, profileId: profile.id, at: f.a.now() }, { id, account: otherAccount, at: f.a.now() }];
  else {
    profile.sentMessages = [id, kept].map(id => ({ id, source: source === 'unknown' ? 'legacy' : 'reply', at: f.a.now(), body: f.a.vault.seal({ text: '合成原始记录正文必须保留' }) }));
    f.a.data.deletedActivityRecords = [{ id, account: otherAccount, source, at: f.a.now() }];
  }
  await f.a.save(); const sentBefore = structuredClone(profile.sentMessages || []);
  await f.a.deleteActivityRecord({ source, id });
  const disk = JSON.parse(await readFile(f.a.file, 'utf8')), expected = project(f.a.data), restarted = await restartedProjection(f);
  if (source === 'skip' || source === 'proactive') {
    const values = source === 'skip' ? expected.skipIds : expected.proactiveIds;
    assert.deepEqual(values, [{ account, id: kept }, { account: otherAccount, id }]);
    if (source === 'skip') assert.deepEqual(expected.eventIds, values);
  } else assert.deepEqual(expected.tombstones, [{ account, source, id }, { account: otherAccount, source, id }]);
  assert.deepEqual(project(disk), expected); assert.deepEqual(restarted, expected);
  assert.deepEqual(f.a.profile(profile.id).sentMessages || [], sentBefore, 'deleting display history does not delete authenticated sent metadata or encrypted source bodies');
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('queued A record deletion rechecks request identity before mutating after an actual switch to B', async t => {
  const f = await fixture(t), accountA = f.a.data.account, profile = f.a.profiles()[0];
  const event = f.a.event('skip', profile.id, 'system-skip', '合成排队删除', { messageId: key('post014-queued-delete') }); await f.a.save();
  const before = project(f.a.data), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const previous = f.a.exclusive(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const outcome = withAccountRequestScope(f.a, accountA, () => f.a.deleteActivityRecord({ source: 'skip', id: event.id })).then(value => ({ value }), error => ({ error }));
  f.bridge.account = key('post014-queued-B'); await f.a.scan(); release.resolve(); await previous;
  const response = await outcome; assert.equal(response.error?.status, 409); assert.equal(response.value, undefined);
  assert.deepEqual(project(f.a.data), before); assert.deepEqual(project(JSON.parse(await readFile(f.a.file, 'utf8'))), before);
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

test('failed single skip deletion restores its target without losing concurrent new records, another account, or independent profile progress', async t => {
  const f = await fixture(t), profile = f.a.profiles()[0], otherAccount = key('post014-failure-other-account');
  const event = f.a.event('skip', profile.id, 'system-skip', '目标合成记录', { messageId: key('post014-target-message') });
  event.at -= 2000; f.a.data.skipLog.find(row => row.id === event.id).at = event.at;
  f.a.data.skipLog.push({ id: event.id, account: otherAccount, target: 'other-profile', at: f.a.now() });
  f.a.data.events.push({ id: event.id, account: otherAccount, target: 'other-profile', code: 'skip', at: f.a.now() }); await f.a.save();
  const gate = await gateNextSave(f), deletion = f.a.deleteActivityRecord({ source: 'skip', id: event.id }), rejected = assert.rejects(deletion, isFilesystemError); await gate.entered;
  const incoming = f.a.event('skip', profile.id, 'system-skip', '并发新记录', { messageId: key('post014-new-message') });
  profile.post014IndependentProfileProgress = 'keep-new-progress'; const background = f.a.save(); gate.release(); await rejected; await background;
  const expectedIds = new Set([event.id, incoming.id]);
  for (const data of [f.a.data, JSON.parse(await readFile(f.a.file, 'utf8'))]) {
    assert.deepEqual(new Set(data.skipLog.filter(row => row.account === profile.account).map(row => row.id)), expectedIds);
    assert.deepEqual(new Set(data.events.filter(row => row.account === profile.account && row.code === 'skip').map(row => row.id)), expectedIds);
    assert.equal(data.skipLog.filter(row => row.account === otherAccount && row.id === event.id).length, 1);
    assert.equal(data.profiles[profile.id].post014IndependentProfileProgress, 'keep-new-progress');
    assert.equal(data.events[0].id, incoming.id, 'a failed older deletion cannot move its restored event above a newer concurrent event');
  }
  assert.deepEqual(await restartedProjection(f), project(f.a.data)); assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});

for (const fail of [true, false]) test(`${fail ? 'failed' : 'successful'} reply deletion follows a concurrent authenticated receipt alias without losing receipt progress or leaking a transaction marker`, async t => {
  const f = await fixture(t), profile = f.a.profiles()[0], account = profile.account;
  const oldId = key('post014-unknown-operation'), receiptId = key('post014-authenticated-receipt'), baseline = key('post014-receipt-baseline');
  const unrelated = { id: oldId, account: key('post014-alias-other-account'), source: 'reply', at: f.a.now() };
  profile.sentMessages = [{ id: oldId, source: 'reply', at: f.a.now(), baseline, confirmed: false, deliveryConfidence: 'unknown', body: f.a.vault.seal({ text: '合成唯一待核回复' }) }];
  f.a.data.deletedActivityRecords = [unrelated]; await f.a.save();
  const gate = await gateNextSave(f, { fail }), deletion = f.a.deleteActivityRecord({ source: 'reply', id: oldId });
  const outcome = deletion.then(value => ({ value }), error => ({ error })); await gate.entered;
  const changed = f.a.reconcileUnknownReplies(profile, { messages: [{ id: baseline, direction: 'other', text: '合成边界', timestamp: Math.floor(f.a.now() / 1000) - 1 }, { id: receiptId, direction: 'self', text: '合成唯一待核回复', timestamp: Math.floor(f.a.now() / 1000) }] });
  assert.equal(changed, true, 'the real receipt reconciler matched and changed the message identity');
  assert.equal(f.a.data.deletedActivityRecords.find(row => row.account === account)?.id, receiptId, 'the production alias path cloned the deletion record with the authenticated id');
  const background = f.a.save(); gate.release(); const response = await outcome; await background;
  if (fail) assert.ok(isFilesystemError(response.error)); else assert.equal(response.error, undefined);
  const disk = JSON.parse(await readFile(f.a.file, 'utf8'));
  for (const data of [f.a.data, disk]) {
    const receipt = data.profiles[profile.id].sentMessages[0];
    assert.equal(receipt.id, receiptId); assert.equal(receipt.operationId, oldId); assert.equal(receipt.confirmed, true); assert.equal(receipt.deliveryConfidence, 'confirmed');
    assert.deepEqual(data.profiles[profile.id].generatedIds, [receiptId], 'failed history deletion never rolls back successful receipt reconciliation');
    assert.deepEqual(data.deletedActivityRecords.filter(row => row.account === account).map(row => row.id), fail ? [] : [receiptId]);
    assert.deepEqual(data.deletedActivityRecords.find(row => row.account === unrelated.account), unrelated);
    for (const row of data.deletedActivityRecords) {
      assert.equal(Object.getOwnPropertySymbols(row).length, 0, 'transaction markers are cleared from all retained records after success or failure');
      assert.deepEqual(Object.keys(row).sort(), ['account', 'at', 'id', 'source'], 'no persistence schema field is added');
    }
  }
  assert.deepEqual(await restartedProjection(f), project(f.a.data)); assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
});
