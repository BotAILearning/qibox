import test from 'node:test';
import assert from 'node:assert/strict';
import { guardFinancialCommitment } from '../server/ai-commitment-guard.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

// Synthetic ordinary narrative from an installed-app failure, not private user history.
const longLoanStory = '说起借东西，我刚从排练室回来。小周前天借的那台录音机，你昨天已经带回去了，卡还压在他桌上的旧曲谱下面。我上次在门口碰见你，你手里那副三脚架是上午还给小周的，他晚上试灯时又支起来用了。我今天是去交自己音箱的维修单，店员只给了个受理编号，顺手发来一张同型号完工照，说那是昨天另一位客人取走前拍的，壳上那道划痕跟我的很像。老马的两节电池前几天托我带着，我刚刚还到他手上，他把它们放进自己那只红袋子；我包里剩的透明袋装着周末自己买的转接头。小周拿曲谱的时候把卡也带了出来，拍给我看了一眼，然后连同桌边那个没名字的黑盒一起收进抽屉。他的钥匙也在那一层，钥匙圈上挂的橘色带子跟黑盒提手颜色差不多。那盒子一直没人来认，大家走的时候还在说不知道落了多久。门口有个人也提着黑盒，我只顾着绕开地上的线，没看清是什么样的。小周说下周有空要把自己卧室的桌子搬到窗边，排练室门外那几箱是店主新进的吸音棉，今天下午刚到。我看他顺手收拾完，桌面比进去时空了一大半，抽屉却塞满了。你的机身放回柜子就能关门，卡还在那叠东西里面，这借出去一趟，回来倒分成了两路。';

test('ordinary object loans and trip counts do not become financial requests', () => {
  const reply = { action: 'send', text: '机身先回来了，卡还在外面。', followUp: false };
  for (const incoming of [longLoanStory, '你看，这借出去一趟，回来倒分成两路。', '你能借我一台录音机吗？',
    '你能借我一块橡皮吗？', '能借我五百本书吗？', '能借我五百元件吗？', '你说能关门，借出去一趟回来还分两路。']) {
    assert.equal(guardFinancialCommitment(incoming, reply), reply, incoming);
  }
});

test('actual unapproved monetary requests still retain the existing financial protection', () => {
  const reply = { action: 'send', text: '可以啊' };
  for (const incoming of ['能借我五百吗？', '你能借我500元吗？', '你借给我一千块钱吧', '能不能借点钱？',
    '你能借我2.5元应急吗？', '能借我500元去买药吗？', '你能借我五百块交房租吗？', '能借给我一点钱吗？',
    '帮我付钱吧', '你明天能帮我垫付五百块吗？']) {
    assert.equal(guardFinancialCommitment(incoming, reply).text, '这事我现在答应不了，抱歉', incoming);
    assert.equal(guardFinancialCommitment(incoming, reply, { facts: '我已经同意付款' }), reply);
  }
});

test('the complete long ordinary reply pipeline delivers its generated draft without buying another generation', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = Date.parse('2026-10-25T20:00:00+08:00'); bridge.stableMessageIds = true;
  const ai = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await ai.init(); clearInterval(ai.timer); clearInterval(ai.warmupTimer);
  t.after(async () => { await ai.close(); await cleanup(root); });
  await ai.configure(modelConfig); await ai.scan(); const contact = bridge.contacts[0].id;
  await ai.setReplyOptions({ contact, enabled: true });
  await ai.settings({ enabled: true, autoLearning: false, judgeReply: false }); await ai.tick();
  now += 1000; Object.assign(bridge.push(contact, 'other', longLoanStory), { timestamp: Math.floor(now / 1000) });
  const draft = '机身先回来了，卡还在外面。'; provider.next = async () => ({ action: 'send', text: draft, followUp: false });
  await ai.tick(); now += 60000; await ai.tick(); await ai.tick();
  assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0].text, draft);
  assert.equal(provider.calls[0].input.conversation.pendingIncomingMessages[0].text, longLoanStory);
  t.diagnostic('Actual assistant pipeline with mock model/native sink; 0 actual HTTP/WeChat sends');
});
