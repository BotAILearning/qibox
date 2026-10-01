import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissibleNotice } from '../web/dismissible-notice.mjs';

function surface() {
  const document = { activeElement: null, createElement: () => element() };
  function element() {
    const classes = new Set(), handlers = new Map();
    return { ownerDocument: document, isConnected: true, hidden: false, children: [], attributes: {}, textContent: '',
      classList: { toggle(key, present) { present ? classes.add(key) : classes.delete(key); }, contains: key => classes.has(key) },
      setAttribute(key, value) { this.attributes[key] = value; },
      replaceChildren(...children) { this.children = children; children.forEach(child => { child.parent = this; }); },
      contains(child) { return child === this || this.children.some(row => row.contains(child)); },
      closest() { return this.hidden || this.parent?.hidden ? this : null; },
      focus() { document.activeElement = this; },
      addEventListener(type, handler) { handlers.set(type, handler); },
      dispatch(type, details = {}) { handlers.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...details }); },
    };
  }
  const node = element(), trigger = element(), fallback = element();
  trigger.focus();
  const notice = dismissibleNotice(node, { fallbackFocus: () => fallback });
  return { document, node, trigger, fallback, notice, text: node.children[0], close: node.children[1] };
}

test('dismissal preserves the error content and restores focus without consuming the next explicit error', () => {
  const { node, notice, text, close, document, trigger } = surface();
  notice.show('保存失败，请重试', true);
  assert.equal(node.hidden, false);
  assert.equal(node.attributes.role, 'alert');
  assert.equal(close.attributes['aria-label'], '关闭错误提示');
  assert.equal(document.activeElement, trigger); // Announcing errors never steals focus.
  close.focus(); close.dispatch('click');
  assert.equal(node.hidden, true);
  assert.equal(text.textContent, '保存失败，请重试');
  assert.equal(document.activeElement, trigger);
  notice.show('保存失败，请重试', true);
  assert.equal(node.hidden, false); // A retry with the same error remains actionable.
  notice.show('联系人已变化', true);
  assert.equal(text.textContent, '联系人已变化');
  assert.equal(node.hidden, false);
});

test('background polling keeps a dismissed error hidden until recovery or a different error', () => {
  const { node, notice } = surface();
  notice.show('连接中断', true, { repeat: false });
  notice.dismiss();
  for (let poll = 0; poll < 3; poll++) notice.show('连接中断', true, { repeat: false });
  assert.equal(node.hidden, true);
  notice.show('连接超时', true, { repeat: false });
  assert.equal(node.hidden, false);
  notice.dismiss(); notice.show('');
  notice.show('连接超时', true, { repeat: false });
  assert.equal(node.hidden, false);
});

test('Escape restores a visible fallback when the original form was removed', () => {
  const { node, notice, close, document, trigger, fallback } = surface();
  notice.show('操作失败', true);
  trigger.isConnected = false;
  close.focus(); node.dispatch('keydown', { key: 'Escape' });
  assert.equal(node.hidden, true);
  assert.equal(document.activeElement, fallback);
});

test('success notices remain dismissible and untrusted text is inserted as plain text', () => {
  const { node, notice, close, text } = surface();
  notice.show('<img src=x onerror=alert(1)>');
  assert.equal(text.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(node.attributes.role, 'status');
  assert.equal(node.classList.contains('error'), false);
  assert.equal(close.attributes['aria-label'], '关闭提示');
  close.dispatch('click');
  assert.equal(node.hidden, true);
});
