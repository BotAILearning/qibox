import test from 'node:test';
import assert from 'node:assert/strict';
import { copyReport } from '../web/ai-analysis-view.mjs';

// Model a browser that reports copy support even when the selection is not
// focused. Acceptance still requires the installed browser's real clipboard.
function browser(t, { command = true, focused = true, api } = {}) {
  const originals = Object.fromEntries(['document', 'navigator', 'isSecureContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  let clipboard = 'previous clipboard', field, commands = 0, removed = false;
  const active = { focus() { document.activeElement = active; } };
  const document = { activeElement: active, hasFocus: () => focused,
    createElement() { return field = { value: '', style: {}, setAttribute() {},
      focus() { document.activeElement = field; }, select() { field.selected = true; }, remove() { removed = true; } }; },
    body: { append() {} }, execCommand(name) { assert.equal(name, 'copy'); commands++; if (command && document.activeElement === field && field.selected) clipboard = field.value; return command; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: api && { writeText: api } } });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: !!api });
  return { get clipboard() { return clipboard; }, get commands() { return commands; }, get removed() { return removed; }, active, document };
}

test('HTTP report copy actually selects the focused full Unicode text and restores focus', async t => {
  const b = browser(t), text = '一、原文\nsequence 1｜收到🙂\nsequence 12｜末条，保留\n';
  await copyReport(text);
  assert.equal(b.clipboard, text);
  assert.equal(b.commands, 1);
  assert.equal(b.removed, true);
  assert.equal(b.document.activeElement, b.active);
});

test('report copy rejection retains report and restores focus without claiming success', async t => {
  const b = browser(t, { command: false });
  await assert.rejects(copyReport('原报告🙂'), /复制/);
  assert.equal(b.clipboard, 'previous clipboard');
  assert(b.removed);
  assert.equal(b.document.activeElement, b.active);
});

test('denied async clipboard uses the same focused fallback', async t => {
  const b = browser(t, { api: async () => { throw new Error('Permission denied'); } });
  await copyReport('完整正文🙂');
  assert.equal(b.clipboard, '完整正文🙂');
  assert.equal(b.commands, 1);
});

test('unfocused report copy refuses before touching the clipboard', async t => {
  const b = browser(t, { focused: false });
  await assert.rejects(copyReport('原报告'), /报告页面/);
  assert.equal(b.commands, 0);
  assert.equal(b.clipboard, 'previous clipboard');
});
