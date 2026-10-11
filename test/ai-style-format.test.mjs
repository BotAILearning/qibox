import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLearnedStyle, styleLayers } from '../server/ai-style.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const descriptions = ['样本不足，仅见🙂表情，难以判断用词习惯', '样本不足，无法判断回复节奏', '说明先自己聊一会儿', '样本不足，不能推测情绪习惯', '样本不足，无法判断角色'];
const modelStyle = Object.fromEntries(styleLayers.map(([field, label], i) => [field, `${label}层":"${descriptions[i]}`]));
const expectedSummary = styleLayers.map(([, label], i) => `${label}：${descriptions[i]}`).join('\n');

test('learned layer template fragments do not leak into the editable summary', () => {
  assert.equal(composeLearnedStyle(modelStyle).summary, expectedSummary);
  assert.equal(composeLearnedStyle({ ...modelStyle, language: '"语言层" : "样本不足' }).summary.split('\n')[0], '语言：样本不足');
});

test('ordinary quotations, unrelated prefixes and manual summaries remain intact', () => {
  const text = '会引用“好的”，偶尔写 语言层":"这样的示例';
  assert.equal(composeLearnedStyle({ language: text }).summary, `语言：${text}`);
  assert.equal(composeLearnedStyle({ language: '情感层":"引用内容' }).summary, '语言：情感层":"引用内容');
  assert.deepEqual(composeLearnedStyle({ summary: '手动保留 语言层":"原文', customTone: '自然' }), { summary: '手动保留 语言层":"原文', customTone: '自然' });
});

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const contact = key('style-format');
  bridge.contacts = [{ id: contact, label: '隔离对象', kind: 'person' }];
  bridge.messages = new Map([[contact, [
    { id: 'other', direction: 'other', text: '聊会儿吗', timestamp: 1791590000 },
    { id: 'self', direction: 'self', text: '先让我自己聊一会儿🙂', timestamp: 1791590001 },
  ]]]);
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  provider.next = async () => ({ style: structuredClone(modelStyle) });
  return { a, provider, contact };
}

test('single-contact default learning cleans the result once and preserves the active default until confirmation', async t => {
  const { a, provider, contact } = await fixture(t);
  await a.saveDefaultStyle({ summary: '原默认口吻，简洁自然。' });
  const original = structuredClone(a.publicState().learnedDefaultStyle), calls = provider.calls.length;
  const result = await a.learn({ contacts: [contact], asDefault: true, perspective: 'self', from: '2026-10-10', to: '2026-10-11', scope: 'range' });
  assert.equal(result.learnedDefaultStyle.style.summary, expectedSummary);
  assert.equal(a.activeDefaultStyle().style.summary, original.style.summary);
  assert.equal(result.defaultStyleUndoable, true);
  assert.equal(provider.calls.length - calls, 1);
  await a.cancelDefaultStyle();
  assert.deepEqual(a.publicState().learnedDefaultStyle, original);
});

test('single-contact style learning cleans the same result without extra provider requests', async t => {
  const { a, provider, contact } = await fixture(t), calls = provider.calls.length;
  await a.learn({ contacts: [contact], target: 'style', perspective: 'self' });
  assert.equal(a.profiles()[0].learnedStyle.summary, expectedSummary);
  assert.equal(provider.calls.length - calls, 1);
});
