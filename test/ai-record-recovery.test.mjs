import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { RecordCache, mergeRecordResults } from '../web/ai-record-cache.mjs';
import { activityRows } from '../web/ai-activity-view.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('record metadata appears without reading WeChat; old bodies hydrate by range once and survive restart encrypted', async t => {
  const root = await temp(), bridge = new ChatFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider: new AIModelFixture() }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan(); await a.settings({ enabled: true, replyScope: 'all' });
  const p = a.profiles()[0], id = key('legacy'), at = Date.now() - 86400000;
  p.generatedIds = [id]; p.sentMessages = [{ id, at, source: 'reply' }];
  bridge.read = async () => assert.fail('Known times must use the bounded history range first');
  let reads = 0;
  bridge.readRange = async args => { reads++; assert.equal(args.to - args.from <= 601, true); return { account: args.account, contact: args.contact, messages: [{ id, direction: 'self', text: 'LEGACY_BODY_PRIVATE', timestamp: Math.floor(at / 1000) }] }; };
  const quick = await a.activityRecords([p.id], { hydrate: false });
  assert.equal(reads, 0); assert.equal(quick.records[0].pending, true);
  assert.match(activityRows(a.publicState(), {}, quick.records, true), /正在读取历史正文/);
  assert.equal((await a.activityRecords([p.id])).records[0].messages[0].text, 'LEGACY_BODY_PRIVATE');
  assert.equal(reads, 1);
  assert.equal((await a.activityRecords([p.id], { hydrate: false })).records[0].pending, false);
  assert.equal((await a.activityRecords([p.id])).records[0].messages.length, 1); assert.equal(reads, 1);
  const persisted = await readFile(a.file, 'utf8'); assert.doesNotMatch(persisted, /LEGACY_BODY_PRIVATE/);
  const reloaded = new AIAssistant({ dataRoot: root, bridge, provider: new AIModelFixture() }); await reloaded.init();
  try { assert.equal((await reloaded.activityRecords([p.id])).records[0].messages[0].text, 'LEGACY_BODY_PRIVATE'); assert.equal(reads, 1); }
  finally { await reloaded.close(); }
});

test('record cache is bounded, expires, and never crosses instance or account boundaries', () => {
  let now = 0; const cache = new RecordCache({ now: () => now, limit: 2, ttl: 100 });
  cache.save('one', 'account-a', { records: ['private'] });
  assert.equal(cache.take('two', 'account-a'), null);
  const value = cache.take('one', 'account-a'); value.records.push('mutated');
  assert.deepEqual(cache.take('one', 'account-a').records, ['private']);
  assert.equal(cache.take('one', 'account-b'), null); assert.equal(cache.take('one', 'account-a'), null);
  for (const id of ['one', 'two', 'three']) cache.save(id, 'account-a', { id });
  assert.equal(cache.take('one', 'account-a'), null);
  now = 100; assert.equal(cache.take('two', 'account-a'), null);
});

test('record refresh failures and pending bodies preserve prior data; confirmed empty clears it', () => {
  const old = [{ id: 'a', messages: [{ id: 'msg', text: 'retained' }] }];
  for (const status of [{ unavailable: true }, { pending: true }]) assert.equal(mergeRecordResults(old, [{ id: 'a', messages: [], ...status }])[0].messages[0].text, 'retained');
  assert.deepEqual(mergeRecordResults(old, [{ id: 'a', messages: [] }])[0].messages, []);
  assert.deepEqual(mergeRecordResults(old, [{ id: 'b', messages: [], unavailable: true }])[0].messages, []);
});
