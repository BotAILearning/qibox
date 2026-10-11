import test from 'node:test';
import assert from 'node:assert/strict';
import { productDialog, bindDialogFocus } from '../web/dialogs.mjs';

function surface(t) {
  const previous = globalThis.document, handlers = new Map(), controls = [], attributes = new Map();
  const document = { activeElement: null, body: { append() {} }, createElement: () => dialog };
  const node = (name, visible = true) => {
    const value = { name, disabled: false, tabIndex: 0, isConnected: true, value: '新名字',
      getClientRects: () => visible ? [{}] : [], focus() { document.activeElement = this; },
      addEventListener(type, handler) { handlers.set(name + ':' + type, handler); } };
    return value;
  };
  const origin = node('origin'), close = node('close'), input = node('input'), cancel = node('cancel'), confirm = node('confirm'), heading = {};
  controls.push(close, cancel, confirm); document.activeElement = origin;
  const form = node('form');
  const dialog = { isConnected: true, className: '', innerHTML: '',
    setAttribute(name, value) { attributes.set(name, value); },
    querySelector(selector) { return ({ h3: heading, '[data-cancel]': cancel, '.qbx-dialog-close': close, form, input })[selector]; },
    querySelectorAll() { return controls; },
    addEventListener(type, handler) { handlers.set('dialog:' + type, handler); },
    showModal() {}, close() { handlers.get('dialog:close')(); }, remove() { this.isConnected = false; } };
  globalThis.document = document; t.after(() => { globalThis.document = previous; });
  return { document, dialog, controls, close, input, cancel, confirm, heading, attributes, origin,
    key(key, shiftKey = false, extras = {}) { let prevented = false; handlers.get('dialog:keydown')({ key, shiftKey, preventDefault() { prevented = true; }, ...extras }); return prevented; },
    escape() { let prevented = false; handlers.get('dialog:cancel')({ preventDefault() { prevented = true; } }); return prevented; },
    submit() { handlers.get('form:submit')({ preventDefault() {} }); } };
}

test('confirmation dialogs wrap keyboard focus at both boundaries and retain interior Tab navigation', async t => {
  const f = surface(t), pending = productDialog({ title: '取消学习？' });
  assert.equal(f.document.activeElement, f.cancel);
  assert.equal(f.key('Tab'), false);
  f.confirm.focus(); assert.equal(f.key('Tab'), true); assert.equal(f.document.activeElement, f.close);
  assert.equal(f.key('Tab', true), true); assert.equal(f.document.activeElement, f.confirm);
  f.cancel.focus(); assert.equal(f.key('Tab', true), false);
  assert.equal(f.escape(), true); assert.equal(await pending, null); assert.equal(f.document.activeElement, f.origin);
});

test('dialog focus boundaries exclude disabled and hidden controls and leave browser shortcuts intact', async t => {
  const f = surface(t), pending = productDialog();
  f.confirm.disabled = true;
  const hidden = { disabled: false, tabIndex: 0, getClientRects: () => [] }; f.controls.push(hidden);
  f.cancel.focus(); assert.equal(f.key('Tab'), true); assert.equal(f.document.activeElement, f.close);
  assert.equal(f.key('Tab', true, { ctrlKey: true }), false);
  assert.equal(f.key('Escape'), false);
  f.escape(); await pending;
});

test('input dialogs keep editing and submission while exposing a unique accessible title', async t => {
  const f = surface(t); f.controls.splice(1, 0, f.input);
  const first = productDialog({ title: '重命名风格', input: '旧名字', confirm: '保存名称' });
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.key('Tab'), false); assert.equal(f.key('Enter'), false);
  assert.equal(f.attributes.get('aria-labelledby'), f.heading.id);
  const titleId = f.heading.id;
  f.submit(); assert.equal(await first, '新名字'); assert.equal(f.document.activeElement, f.origin);
  const second = productDialog({ title: '再次确认' });
  assert.notEqual(f.heading.id, titleId); f.escape(); await second;
});

test('reused instance dialogs update focus boundaries as content and pending controls change', async t => {
  const f = surface(t); bindDialogFocus(f.dialog);
  f.confirm.focus(); assert.equal(f.key('Tab'), true); assert.equal(f.document.activeElement, f.close);
  f.controls.splice(0, f.controls.length, f.input, f.cancel, f.confirm);
  f.input.focus(); assert.equal(f.key('Tab', true), true); assert.equal(f.document.activeElement, f.confirm);
  f.confirm.disabled = true;
  f.cancel.focus(); assert.equal(f.key('Tab'), true); assert.equal(f.document.activeElement, f.input);
  assert.equal(f.key('Enter'), false);
  assert.equal(f.key('Tab', false, { ctrlKey: true }), false);
  f.controls.splice(0, f.controls.length, f.cancel);
  f.cancel.focus(); assert.equal(f.key('Tab'), true); assert.equal(f.document.activeElement, f.cancel);
  assert.equal(f.key('Tab', true), true); assert.equal(f.document.activeElement, f.cancel);
});
