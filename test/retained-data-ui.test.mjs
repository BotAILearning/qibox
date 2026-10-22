import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Execute the production dialog renderer and restore handler. This does not
// claim browser layout/focus acceptance; the isolated browser fixture covers it.
const source = await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function retainedDialog('), end = source.indexOf('function importDialog(', start);
assert(start >= 0 && end > start);
const create = Function('deps', `const {state,retainedFor,definition,dialog,api,refresh,notify,closeModal,nameTaken,esc}=deps;
  const marketAppId='wechat',modalGeneration=1,modal={open:true};
  ${source.slice(start, end)}
  return {retainedDialog,restoreInstance};`);
function fixture(pending) {
  const item = { id: 'synthetic-pending', name: '合成保留数据', dataDeletionPending: pending }, calls = []; let markup;
  const ui = create({ state: { library: { installed: {} } }, retainedFor: () => [item], definition: () => ({ library: { installed: {}, job: null } }),
    dialog: (_title, body) => { markup = body; }, api: async (...args) => { calls.push(args); }, refresh: async () => {}, notify() {}, closeModal() {}, nameTaken: () => false,
    esc: text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;') });
  return { ui, item, calls, get markup() { return markup; } };
}
test('retained pending deletion visibly explains unavailable recovery and disables only its restore action', async () => {
  const f = fixture(true); f.ui.retainedDialog();
  assert.match(f.markup, /数据清理未完成，无法恢复/);
  assert.match(f.markup, /<button[^>]*data-restore="synthetic-pending"[^>]*\bdisabled/);
  assert.doesNotMatch(f.markup.match(/<button[^>]*data-purge="synthetic-pending"[^>]*>/)[0], /disabled/);
  await assert.rejects(f.ui.restoreInstance(f.item, { disabled: false }), /数据清理未完成/); assert.equal(f.calls.length, 0);
});
test('ordinary retained recovery remains available and removing the pending marker restores the ordinary handler', async () => {
  const f = fixture(false); f.ui.retainedDialog();
  assert.doesNotMatch(f.markup, /数据清理未完成/); assert.doesNotMatch(f.markup.match(/<button[^>]*data-restore="synthetic-pending"[^>]*>/)[0], /disabled/);
  const button = { disabled: false }; await f.ui.restoreInstance(f.item, button);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], '/instances/synthetic-pending/restore'); assert.equal(button.disabled, false);
  f.item.dataDeletionPending = true; await assert.rejects(f.ui.restoreInstance(f.item, button), /数据清理未完成/); assert.equal(f.calls.length, 1);
  delete f.item.dataDeletionPending; await f.ui.restoreInstance(f.item, button); assert.equal(f.calls.length, 2);
});
