import test from 'node:test';
import assert from 'node:assert/strict';
import { objectList } from '../web/ai-object-view.mjs';

const ids = html => [...html.matchAll(/data-ai-object="([^"]+)"/g)].map(match => match[1]);
const contact = (id, kind = 'person') => ({ id, kind, label: `对象${id}` });

test('saved automatic reply takes priority over style, drafts and paused execution', () => {
  const state = { contacts: ['off', 'on', 'paused', 'target'].map(id => contact(id)), settings: { replyScope: 'selected' }, replyTargets: ['pt'], profiles: [
    { contact: 'off', styleId: 'custom', replyOptions: { enabled: false } },
    { contact: 'on', replyOptions: { enabled: true } },
    { contact: 'paused', paused: true, replyOptions: { enabled: true } },
    { id: 'pt', contact: 'target' },
  ] };
  const html = objectList(state, { kind: 'person', selected: 'off', draft: { enabled: true, styleId: 'learned' } });
  assert.deepEqual(ids(html), ['on', 'paused', 'target', 'off']);
  assert.match(html, /自动回复已开启/);
  assert.match(html, /自动回复未开启/);
  assert.match(html, /已暂停/);
  assert.doesNotMatch(html, /自定义|已学习风格|使用默认风格/);
  assert.deepEqual(state.contacts.map(c => c.id), ['off', 'on', 'paused', 'target']);
  state.settings.replyScope = 'all';
  assert.deepEqual(ids(objectList(state, { kind: 'person' })), ['on', 'paused', 'target', 'off']);
});

test('groups rank realtime then at-me then at-all and display every saved mode', () => {
  const state = { contacts: ['off', 'all', 'me', 'live', 'both', 'live2'].map(id => contact(id, 'group')), profiles: [
    { contact: 'all', groupOptions: { atAll: true } },
    { contact: 'me', groupOptions: { atMe: true } },
    { contact: 'live', groupOptions: { realtime: true, atMe: true, atAll: true }, rounds: 200, mentionRounds: 24, replyStrategy: { maxRounds: 200 } },
    { contact: 'both', groupOptions: { atMe: true, atAll: true } },
    { contact: 'live2', paused: true, groupOptions: { realtime: true } },
  ] };
  const html = objectList(state, { kind: 'group' });
  assert.deepEqual(ids(html), ['live', 'live2', 'me', 'both', 'all', 'off']);
  assert.match(html, /实时回复 · @我 · @所有人/);
  assert.match(html, /已达回复次数上限 200\/200/);
  assert.deepEqual(ids(objectList(state, { kind: 'group', search: '对象all' })), ['all']);
});

test('enabled entries at the end of a large book enter the first virtual window', () => {
  const state = { contacts: Array.from({ length: 2000 }, (_, i) => contact(`c${i}`)), profiles: [{ contact: 'c1999', replyOptions: { enabled: true } }] };
  const html = objectList(state, { kind: 'person', height: 600 });
  assert.equal(ids(html)[0], 'c1999');
  assert.equal(ids(html).length, 20);
  assert.match(objectList(state, { kind: 'person', scrollTop: 160000, height: 600 }), /data-ai-object="c1998"/);
});
