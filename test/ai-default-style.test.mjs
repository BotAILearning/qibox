import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, count = 3) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.contacts = Array.from({ length: count }, (_, i) => ({ id: key(`default-${i}`), label: `联系人${i}`, kind: 'person' }));
  bridge.messages = new Map(bridge.contacts.map((c, i) => [c.id, [
    { id: `other-${i}`, direction: 'other', text: `对方-${i}` }, { id: `self-${i}`, direction: 'self', text: `本人-${i}` },
  ]]));
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider();
  await a.scan();
  return { a, bridge, provider, root, contacts: bridge.contacts.map(c => c.id) };
}

test('default style learning combines selected chats into one account-level style without profiles', async t => {
  const { a, bridge, provider, contacts } = await fixture(t, 5);
  let reads = 0; const read = bridge.read.bind(bridge);
  bridge.read = async value => { reads++; return read(value); };
  provider.next = async input => ({ style: { summary: '自然简洁，常用短句。' } });
  await a.learn({ contacts: contacts.slice(0, 3), asDefault: true, perspective: 'self' });
  assert.equal(reads, 3); assert.equal(provider.calls.length, 1);
  const { input, system } = provider.calls[0];
  assert.equal(input.styleOwner, 'self'); assert.equal(input.defaultStyle, true);
  assert.deepEqual(input.conversations.map(c => c.contact), contacts.slice(0, 3));
  assert.match(system, /综合成一份通用风格总结/);
  const learned = a.publicState().learnedDefaultStyle;
  assert.ok(learned); assert.equal(learned.style.summary, '自然简洁，常用短句。');
  assert.equal(learned.perspective, 'self'); assert.equal(learned.source, 'learned');
  assert.deepEqual(learned.contacts, contacts.slice(0, 3));
  assert.equal(a.profiles().length, 0);
  // 原文不入盘
  const saved = a.data.learnedDefaultStyle;
  assert.equal(JSON.stringify(saved).includes('本人-'), false);
});

test('default style learning honors the other-party perspective and requires their speech', async t => {
  const { a, bridge, provider, contacts } = await fixture(t, 3);
  provider.next = async () => ({ style: { summary: '对方爱用表情包，句子简短。' } });
  await a.learn({ contacts: contacts.slice(0, 2), asDefault: true, perspective: 'other' });
  const { input } = provider.calls[0];
  assert.equal(input.styleOwner, 'other');
  assert.equal(a.publicState().learnedDefaultStyle.perspective, 'other');
  // 只有本人发言时，学习对方风格应拒绝
  bridge.messages.set(contacts[2], [{ id: 's1', direction: 'self', text: '只有我说话' }]);
  await assert.rejects(a.learn({ contacts: [contacts[2]], asDefault: true, perspective: 'other' }), /没有对方的发言/);
  // 只有对方发言时，学习自己风格应拒绝
  bridge.messages.set(contacts[0], [{ id: 'o1', direction: 'other', text: '只有对方说话' }]);
  await assert.rejects(a.learn({ contacts: [contacts[0]], asDefault: true, perspective: 'self' }), /没有你的发言/);
});

test('default style learning rejects more than five contacts before reading', async t => {
  const { a, bridge, provider, contacts } = await fixture(t, 6);
  bridge.read = async () => assert.fail('oversized default learning read chats');
  await assert.rejects(a.learn({ contacts, asDefault: true }), /最多学习 5/);
  assert.equal(provider.calls.length, 0);
  assert.equal(a.publicState().learnedDefaultStyle, null);
});

test('pasted chat can update the default style without creating a profile', async t => {
  const { a, provider } = await fixture(t, 1);
  provider.next = async () => ({ style: { summary: '粘贴得到的默认口吻。' } });
  await a.learn({ text: '我：在吗？\n对方：在呀', asDefault: true, perspective: 'self' });
  const learned = a.publicState().learnedDefaultStyle;
  assert.ok(learned); assert.equal(learned.source, 'paste'); assert.equal(learned.style.summary, '粘贴得到的默认口吻。');
  assert.deepEqual(learned.contacts, []);
  assert.equal(a.profiles().length, 0);
});

test('default style can be edited and cleared; ordinary learning leaves it untouched', async t => {
  const { a, provider, contacts } = await fixture(t, 3);
  assert.equal(a.publicState().learnedDefaultStyle, null);
  // 普通学习不产生默认风格
  provider.next = async () => ({ style: { summary: '按联系人学习。' } });
  await a.learn({ contacts: [contacts[0]] });
  assert.equal(a.publicState().learnedDefaultStyle, null);
  assert.equal(a.profiles().length, 1);
  // 学习默认风格后可编辑
  provider.next = async () => ({ style: { summary: '初版默认风格。' } });
  await a.learn({ contacts: contacts.slice(0, 2), asDefault: true });
  await a.saveDefaultStyle({ summary: '修改后的默认风格。' });
  assert.equal(a.publicState().learnedDefaultStyle.style.summary, '修改后的默认风格。');
  // 清除
  await a.clearDefaultStyle();
  assert.equal(a.publicState().learnedDefaultStyle, null);
  // 未学习时编辑报错；清除幂等安全
  await assert.rejects(a.saveDefaultStyle({ summary: '无效' }), /还没有默认风格/);
  await a.clearDefaultStyle();
});

test('applying the default style refreshes only the objects on the default style and keeps others following', async t => {
  const { a, provider, contacts } = await fixture(t, 3);
  provider.next = async () => ({ style: { summary: '账号级默认风格。' } });
  await a.learn({ contacts: contacts.slice(0, 2), asDefault: true });
  await a.settings({ enabled: true, reply: true, replyScope: 'all' });
  provider.next = async () => ({ style: { summary: '联系人自己的风格。' } });
  await a.learn({ contacts: [contacts[0]] });
  const own = () => a.profiles().find(p => p.contact === contacts[0]);
  const plain = () => a.profiles().find(p => p.contact === contacts[1]);
  assert.equal(own().styleId, 'learned');
  // 「默认风格」只有一套：账号级默认风格更新后，选择默认风格的对象立即跟随
  await a.saveDefaultStyle({ summary: '更新后的默认风格。' });
  assert.equal(a.generationStyle(plain(), {}, 'reply').summary, '更新后的默认风格。');
  assert.equal(a.generationStyle(own(), {}, 'reply').summary, '联系人自己的风格。');
  const before = { replyTargets: [...a.data.replyTargets], settings: structuredClone(a.data.settings) };
  const result = await a.applyDefaultStyle();
  // 只有使用默认风格的两个对象被刷新
  assert.equal(result.appliedDefaultStyle, 2);
  assert.equal(plain().style.summary, '更新后的默认风格。');
  assert.equal(plain().styleId ?? '', '');
  assert.equal(plain().defaultStyle, undefined);
  // 已选择其他聊天风格的对象不受影响
  assert.equal(own().styleId, 'learned');
  assert.equal(own().style.summary, '联系人自己的风格。');
  assert.equal(own().learnedStyle.summary, '联系人自己的风格。');
  assert.deepEqual(a.data.replyTargets, before.replyTargets);
  assert.deepEqual(a.data.settings, before.settings);
  // 与默认风格内容一致时保存仍按「默认风格」处理；改过内容才固化为对象自己的【自定义】风格
  await a.saveReplyProfile({ contact: contacts[1], style: { summary: '更新后的默认风格。' }, styleId: '', strategy: {}, preserveSwitches: true });
  assert.equal(plain().styleId, '');
  await a.saveReplyProfile({ contact: contacts[1], style: { summary: '我自己改过的口吻。' }, styleId: '', strategy: {}, preserveSwitches: true });
  assert.equal(plain().styleId, 'custom');
  assert.equal(a.generationStyle(plain(), {}, 'reply').summary, '我自己改过的口吻。');
  await a.clearDefaultStyle();
  await assert.rejects(a.applyDefaultStyle(), /还没有默认风格/);
});

test('cancelling a default style learning restores the previous one; saving commits and ends the undo window', async t => {
  const { a, provider, contacts } = await fixture(t, 3);
  assert.equal(a.publicState().defaultStyleUndoable, false);
  // 第一次学习时学习前没有默认风格，取消即回到「未设置默认风格」
  provider.next = async () => ({ style: { summary: '第一版默认风格。' } });
  await a.learn({ contacts: contacts.slice(0, 2), asDefault: true, perspective: 'other' });
  assert.equal(a.publicState().defaultStyleUndoable, true);
  assert.equal((await a.cancelDefaultStyle()).defaultStyleCancelled, 'cleared');
  assert.equal(a.publicState().learnedDefaultStyle, null);
  assert.equal(a.publicState().defaultStyleUndoable, false);
  // 学习前已有默认风格时，取消整份还原（含来源、方向、学习时间等元信息）
  provider.next = async () => ({ style: { summary: '第一版默认风格。' } });
  await a.learn({ contacts: contacts.slice(0, 2), asDefault: true, perspective: 'other' });
  const first = structuredClone(a.publicState().learnedDefaultStyle);
  provider.next = async () => ({ style: { summary: '第二版默认风格。' } });
  await a.learn({ contacts: [contacts[1]], asDefault: true, perspective: 'self' });
  assert.equal(a.publicState().learnedDefaultStyle.style.summary, '第二版默认风格。');
  assert.equal((await a.cancelDefaultStyle()).defaultStyleCancelled, 'reverted');
  assert.deepEqual(a.publicState().learnedDefaultStyle, first);
  // 保存 = 保存说明 + 应用到聊天风格一步完成，并结束可撤销状态；联系人自己的风格不受影响
  await a.settings({ enabled: true, reply: true, replyScope: 'all' });
  provider.next = async () => ({ style: { summary: '联系人自己的风格。' } });
  await a.learn({ contacts: [contacts[0]] });
  const own = () => a.profiles().find(p => p.contact === contacts[0]);
  assert.equal(own().style.summary, '联系人自己的风格。');
  const saved = await a.commitDefaultStyle({ summary: '保存后的默认风格。' });
  assert.ok(saved.appliedDefaultStyle >= 1);
  assert.equal(a.publicState().learnedDefaultStyle.style.summary, '保存后的默认风格。');
  assert.equal(a.publicState().learnedDefaultStyle.perspective, 'other');
  assert.equal(a.publicState().defaultStyleUndoable, false);
  assert.equal(own().style.summary, '联系人自己的风格。');
  // 保存过之后再取消即清除默认风格
  assert.equal((await a.cancelDefaultStyle()).defaultStyleCancelled, 'cleared');
  assert.equal(a.publicState().learnedDefaultStyle, null);
});

test('untouched default profiles fall back to the learned default style at generation time', async t => {
  const { a, provider, contacts } = await fixture(t, 3);
  provider.next = async () => ({ style: { summary: '账号级默认风格。' } });
  await a.learn({ contacts: contacts.slice(0, 2), asDefault: true });
  const learned = a.publicState().learnedDefaultStyle.style;
  await a.settings({ enabled: true, reply: true, replyScope: 'all' });
  const fallback = a.profiles().find(p => p.source === 'default');
  assert.ok(fallback);
  assert.equal(a.generationStyle(fallback, {}, 'reply'), learned);
  // 该联系人随后单独学习后，不再回退到默认风格
  provider.next = async () => ({ style: { summary: '本人风格。' } });
  await a.learn({ contacts: [fallback.contact] });
  const own = a.profiles().find(p => p.contact === fallback.contact);
  assert.equal(own.style.summary, '本人风格。');
  assert.equal(a.generationStyle(own, {}, 'reply'), own.style);
});
