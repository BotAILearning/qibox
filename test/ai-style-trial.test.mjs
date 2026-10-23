import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { generateStyleTrial, cancelStyleTrial, styleTrialScenes } from '../server/ai-style-trial.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const result = () => ({ trials: styleTrialScenes.map(scene => ({ id: scene.id, reply: '合成接话' })) });
async function fixture(t, fetcher) {
  const root = await temp(), bridge = new ChatFixture(); let requests = [];
  const provider = new AIProvider({ fetcher: async (url, options) => { requests.push({ url, options, input: JSON.parse(options.body) }); return fetcher ? fetcher(url, options) : Response.json({ choices: [{ message: { content: JSON.stringify(result()) } }] }); } });
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  await a.configure(modelConfig); await a.scan();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, bridge, requests, value: { account: bridge.account, contact: bridge.contacts[0].id, operationId: key('trial-one'), styleId: '', style: { summary: '自然短句，明确要求时说完整。' } } };
}
test('explicit trial uses one real provider transport call with only draft and five synthetic scenes; no persistence, WeChat or learning', async t => {
  const f = await fixture(t), before = await readFile(f.a.file), controller = f.a.controller;
  const r = await f.a.generateStyleTrial(f.value);
  assert.equal(r.trials.length, 5); assert.equal(f.requests.length, 1); assert.equal(f.bridge.sent.length, 0);
  assert.equal(f.a.controller, controller); assert.equal(controller.signal.aborted, false);
  assert.deepEqual(await readFile(f.a.file), before);
  const wire = JSON.stringify(f.requests[0].input);
  assert(!wire.includes('CHAT_PRIVATE_MARKER')); assert(!wire.includes(f.value.contact)); assert(!wire.includes(f.value.account));
  assert(wire.includes(f.value.style.summary));
  await assert.rejects(f.a.generateStyleTrial(f.value), e => e.code === 'ai_style_trial_used'); assert.equal(f.requests.length, 1);
});
for (const kind of ['429', '500', 'invalid-json', 'missing-scene', 'duplicate-scene']) test(`trial ${kind} fails once without provider format/status retry or overwriting data`, async t => {
  const f = await fixture(t, () => {
    if (kind === '429' || kind === '500') return Response.json({}, { status: Number(kind) });
    const r = result(); if (kind === 'missing-scene') r.trials.pop(); if (kind === 'duplicate-scene') r.trials[4] = r.trials[0];
    return Response.json({ choices: [{ message: { content: kind === 'invalid-json' ? 'unstructured text' : JSON.stringify(r) } }] });
  }), before = await readFile(f.a.file);
  await assert.rejects(f.a.generateStyleTrial(f.value)); assert.equal(f.requests.length, 1); assert.equal(f.bridge.sent.length, 0); assert.deepEqual(await readFile(f.a.file), before);
});
test('cancel only the trial, reject concurrent requests and retain operation tombstone', async t => {
  let entered, settle; const started = new Promise(r => entered = r), blocked = new Promise(r => settle = r);
  const f = await fixture(t, async (_url, options) => { entered(); await blocked; options.signal.throwIfAborted(); return Response.json({ choices: [{ message: { content: JSON.stringify(result()) } }] }); });
  const normal = f.a.controller, p = generateStyleTrial(f.a, f.value); await started;
  await assert.rejects(generateStyleTrial(f.a, { ...f.value, operationId: key('second') }), e => e.code === 'ai_style_trial_busy');
  cancelStyleTrial(f.a, { ...f.value, account: key('wrong') }); assert.equal(f.requests[0].options.signal.aborted, false);
  f.a.cancelStyleTrial(f.value); assert.equal(f.requests[0].options.signal.aborted, true); assert.equal(normal.signal.aborted, false);
  settle(); await assert.rejects(p); await assert.rejects(generateStyleTrial(f.a, f.value), e => e.code === 'ai_style_trial_used'); assert.equal(f.requests.length, 1);
});
test('late account/config changes discard result and never send', async t => {
  const f = await fixture(t, () => { f.bridge.account = key('switched-account'); return Response.json({ choices: [{ message: { content: JSON.stringify(result()) } }] }); });
  await assert.rejects(f.a.generateStyleTrial(f.value), e => e.code === 'AI_SCOPE_CHANGED'); assert.equal(f.requests.length, 1); assert.equal(f.bridge.sent.length, 0);
});
test('pre-cancel/disconnect and invalid account prevent dispatch; a new explicit click can proceed', async t => {
  const f = await fixture(t); f.a.cancelStyleTrial(f.value);
  await assert.rejects(f.a.generateStyleTrial(f.value));
  await assert.rejects(f.a.generateStyleTrial({ ...f.value, account: undefined }));
  const c = new AbortController(); c.abort(); await assert.rejects(f.a.generateStyleTrial({ ...f.value, operationId: key('disconnect') }, { signal: c.signal }));
  assert.equal(f.requests.length, 0); const r = await f.a.generateStyleTrial({ ...f.value, operationId: key('explicit-new-click') }); assert.equal(r.trials.length, 5); assert.equal(f.requests.length, 1);
});
