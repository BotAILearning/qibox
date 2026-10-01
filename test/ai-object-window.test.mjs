import test from 'node:test';
import assert from 'node:assert/strict';
import { objectList, objectWindow } from '../web/ai-object-view.mjs';

test('a large address book renders a bounded window but searches the full book', () => {
  const state = { profiles: [], contacts: Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, label: `联系人${i}`, kind: 'person' })) };
  const html = objectList(state, { kind: 'person', height: 600 });
  assert.equal((html.match(/data-ai-object=/g) || []).length, 20);
  assert.doesNotMatch(html, /data-ai-object="c1999"/);
  assert.match(objectList(state, { kind: 'person', search: '联系人1999' }), /data-ai-object="c1999"/);
  assert.match(objectList(state, { kind: 'person', height: 600, scrollTop: 160000 }), /data-ai-object="c1999"/);
  for (let i = 0; i < 2000; i++) {
    const range = objectWindow(2000, i * 80, 600);
    assert.ok(range.start <= i && range.end > i);
    assert.ok(range.end - range.start <= 20);
  }
});
