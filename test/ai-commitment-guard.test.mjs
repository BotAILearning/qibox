import test from 'node:test';
import assert from 'node:assert/strict';
import { guardFinancialCommitment } from '../server/ai-commitment-guard.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('an unapproved payment request cannot turn a short yes into a financial promise', () => {
  assert.deepEqual(guardFinancialCommitment('你明天能帮我垫付五百块吗？', { action: 'send', text: '可以啊，怎么了' }),
    { action: 'send', text: '这事我现在答应不了，抱歉', followUp: false });
  assert.deepEqual(guardFinancialCommitment('能借我五百吗？', { action: 'send', segments: ['没问题', '明天给你'] }),
    { action: 'send', text: '这事我现在答应不了，抱歉', followUp: false });
  assert.deepEqual(guardFinancialCommitment('你能帮我付钱吗？', { action: 'send', text: '最近手头也紧，没法付' }),
    { action: 'send', text: '这事我现在答应不了，抱歉', followUp: false });
});

test('the guard leaves ordinary replies and explicit user authorization alone', () => {
  const reply = { action: 'send', text: '可以啊，怎么了' };
  assert.equal(guardFinancialCommitment('明天有空聊天吗？', reply), reply);
  assert.equal(guardFinancialCommitment('能帮我垫付吗？', reply, { facts: '我已经同意垫付这笔钱' }), reply);
  const ordinary = { action: 'send', text: '转账截图我看到了' };
  assert.equal(guardFinancialCommitment('昨天的转账截图你看了吗？', ordinary), ordinary);
});

test('a past-payment status question is distinct from a request for a new financial commitment',()=>{
  const reply={action:'send',text:'这边还没有付款的确认，先别当作付了'};
  for(const incoming of ['你是不是已经帮我付钱了？','你已经付款了吗？','你是否替我转账了？'])assert.deepEqual(guardFinancialCommitment(incoming,reply),{action:'send',text:'这边还没有付款的确认，先别当作已经付了',followUp:false});
  for(const incoming of ['你是不是可以帮我付钱了？','你是不是已经帮我付钱了？再借我五百吧'])assert.equal(guardFinancialCommitment(incoming,reply).text,'这事我现在答应不了，抱歉');
});

test('an unsafe model answer is replaced before the real send boundary', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.UTC(2026, 8, 29, 12);
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await assistant.init();
  t.after(async () => { await assistant.close(); await cleanup(root); });
  await assistant.configure(modelConfig);
  await assistant.scan();
  const contact = bridge.contacts[0].id;
  await assistant.setReplyOptions({ contact, enabled: true });
  await assistant.settings({ enabled: true });
  await assistant.tick();
  const incoming = bridge.push(contact, 'other', '你明天能帮我垫付五百块吗？');
  incoming.timestamp = Math.floor(now / 1000);
  await assistant.tick(); now += 20000;
  provider.next = async () => ({ action: 'send', text: '最近手头也紧，这阵子没法垫哦' });
  await assistant.tick();
  assert.equal(bridge.sent.at(-1)?.text, '这事我现在答应不了，抱歉');
});
