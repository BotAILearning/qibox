import test from 'node:test';
import assert from 'node:assert/strict';
import { errorDisclosureKeys, errorDisclosureState, refreshErrors, revealErrorRecord } from '../web/ai-error-view.mjs';

// These unit tests model DOM replacement/focus, without a browser or device.
function element(tagName, attributes = {}, children = []) {
  const node = { tagName: tagName.toUpperCase(), children, attributes, focusCalls: [], disabled: !!attributes.disabled, open: Object.hasOwn(attributes, 'open'),
    hasAttribute: key => Object.hasOwn(attributes, key), getAttribute: key => attributes[key] ?? null,
    contains(target) { return this === target || this.children.some(child => child.contains(target)); },
    closest(selector) { for (let current = this; current; current = current.parentElement) if (matches(current, selector)) return current; return null; },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    focus(options) { this.focusCalls.push(options); this.ownerDocument.activeElement = this; } };
  for (const child of children) child.parentElement = node;
  return node;
}
function matches(node, selector) {
  if (selector.startsWith('.')) return (node.attributes.class || '').split(' ').includes(selector.slice(1));
  const match = /^([a-z]+)?(?:\[([a-z-]+)\])?$/i.exec(selector);
  return !!match && (!match[1] || node.tagName === match[1].toUpperCase()) && (!match[2] || node.hasAttribute(match[2]));
}
const action = id => element('button', { 'data-ai-error-object': id });
const record = (id, children) => element('article', { 'data-ai-error-record': id }, children);
const detail = (id, open = false) => element('details', { 'data-ai-error-detail': id, ...(open ? { open: '' } : {}) }, [element('summary')]);
function fixture(markup, initial, replacements = []) {
  const host = element('div', {}, initial), document = { activeElement: null, createElement() { return { innerHTML: '' }; } };
  let writes = 0, content = markup;
  const connect = node => { node.ownerDocument = document; for (const child of node.children) { child.parentElement = node; connect(child); } };
  connect(host);
  Object.defineProperty(host, 'innerHTML', { get: () => content, set(value) { writes++; if (host.contains(document.activeElement)) document.activeElement = null; host.children = replacements; content = value; connect(host); } });
  return { host, document, writes: () => writes };
}
test('error refresh keeps unchanged DOM/selection on first and later polls', () => {
  const button = action('error-1'), f = fixture('same', [record('error-1', [button])]);
  f.document.activeElement = button; f.document.selection = { text: 'selected excerpt', anchorNode: button };
  assert.equal(refreshErrors(f.host, () => 'same'), false); assert.equal(refreshErrors(f.host, () => 'same'), false);
  assert.equal(f.writes(), 0); assert.equal(f.document.activeElement, button); assert.equal(f.document.selection.anchorNode, button);
});
test('changed error refresh restores the exact error action among repeated object failures', () => {
  const old = action('error-2'), wrong = action('error-1'), expected = action('error-2');
  const f = fixture('old', [record('error-2', [old])], [record('error-1', [wrong]), record('error-2', [expected])]);
  f.document.activeElement = old;
  assert.equal(refreshErrors(f.host, () => 'new'), true); assert.equal(f.document.activeElement, expected);
  assert.deepEqual(expected.focusCalls, [{ preventScroll: true }]); assert.equal(wrong.focusCalls.length, 0);
});
test('changed error refresh restores disclosure summary by error ID and never a removed record', () => {
  const before = detail('error-2'), after = detail('error-2');
  const f = fixture('old', [record('error-2', [before])], [record('error-2', [after])]);
  f.document.activeElement = before.children[0]; refreshErrors(f.host, () => 'new');
  assert.equal(f.document.activeElement, after.children[0]); assert.deepEqual(after.children[0].focusCalls, [{ preventScroll: true }]);
  const removedButton = action('removed'), other = action('other'), removed = fixture('old', [record('removed', [removedButton])], [record('other', [other])]);
  removed.document.activeElement = removedButton; refreshErrors(removed.host, () => 'new');
  assert.equal(removed.document.activeElement, null); assert.equal(other.focusCalls.length, 0);
});
test('actual open/closed disclosure state wins; older unseen error state is retained for pagination', () => {
  const f = fixture('content', [record('a', [detail('a', true)]), record('b', [detail('b', false)])]);
  assert.deepEqual(errorDisclosureKeys(f.host, ['b', 'older']), ['older', 'a']);
});
test('actual outer disclosure open state wins before a queued toggle can update filters', () => {
  const outer = element('details', { class: 'ap-record-errors', open: '' }, [detail('a', true)]);
  const f = fixture('content', [outer]);
  assert.deepEqual(errorDisclosureState(f.host, { errorsOpen: false, errorExpanded: [] }), { errorsOpen: true, errorExpanded: ['a'] });
  outer.open = false;
  assert.equal(errorDisclosureState(f.host, { errorsOpen: true }).errorsOpen, false);
});
test('error record navigation opens folded skip/proactive sections before focusing the record', () => {
  for (const source of ['skip', 'proactive']) {
    const messages = element('details', { 'data-ai-skip-messages': 'incoming' }, []);
    const row = record('record', source === 'skip' ? [messages] : []);
    const section = element('details', {}, [row]), wrapper = element('details', {}, [section]);
    const f = fixture('content', [wrapper]);
    let scrolled = false; row.scrollIntoView = options => { assert.deepEqual(options, { block: 'center' }); assert.equal(section.open, true); assert.equal(wrapper.open, true); scrolled = true; };
    assert.equal(revealErrorRecord(row, f.host), true); assert.equal(scrolled, true); assert.equal(f.document.activeElement, row); assert.equal(row.tabIndex, -1);
    if (source === 'skip') assert.equal(messages.open, true);
  }
  assert.equal(revealErrorRecord(null, element('div')), false);
});
