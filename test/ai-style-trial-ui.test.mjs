import test from 'node:test';
import assert from 'node:assert/strict';
import { createStyleTrialUI, styleTrialMarkup } from '../web/ai-style-trial.mjs';

function fixture() {
  let target = { instance: 'instance', account: 'account', contact: 'contact', verified: true, revision: 1 }, draft = { styleId: '', style: { summary: '未保存的草稿' } }, state, pending;
  const calls = [];
  const api = (url, data, timeout, options) => {
    calls.push({ url, data, timeout, options });
    if (data.action === 'style-trial-cancel') return Promise.resolve({ cancelled: true });
    return new Promise((resolve, reject) => pending = { resolve: trials => resolve({ ...data.value, trials }), reject });
  };
  const ui = createStyleTrialUI({ api, scope: () => target, draft: () => structuredClone(draft), changed: s => state = structuredClone(s) });
  return { ui, calls, get state() { return state; }, get pending() { return pending; }, target, draft };
}
const trials = [{ id: 'question', label: '合成问答', messages: [{ direction: 'other', text: '<img src=x onerror=alert(1)>' }], reply: '<script>不运行</script>' }];
test('trial UI deduplicates busy clicks, sends current unsaved draft, and renders model text as escaped text', async () => {
  const f = fixture(), p = f.ui.generate(); await f.ui.generate(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].data.value.style.summary, '未保存的草稿'); assert(f.state.busy);
  f.pending.resolve(trials); await p; assert.deepEqual(f.state.result.trials, trials); assert(!f.state.busy);
  const html = styleTrialMarkup(f.state); assert(html.includes('&lt;script&gt;')); assert(!html.includes('<img src=x')); assert(html.includes('按上游服务计费')); assert(html.includes('不会发微信'));
});
test('trial failure and cancellation retain old results and draft without automatically retrying', async () => {
  const f = fixture(), first = f.ui.generate(); f.pending.resolve(trials); await first;
  const second = f.ui.generate(); f.pending.reject(new Error('合成服务失败')); await second;
  assert.equal(f.calls.length, 2); assert.deepEqual(f.state.result.trials, trials); assert(f.state.error.includes('不会自动重试')); assert.equal(f.draft.style.summary, '未保存的草稿');
  const third = f.ui.generate(), old = f.pending; f.ui.cancel({ stale: true }); assert(f.calls[2].options.signal.aborted); assert.equal(f.calls[3].data.action, 'style-trial-cancel'); old.resolve([{ ...trials[0], reply: '迟到内容不能覆盖' }]); await third;
  assert.deepEqual(f.state.result.trials, trials); assert(f.state.stale); assert(!f.state.busy);
});
for (const key of ['instance', 'account', 'contact', 'revision', 'draft']) test(`trial ignores late result after ${key} changes`, async () => {
  const f = fixture(), p = f.ui.generate(); if (key === 'draft') f.draft.style.summary = '新的草稿'; else f.target[key] = 'changed';
  f.pending.resolve(trials); await p; assert.equal(f.state.result, undefined); assert.equal(f.state.busy, false); assert.equal(f.calls.length, 1);
});
test('hide/switch clears old account results and aborts the request before a new object can show them', async () => {
  const f = fixture(), p = f.ui.generate(); f.ui.cancel({ clear: true }); f.pending.resolve(trials); await p; assert.deepEqual(f.state, {}); assert(f.calls[0].options.signal.aborted);
});
