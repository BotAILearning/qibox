import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { personalInformation, selfContext, stageSelfSuggestions, styleTabs, saveObjectStyle } from '../server/ai-account-configuration.mjs';
import { currentChatTime, guardTimeGreeting } from '../server/ai-chat-context.mjs';
import { validateReplyResult } from '../server/ai-prompts.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-09-30T15:20:30+08:00');
  const options = { dataRoot: root, bridge, provider, now: () => now };
  const a = new AIAssistant(options); await a.init(); await a.configure(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id;
  await a.setReplyOptions({ contact, enabled: true });
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, bridge, provider, contact, options, p: a.profiles()[0], advance: ms => now += ms };
}

test('self information is encrypted, account isolated, stays until edited and requires explicit group sharing', async t => {
  const { a, advance } = await fixture(t);
  await a.configuration({ type: 'personal-information', entries: [
    { field: 'city', text: 'SELF_PRIVATE_CITY' }, { field: 'occupation', text: 'SELF_SHARED_WORK', allowGroup: true },
    { field: 'status', text: 'SELF_TEMP_STATUS', expiresAt: a.now()+1000 },
  ] });
  assert.equal(selfContext(a, 'person').length, 3);
  assert.deepEqual(selfContext(a, 'group').map(row => row.text), ['SELF_SHARED_WORK']);
  advance(1001); assert.equal(selfContext(a, 'person').length, 3);
  assert.ok(personalInformation(a).entries.every(row => !('expiresAt' in row)));
  assert.doesNotMatch(await readFile(a.file, 'utf8'), /SELF_PRIVATE_CITY|SELF_SHARED_WORK|SELF_TEMP_STATUS/);
  const account = a.data.account; a.data.account = 'another-account';
  assert.equal(selfContext(a, 'person').length, 0); a.data.account = account;
});

test('legacy expired self information and history retain facts and group permissions without expiry', async t => {
  const { a } = await fixture(t);
  const old = [{ id: 'old-private', field: 'status', text: '已确认的本人状态', allowGroup: false, updatedAt: 123, expiresAt: 1 },
    { id: 'old-shared', field: 'city', text: '深圳', allowGroup: true, updatedAt: 124, expiresAt: 1 }];
  a.data.personalInformation = { [a.data.account]: a.vault.seal({ entries: old, suggestions: [], history: [{ at: 100, entries: old }] }) };
  assert.equal(selfContext(a, 'person').length, 2);
  assert.deepEqual(selfContext(a, 'group').map(row => row.text), ['深圳']);
  assert.equal(personalInformation(a).entries[0].id, 'old-private');
  assert.equal(personalInformation(a).entries[0].updatedAt, 123);
  assert.ok(personalInformation(a).history[0].entries.every(row => !('expiresAt' in row)));
  await a.configuration({ type: 'personal-restore', at: 100 });
  assert.ok(personalInformation(a).entries.every(row => !('expiresAt' in row)));
  await a.configuration({ type: 'personal-information', entries: [{ field: 'status', text: '用户已自行修改', expiresAt: 'obsolete-field' }] });
  assert.deepEqual(selfContext(a, 'person').map(row => row.text), ['用户已自行修改']);
  const stored = a.vault.open(a.data.personalInformation[a.data.account]);
  assert.ok(stored.history.flatMap(row => row.entries).every(row => !('expiresAt' in row)));
});

test('new conversation-scene fields persist while unconfirmed model suggestions stay separate', async t => {
  const { a } = await fixture(t);
  await a.configuration({ type: 'personal-information', entries: [
    { field: 'hometown', text: '潮州' }, { field: 'relationships', text: '和家人同住', allowGroup: true },
  ] });
  assert.deepEqual(selfContext(a, 'group').map(row => row.field), ['relationships']);
  assert.ok(a.publicState().personalFields.some(([key]) => key === 'hometown'));
  await assert.rejects(a.configuration({ type: 'personal-information', entries: [{ field: 'password', text: 'invalid' }] }), /请检查个人信息/);
});

test('stale personal drafts and history actions cannot read or write a newly connected account', async t => {
  const { a } = await fixture(t), account = a.data.account;
  await a.configuration({ type: 'personal-information', account, entries: [{ field: 'city', text: '深圳' }] });
  const original = a.data.personalInformation[account];
  a.data.account = 'new-account';
  for (const value of [
    { type: 'personal-information', entries: [{ field: 'city', text: '旧草稿' }] },
    { type: 'personal-history', at: 1 }, { type: 'personal-restore', at: 1 },
    { type: 'personal-suggestion', id: 'old-id', command: 'accept' },
  ]) await assert.rejects(a.configuration({ ...value, account }), error => error.code === 'account_changed');
  assert.equal(personalInformation(a).entries.length, 0);
  assert.equal(a.data.personalInformation[account], original);
  a.data.account = account;
});

test('chat self-information proposals never overwrite manual facts or learn AI-generated facts', async t => {
  const { a, p } = await fixture(t);
  await a.configuration({ type: 'personal-information', entries: [{ field: 'city', text: '深圳' }] });
  p.generatedIds = ['ai-self'];
  const messages = [{ id: 'human', direction: 'self', text: '我搬到上海了' }, { id: 'ai-self', direction: 'self', text: '我搬到北京了' }, { id: 'other', direction: 'other', text: '你住杭州' }];
  assert.equal(stageSelfSuggestions(a, [{ field: 'city', text: '上海', messageId: 'human' }, { field: 'city', text: '北京', messageId: 'ai-self' }, { field: 'city', text: '杭州', messageId: 'other' }], messages), true);
  assert.equal(personalInformation(a).entries[0].text, '深圳');
  const suggestions = personalInformation(a).suggestions; assert.equal(suggestions.length, 1);
  await a.configuration({ type: 'personal-suggestion', id: suggestions[0].id, command: 'accept' });
  assert.equal(personalInformation(a).entries[0].text, '上海');
  assert.equal(selfContext(a, 'group').length, 0);
  assert.ok(personalInformation(a).history.some(row => row.entries.some(entry => entry.text === '深圳')));
});

test('global reply strategy follows inheritance and preserves per-object cap and independent facts', async t => {
  const { a, p } = await fixture(t);
  p.replyStrategy = { replyGoal: '独立目标', facts: '独立事实', boundaries: '独立边界', maxRounds: 7 };
  await a.configuration({ type: 'global-reply-strategy', strategy: { replyGoal: '全局目标', facts: '全局事实', boundaries: '全局边界' } });
  assert.equal(a.strategy(p, 'reply').facts, '独立事实');
  p.inheritReplyStrategy = true;
  assert.equal(a.strategy(p, 'reply').facts, '全局事实');
  assert.equal(a.strategy(p, 'reply').maxRounds, 7);
  await a.configuration({ type: 'global-reply-strategy', strategy: { replyGoal: '更新目标', facts: '更新事实', boundaries: '更新边界' } });
  assert.equal(a.strategy(p, 'reply').replyGoal, '更新目标');
  assert.equal(p.replyStrategy.facts, '独立事实');
});

test('preset edits create separate custom tabs, custom edits stay local, style deletion retains memory', async t => {
  const { a, p, contact, options } = await fixture(t);
  assert.equal(styleTabs(p).length, 5);
  const defaultStyle = a.publicState().schema.defaultStyle;
  const summary = ['formality', 'warmth', 'length', 'directness', 'emoji', 'humor', 'customTone'].map(key => defaultStyle[key]).filter(Boolean).join('，');
  await a.saveReplyProfile({ contact, styleId: '', style: { ...defaultStyle, summary }, strategy: {}, preserveSwitches: true });
  assert.equal(p.styleId, ''); assert.equal(p.customStyles.length, 0, 'saving default display text keeps following the default');
  p.learnedStyle = { ...defaultStyle, customTone: '已学习语气' };
  const learnedSummary = summary + '，已学习语气';
  assert.equal(saveObjectStyle(p, { ...p.learnedStyle, summary: learnedSummary }, 'learned').styleId, 'learned');
  assert.equal(p.customStyles.length, 0);
  await a.editMemory(p.id, { summary: 'STYLE_MEMORY_PRESERVE' });
  await a.saveReplyProfile({ contact, styleId: 'preset:natural', style: { summary: '自定义甲' }, strategy: {}, preserveSwitches: true });
  const one = p.styleId;
  await a.saveReplyProfile({ contact, styleId: 'preset:polite', style: { summary: '自定义乙' }, strategy: {}, preserveSwitches: true });
  const two = p.styleId; assert.notEqual(one, two); assert.equal(p.customStyles.length, 2);
  await a.saveReplyProfile({ contact, styleId: one, style: { summary: '修改甲' }, strategy: {}, preserveSwitches: true });
  assert.equal(p.customStyles.length, 2); assert.equal(p.customStyles.find(row => row.id === two).style.summary, '自定义乙');
  await a.configuration({ type: 'style', id: p.id, command: 'rename', styleId: one, name: '我的甲' });
  await assert.rejects(a.configuration({ type: 'style', id: p.id, command: 'rename', styleId: '', name: '错误' }));
  await a.configuration({ type: 'style', id: p.id, command: 'delete', styleId: two });
  assert.match(a.publicState().profiles[0].memory.summary, /STYLE_MEMORY_PRESERVE/);
  assert.equal(a.replyOptions(p).enabled, true);
  const b = new AIAssistant(options); await b.init();
  try { assert.equal(b.profiles()[0].customStyles[0].label, '我的甲'); } finally { await b.close(); }
});

test('delete-all confirmation includes old records, retains new arrivals and never changes dedupe or caps', async t => {
  const { a, p } = await fixture(t);
  p.rounds = 123; p.generatedIds = ['old-id'];
  p.sentMessages = Array.from({ length: 650 }, (_, i) => ({ id: `old-${i}`, source: 'reply', at: a.now()-i, body: a.vault.seal({ text: `正文${i}` }) }));
  const preview = await a.configuration({ type: 'clear-records', source: 'reply' });
  assert.equal(preview.confirmation.count, 650);
  p.sentMessages.push({ id: 'new-during-dialog', at: a.now()+1, source: 'reply', body: a.vault.seal({ text: '确认期间的新消息' }) });
  await a.configuration({ type: 'clear-records', token: preview.confirmation.token });
  const records = await a.activityRecords([p.id], {});
  assert.deepEqual(records.records[0].messages.map(row => row.id), ['new-during-dialog']);
  assert.equal(p.sentMessages.length, 651); assert.equal(p.rounds, 123); assert.deepEqual(p.generatedIds, ['old-id']);
  await assert.rejects(a.configuration({ type: 'clear-records', token: preview.confirmation.token }), /过期/);
});

test('failed record deletion restores visible records and preserves new records created during saving', async t => {
  const { a, p } = await fixture(t);
  a.event('skip', p.id, 'model-skip', '无需回复', { messageId: 'old' });
  const preview = await a.configuration({ type: 'clear-records', source: 'skip' }), save = a.save;
  a.save = async () => { a.event('skip', p.id, 'model-skip', '新消息', { messageId: 'new' }); throw Error('disk full'); };
  await assert.rejects(a.configuration({ type: 'clear-records', token: preview.confirmation.token }), /disk full/);
  a.save = save;
  assert.equal(a.skipEvents().length, 2);
  assert.deepEqual(new Set(a.skipEvents().map(row => row.messageId)), new Set(['old','new']));
});

test('failed account settings and style saves retain the previously effective values and runtime records', async t => {
  const { a, p } = await fixture(t);
  await a.configuration({ type: 'personal-information', entries: [{ field: 'city', text: '深圳' }] });
  await a.configuration({ type: 'global-reply-strategy', strategy: { replyGoal: '旧目标' } });
  const save = a.save, previousStyle = p.styleId;
  a.save = async () => { p.sentMessages ||= []; p.sentMessages.push({ id: 'concurrent-receipt' }); throw Error('disk full'); };
  await assert.rejects(a.configuration({ type: 'personal-information', entries: [{ field: 'city', text: '上海' }] }), /disk full/);
  assert.equal(personalInformation(a).entries[0].text, '深圳');
  await assert.rejects(a.configuration({ type: 'global-reply-strategy', strategy: { replyGoal: '新目标' } }), /disk full/);
  assert.equal(a.globalReplyStrategy().replyGoal, '旧目标');
  await assert.rejects(a.configuration({ type: 'style', id: p.id, command: 'add' }), /disk full/);
  assert.equal((p.customStyles || []).length, 0); assert.equal(p.styleId, previousStyle);
  assert.equal(p.sentMessages.length, 3);
  a.save = save;
});

test('unreply paging covers more than 50 records and compact updates explicitly clear transient state', async t => {
  const { a, p } = await fixture(t);
  for (let i=0; i<125; i++) a.event('skip', p.id, 'model-skip', '无需回复', { messageId: 'incoming-'+i });
  const first = a.skipRecords(), second = a.skipRecords({ before: first.page.nextBefore }), third = a.skipRecords({ before: second.page.nextBefore });
  assert.equal(first.page.total, 125); assert.equal(second.records.length, 50); assert.equal(third.records.length, 25);
  assert.equal(new Set([...first.records, ...second.records, ...third.records].map(row => row.id)).size, 125);
  p.groupReplyLimitBlocked = true; delete p.groupReplyLimitBlocked;
  const compact = JSON.parse(JSON.stringify(a.publicLiveState(p.contact)));
  assert.equal(compact.profiles[0].groupReplyLimitBlocked, false); assert.equal(compact.profiles[0].groupWait, null);
});

test('time context uses current timezone and only corrects a misplaced opening greeting', () => {
  const now = Date.parse('2026-09-30T15:20:30+08:00'), context = currentChatTime(now);
  assert.equal(context.timeContext.daypart, '下午'); assert.equal(context.timeContext.weekday, '星期三');
  assert.equal(guardTimeGreeting('早上好，最近怎样？', context), '你好，最近怎样？');
  assert.equal(guardTimeGreeting('王老师，早安！', context), '王老师，你好！');
  assert.equal(guardTimeGreeting('他说过“早上好”', context), '他说过“早上好”');
  assert.equal(currentChatTime(now, [{ field: 'timezone', text: 'Invalid/Zone' }]).timezone, 'Asia/Shanghai');
  assert.equal(currentChatTime(now, [{ field: 'timezone', text: 'America/New_York' }]).timeContext.hour, 3);
});

test('reply schema repairs case and rejects incomplete replies while group wait remains valid', () => {
  assert.equal(validateReplyResult({ action: ' SEND ', text: '内容' }).action, 'send');
  assert.deepEqual(validateReplyResult({ action: 'wait' }, { group: true }), { action: 'wait' });
  for (const result of [{ action: 'send' }, { text: '没有动作' }, { stop: true, action: 'send', text: '矛盾' }, { action: 'wait' }]) assert.throws(() => validateReplyResult(result), error => error.code === 'ai_model_schema');
});
