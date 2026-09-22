import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider, modelResult } from '../server/ai-provider.mjs';
import { analysisChunks } from '../server/ai-analysis.mjs';
import { AppError } from '../server/files.mjs';
import { activityRows } from '../web/ai-activity-view.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let now = Date.parse('2026-09-17T02:00:00Z');
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan(); await a.settings({ enabled: true });
  return { a, bridge, provider, advance: ms => now += ms, p: a.profiles()[0] };
}
test('concurrent refreshes share one scan; transient failure keeps verified contacts and backs off', async t => {
  const { a, bridge, advance } = await fixture(t); bridge.stableMessageIds = true;
  let scans = 0; const release = Promise.withResolvers();
  bridge.scan = async () => { scans++; await release.promise; throw new AppError('temporary'); };
  const first = a.scan(), second = a.scan(); release.resolve();
  await assert.rejects(first); await assert.rejects(second);
  assert.equal(scans, 1); assert.equal(a.contacts.size, 3); assert.equal(a.available, true); assert.equal(a.scanOperation, null);
  const retry = a.scanRetryAt; advance(15000); await a.tick(); assert.equal(scans, 1);
  assert.ok(retry > a.now());
  bridge.scan = async () => ({ available: true, account: bridge.account, contacts: bridge.contacts });
  await a.scan(); assert.equal(a.scanFailures, 0); assert.equal(a.scanRetryAt, 0);
});
test('one undecodable sender does not invalidate the address book or block other conversations', async t => {
  const { a, bridge, p, advance } = await fixture(t); bridge.stableMessageIds = true;
  const read = bridge.read.bind(bridge), reads = [];
  bridge.read = async args => { reads.push(args.contact); if (args.contact === p.contact) throw new AppError('无法确认部分消息的发送人', 409, 'ai_data_message_sender'); return read(args); };
  await a.tick(); assert.equal(a.available, true); assert.equal(a.contacts.size, 3); assert.equal(reads.length, 3);
  assert.equal(a.cursors.size, 2); assert.ok(p.readRetryAt > a.now());
  let scans = 0; bridge.scan = async () => { scans++; return { available: true, account: bridge.account, contacts: bridge.contacts }; };
  advance(61000); await a.tick(); assert.equal(scans, 0); assert.equal(reads.filter(x => x === p.contact).length, 1);
  await a.tickError(new AppError('模型返回格式无效'), a.revision); assert.equal(a.available, true);
});
test('confirmed encrypted reply survives history eviction and disk never receives its plaintext', async t => {
  const { a, bridge, p } = await fixture(t), id = key('record');
  p.generatedIds = [id]; p.sentMessages = [{ id, at: a.now(), source: 'reply', body: a.vault.seal({ text: 'ENCRYPTED_RECORD_PRIVATE' }) }];
  await a.save(); bridge.read = async () => assert.fail('Known encrypted body needs no recent-history scan');
  const result = await a.activityRecords([p.id]); assert.equal(result.records[0].messages[0].text, 'ENCRYPTED_RECORD_PRIVATE');
  assert.equal(a.publicState().profiles.find(x => x.id === p.id).sentMessages[0].body, undefined);
  assert.doesNotMatch(await readFile(a.file, 'utf8'), /ENCRYPTED_RECORD_PRIVATE/);
});
test('legacy reply is recovered by ID from older history; unrelated or incoming matches are excluded', async t => {
  const { a, bridge, p } = await fixture(t), id = key('old');
  p.generatedIds = [id]; p.sentMessages = [{ id, at: a.now() - 86400000, source: 'reply' }];
  let ranges = 0;
  bridge.readRange = async args => { ranges++; return { account: args.account, contact: args.contact, messages: [{ id: key('manual'), text: 'same', direction: 'self', timestamp: args.from + 1 }, { id, text: 'old confirmed', direction: 'self', timestamp: args.from + 2 }] }; };
  assert.deepEqual((await a.activityRecords([p.id])).records[0].messages.map(m => m.id), [id]); assert.equal(ranges, 2);
  bridge.read = async () => { throw new AppError('读取超时'); };
  const recovered = (await a.activityRecords([p.id])).records[0]; assert.equal(recovered.unavailable, false); assert.equal(recovered.messages[0].id, id);
  bridge.readRange = undefined;
  // Exercise a genuinely unhydrated old record; recovered bodies now persist.
  delete p.sentMessages[0].body;
  const failure = (await a.activityRecords([p.id])).records[0]; assert.equal(failure.unavailable, true); assert.match(failure.error, /读取超时/);
  const state = { activity: [{ id: p.id, label: '甲', hasSent: true, at: a.now() }] };
  assert.doesNotMatch(activityRows(state, {}, [{ id: p.id, messages: [] }], false), /class="ai-contact-record"/);
  const html = activityRows(state, {}, [failure], false); assert.match(html, /data-ai-retry-records/); assert.doesNotMatch(html, /展开近期执行记录（0 条）/);
});

test('analysis distinguishes empty history from existing unreadable messages', async t => {
  const { a, bridge, p } = await fixture(t);
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key('unparsed'), direction: 'system', text: '', timestamp: 1789610400 }] });
  const result = await a.analyze({ contacts: [p.contact], request: '总结' });
  assert.equal(result.reports[0].skipped, 1); assert.match(result.reports[0].report, /无法解析/);
});
test('message navigation validates recorded ID, forwards authentic context and reports precise fallback', async t => {
  const { a, bridge, p } = await fixture(t), message = bridge.push(p.contact, 'self', 'recorded');
  p.generatedIds = [message.id]; p.sentMessages = [{ id: message.id, at: a.now(), source: 'reply' }];
  let requests = []; bridge.openChat = async args => { requests.push(args); return { opened: true, located: true, messageId: args.locate?.messageId }; };
  assert.equal((await a.openConversation(p.id, { messageId: message.id })).located, true);
  assert.equal(requests[0].locate.messages.find(m => m.id === message.id).text, 'recorded');
  await assert.rejects(a.openConversation(p.id, { messageId: key('foreign') }), /不属于/); assert.equal(requests.length, 1);
  bridge.openChat = async () => ({ opened: true });
  assert.match((await a.openConversation(p.id, { messageId: message.id })).notice, /暂时无法定位/);
  assert.equal((await a.openConversation(p.id)).located, undefined);
});
test('analysis accepts provider text blocks, reasoning prefix and prose report but actions remain structured', async () => {
  assert.equal(modelResult('<think>internal</think>```json\n{"report":"正文{引用}"}\n```').report, '正文{引用}');
  assert.equal(modelResult('分析如下：\n{"report":"结论"}').report, '结论');
  assert.equal(modelResult([{ type: 'text', text: '纯文字报告' }], 'report').report, '纯文字报告');
  for (const text of ['send hello', '[{"action":"send"}]', '{"report":', '<think>incomplete', '{} {}']) assert.throws(() => modelResult(text));
  assert.throws(() => modelResult('{"report":', 'report'));
  const provider = new AIProvider({ fetcher: async () => Response.json({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '完整报告' }] }) });
  assert.equal((await provider.complete({ ...modelConfig, protocol: 'anthropic' }, '', {}, undefined, { format: 'report' })).report, '完整报告');
});
test('analysis chunks preserve message timestamps and Beijing calendar dates without splitting messages', () => {
  const messages = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: '字'.repeat(10000), direction: 'self', timestamp: 1789578000 + i }));
  const chunks = analysisChunks([messages]); assert.equal(chunks.length, 5); assert.deepEqual(chunks.flat().map(m => m.timestamp), messages.map(m => m.timestamp));
  assert.ok(chunks.flat().every(m => m.time.endsWith('+08:00'))); assert.equal(chunks[0][0].text.length, 10000);
});
