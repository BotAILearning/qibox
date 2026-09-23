import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

class RecordingModel extends AIModelFixture {
  constructor() { super(); this.used = []; this.fail = false; }
  async test() { if (this.fail) throw new Error('connection refused'); }
  async complete(config, system, input, signal) { this.used.push(config.apiKey); return super.complete(config, system, input, signal); }
}
async function fixture(t, { configured = false } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel(); let now = 1000000;
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, interval: () => 180000 }); await assistant.init();
  t.after(async () => { await assistant.close(); await cleanup(root); });
  if (configured) { await assistant.configure(modelConfig); await assistant.testProvider(); await assistant.scan(); }
  return { assistant: a => assistant, bridge, provider, root, advance: ms => now += ms };
}
const K1 = 'only-a-test-key', K2 = 'another-test-key-2';
const modelA = { baseUrl: 'https://models.example.test/v1', model: 'test-model-a', apiKey: K1, timeout: 30, consent: true };
const modelB = { baseUrl: 'https://models.example.test/v1', model: 'test-model-b', apiKey: K2, timeout: 30, consent: true };

test('第一次添加的模型默认应用于全部功能，且密钥加密保存', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const state = await a.saveModels({ models: [{ label: '我的模型', ...modelA }], assignments: {} });
  assert.equal(state.models.length, 1);
  const id = state.models[0].id;
  assert.ok(!/^draft-|^legacy$/.test(id));
  assert.deepEqual(state.assignments, { chat: id, learningAnalysis: id });
  for (const f of ['chat', 'proactive', 'learning', 'analysis']) assert.equal(a.modelFor(f).apiKey, K1);
  const saved = JSON.parse(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'));
  assert.equal(JSON.stringify(saved).includes(K1), false);
  assert.equal(saved.modelList.length, 1);
  assert.equal(saved.modelAssignments.chat, id);
});

test('功能可按需分配不同模型，运行时按功能取模型', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel(); let now = 1000000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, interval: () => 180000 }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const first = await a.saveModels({ models: [{ label: '模型A', ...modelA }], assignments: {} });
  const m1 = first.models[0].id;
  const saved = await a.saveModels({ models: [{ id: m1, label: '模型A', ...modelA }, { id: 'draft-b', label: '模型B', ...modelB }], assignments: { chat: m1, learningAnalysis: 'draft-b' } });
  const m2 = saved.models.find(m => m.id !== m1).id;
  assert.equal(m2, 'draft-b');                      // 客户端草稿 id 被保留
  assert.equal(saved.assignments.chat, m1);
  assert.equal(saved.assignments.learningAnalysis, 'draft-b'); // 学习和分析共用一类模型
  assert.equal(a.modelFor('chat').apiKey, K1);
  assert.equal(a.modelFor('proactive').apiKey, K1);
  assert.equal(a.modelFor('learning').apiKey, K2);
  assert.equal(a.modelFor('analysis').apiKey, K2);

  // 分析功能使用分配的分析模型
  await a.scan();
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, rangeRevision: key(args.contact), messages: [{ id: key('msg-r'), timestamp: args.from + 1, text: 'fixture-private-chat', direction: 'self' }] });
  provider.used = [];
  await a.analyze({ request: '总结', from: '2026-09-01', to: '2026-09-02', contacts: [bridge.contacts[0].id] });
  assert.ok(provider.used.includes(K2));

  // 学习和分析使用相同的学习分析类模型
  provider.used = [];
  await a.learn({ contacts: [bridge.contacts[0].id] });
  assert.ok(provider.used.includes(K2));

  // 自动回复使用聊天模型
  await a.targets([a.profiles().find(p => p.contact === bridge.contacts[0].id).id]);
  provider.used = [];
  await a.settings({ reply: true, enabled: true });
  await a.tick();
  bridge.push(bridge.contacts[0].id, 'other', '你好');
  await a.tick(); now += 8000; await a.tick();
  assert.ok(provider.used.includes(K1));
  assert.ok(bridge.sent.length > 0);
});

test('修改模型配置后清除已验证状态，未修改则保留', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const state = await a.saveModels({ models: [{ label: '模型A', ...modelA }], assignments: {} });
  const id = state.models[0].id;
  await a.testProvider();
  assert.equal(a.publicState().models[0].tested, true);
  await a.saveModels({ models: [{ id, label: '模型A', ...modelA }], assignments: { chat: id, learningAnalysis: id } });
  assert.equal(a.publicState().models[0].tested, true);
  await a.saveModels({ models: [{ id, label: '模型A', ...modelA, model: 'changed-model' }], assignments: { chat: id, learningAnalysis: id } });
  assert.equal(a.publicState().models[0].tested, false);
});

test('删除模型后，引用它的功能回退到剩余第一个模型', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const state = await a.saveModels({ models: [{ label: '模型A', ...modelA }, { label: '模型B', ...modelB }], assignments: { chat: null, learningAnalysis: null } });
  const m1 = state.models[0].id, m2 = state.models[1].id;
  const state2 = await a.saveModels({ models: [{ id: m2, label: '模型B', ...modelB }], assignments: { chat: m1, learningAnalysis: m2 } });
  assert.equal(state2.models.length, 1);
  assert.equal(state2.assignments.chat, m2);
  assert.equal(state2.assignments.learningAnalysis, m2);
  assert.equal(state2.models[0].tested, false);
});
test('旧版单一模型配置首次保存时迁移为模型列表并保留密钥', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider();
  assert.equal(a.publicState().models.length, 1);
  assert.equal(a.publicState().models[0].id, 'legacy');
  const state = await a.saveModels({ models: [{ id: 'legacy', label: '默认模型', ...modelConfig }], assignments: {} });
  const id = state.models[0].id;
  assert.ok(!/^legacy$/.test(id));
  assert.equal(state.models[0].hasKey, true);
  assert.equal(state.models[0].tested, true);
  assert.equal(a.modelFor('chat').apiKey, modelConfig.apiKey);
  assert.equal(a.providerConfig('chat').model, modelConfig.model);
});

test('model-test 只测试不保存；缺少同意则拒绝', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const before = a.publicState().models.length;
  assert.equal((await a.testModel({ label: '草稿', ...modelA })).ok, true);
  assert.equal(a.publicState().models.length, before);
  await assert.rejects(a.testModel({ label: '草稿', ...modelA, consent: false }), /确认将选定聊天/);
  provider.fail = true;
  await assert.rejects(a.testModel({ label: '草稿', ...modelA }), /connection refused/);
});

test('测试连接成功后，编辑同名模型可保留已存密钥再测', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const state = await a.saveModels({ models: [{ label: '模型A', ...modelA }], assignments: {} });
  const id = state.models[0].id;
  // 不带 apiKey 编辑（客户端不重发密钥），服务端按 modelId 保留密钥
  const { apiKey, ...stored } = modelA;
  assert.equal((await a.testModel({ modelId: id, ...stored })).ok, true);
  const state2 = await a.saveModels({ models: [{ id, label: '模型A', ...stored }], assignments: { chat: id, learningAnalysis: id } });
  assert.equal(state2.models[0].hasKey, true);
  assert.equal(a.modelFor('chat').apiKey, K1);
});


test('草稿模型测试通过后保存保留已验证状态；改配置未重测则清除', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new RecordingModel();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  const draftId = 'draft-ui-000001';
  assert.equal((await a.testModel({ modelId: draftId, label: '草稿A', ...modelA })).ok, true);
  const state = await a.saveModels({ models: [{ id: draftId, label: '草稿A', ...modelA }], assignments: {} });
  assert.equal(state.models[0].id, draftId);
  assert.equal(state.models[0].tested, true);
  assert.equal(a.modelFor('chat').apiKey, K1);
  const state2 = await a.saveModels({ models: [{ id: draftId, label: '草稿A', ...modelA, model: 'changed-model' }], assignments: { chat: draftId, learningAnalysis: draftId } });
  assert.equal(state2.models[0].tested, false);
});
