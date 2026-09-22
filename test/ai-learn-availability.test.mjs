import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => Date.now() });
  await a.init(); t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan(); await a.settings({ enabled: true });
  return { a, bridge, provider };
}

// 真机实测（2026-09-22）：一次发送失败会把 available 打成 false，并连带着让学习与分析
// 一直报「请先获取联系人列表 / 聊天数据暂不可用」，只有重新刷新联系人才能恢复。
// 发送受阻只应暂停发送，联系人与聊天数据依然可用。
test('发送受阻不再阻断学习：available 为 false 时仍可学习风格', async t => {
  const { a, bridge } = await fixture(t);
  const contact = bridge.contacts[0].id;
  a.available = false; a.notice = '暂时无法发送，稍后重试'; a.sendBlockedUntil = a.now() + 30000;
  const state = await a.learn({ contacts: [contact], target: 'style' });
  assert.ok(state.profiles.some(profile => profile.contact === contact && profile.learnedAt));
});

test('发送受阻不再阻断分析：报的是接口能力而不是数据不可用', async t => {
  const { a, bridge } = await fixture(t);
  a.available = false; a.sendBlockedUntil = a.now() + 30000;
  const error = await a.analyze({ contacts: [bridge.contacts[0].id], request: '最近聊了什么' }).catch(e => e);
  assert.notEqual(error?.code, 'ai_data_unavailable');
  assert.doesNotMatch(String(error?.message || ''), /聊天数据暂不可用/);
});

test('确实没有联系人时仍然要求先获取联系人列表', async t => {
  const { a, bridge } = await fixture(t);
  a.available = false; a.contacts.clear();
  // 联系人已经不在列表里时，先由"请选择要学习的联系人"拦住，同样是明确提示而不是静默通过。
  await assert.rejects(a.learn({ contacts: [bridge.contacts[0].id], target: 'style' }), /请先获取联系人列表|请选择要学习的联系人/);
  await assert.rejects(a.analyze({ contacts: [bridge.contacts[0].id], request: '最近聊了什么' }), /聊天数据暂不可用/);
});
