import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { annotateChatTimes, staleProactiveTimeClaim } from '../server/ai-time-context.mjs';
import { proactiveTimelinePrompt } from '../server/ai-prompts.mjs';
import { speakerAuditInput } from '../server/ai-speakers.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const now = Date.parse('2026-10-02T10:00:00+08:00');
const sent = value => Math.floor(Date.parse(value) / 1000);
const row = (id, direction, text, time) => ({ id, direction, text, ...(time ? { timestamp: sent(time) } : {}) });
const history = [
  row('plan', 'other', '今天准备试试你说的那个办法', '2026-10-01T17:00:00+08:00'),
  row('answered', 'self', '好，先试试，不着急', '2026-10-01T17:01:00+08:00'),
];

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  await a.saveReplyProfile({ contact: bridge.contacts[0].id, style: { summary: '熟人说话自然简短，不使用亲昵称呼。' }, strategy: {} });
  return { a, bridge, provider, profile: a.profiles().find(item => item.contact === bridge.contacts[0].id) };
}
const task = { goal: '自然关心对方，适度跟进最近讨论的事情', requirements: '不预设对方已试过、不重复询问未回答的问题' };

test('chat chronology anchors yesterday and its relative words without changing source rows', () => {
  const input = structuredClone(history);
  const output = annotateChatTimes(input, now);
  assert.equal(output[0].temporal.sourceDate, '2026-10-01');
  assert.equal(output[0].temporal.localTime, '2026-10-01T17:00:00');
  assert.equal(output[0].temporal.relation, 'yesterday');
  assert.equal(output[0].temporal.daysAgo, 1);
  assert.equal(output[0].temporal.ageSeconds, 17 * 3600);
  assert.equal(output[0].relativeDates, undefined);
  assert.deepEqual(output[0].relativeDateWords, ['今天']);
  assert.equal(output[0].text, input[0].text);
  assert.deepEqual(input, history);
});

test('calendar dates respect configured timezone including daylight-saving gaps', () => {
  const current = Date.parse('2026-03-08T10:30:00Z');
  const [message] = annotateChatTimes([row('dst', 'other', '今天会试试', '2026-03-08T07:30:00Z')], current, 'America/Los_Angeles');
  assert.equal(message.temporal.sourceDate, '2026-03-07');
  assert.equal(message.temporal.daysAgo, 1);
  assert.equal(message.temporal.ageSeconds, 3 * 3600);
  assert.equal(message.temporal.relation, 'yesterday');
  assert.equal(message.relativeDates, undefined);
  assert.deepEqual(message.relativeDateWords, ['今天']);
});

test('a viewer in Los Angeles cannot assign their local day to a China counterpart event', () => {
  const current = Date.parse('2026-10-02T12:00:00+08:00');
  const incoming = row('china-today', 'other', '今天中午试试，明天再看看效果', '2026-10-02T11:00:00+08:00');
  const own = row('la-today', 'self', '今天先看看，明天再说', '2026-10-02T11:00:00+08:00');
  const [other, self] = annotateChatTimes([incoming, own], current, 'America/Los_Angeles');
  assert.equal(other.temporal.sourceDate, '2026-10-01');
  assert.equal(other.temporal.calendarBasis, 'viewer-timezone');
  assert.equal(other.relativeDates, undefined);
  assert.deepEqual(other.relativeDateWords, ['今天', '明天']);
  assert.deepEqual(self.relativeDates, { 今天: '2026-10-01', 明天: '2026-10-02' });
  assert.equal(self.text, own.text);
});

test('missing, malformed and future timestamps never acquire an invented historical date', () => {
  const input = [undefined, null, '1760000000', Number.MAX_SAFE_INTEGER, -1].map((timestamp, index) => ({ id: `bad-${index}`, text: '今天试试', timestamp }));
  for (const message of annotateChatTimes(input, now)) {
    assert.deepEqual(message.temporal, { known: false, timezone: 'Asia/Shanghai', calendarBasis: 'viewer-timezone', relation: 'unknown', usableAsCurrentState: false });
    assert.equal(message.sourceDate, undefined);
    assert.equal(message.relativeDates, undefined);
  }
  const [future] = annotateChatTimes([row('future', 'other', '我去开会', '2026-10-03T09:00:00+08:00')], now);
  assert.equal(future.temporal.relation, 'future');
  assert.equal(future.temporal.ageSeconds, null);
  assert.equal(future.temporal.usableAsCurrentState, false);
});

test('a short midnight gap stays recent while a stale just-said claim is identified', () => {
  const lateNow = Date.parse('2026-10-02T00:03:00+08:00');
  const rows = [row('midnight', 'other', '刚装好', '2026-10-01T23:59:00+08:00')];
  const output = { action: 'send', text: '你刚才说装好了，用着怎么样？' };
  assert.equal(annotateChatTimes(rows, lateNow)[0].temporal.ageSeconds, 240);
  assert.equal(staleProactiveTimeClaim(output, rows, lateNow), false);
  assert.equal(staleProactiveTimeClaim(output, history, now), true);
  assert.equal(staleProactiveTimeClaim({ action: 'send', text: '昨天说的那个办法，后来有没有试试？' }, history, now), false);
  assert.equal(staleProactiveTimeClaim({ action: 'send', text: '之前那句“你刚才说”是指当时的聊天' }, history, now), false);
  assert.equal(staleProactiveTimeClaim(output, [row('unknown', 'other', '刚装好')], now), false);
});

test('proactive generation receives dated background and preserves a separate pending reply window', async t => {
  const { a, bridge, provider, profile } = await fixture(t);
  const cursor = { pending: true, pendingAfter: 'answered', pendingSince: now - 10000 };
  a.cursors.set(profile.id, cursor);
  provider.next = async () => ({ action: 'send', text: '昨天说的那个办法，后来有机会试试吗？', followUp: false });
  const result = await a.generateProactiveMessage(task, profile, { messages: structuredClone(history) }, new AbortController().signal);
  const call = provider.calls.at(-1);
  assert.equal(provider.calls.length, 1);
  assert.equal(call.input.currentTime, '2026-10-02T10:00:00');
  assert.equal(call.input.timezone, 'Asia/Shanghai');
  assert.deepEqual(call.input.conversation.pendingIncomingIds, []);
  assert.deepEqual(call.input.conversation.pendingIncomingMessages, []);
  assert.ok(call.input.messages.every(message => message.pending === false));
  assert.equal(call.input.conversation.latestIncoming.temporal.relation, 'yesterday');
  assert.equal(call.input.conversation.recentSelfMessages[0].temporal.sourceDate, '2026-10-01');
  assert.ok(call.system.includes(proactiveTimelinePrompt));
  assert.match(call.system, /不能预设已经试过、有效或仍在进行/);
  assert.match(call.system, /不催促、不换词重复问/);
  assert.equal(result.text, '昨天说的那个办法，后来有机会试试吗？');
  const audit = speakerAuditInput(call.input, result);
  const auditedHistory = audit.speakerHistory.flatMap(group => group.messages);
  assert.deepEqual(auditedHistory.find(message => message.text === history[0].text).temporal, call.input.messages[0].temporal);
  assert.equal(auditedHistory.find(message => message.text === history[0].text).relativeDates, undefined);
  assert.deepEqual(auditedHistory.find(message => message.text === history[0].text).relativeDateWords, ['今天']);
  assert.deepEqual(audit.pendingIncomingMessages, []);
  assert.deepEqual(audit.timeContext, call.input.timeContext);
  assert.strictEqual(a.cursors.get(profile.id), cursor);
  assert.equal(profile.handledIncomingId, undefined);
  assert.equal(bridge.sent.length, 0);
});

test('a stale just-said draft is corrected once without sending or replacing the history', async t => {
  const { a, bridge, provider, profile } = await fixture(t);
  provider.next = async () => ({ action: 'send', text: '你刚才说准备去试试，那你现在去试吧', followUp: false });
  const result = await a.generateProactiveMessage(task, profile, { messages: structuredClone(history) }, new AbortController().signal);
  assert.equal(provider.calls.length, 2);
  assert.match(provider.calls[1].system, /最近对方来信已过去数小时/);
  assert.equal(result.text, 'GENERATED_PRIVATE_MARKER');
  assert.deepEqual(provider.calls[0].input.messages, provider.calls[1].input.messages);
  assert.equal(bridge.sent.length, 0);
});

test('two stale time claims fail before delivery instead of generating another automatic send', async t => {
  const { a, bridge, provider, profile } = await fixture(t);
  provider.complete = async (_config, system, input) => {
    provider.calls.push({ system, input });
    return { action: 'send', text: '你刚刚说准备试试，那现在去试吧', followUp: false };
  };
  await assert.rejects(a.generateProactiveMessage(task, profile, { messages: history }, new AbortController().signal), /仍将历史来信当作刚刚发生/);
  assert.equal(provider.calls.length, 2);
  assert.equal(bridge.sent.length, 0);
});

test('stop requests remain stop requests and unknown message dates remain unknown at the model boundary', async t => {
  const { a, bridge, provider, profile } = await fixture(t);
  provider.next = async () => ({ stop: true });
  const result = await a.generateProactiveMessage(task, profile, { messages: [row('stop', 'other', '不要联系我')] }, new AbortController().signal);
  assert.deepEqual(result, { stop: true });
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].input.conversation.latestIncoming.temporal.relation, 'unknown');
  assert.equal(provider.calls[0].input.messages[0].timestamp, undefined);
  assert.equal(bridge.sent.length, 0);
});

for (const [name, message, draft, corrected] of [
  ['unknown-time plan', row('unknown-plan', 'other', '今天去试试那个办法'), '怎么样，有效果吗', '之前说的办法，后来有机会试试吗？'],
  ['future-clock activity', row('future-meeting', 'other', '今天准备去开会', '2026-10-03T09:00:00+08:00'), '早，开会顺利', '早，最近怎么样？'],
  ['future-clock implied trip', row('future-trip', 'other', '今天准备去开会', '2026-10-03T09:00:00+08:00'), '早啊，路上注意安全', '早啊'],
  ['unconfirmed use duration', row('setup-confirmed', 'other', '设置好了，文件也同步好了', '2026-10-01T17:01:00+08:00'), '用了几天感觉怎么样，有没有遇到什么问题？', '用着感觉怎么样？'],
]) {
  test(`the real provider audit path retains temporal evidence and rechecks a repaired ${name}`, async t => {
    const { a, bridge, profile } = await fixture(t);
    const requests = [];
    a.provider = new AIProvider({ fetcher: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      const value = requests.length === 1 ? { action: 'send', text: draft, followUp: false }
        : requests.length === 2 ? { consistent: false, text: corrected }
          : { consistent: true, checks: [{ partId: 'reply_1', attribution: '当前本人回应对方', grounding: '没有预设对方已经尝试或当前正在开会' }] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
    } });
    const result = await a.generateProactiveMessage(task, profile, { messages: [message] }, new AbortController().signal);
    assert.equal(result.text, corrected);
    assert.equal(requests.length, 3);
    const generatedInput = JSON.parse(requests[0].messages.at(-1).content);
    assert.equal(generatedInput.messages[0].temporal.usableAsCurrentState, name === 'unconfirmed use duration' ? undefined : false);
    assert.match(requests[0].messages[0].content, /不能只问“怎么样、有效果吗”/);
    assert.match(requests[0].messages[0].content, /不补持续时间/);
    const auditInput = JSON.parse(requests[1].messages.at(-1).content);
    assert.equal(auditInput.speakerHistory[0].messages[0].temporal.usableAsCurrentState, name === 'unconfirmed use duration' ? undefined : false);
    assert.match(requests[1].messages[0].content, /提问和祝愿中的预设也须核对/);
    assert.match(requests[1].messages[0].content, /出行关心也在预设行动/);
    assert.match(requests[1].messages[0].content, /发言间隔不是活动持续时长/);
    assert.equal(JSON.parse(requests[2].messages.at(-1).content).draft.text, corrected);
    assert.equal(bridge.sent.length, 0);
  });
}
