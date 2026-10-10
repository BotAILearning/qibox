import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AppError } from '../server/files.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
import { safeErrorText } from '../server/ai-error-details.mjs';
import { recentErrorsBox } from '../web/ai-activity-view.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let time = Date.parse('2026-10-02T10:00:00+08:00');
  const args = { dataRoot: root, bridge, provider, now: () => time, delay: async ms => { time += ms; } };
  const ai = new AIAssistant(args); await ai.init(); await ai.configure(modelConfig); await ai.scan();
  const contact = bridge.contacts[0].id;
  await ai.setReplyOptions({ contact, enabled: true });
  const profile = ai.profiles().find(row => row.contact === contact);
  t.after(async () => { await ai.close(); await cleanup(root); });
  return { ai, profile, contact, bridge, provider, args, advance: ms => { time += ms; } };
}

test('a real model failure freezes exact pending IDs, bounded encrypted excerpts and object at occurrence', async t => {
  const f = await fixture(t);
  await f.ai.settings({ enabled: true }); await f.ai.tick();
  f.bridge.push(f.contact, 'other', 'OLDER_CONTEXT');
  await f.ai.tick(); f.advance(20000); await f.ai.tick();
  const incoming = f.bridge.push(f.contact, 'other', 'PENDING_PRIVATE_EXCERPT' + '长'.repeat(600));
  incoming.timestamp = Math.floor(f.ai.now() / 1000);
  await f.ai.tick();
  f.provider.next = () => { throw new AppError('模型响应超时', 504, 'ai_model_timeout'); };
  f.advance(20000); await f.ai.tick();
  const error = f.ai.errorRecords().records[0];
  assert.equal(error.context.stage, 'model'); assert.equal(error.context.type, '操作超时');
  assert.equal(error.context.label, f.profile.label); assert.equal(error.objectTarget, f.contact);
  assert.deepEqual(error.context.incomingIds, [incoming.id]);
  assert.equal(error.context.messages[0].id, incoming.id); assert.equal(error.context.messages[0].text.length, 350);
  assert.equal(error.context.messages[0].timestamp, incoming.timestamp); assert.match(error.context.evidenceNote, /有限摘要/);
  const persisted = await readFile(f.ai.file, 'utf8'); assert.ok(!persisted.includes('PENDING_PRIVATE_EXCERPT'));
  f.bridge.push(f.contact, 'other', 'AFTER_ERROR_MUST_NOT_BE_USED');
  f.ai.contacts.get(f.contact).label = '改名后的对象';
  assert.equal(f.ai.errorRecords().records[0].context.label, error.context.label);
  assert.ok(!JSON.stringify(f.ai.errorRecords()).includes('AFTER_ERROR_MUST_NOT_BE_USED'));
  await f.ai.close(); const restarted = new AIAssistant(f.args); await restarted.init();
  try { assert.deepEqual(restarted.errorRecords().records[0].context.messages, error.context.messages); }
  finally { await restarted.close(); }
});

test('read failure carries the real object and stage without fabricating a message from current history', async t => {
  const f = await fixture(t);
  f.bridge.read = async () => { throw new AppError('暂时无法读取聊天记录', 503, 'ai_read_unavailable'); };
  let failure; try { await f.ai.read(f.profile, new AbortController().signal); } catch (error) { failure = error; }
  await f.ai.tickError(failure, f.ai.revision);
  const error = f.ai.errorRecords().records[0];
  assert.equal(error.objectTarget, f.contact); assert.equal(error.context.stage, 'read');
  assert.deepEqual(error.context.messages, []); assert.deepEqual(error.context.incomingIds, []);
  assert.match(error.context.evidenceNote, /未保存消息证据/);
});

test('role failure codes and legacy saved attribution messages have a clear role-check stage', async t => {
  const f = await fixture(t);
  f.ai.event('error', f.profile.id, 'reply', '回复角色与当前微信账号不一致，本次未发送', { stage: 'model', errorCode: 'ai_role_blocked' });
  let error = f.ai.errorRecords().records[0];
  assert.equal(error.context.stageLabel, '发送前角色核验'); assert.equal(error.context.errorCode, 'ai_role_blocked');
  f.ai.data.errorLog.unshift({ id: 'legacy-role', account: f.ai.data.account, at: f.ai.now(), target: f.profile.id, code: 'error', message: '模型的发言归属核对结果无效，当前回复未发送' });
  error = f.ai.errorRecords().records[0];
  assert.equal(error.context.stage, 'role-check'); assert.equal(error.context.labelBasis, 'current'); assert.equal(error.context.stageBasis, 'saved-reason');
  assert.deepEqual(error.context.messages, []); assert.match(error.context.evidenceNote, /历史异常未保存当时消息/);
});

test('error text/excerpts redact actual keys and common secrets, omit arbitrary provider metadata', async t => {
  const f = await fixture(t);
  const detail = `连接失败 ${modelConfig.apiKey} Authorization: Bearer eyJ.secret.jwt apiKey=sk-abcdefgh123456 password=pass123`;
  f.ai.event('error', f.profile.id, 'reply', detail, { stage: 'model', providerBody: 'DO_NOT_COPY_PROVIDER_BODY', stack: 'DO_NOT_COPY_STACK', incomingMessages: [{ id: 'incoming-1', direction: 'other', text: modelConfig.apiKey + ' token=x' }] });
  await f.ai.save();
  const wire = JSON.stringify(f.ai.errorRecords()), stored = await readFile(f.ai.file, 'utf8');
  for (const secret of [modelConfig.apiKey, 'eyJ.secret.jwt', 'sk-abcdefgh123456', 'pass123', 'DO_NOT_COPY_PROVIDER_BODY', 'DO_NOT_COPY_STACK']) {
    assert.ok(!wire.includes(secret), secret); assert.ok(!stored.includes(secret), secret);
  }
  assert.ok(safeErrorText('x'.repeat(5000)).length <= 2000);
  const context = f.ai.data.errorLog[0].context;
  context.sourceLabel = modelConfig.apiKey; context.taskName = modelConfig.apiKey;
  context.evidenceSnapshot = f.ai.vault.seal({ messages: [{ id: 'saved', text: 'safe', type: '<script>', senderId: 'bad' }] });
  const publicContext = f.ai.errorRecords().records[0].context;
  assert.ok(!JSON.stringify(publicContext).includes(modelConfig.apiKey)); assert.equal(publicContext.messages[0].type, undefined); assert.equal(publicContext.messages[0].senderId, undefined);
});

test('proactive failures link to the exact failed record and label context instead of incoming triggers', async t => {
  const f = await fixture(t);
  await f.ai.settings({ enabled: true, reply: false });
  f.bridge.push(f.contact, 'other', 'PROACTIVE_CONTEXT_EXCERPT');
  f.provider.next = () => { throw new AppError('模型响应超时', 504, 'ai_model_timeout'); };
  await f.ai.proactiveTaskAction({ command: 'create', name: '真实任务名称', taskType: 'greeting', contacts: [f.contact], goal: '问候近况', requirements: '', schedule: { cycle: 'once' } });
  await f.ai.tick();
  const error = f.ai.errorRecords().records[0], linked = f.ai.errorRelatedRecord(error.id);
  assert.equal(error.context.taskName, '真实任务名称'); assert.equal(error.context.stage, 'model');
  assert.equal(linked.source, 'proactive'); assert.equal(linked.record.id, error.relatedRecord.id);
  assert.equal(linked.record.status, 'failed'); assert.equal(linked.record.profileId, f.profile.id);
  assert.match(error.context.evidenceNote, /不代表这些消息触发/);
  assert.equal(f.bridge.sent.length, 0);
  const rawError = f.ai.data.errorLog[0], rawRecord = f.ai.data.proactiveRecords.find(row => row.id === linked.record.id);
  rawRecord.contact = f.bridge.contacts[1].id;
  assert.equal(f.ai.errorRecords().records[0].relatedRecord, undefined);
  assert.throws(() => f.ai.errorRelatedRecord(error.id), /关联记录/);
  rawRecord.contact = f.contact; rawRecord.profileId = key('another-profile');
  assert.equal(f.ai.errorRecords().records[0].relatedRecord, undefined);
  rawRecord.profileId = f.profile.id;
  f.ai.data.deletedActivityRecords.push({ account: f.ai.data.account, source: 'proactive', id: rawRecord.id });
  assert.equal(f.ai.errorRecords().records[0].relatedRecord, undefined);
  assert.equal(rawError.context.proactiveRecordId, linked.record.id);
  f.ai.event('error', f.profile.id, 'reply', '发送未提交', { stage: 'send', source: 'reply', evidenceScope: 'chat-context', incomingMessages: [{ id: 'reply-context', direction: 'other', text: 'REPLY_CONTEXT_EXCERPT' }] });
  const replyError = f.ai.errorRecords().records[0];
  assert.equal(replyError.context.sourceLabel, '自动回复');
  assert.match(replyError.context.evidenceNote, /本次操作读取的聊天片段/);
  assert.doesNotMatch(replyError.context.evidenceNote, /主动任务/);
  assert.deepEqual(replyError.context.incomingIds, ['reply-context']);
  assert.equal(replyError.context.messages[0].text, 'REPLY_CONTEXT_EXCERPT');
});

test('legacy migration uses saved exact event ID only; account switch never returns encrypted previous-account evidence', async t => {
  const f = await fixture(t);
  f.ai.data.events.unshift({ id: 'legacy-event', code: 'error', target: f.profile.id, operationId: 'saved-operation', account: f.ai.data.account, at: f.ai.now(), detail: '模型响应超时' });
  f.ai.data.errorLog.unshift({ id: 'legacy-event', account: f.ai.data.account, at: f.ai.now(), code: 'error', message: '模型响应超时' });
  f.ai.migrateErrorLog();
  const error = f.ai.errorRecords().records[0]; assert.equal(error.context.operationId, 'saved-operation'); assert.equal(error.objectTarget, f.contact);
  assert.equal(error.context.labelBasis, 'current'); assert.deepEqual(error.context.messages, []);
  f.ai.event('error', f.profile.id, 'reply', '本次失败', { stage: 'model', incomingMessages: [{ id: 'old-private', direction: 'other', text: 'OLD_ACCOUNT_EXCERPT' }] });
  f.ai.data.account = key('different-account');
  assert.equal(f.ai.errorRecords().records.length, 0); assert.throws(() => f.ai.errorRelatedRecord(error.id), /关联记录/);
});

test('skip linkage requires the exact saved event, target and account; broken evidence is explicit', async t => {
  const f = await fixture(t), incoming = { id: 'incoming-1', direction: 'other', text: '当时的提问', timestamp: Math.floor(f.ai.now() / 1000) };
  const skip = f.ai.event('skip', f.profile.id, 'system-skip', '未生成文字', { messageId: incoming.id, incomingMessages: [incoming] });
  f.ai.event('error', f.profile.id, 'reply', '明确提问未生成文字', { stage: 'model', errorCode: 'ai_model_no_text', relatedSkipEventId: skip.id, incomingMessages: [incoming] });
  let error = f.ai.errorRecords().records[0];
  assert.equal(error.relatedRecord.id, skip.id); assert.equal(f.ai.errorRelatedRecord(error.id).record.incomingMessages[0].text, incoming.text);
  const raw = f.ai.data.skipLog.find(row => row.id === skip.id); raw.target = key('other-profile');
  assert.equal(f.ai.errorRecords().records[0].relatedRecord, undefined); assert.throws(() => f.ai.errorRelatedRecord(error.id), /关联记录/);
  raw.target = f.profile.id; raw.account = key('other-account'); assert.equal(f.ai.errorRecords().records[0].relatedRecord, undefined);
  raw.account = f.ai.data.account; f.ai.data.deletedActivityRecords.push({ account: f.ai.data.account, source: 'skip', id: skip.id });
  assert.equal(f.ai.errorRecords().records[0].relatedRecord, undefined);
  f.ai.data.errorLog[0].context.evidenceSnapshot = 'broken-encrypted-snapshot';
  f.bridge.push(f.contact, 'other', 'CURRENT_CHAT_IS_NOT_OLD_EVIDENCE');
  error = f.ai.errorRecords().records[0]; assert.deepEqual(error.context.messages, []); assert.match(error.context.evidenceNote, /暂时无法读取/);
  assert.ok(!JSON.stringify(error).includes('CURRENT_CHAT_IS_NOT_OLD_EVIDENCE'));
});

test('error detail view escapes all fields, shows object in folded summary and keeps unknown group sender explicit', () => {
  const state = { recentErrors: [{ id: 'error-1', at: Date.now(), message: '<img src=x>', objectTarget: 'contact', relatedRecord: { source: 'proactive', id: 'record' }, context: { label: '很长群名<script>', kind: 'group', labelBasis: 'occurrence', taskName: '任务&名称', stageLabel: '发送前角色核验', type: '角色核验未通过', errorCode: 'ai_role_blocked', messages: [{ id: 'incoming', text: '<PRIVATE>' }], evidenceNote: '当时的摘要' } }, { id: 'old', at: Date.now(), message: '历史失败' }] };
  const html = recentErrorsBox(state, true, false, ['error-1']);
  assert.match(html, /class="ai-error-object">很长群名&lt;script&gt; · 任务&amp;名称/);
  assert.match(html, /data-ai-error-detail="error-1" open/); assert.doesNotMatch(html, /data-ai-error-detail="old" open/);
  assert.match(html, /<strong>发送者未记录<\/strong>/); assert.doesNotMatch(html, /<img|<script|<PRIVATE>/);
  assert.match(html, /data-ai-error-object="error-1"/); assert.match(html, /data-ai-error-record-target="error-1"/);
  assert.match(html, /历史异常未保存当时消息/); assert.match(html, /已加载 2 \/ 2 条/);
});
