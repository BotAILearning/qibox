import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshRecordContent, skipDisclosureKeys } from '../web/ai-record-refresh.mjs';

// A small DOM double keeps these state/focus tests independent of browsers.
// Replacement disconnects old controls just as innerHTML does in the page.
function node(tagName, attributes = {}, children = []) {
  const element = {
    tagName: tagName.toUpperCase(), attributes, children, focusCalls: [],
    hasAttribute: key => Object.hasOwn(attributes, key),
    getAttribute: key => attributes[key] ?? null,
    contains(target) { return this === target || this.children.some(child => child.contains(target)); },
    closest(selector) {
      for (let current = this; current; current = current.parentElement) if (matches(current, selector)) return current;
      return null;
    },
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    focus(options) { this.focusCalls.push(options); this.ownerDocument.activeElement = this; },
  };
  element.id = attributes.id || '';
  element.disabled = Object.hasOwn(attributes, 'disabled');
  element.open = Object.hasOwn(attributes, 'open');
  for (const child of children) child.parentElement = element;
  return element;
}
function matches(element, selector) {
  return selector.split(',').some(part => {
    const match = /^([a-z]+)?(?:\[([a-z-]+)\])?$/i.exec(part);
    return !!match && (!match[1] || element.tagName === match[1].toUpperCase()) && (!match[2] || element.hasAttribute(match[2]));
  });
}
const record = (id, children, proactive = false) => node('article', { [proactive ? 'data-proactive-record' : 'data-ai-skip-record']: id }, children);
const mark = (profile = 'same-profile', disabled = false) => node('button', { 'data-ai-mark-reply': profile, ...(disabled ? { disabled: '' } : {}) });
const disclosure = (id, open = false) => node('details', { 'data-ai-skip-messages': id, ...(open ? { open: '' } : {}) }, [node('summary')]);

function fixture(initialHtml, initialChildren, nextTrees = new Map(), id = 'ai-skip-records') {
  const root = node('div', { id }, initialChildren);
  let html = initialHtml, writes = 0, templates = 0;
  const document = {
    activeElement: null,
    createElement(tag) {
      assert.equal(tag, 'template');
      templates++;
      return {
        content: {},
        get innerHTML() { return this.markup; },
        set innerHTML(value) {
          this.markup = value;
          const wrapper = /^<div id="([^"]*)">([\s\S]*)<\/div>$/.exec(value);
          this.content.firstElementChild = wrapper ? { id: wrapper[1], innerHTML: wrapper[2] } : null;
        },
      };
    },
  };
  const connect = element => {
    element.ownerDocument = document;
    for (const child of element.children) { child.parentElement = element; connect(child); }
  };
  connect(root);
  Object.defineProperty(root, 'innerHTML', {
    get: () => html,
    set(value) {
      writes++;
      if (root.contains(document.activeElement)) document.activeElement = null;
      html = value;
      root.children = nextTrees.get(value) || [];
      connect(root);
    },
  });
  root.scrollTop = 180;
  return { root, document, writes: () => writes, templates: () => templates };
}

test('unchanged refresh preserves existing controls and text selection, including the first refresh', () => {
  const button = mark(), view = fixture('same content', [record('record-1', [button])]);
  view.document.activeElement = button;
  view.document.selection = { anchorNode: button, text: 'selected message' };
  assert.equal(refreshRecordContent(view.root, () => 'same content'), false);
  assert.equal(refreshRecordContent(view.root, () => 'same content'), false);
  assert.equal(view.writes(), 0);
  assert.equal(view.templates(), 1);
  assert.equal(view.document.activeElement, button);
  assert.equal(view.document.selection.anchorNode, button);
  assert.equal(button.focusCalls.length, 0);
});

test('a located record root retains exact focus when opening message details changes the next poll', () => {
  for (const proactive of [false, true]) {
    const previous = record('record-2', [disclosure('incoming', true)], proactive);
    const wrong = record('record-1', [], proactive), next = record('record-2', [disclosure('incoming', true)], proactive);
    const view = fixture('previous closed markup', [previous], new Map([
      ['message details now open', [wrong, next]],
    ]));
    previous.tabIndex = -1; view.document.activeElement = previous;
    assert.equal(refreshRecordContent(view.root, () => 'message details now open'), true);
    assert.equal(view.document.activeElement, next); assert.equal(next.tabIndex, -1);
    assert.deepEqual(next.focusCalls, [{ preventScroll: true }]); assert.equal(wrong.focusCalls.length, 0);
    assert.equal(view.root.scrollTop, 180);
    assert.equal(refreshRecordContent(view.root, () => 'message details now open'), false);
    assert.equal(view.document.activeElement, next); assert.equal(view.writes(), 1);
  }
});

test('changed records restore the exact record action without scrolling or choosing another occurrence', () => {
  const previous = mark(), wrongRecord = mark(), next = mark();
  const view = fixture('old', [record('record-2', [previous])], new Map([
    ['new', [record('record-1', [wrongRecord]), record('record-2', [next])]],
  ]));
  view.document.activeElement = previous;
  assert.equal(refreshRecordContent(view.root, 'new'), true);
  assert.equal(view.document.activeElement, next);
  assert.deepEqual(next.focusCalls, [{ preventScroll: true }]);
  assert.equal(wrongRecord.focusCalls.length, 0);
  assert.equal(view.root.scrollTop, 180);
});

test('actual disclosure state is saved before render and summary focus survives a changed record', () => {
  const oldDisclosure = disclosure('record-1', true), nextDisclosure = disclosure('record-1', true);
  const view = fixture('old', [record('record-1', [oldDisclosure])], new Map([
    ['updated and open', [record('record-1', [nextDisclosure])]],
  ]));
  view.document.activeElement = oldDisclosure.querySelector('summary');
  let expanded = ['record-not-currently-visible'];
  refreshRecordContent(view.root, () => {
    expanded = skipDisclosureKeys(view.root, expanded);
    assert.deepEqual(expanded, ['record-not-currently-visible', 'record-1']);
    return '<div id="ai-skip-records">updated and open</div>';
  }, { outerMarkup: true });
  assert.equal(nextDisclosure.open, true);
  assert.equal(view.document.activeElement, nextDisclosure.querySelector('summary'));
  assert.deepEqual(nextDisclosure.querySelector('summary').focusCalls, [{ preventScroll: true }]);
});

test('closing a disclosure removes only its key and preserves expansion of unloaded records', () => {
  const view = fixture('unchanged', [record('visible', [disclosure('visible')])]);
  assert.deepEqual(skipDisclosureKeys(view.root, ['visible', 'unloaded']), ['unloaded']);
});

test('legacy records without an ID restore a uniquely keyed summary, never an ambiguous contact action', () => {
  const previous = disclosure('profile:old-time', true), next = disclosure('profile:old-time', true);
  const view = fixture('old', [record('', [previous])], new Map([
    ['new', [record('', [disclosure('other-profile:old-time')]), record('', [next])]],
  ]));
  view.document.activeElement = previous.querySelector('summary');
  refreshRecordContent(view.root, 'new');
  assert.equal(view.document.activeElement, next.querySelector('summary'));
  const oldButton = mark(), another = mark();
  const unkeyed = fixture('old', [record('', [oldButton])], new Map([['new', [record('', [another])]]]));
  unkeyed.document.activeElement = oldButton;
  refreshRecordContent(unkeyed.root, 'new');
  assert.equal(another.focusCalls.length, 0);
});

test('a deleted record or disabled replacement never sends focus to a different action', () => {
  for (const removed of [true, false]) {
    const old = mark(), next = mark('same-profile', true), other = mark();
    const view = fixture('old', [record('original', [old])], new Map([
      ['new', [record('other', [other]), ...(removed ? [] : [record('original', [next])])]],
    ]));
    view.document.activeElement = old;
    refreshRecordContent(view.root, 'new');
    assert.equal(view.document.activeElement, null);
    assert.equal(next.focusCalls.length, 0);
    assert.equal(other.focusCalls.length, 0);
  }
});

test('proactive contact and pagination controls retain their own action identity', () => {
  for (const attribute of ['data-ai-open-conversation', 'data-proactive-record-more']) {
    const old = node('button', { [attribute]: attribute.endsWith('more') ? '' : 'profile-1' });
    const next = node('button', { ...old.attributes });
    const rows = control => attribute.endsWith('more') ? [control] : [record('proactive-1', [control], true)];
    const view = fixture('old', rows(old), new Map([['new', rows(next)]]), 'ai-proactive-records');
    view.document.activeElement = old;
    refreshRecordContent(view.root, 'new');
    assert.equal(view.document.activeElement, next);
    assert.deepEqual(next.focusCalls, [{ preventScroll: true }]);
  }
});

test('refresh never steals focus from outside the record list and keeps its wrapper', () => {
  const view = fixture('old', [], new Map([['new', [record('new-record', [mark()])]]]));
  const external = node('input');
  view.document.activeElement = external;
  refreshRecordContent(view.root, '<div id="ai-skip-records">new</div>', { outerMarkup: true });
  assert.equal(view.document.activeElement, external);
  assert.equal(view.root.id, 'ai-skip-records');
  assert.equal(view.root.scrollTop, 180);
});

test('a missing host is a no-op and a mismatched renderer wrapper fails before replacement', () => {
  let rendered = false;
  assert.equal(refreshRecordContent(null, () => { rendered = true; }), false);
  assert.equal(rendered, false);
  const view = fixture('old', []);
  assert.throws(() => refreshRecordContent(view.root, '<div id="wrong-root">new</div>', { outerMarkup: true }), /retain its root/);
  assert.equal(view.writes(), 0);
});
