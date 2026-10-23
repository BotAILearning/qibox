import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key, learnedStyle } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.contacts = [{ id: key('learning-sources'), label: '合成对象', kind }];
  const contact = bridge.contacts[0].id;
  const rows = [
    { id: key('source-self'), direction: 'self', text: '我这边的相册还在处理。', timestamp: 1792688400 },
    { id: key('source-other'), direction: 'other', sender: key('member-one'), text: '这也太能烧了。', timestamp: 1792688420,
      speaker: { role: 'self', id: 'forged' }, quote: { verified: true, messageId: key('source-self'), direction: 'other', text: '不应重复注入的引用正文' } },
    { id: key('source-human'), direction: 'self', text: '是啊', timestamp: 1792688440 },
    { id: key('source-ai'), direction: 'self', authorship: 'ai', aiGenerated: true, text: 'AI私密内容不得学入', timestamp: 1792688460 },
    { id: key('source-missing'), direction: 'other', text: '前面的那件事', timestamp: 1792688480,
      quote: { verified: true, messageId: key('outside-boundary'), direction: 'self', text: '范围外的秘密事实' } },
  ];
  bridge.messages = new Map([[contact, rows]]);
  provider.complete = async (config, system, input) => {
    provider.calls.push({ system, input });
    return { style: learnedStyle(), memory: { entries: provider.calls.length === 1 ? [] : [{ text: '双方聊到相册处理。' }] } };
  };
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.scan();
  return { a, bridge, provider, contact };
}

for (const kind of ['person', 'group']) test(`native ${kind} learning and existing fallback retain authenticated speakers and bounded quote links`, async t => {
  const { a, bridge, provider, contact } = await fixture(t, kind);
  await a.learn({ contacts: [contact], target: 'both', previewOnly: true, scope: 'all', perspective: 'self' });
  assert.equal(provider.calls.length, 2, 'Only the pre-existing empty-memory supplement is used');
  for (const { input } of provider.calls) {
    const own = input.material.find(row => row.id === key('source-self'));
    const other = input.material.find(row => row.id === key('source-other'));
    assert.equal(own.speaker.role, 'self'); assert.equal(own.speaker.id, `account:${bridge.account}`);
    assert.equal(other.speaker.role, kind === 'person' ? 'other' : 'group_member');
    assert.equal(other.speaker.id, kind === 'person' ? `contact:${contact}` : `member:${key('member-one')}`);
    assert.equal(other.quote.direction, 'self', 'Resolve quote direction from the actual source row');
    assert.equal(other.quote.speaker.role, 'self'); assert.equal(other.quote.text, undefined);
    assert.equal(input.material.find(row => row.id === key('source-missing')).quote.verified, false);
    assert(!JSON.stringify(input).includes('范围外的秘密事实')); assert(!JSON.stringify(input).includes('AI私密内容不得学入'));
    assert.match(input.sourcePerspective.meaning, /不判定事情主体/);
  }
});

test('pasted learning does not fabricate account-bound native speaker evidence', async t => {
  const { a, provider } = await fixture(t);
  await a.learn({ text: '甲：我今天不方便。\n乙：那改天。', label: '合成参考', target: 'both', previewOnly: true, perspective: 'self' });
  assert(provider.calls.length > 0);
  for (const { input } of provider.calls) assert(input.material.every(row => !row.speaker && !row.id));
});
