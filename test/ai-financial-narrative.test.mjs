import test from 'node:test';
import assert from 'node:assert/strict';
import { guardFinancialCommitment } from '../server/ai-commitment-guard.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const ordinary = [
  '回来看见你发的付款截图，突然觉得这七百八还挺好玩的。',
  '你那个小白方块倒挺适合放桌角，远看像没花什么钱，付款时就一点也不小了。',
  '你刚发的转账凭证挺清楚，数字一眼就看到了。',
  '你截图里的支付金额是七百八，跟他修车的数一样。',
  '你说这个小东西能放桌角，付款时倒是一点也不小。',
  '你发的付款成功截图收到了，数字挺清楚的。',
  '能帮我看一下支付金额吗？这张截图太小了。',
];

for (const incoming of ordinary) test('financial narrative preserves the generated ordinary reply: '+incoming, () => {
  const reply={action:'send',text:'东西越小，付款那一下越有存在感。',followUp:false};
  assert.equal(guardFinancialCommitment(incoming,reply),reply);
});

test('a receipt mention cannot exempt a separate real monetary request', () => {
  const result={action:'send',text:'可以啊',followUp:false};
  for(const incoming of [
    '你发的付款截图收到了。再帮我垫付五百吧。',
    '你截图里的支付金额我看了，你明天能替我付款吗？',
    '你先付款，截图晚点发我。',
    '你付款后把截图给我。',
    '帮我支付这笔钱吧。',
    '能帮我付款并截图吗？',
    '你先帮我个忙：付款五百给他。',
    '你先帮我，付款吧。',
    '能不能帮我个忙：替我支付这笔钱。',
    '帮我垫付金额五百。',
    '你用这个付款链接付一下吧。',
    '帮我付款截图给我。',
    '能不能借我五百，明天还你。',
  ]) assert.equal(guardFinancialCommitment(incoming,result).text,'这事我现在答应不了，抱歉',incoming);
  assert.deepEqual(guardFinancialCommitment('你已经付款了吗？',result),{action:'send',text:'这边还没有付款的确认，先别当作已经付了',followUp:false});
  assert.equal(guardFinancialCommitment('能帮我付款吗？',result,{facts:'我已经同意付款'}),result);
});

test('two ordinary payment discussions reach the send boundary unchanged and without a second generation',async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let now=Date.parse('2026-10-28T03:15:00+08:00');bridge.stableMessageIds=true;
  const ai=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{}});await ai.init();clearInterval(ai.timer);clearInterval(ai.warmupTimer);t.after(async()=>{await ai.close();await cleanup(root);});await ai.configure(modelConfig);await ai.scan();const contact=bridge.contacts[0].id;await ai.setReplyOptions({contact,enabled:true});await ai.settings({enabled:true,autoLearning:false,judgeReply:false,segmentReplies:false});await ai.tick();
  const drafts=['同样是七百八，一个让轮子转起来，一个让收纳盒实现标签自由。','东西越小，付款那一下越有存在感。'];
  for(let i=0;i<2;i++){
    now+=1000;Object.assign(bridge.push(contact,'other',ordinary[i]),{timestamp:Math.floor(now/1000)});provider.next=async()=>({action:'send',text:drafts[i],followUp:false});await ai.tick();now+=60000;await ai.tick();
    assert.equal(provider.calls.length,i+1);assert.equal(bridge.sent.length,i+1);assert.equal(bridge.sent[i].text,drafts[i]);assert.equal(provider.calls[i].input.conversation.pendingIncomingMessages.at(-1).text,ordinary[i]);
  }
});
