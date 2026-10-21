import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { readMemory } from '../server/ai-wiki.mjs';
import { replyPresets } from '../server/ai-presets.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, { modern = false, memoryOnly = false } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const options = { dataRoot: root, bridge, provider, now: () => 1792548000000 };
  const a = new AIAssistant(options); await a.init();
  if (!memoryOnly) {
    if (modern) await a.saveModels({ models: [
      { ...modelConfig, id: 'storage-chat', label: '聊天模型', model: 'fixture-chat' },
      { ...modelConfig, id: 'storage-learning', label: '学习模型', model: 'fixture-learning', apiKey: 'another-fixture-key' },
    ], assignments: { chat: 'storage-chat', learningAnalysis: 'storage-learning' } });
    else await a.configure(modelConfig);
  }
  await a.scan();
  const contact = bridge.contacts[0].id;
  await a.saveReplyProfile({ contact, ...replyPresets[0] });
  await a.editContactMemory(contact, { entries: [{ field: 'other', text: '合成对象喜欢茶' }] });
  await a.editContactMemory(contact, { entries: [{ field: 'other', text: '合成对象喜欢乌龙茶' }] });
  const profileId = a.profiles().find(p => p.contact === contact).id;
  await a.close();
  const file = path.join(root, 'ai-assistant.json'), keyFile = path.join(root, 'ai-secret.key');
  const originalBytes = await readFile(file), originalKey = await readFile(keyFile), original = JSON.parse(originalBytes);
  t.after(async () => { await cleanup(root); });
  return { root, options, provider, bridge, file, keyFile, originalBytes, originalKey, original, profileId };
}

for (const modern of [false, true]) for (const fault of ['missing', 'wrong']) test(`${modern ? 'modern models' : 'legacy provider'}: ${fault} key preserves exact saved data and original key alone restores it`, async t => {
  const f = await fixture(t, { modern });
  if (fault === 'missing') await rename(f.keyFile, path.join(f.root, 'saved-original.key'));
  else { const wrong = Buffer.from(f.originalKey); wrong[0] ^= 1; await writeFile(f.keyFile, wrong); }
  const failed = new AIAssistant(f.options);
  const code = fault === 'missing' ? 'ai_secret_missing' : 'ai_secret_invalid';
  await assert.rejects(failed.init(), error => { assert.equal(error.code, code); assert.match(error.message, /原数据已保留.*恢复原密钥/); return true; });
  assert.deepEqual(await readFile(f.file), f.originalBytes, 'Failed initialization must not migrate or replace any ciphertext.');
  if (fault === 'missing') await assert.rejects(access(f.keyFile), { code: 'ENOENT' });
  else { const wrong = await readFile(f.keyFile); assert.equal(wrong.length, 32); assert.notDeepEqual(wrong, f.originalKey); }
  await assert.rejects(failed.save(), { code });
  await assert.rejects(failed.close(), { code });
  assert.deepEqual(await readFile(f.file), f.originalBytes, 'Later save/close must not erase data after rejected initialization.');
  await writeFile(f.keyFile, f.originalKey);
  const restored = new AIAssistant(f.options); await restored.init();
  assert.equal(restored.data.account, f.original.account);
  assert.deepEqual(restored.data.profiles[f.profileId].memory, f.original.profiles[f.profileId].memory);
  assert.deepEqual(restored.data.profiles[f.profileId].memoryHistory, f.original.profiles[f.profileId].memoryHistory);
  assert.deepEqual(restored.data.profiles[f.profileId].style, f.original.profiles[f.profileId].style);
  assert.deepEqual(readMemory(restored.vault, restored.data.profiles[f.profileId]).entries.map(row => row.text), ['合成对象喜欢乌龙茶']);
  if (modern) {
    assert.deepEqual(restored.data.modelList, f.original.modelList);
    assert.equal(restored.models.length, 2);
    assert.equal(restored.modelFor('chat').model, 'fixture-chat');
    assert.equal(restored.modelFor('learning').model, 'fixture-learning');
  } else assert.equal(restored.config.model, modelConfig.model);
  assert.equal(f.provider.calls.length, 0); assert.equal(f.bridge.sent.length, 0);
  await restored.close();
});

test('missing key for memory-only data does not create a replacement key or change the saved identity', async t => {
  const f = await fixture(t, { memoryOnly: true });
  assert.equal(f.original.provider, undefined); assert.equal(f.original.modelList.length, 0);
  await rename(f.keyFile, path.join(f.root, 'saved-original.key'));
  const failed = new AIAssistant(f.options);
  await assert.rejects(failed.init(), { code: 'ai_secret_missing' });
  await assert.rejects(access(f.keyFile), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.file), f.originalBytes);
});

test('short existing key fails without replacing either key or config', async t => {
  const f = await fixture(t), short = Buffer.from('short'); await writeFile(f.keyFile, short);
  const failed = new AIAssistant(f.options);
  await assert.rejects(failed.init(), { code: 'ai_secret_invalid' });
  assert.deepEqual(await readFile(f.keyFile), short); assert.deepEqual(await readFile(f.file), f.originalBytes);
});

test('malformed saved JSON is retained before a missing key could be generated', async t => {
  const root = await temp(); t.after(() => cleanup(root));
  const file = path.join(root, 'ai-assistant.json'), keyFile = path.join(root, 'ai-secret.key');
  const broken = Buffer.from('{"version":1,"account":"synthetic-incomplete",'); await writeFile(file, broken);
  const a = new AIAssistant({ dataRoot: root, bridge: new ChatFixture(), provider: new AIModelFixture() });
  await assert.rejects(a.init(), SyntaxError); await assert.rejects(a.save(), SyntaxError);
  assert.deepEqual(await readFile(file), broken); await assert.rejects(access(keyFile), { code: 'ENOENT' });
});

test('independently damaged legacy provider ciphertext remains recoverable while a valid saved memory authenticates the key', async t => {
  const f = await fixture(t), damaged = structuredClone(f.original.provider); damaged.tag = 'invalid';
  const saved = { ...f.original, provider: damaged }; await writeFile(f.file, JSON.stringify(saved));
  const a = new AIAssistant(f.options); await a.init();
  assert.equal(a.config, null); assert.match(a.notice, /模型配置暂不可读取.*原数据已保留/);
  assert.deepEqual(a.data.provider, damaged); assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).provider, damaged);
  assert.equal(readMemory(a.vault, a.data.profiles[f.profileId]).unavailable, undefined);
  assert.equal(f.provider.calls.length, 0);
  await a.close();
});

test('valid legacy analysis fallback does not overwrite an unreadable primary provider ciphertext', async t => {
  const f = await fixture(t), saved = structuredClone(f.original);
  const helper = new AIAssistant(f.options); await helper.init();
  saved.analysisProvider = helper.vault.seal({ ...modelConfig, model: 'fallback-model' }); await helper.close();
  saved.provider.tag = 'invalid'; await writeFile(f.file, JSON.stringify(saved));
  const a = new AIAssistant(f.options); await a.init();
  assert.equal(a.config.model, 'fallback-model');
  assert.deepEqual(a.data.provider, saved.provider);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).provider, saved.provider);
  assert.deepEqual(a.data.analysisProvider, saved.analysisProvider);
  assert.equal(f.provider.calls.length, 0); await a.close();
});

test('one damaged modern model retains its ciphertext and the other model remains available', async t => {
  const f = await fixture(t, { modern: true }), saved = structuredClone(f.original);
  saved.modelList[1].sealed.tag = 'invalid'; await writeFile(f.file, JSON.stringify(saved));
  const a = new AIAssistant(f.options); await a.init();
  assert.equal(a.models.length, 1); assert.equal(a.modelFor('chat').model, 'fixture-chat');
  assert.deepEqual(a.data.modelList, saved.modelList); assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).modelList, saved.modelList);
  assert.deepEqual(a.data.profiles[f.profileId].memory, f.original.profiles[f.profileId].memory);
  assert.equal(f.provider.calls.length, 0);
  await a.close();
});

test('fresh empty data creates one reusable key and reopens normally', async t => {
  const root = await temp(); t.after(() => cleanup(root));
  const options = { dataRoot: root, bridge: new ChatFixture(), provider: new AIModelFixture() };
  const a = new AIAssistant(options); await a.init(); const first = await readFile(path.join(root, 'ai-secret.key')); await a.close();
  assert.equal(first.length, 32);
  const b = new AIAssistant(options); await b.init(); await b.close();
  assert.deepEqual(await readFile(path.join(root, 'ai-secret.key')), first);
});
