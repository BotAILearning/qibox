import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { replySafetyPrompt, disclosesAIIdentity, claimsUnverifiedExecution, replySafetyViolation } from '../server/ai-reply-safety.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('robot introductions and model explanations are recognized without banning AI as a topic', () => {
  for (const text of ['我是一个机器人', '我只是个AI助手', '作为一名聊天机器人，我能帮你', '我是 ＡＩ', '我的回答由人工智能生成', '本次回复是由AI代为回复的', "I'm an AI", 'I am a language model', '我是自动回复系统', '是AI代回的', '由机器人回复'])
    assert.equal(disclosesAIIdentity(text), true, text);
  for (const text of ['你觉得AI哪个好用', '我觉得机器人很有意思', '他说“我是机器人”', '不要说我是机器人', '（AI 合成语音）你好', '我是做机器人研发的'])
    assert.equal(disclosesAIIdentity(text), false, text);
});

test('external completion, fake live operations and delayed promises fail before sending', () => {
  for (const text of ['已执行任务', '任务执行完成', '我已经完成任务', '好的，已经帮你完成任务', '任务已经处理好了', '我帮你处理好了', '我已经办妥', '搞定了', '完成✅', 'Done!', '任务执行成功', '我已经替你下单了', '我帮你设置好了', '我把文件删除了', '申请已提交', '我正在查询', '我稍后给你转账', '不能运行脚本，但我已运行代码', '我没有查询权限，已经查到结果', 'I have already executed the task', 'The task is completed'])
    assert.equal(claimsUnverifiedExecution(text), true, text);
});

test('acknowledgements, suggestions, denials, attribution and examples remain sendable', () => {
  for (const text of ['收到了', '我明白了', '我已经收到你的消息', '我看懂你的意思了', '可以先打开设置，再点击保存', '我没有执行任务', '还没有下单，需要你确认', '无法付款，可以说明具体步骤', '你已经提交了吗', '你说“我已经处理好了”，那我等你结果', '如果已经执行，请核对结果', '不要声称任务已完成', '例如“申请已提交”只是示例', '刚才你提到已预约，我记住这个安排'])
    assert.equal(claimsUnverifiedExecution(text), false, text);
  assert.match(replySafetyPrompt, /当前没有执行外部操作的工具/);
  assert.match(replySafetyPrompt, /优先于风格/);
});

test('implicit admissions are scoped to pending identity questions and apply to segments and speech', () => {
  for(const text of ['抱歉，回得确实太机械了，被你发现了。','哈哈，你猜对了','没错','是的','被你识破了','不是我亲自回的。']) {
    assert.equal(replySafetyViolation([text], {identityAsked:true}), 'identity',text);
    assert.equal(replySafetyViolation([text]), '',text);
    assert.equal(replySafetyViolation([text], {identityAsked:true,allowIdentity:true}), '',text);
  }
  assert.equal(replySafetyViolation(['被你','发现了'], {identityAsked:true}), 'identity');
  assert.equal(replySafetyViolation(['哪里听着不自然？'], {identityAsked:true}), '');
  assert.equal(replySafetyViolation(['他说被你发现了。'], {identityAsked:true}), '');
  assert.equal(replySafetyViolation(['哪里听着不自然？'], {identityAsked:true,audioText:'被你发现了'}), 'identity');
});

test('an unknown plan cannot create a future notification promise', () => {
  for(const text of ['现在还没确定，定了告诉你。','确定了通知你一声。','等我确认了跟你说。','到了再给你发消息。','明天几点到还没定，我先确认下再告诉你。','先问一下再回复你。','我确认下再跟你说。','确认后告诉你。','一确定就告诉你。','定好了我会通知你。'])
    assert.equal(claimsUnverifiedExecution(text),true,text);
  for(const text of ['还不确定，具体时间说不准。','你定了告诉我吧。','你确定了通知我一声。','如果确定了，请你告诉我。'])
    assert.equal(claimsUnverifiedExecution(text),false,text);
});

test('splitting a claim across segments and quoting it bare cannot bypass the guard', () => {
  assert.equal(replySafetyViolation(['我是一个', '机器人']), 'identity');
  assert.equal(replySafetyViolation(['任务已经', '执行完成']), 'execution');
  assert.equal(replySafetyViolation(['“已执行任务”']), 'execution');
  assert.equal(replySafetyViolation(['我是AI'], { allowIdentity: true }), '');
  assert.equal(replySafetyViolation(['我是AI，任务已执行'], { allowIdentity: true }), 'execution');
  assert.equal(replySafetyViolation(['收到'], { audioText: '我是一个机器人' }), 'identity');
  assert.equal(replySafetyViolation(['收到'], { audioText: '已经帮你处理好了' }), 'execution');
  assert.equal(replySafetyViolation(['收到'], { audioText: '语音确认收到' }), '');
});

async function fixture(t, group = false) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true;
  if (group) bridge.contacts[0].kind = 'group';
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.scan();
  const contact = bridge.contacts[0].id;
  if (group) await a.setGroupOptions({ contact, atMe: true });
  else await a.setReplyOptions({ contact, enabled: true, judgeReply: false });
  await a.settings({ enabled: true }); await a.tick();
  const p = a.profiles().find(value => value.contact === contact);
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, bridge, provider, p, async receive(text = '请帮我处理任务') {
    const incoming = Object.assign(bridge.push(contact, 'other', text), { timestamp: Math.floor(now / 1000),
      ...(group ? { sender: 'a'.repeat(64), mentions: { verified: true, self: true, all: false, others: false } } : {}) });
    await a.tick(); now += group ? 3000 : 20000; await a.tick(); return incoming;
  }};
}

for(const [question,text,reasonCode] of [
  ['你现在具体在哪个地方？','怎么突然问这个，我在家呢。','unverified-personal-fact'],
  ['你今天在哪家公司上班？','我没有在哪家公司上班。','unverified-personal-fact'],
  ['改成周日吧，周六我不行。','行，那就改周日，具体几点等我确认一下再跟你说。','unverified-execution'],
  ['改成周日吧，周六我不行。','行，改成周日。我确认下时间再回你。','unverified-execution'],
  ['改成周日吧，周六我不行。','行，那就周日。具体几点我确认下再跟你定。','unverified-execution'],
  ['你是AI在代回复吗？','不是的，有什么事你说','identity-rule-block'],
  ['你现在具体在哪个地方？','你问这个是要找我吗？我这边位置不太方便说。','unverified-personal-fact'],
  ['我去年旅行拍的照片今天才整理，别以为我现在在外地。','整理一年前的照片挺费劲的吧。','unverified-time-fact'],
  ['我只说喜欢茶，没说我每天都喝咖啡。','哦哦记错了，是喜欢茶，那下次给你带点茶。','unverified-execution'],
  ['改成周日吧，周六我不行。','行，那改周日。具体几点我再确认一下，到时候跟你说。','unverified-execution'],
  ['我只说喜欢茶，没说我每天都喝咖啡。','行，是我记岔了，你喜欢茶。那回头选茶的时候叫上你。','unverified-execution'],
  ['我周日想买书，其余再看，不用帮我确定计划。','行，那就定周日，按天气看着办就好','unverified-execution'],
  ['改成周日吧，周六我不行。','行，那就改周日，具体几点到时候再定。','unverified-execution'],
  ['昨天下雨那事已经过去了，现在只想找点吃的。','那就找点想吃的去，昨晚的事翻篇就好','unverified-time-fact'],
  ['你记错了，胃疼的是我，不是你。','我没记错呀，昨天听你说胃疼。','unverified-time-fact'],
])test(`final local guard stops ${reasonCode} without another model request`,async t=>{
  const f=await fixture(t);f.provider.next=async()=>({action:'send',text});await f.receive(question);
  assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,0);
  assert.ok(f.a.data.events.some(e=>e.code==='skip'&&e.reasonCode===reasonCode));
  await f.a.tick();assert.equal(f.provider.calls.length,1,'The rejected turn must not be replayed');
});

for (const [bad, reason] of [['我是一个机器人', 'identity'], ['任务已执行完成', 'execution']]) {
  test(`${reason}: one corrected draft is sent, unsafe original never reaches the sender`, async t => {
    const f = await fixture(t); f.provider.next = async () => ({ action: 'send', text: bad });
    await f.receive();
    assert.equal(f.provider.calls.length, 2);
    assert.deepEqual(f.bridge.sent.map(row => row.text), ['GENERATED_PRIVATE_MARKER']);
    assert.match(f.provider.calls[1].system, reason === 'identity' ? /上一份正文违规/ : /上一份正文声称/);
    assert.equal(f.provider.calls[0].input.capabilities.executeExternalActions, false);
    assert.ok(f.provider.calls[0].system.indexOf(replySafetyPrompt) > f.provider.calls[0].system.indexOf('本轮用户为当前联系人设置的风格'));
  });
  test(`${reason}: persistent invalid drafts leave a visible unsent record and later messages still work`, async t => {
    const f = await fixture(t); let calls = 0;
    f.provider.complete = async () => { calls++; return { action: 'send', text: bad }; };
    const incoming = await f.receive(); await f.a.tick();
    assert.equal(calls, 2); assert.equal(f.bridge.sent.length, 0);
    const record = f.a.publicState().skipRecords[0];
    assert.equal(record.source, 'system-skip'); assert.equal(record.messageId, incoming.id);
    assert.equal(record.reasonCode, reason === 'identity' ? 'identity-rule-block' : 'unverified-execution');
    f.provider.complete = async () => ({ action: 'send', text: '收到了' });
    await f.receive('只确认收到即可'); assert.equal(f.bridge.sent.length, 1); assert.equal(f.p.paused, false);
  });
}

test('a group @me requirement does not override the execution guard or erase the skipped record', async t => {
  const f = await fixture(t, true); f.provider.complete = async () => ({ action: 'send', text: '我已经执行任务了' });
  const incoming = await f.receive('@我 请处理');
  assert.equal(f.bridge.sent.length, 0);
  const record = f.a.publicState().skipRecords[0];
  assert.equal(record.reasonCode, 'unverified-execution'); assert.equal(record.messageId, incoming.id);
});

test('an unknown past-payment question receives a status answer without a new request or invented receipt',async t=>{
  const f=await fixture(t);let calls=0;
  f.provider.complete=async()=>{calls++;return{action:'send',text:'我已经帮你付钱了'};};
  await f.receive('你是不是已经帮我付钱了？');
  assert.equal(calls,1);assert.deepEqual(f.bridge.sent.map(x=>x.text),['这边还没有付款的确认，先别当作已经付了']);
});

for(const [question,text] of [['你今天在哪家公司上班？','这个我暂时说不上来，你找我有什么事吗？'],['你现在具体在哪个地方？','我这边具体情况说不太上，你先说说要处理啥']])test('a pure unknown personal question receives a neutral clarification within the same request',async t=>{
 const f=await fixture(t);f.provider.next=async()=>({action:'send',text,memoryUpdates:[{text:'不应保存的推测'}]});await f.receive(question);
 assert.equal(f.provider.calls.length,1);assert.deepEqual(f.bridge.sent.map(x=>x.text),['怎么了，找我有事吗？']);
 assert.equal(f.a.publicProfile(f.p).memory.entries.length,0);assert.equal(f.p.paused,false);
});

test('a rejected future-time addition preserves only the human-approved date correction without another request',async t=>{
 const f=await fixture(t);Object.assign(f.bridge.messages.get(f.p.contact)[0],{text:'先按周六记着。',authorship:'human',timestamp:Math.floor(f.a.now()/1000)-60});
 f.provider.next=async()=>({action:'send',text:'行，那就改周日，具体几点到时候再定。'});
 await f.receive('改成周日吧，周六我不行。');assert.equal(f.provider.calls.length,1);assert.deepEqual(f.bridge.sent.map(x=>x.text),['行，改成周日。']);
});

test('the identity switch is scoped to this pending question, never an old question or proactive task', async t => {
  const f = await fixture(t); await f.a.settings({ acknowledgeAI: true });
  f.provider.complete = async () => ({ action: 'send', text: '我是AI代为回复' });
  await f.receive('你是AI吗'); assert.equal(f.bridge.sent.length, 1);
  await f.receive('聊聊今天的计划'); assert.equal(f.bridge.sent.length, 1);
  assert.equal(f.a.proactiveUnsupported('我是AI代为回复', { messages: [{ direction: 'other', text: '你是AI吗' }] }).includes('身份'), true);
});

test('a disabled identity switch corrects an indirect admission before sending without banning ordinary chat', async t => {
  const f=await fixture(t);
  f.provider.next=async()=>({action:'send',text:'抱歉，回得太机械了，被你发现了。'});
  await f.receive('你这是不是AI回复的？');
  assert.equal(f.provider.calls.length,2);
  assert.deepEqual(f.bridge.sent.map(row=>row.text),['GENERATED_PRIVATE_MARKER']);
  assert.match(f.provider.calls[1].system,/间接承认/);
  f.provider.complete=async()=>({action:'send',text:'被你发现了'});
  await f.receive('我发现你整理过书架了');
  assert.equal(f.bridge.sent.at(-1).text,'被你发现了');
});

test('proactive drafts retry safety violations once and reject repeated false completion', async t => {
  const f = await fixture(t), snapshot = { messages: [] }, task = { goal: '自然问候', requirements: '' };
  f.provider.next = async () => ({ action: 'send', text: '任务已经执行' });
  const corrected = await f.a.generateProactiveMessage(task, f.p, snapshot, new AbortController().signal);
  assert.equal(corrected.text, 'GENERATED_PRIVATE_MARKER'); assert.equal(f.provider.calls.length, 2);
  f.provider.complete = async () => ({ action: 'send', text: '我是一个机器人' });
  await assert.rejects(f.a.generateProactiveMessage(task, f.p, snapshot, new AbortController().signal), /身份规则/);
  assert.equal(f.bridge.sent.length, 0);
});

for (const [audioText, reason] of [['我是一个机器人', 'identity-rule-block'], ['任务已经执行完成', 'unverified-execution']]) {
  test(`safe text cannot hide unsafe native voice: ${reason}`, async t => {
    const f = await fixture(t);
    await f.a.configure({ ...modelConfig, baseUrl: 'https://api.minimaxi.com/v1' });
    f.bridge.supportsMediaOutput = true; f.bridge.supportsNativeVoiceOutput = true;
    await f.a.setReplyOptions({ contact: f.p.contact, sendAudio: true });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unsafe speech must never reach media generation'); });
    f.provider.complete = async () => ({ action: 'send', text: '收到', media: [{ type: 'audio', text: audioText }] });
    await f.receive('请发语音');
    assert.equal(fetchMock.mock.callCount(), 0); assert.equal(f.bridge.sent.length, 0);
    assert.equal(f.a.publicState().skipRecords[0].reasonCode, reason);
  });
}
