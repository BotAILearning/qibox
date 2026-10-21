import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { commitObjectConfiguration } from '../server/ai-object-configuration.mjs';
import { readGroupInbox } from '../server/ai-group-inbox.mjs';
import { readMemory } from '../server/ai-wiki.mjs';
import { ChatFixture, AIModelFixture, modelConfig, strategy } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person', expectedCalls = 0, expectedSends = 0) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.contacts[0].kind = kind; bridge.stableMessageIds = true;
  const ai = new AIAssistant({ dataRoot: root, bridge, provider });
  await ai.init(); clearInterval(ai.timer); clearInterval(ai.warmupTimer);
  await ai.configure(modelConfig); await ai.scan();
  await ai.settings({ enabled: true, reply: true, replyScope: 'selected', judgeReply: false });
  t.after(async () => {
    ai.closed = true; clearInterval(ai.timer); clearInterval(ai.warmupTimer);
    await ai.actions; await ai.writes;
    assert.equal(provider.calls.length, expectedCalls); assert.equal(bridge.sent.length, expectedSends);
    await cleanup(root);
  });
  return { ai, root, bridge, provider, contact: bridge.contacts[0].id };
}
const profileValue = ai => ({ style: ai.publicState().schema.defaultStyle, strategy: { ...strategy, maxRounds: 50 }, preserveSwitches: true });
const entries = [
  { name: 'person-options', kind: 'person', apply: (a, contact) => a.setReplyOptions({ contact, enabled: true }) },
  { name: 'group-options', kind: 'group', apply: (a, contact) => a.setGroupOptions({ contact, atMe: true }) },
  { name: 'object-form', kind: 'person', apply: (a, contact) => a.saveReplyProfile({ ...profileValue(a), contact, replyEnabled: true, style: { ...a.publicState().schema.defaultStyle, summary: 'New uncommitted object style' } }) },
];
const configuration = a => structuredClone({ profiles: a.data.profiles, replyTargets: a.data.replyTargets, proactiveTargets: a.data.proactiveTargets, targets: a.data.targets, reply: a.data.settings.reply });
async function diskFault(root, file, action) {
  const absolute = path.resolve(file); assert.ok(absolute.startsWith(path.resolve(root) + path.sep));
  const backup = file + '.configuration-fault-backup'; await fs.rename(file, backup); await fs.mkdir(file);
  try { return await action(backup); }
  finally { await fs.rm(absolute, { recursive: true }); await fs.rename(backup, file); }
}

for (const entry of entries) for (const existing of [false, true]) test(`${entry.name}: failed real rename preserves ${existing ? 'existing object and history' : 'unconfigured object'} and later saves`, async t => {
  const { ai, root, contact } = await fixture(t, entry.kind);
  if (existing) {
    await ai.saveReplyProfile({ ...profileValue(ai), contact, ...(entry.kind === 'group' ? { group: { atMe: false, atAll: false, realtime: false } } : { replyEnabled: false }) });
    const p = ai.profiles()[0]; p.rounds = 5; p.sentMessages = [{ id: 'preserved-history', at: 1, body: ai.vault.seal({ text: 'Fixture confirmed history' }) }]; await ai.save();
  }
  const before = configuration(ai), durableBefore = await fs.readFile(ai.file, 'utf8');
  await diskFault(root, ai.file, async backup => {
    await assert.rejects(entry.apply(ai, contact), error => ['EPERM', 'EISDIR', 'EEXIST', 'ENOTEMPTY'].includes(error.code));
    assert.equal(await fs.readFile(backup, 'utf8'), durableBefore);
    assert.deepEqual(configuration(ai), before, 'Failed configuration must never become active in memory');
  });
  await ai.save();
  const durable = JSON.parse(await fs.readFile(ai.file, 'utf8'));
  assert.deepEqual(durable.profiles, JSON.parse(JSON.stringify(before.profiles))); assert.deepEqual(durable.replyTargets, before.replyTargets);
});

for (const entry of entries) for (const fail of [false, true]) test(`${entry.name}: pending ${fail ? 'failure' : 'success'} isolates execution and defers unrelated snapshot cloning`, async t => {
  const { ai, contact } = await fixture(t, entry.kind);
  await ai.saveReplyProfile({ ...profileValue(ai), contact, ...(entry.kind === 'group' ? { group: { atMe: true, atAll: false, realtime: false } } : { replyEnabled: true }) });
  const original = ai.data.profiles[ai.profiles()[0].id], id = original.id, before = configuration(ai);
  const save = ai.save, started = Promise.withResolvers(), held = Promise.withResolvers(); let first = true;
  ai.save = function (...args) {
    if (first) { first = false; started.resolve(); return held.promise.then(() => save.apply(this, args)); }
    return save.apply(this, args);
  };
  const operation = entry.apply(ai, contact);
  const outcome = operation.then(() => null, error => error);
  await started.promise;
  const during = configuration(ai), canDeliver = ai.canDeliver(original, 'reply', ai.revision, ai.controller.signal);
  let ran = false; const run = ai.startRun(id, () => { ran = true; }, ai.revision);
  original.sentMessages = [...(original.sentMessages || []), { id: 'independent-receipt-during-save', at: 2, body: ai.vault.seal({ text: 'Independent fixture receipt' }) }];
  let backgroundCompleted = false; const background = ai.save().then(() => { backgroundCompleted = true; });
  await new Promise(resolve => setImmediate(resolve)); const completedWhilePending = backgroundCompleted;
  if (fail) held.reject(Object.assign(Error('fixture pending object write failed'), { code: 'ENOSPC' })); else held.resolve();
  const error = await outcome; await background; await run;
  assert.equal(!!error, fail); assert.deepEqual(during, before, 'Uncommitted fields must remain staged, not visible');
  assert.equal(canDeliver, false); assert.equal(run, null); assert.equal(ran, false);
  assert.equal(completedWhilePending, false, 'Ordinary save must wait before taking its data clone');
  assert.equal(ai.data.profiles[id], original, 'Configuration commit preserves the live object reference for independent receipts');
  assert.ok(original.sentMessages.some(row => row.id === 'independent-receipt-during-save'));
  const durable = JSON.parse(await fs.readFile(ai.file, 'utf8'));
  assert.ok(durable.profiles[id].sentMessages.some(row => row.id === 'independent-receipt-during-save'));
  if (fail) {
    const actual = configuration(ai), expected = structuredClone(before);
    delete actual.profiles[id].sentMessages; delete expected.profiles[id].sentMessages;
    assert.deepEqual(actual, expected, 'Only independent history may change after a failed configuration');
  }
});

for (const name of ['strategy', 'update-style', 'delete', 'edit-memory', 'edit-contact-memory', 'apply-memory', 'discard-memory', 'merge-memory']) test(`related object ${name}: failed save cannot leak into later snapshots`, async t => {
  const { ai, root, contact } = await fixture(t);
  await ai.saveReplyProfile({ ...profileValue(ai), contact, replyEnabled: false });
  const id = ai.profiles()[0].id;
  if (['apply-memory', 'discard-memory', 'merge-memory'].includes(name)) {
    ai.setPendingMemory(ai.data.profiles[id], { entries: [{ field: 'other', text: 'Pending synthetic fact' }] }); await ai.save();
  }
  const before = configuration(ai);
  await diskFault(root, ai.file, async () => {
    const operation = name === 'edit-memory' ? ai.editMemory(id, { summary: 'Rejected synthetic fact' })
      : name === 'edit-contact-memory' ? ai.editContactMemory(contact, { summary: 'Rejected synthetic fact' })
      : name === 'apply-memory' ? ai.applyPendingMemory(id)
      : name === 'discard-memory' ? ai.discardPendingMemory(id)
      : name === 'merge-memory' ? ai.mergePendingMemory(id)
      : name === 'strategy' ? ai.saveStrategy({ ...strategy, maxRounds: 71 }, id, 'reply')
      : ai.editProfile(id, name === 'delete' ? { delete: true } : { style: { ...ai.publicState().schema.defaultStyle, summary: 'Failed object style update' } });
    await assert.rejects(operation);
    assert.deepEqual(configuration(ai), before);
  });
  await ai.save(); const durable = JSON.parse(await fs.readFile(ai.file, 'utf8'));
  assert.deepEqual(durable.profiles, JSON.parse(JSON.stringify(before.profiles)));
});

for (const entry of [...entries, ...['strategy', 'update-style', 'delete', 'edit-memory', 'edit-contact-memory', 'apply-memory', 'discard-memory', 'merge-memory'].map(name => ({ name, kind: 'person' }))]) test(`${entry.name}: failed change preserves another object's definite-not-sent answer and original deadline`, async t => {
  const { ai, root, contact, bridge, provider } = await fixture(t, entry.kind, 1, 1);
  let now = Date.now(); ai.now = () => now;
  await ai.saveReplyProfile({ ...profileValue(ai), contact, ...(entry.kind === 'group' ? { group: { atMe: false, atAll: false, realtime: false } } : { replyEnabled: false }) });
  const target = ai.profiles().find(profile => profile.contact === contact), other = bridge.contacts[1].id;
  if (['apply-memory', 'discard-memory', 'merge-memory'].includes(entry.name)) {
    ai.setPendingMemory(target, { entries: [{ field: 'other', text: 'Pending synthetic fact' }] }); await ai.save();
  }
  await ai.setReplyOptions({ contact: other, enabled: true, judgeReply: false }); await ai.tick();
  const incoming = bridge.push(other, 'other', 'A synthetic question for the other object?'); incoming.timestamp = Math.floor(now / 1000); await ai.tick();
  const send = bridge.send.bind(bridge); bridge.send = () => ({ status: 'not-sent', diagnostic: { phase: 'native-prepare', code: 'fixture-controls-unavailable' } });
  provider.next = async () => ({ action: 'send', text: 'The retained synthetic answer.' });
  now += 20000; await ai.tick();
  const otherProfile = ai.profiles().find(profile => profile.contact === other), before = structuredClone(otherProfile.preparedReply);
  assert.equal(provider.calls.length, 1); assert.ok(before); assert.equal(before.state, 'retry');
  await diskFault(root, ai.file, async () => {
    const operation = entry.apply ? entry.apply(ai, contact)
      : entry.name === 'edit-memory' ? ai.editMemory(target.id, { summary: 'Rejected synthetic fact' })
      : entry.name === 'edit-contact-memory' ? ai.editContactMemory(contact, { summary: 'Rejected synthetic fact' })
      : entry.name === 'apply-memory' ? ai.applyPendingMemory(target.id)
      : entry.name === 'discard-memory' ? ai.discardPendingMemory(target.id)
      : entry.name === 'merge-memory' ? ai.mergePendingMemory(target.id)
      : entry.name === 'strategy' ? ai.saveStrategy({ ...strategy, maxRounds: 71 }, target.id, 'reply')
      : ai.editProfile(target.id, entry.name === 'delete' ? { delete: true } : { style: { ...ai.publicState().schema.defaultStyle, summary: 'Rejected target edit' } });
    await assert.rejects(operation);
    assert.deepEqual(otherProfile.preparedReply, before, 'Failed target configuration must not touch another object cache or its retry window');
  });
  bridge.send = send; now += 30000; await ai.tick();
  assert.equal(provider.calls.length, 1, 'The already-generated answer must be reused without another fixture request');
  assert.deepEqual(bridge.sent.map(row => row.text), ['The retained synthetic answer.']);
  assert.equal(before.createdAt + 300000, before.retryStartedAt + 300000, 'Original retry deadline is unchanged');
});

for (const fail of [false, true]) test(`memory merge: pending ${fail ? 'failure' : 'success'} starts the existing background action only after a durable running marker`, async t => {
  const { ai, contact } = await fixture(t); await ai.saveReplyProfile({ ...profileValue(ai), contact, replyEnabled: false });
  const id = ai.profiles()[0].id; ai.setPendingMemory(ai.data.profiles[id], { entries: [{ field: 'other', text: 'Merge candidate' }] }); await ai.save();
  let starts = 0; ai.finishMemoryMerge = () => { starts++; };
  const save = ai.save, started = Promise.withResolvers(), held = Promise.withResolvers(); let first = true;
  ai.save = function (...args) { if (first) { first = false; started.resolve(); return held.promise.then(() => save.apply(this, args)); } return save.apply(this, args); };
  const operation = ai.mergePendingMemory(id), outcome = operation.then(() => null, error => error); await started.promise;
  assert.equal(starts, 0); assert.equal(ai.data.profiles[id].memoryMerge, null, 'Uncommitted running marker must stay invisible');
  if (fail) held.reject(Error('fixture deferred merge marker failed')); else held.resolve();
  const error = await outcome; assert.equal(!!error, fail); assert.equal(starts, fail ? 0 : 1);
  const durable = JSON.parse(await fs.readFile(ai.file, 'utf8')).profiles[id];
  assert.equal(durable.memoryMerge?.status, fail ? undefined : 'running');
});

for (const action of ['edit', 'apply', 'discard']) for (const fail of [false, true]) test(`memory ${action}: pending ${fail ? 'failed' : 'successful'} configuration cancels an older background result before persistence`, async t => {
  const { ai, contact, provider } = await fixture(t, 'person', 1, 0);
  await ai.saveReplyProfile({ ...profileValue(ai), contact, replyEnabled: false });
  const id = ai.profiles()[0].id; ai.setPendingMemory(ai.data.profiles[id], { entries: [{ field: 'other', text: 'Previously confirmed candidate' }] }); await ai.save();
  const pendingId = ai.data.profiles[id].pendingMemoryId, modelEntered = Promise.withResolvers(), modelResult = Promise.withResolvers(); let oldSignal;
  provider.next = (_input, signal) => { oldSignal = signal; modelEntered.resolve(); return modelResult.promise; };
  const previous = ai.finishMemoryMerge(id); await modelEntered.promise;
  const save = ai.save, started = Promise.withResolvers(), held = Promise.withResolvers(); let first = true;
  ai.save = function (...args) { if (first) { first = false; started.resolve(); return held.promise.then(() => save.apply(this, args)); } return save.apply(this, args); };
  const revision = ai.revision, operation = action === 'edit' ? ai.editMemory(id, { summary: 'Fresh manual memory' })
    : action === 'apply' ? ai.applyPendingMemory(id) : ai.discardPendingMemory(id);
  const outcome = operation.then(() => null, error => error); await started.promise;
  const abortedBeforePersist = oldSignal.aborted, pendingRevision = ai.revision;
  modelResult.resolve({ memory: { entries: [{ field: 'other', text: 'Late obsolete model candidate' }] } });
  await new Promise(resolve => setImmediate(resolve));
  const candidateDuringSave = ai.data.profiles[id].pendingMemoryId;
  if (fail) held.reject(Error('fixture memory configuration write failure')); else held.resolve();
  const error = await outcome; await previous;
  assert.equal(!!error, fail); assert.equal(abortedBeforePersist, true, 'Validated memory changes must cancel the older model before awaiting storage');
  assert.equal(pendingRevision, revision + 1); assert.equal(ai.revision, pendingRevision, 'A successful commit must not invalidate the epoch a second time');
  assert.equal(candidateDuringSave, pendingId, 'An obsolete result must not replace the pending candidate while storage is busy');
  const profile = ai.data.profiles[id]; assert.equal(profile.pendingMemoryId, fail || action === 'edit' ? pendingId : undefined);
  assert.doesNotMatch(JSON.stringify(ai.pendingMemoryOf(profile)), /Late obsolete/);
  assert.equal(readMemory(ai.vault, profile).summary.includes('Fresh manual memory'), !fail && action === 'edit');
});

for (const preparePrune of ['ordinary', 'eligible', 'removal']) for (const fail of [false, true]) test(`legacy pending queue: ${preparePrune} ${fail ? 'failure' : 'success'} keeps runtime fence separate from eligibility`, async t => {
  const { ai, contact } = await fixture(t);
  await ai.saveReplyProfile({ ...profileValue(ai), contact, replyEnabled: true });
  const id = ai.profiles()[0].id;
  ai.data.settings.proactive = true; ai.data.proactiveTargets = [id]; ai.syncTargets();
  ai.data.queue = { status: 'running', items: [{ id, status: 'pending', attempts: 0, strategy: { ...strategy } }], nextAt: Date.now() };
  await ai.save(); const originalRow = ai.data.queue.items[0];
  const save = ai.save, started = Promise.withResolvers(), held = Promise.withResolvers(); let first = true;
  ai.save = function (...args) { if (first) { first = false; started.resolve(); return held.promise.then(() => save.apply(this, args)); } return save.apply(this, args); };
  const operation = preparePrune !== 'ordinary' ? ai.exclusive(() => commitObjectConfiguration(ai, id, () => {
    if (preparePrune === 'removal') { ai.data.proactiveTargets = []; ai.syncTargets(); }
    ai.pruneQueueTargets();
  })) : ai.setReplyOptions({ contact, enabled: true, judgeReply: true });
  const outcome = operation.then(() => null, error => error); await started.promise;
  const beforeRuntimePrune = ai.data.queue.items[0].status;
  ai.pruneQueueTargets(); const afterRuntimePrune = ai.data.queue.items[0].status;
  originalRow.independentReceipt = 'keep-unrelated-field';
  if (fail) held.reject(Error('fixture queue configuration failure')); else held.resolve();
  const error = await outcome; assert.equal(!!error, fail);
  assert.equal(beforeRuntimePrune, 'pending', 'Candidate queue rows must never alias live rows');
  assert.equal(afterRuntimePrune, 'pending', 'Temporary execution fencing must not mark a valid pending queue item skipped');
  assert.equal(ai.data.queue.items[0], originalRow);
  assert.equal(originalRow.independentReceipt, 'keep-unrelated-field');
  assert.equal(originalRow.status, preparePrune === 'removal' && !fail ? 'skipped' : 'pending');
});

for (const entry of ['person-options', 'group-options', 'group-form']) for (const fail of [false, true]) test(`${entry}: ${fail ? 'failed' : 'successful'} disable preserves messages observed while its snapshot is pending`, async t => {
  const group = entry !== 'person-options', { ai, contact, bridge } = await fixture(t, group ? 'group' : 'person');
  let now = Date.now(); ai.now = () => now;
  if (group) await ai.setGroupOptions({ contact, atMe: true }); else await ai.setReplyOptions({ contact, enabled: true });
  const profile = ai.profiles()[0], id = profile.id;
  await ai.observe(profile, await bridge.read({ contact }));
  const push = text => Object.assign(bridge.push(contact, 'other', text), { timestamp: Math.floor(now / 1000),
    sender: 'synthetic-group-member', mentions: { verified: true, self: true, all: false, others: false } });
  const oldMessage = push('Observed before configuration'); await ai.observe(profile, await bridge.read({ contact }));
  const save = ai.save, started = Promise.withResolvers(), held = Promise.withResolvers(); let first = true;
  ai.save = function (...args) { if (first) { first = false; started.resolve(); return held.promise.then(() => save.apply(this, args)); } return save.apply(this, args); };
  const operation = entry === 'person-options' ? ai.setReplyOptions({ contact, enabled: false })
    : entry === 'group-options' ? ai.setGroupOptions({ contact, atMe: false })
      : ai.saveReplyProfile({ ...profileValue(ai), contact, preserveSwitches: true, group: { atMe: false, atAll: false, realtime: false } });
  const outcome = operation.then(() => null, error => error); await started.promise;
  now += 1000; const newMessage = push('Arrived during the deferred configuration write');
  const observation = ai.observe(profile, await bridge.read({ contact }));
  await new Promise(resolve => setImmediate(resolve));
  const latestCursor = structuredClone(ai.cursors.get(id));
  assert.equal(latestCursor.last, newMessage.id); assert.equal(latestCursor.pending, true);
  if (group) assert.deepEqual(readGroupInbox(ai.vault, profile).pending.map(row => row.id), [oldMessage.id, newMessage.id]);
  if (fail) held.reject(Error('fixture deferred disable failed')); else held.resolve();
  const error = await outcome; await observation; assert.equal(!!error, fail);
  assert.deepEqual(ai.cursors.get(id), latestCursor, 'Commit must not replace a newer observed cursor with the pre-write cursor');
  assert.equal(profile.replyCursor.last, newMessage.id, 'Durable cursor projection follows the newest observed message');
  if (group) {
    const inbox = readGroupInbox(ai.vault, profile);
    assert.deepEqual(inbox.pending.map(row => row.id), fail ? [oldMessage.id, newMessage.id] : [newMessage.id]);
    assert.equal(inbox.seen, newMessage.id); assert.equal(inbox.settled.includes(oldMessage.id), !fail);
    assert.equal(inbox.settled.includes(newMessage.id), false, 'Only messages actually observed by the disable operation may be settled');
  }
  const durable = JSON.parse(await fs.readFile(ai.file, 'utf8')).profiles[id];
  assert.equal(durable.replyCursor.last, newMessage.id);
  if (group) assert.deepEqual(readGroupInbox(ai.vault, durable), readGroupInbox(ai.vault, profile));
});

test('closing a large accumulated group inbox settles every observed obligation while retaining the bounded identity window', async t => {
  const { ai, contact } = await fixture(t, 'group'); await ai.setGroupOptions({ contact, atMe: true });
  const profile = ai.profiles()[0], ids = Array.from({ length: 4005 }, (_, index) => `synthetic-obligation-${index}`);
  profile.groupInbox = ai.vault.seal({ pending: ids.map(id => ({ id, trigger: 'atMe' })), settled: [], seen: ids.at(-1), seenAt: Date.now() });
  await ai.save(); await ai.setGroupOptions({ contact, atMe: false });
  const inbox = readGroupInbox(ai.vault, profile);
  assert.deepEqual(inbox.pending, []); assert.equal(inbox.settled.length, 4000);
  assert.deepEqual(inbox.settled, ids.slice(-4000)); assert.equal(inbox.seen, ids.at(-1));
});
