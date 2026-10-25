import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider } from '../server/ai-provider.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const config = { ...modelConfig, protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };
const result = (content, tokens) => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }],
  ...(tokens === undefined ? {} : { usage: { completion_tokens: tokens } }) });
const options = { format: 'report', budget: 8192, maxOutputAcrossAttempts: 12288 };
function provider(fetcher) { const p = new AIProvider({ fetcher }); p.backoff = async () => {}; return p; }

test('official DeepSeek report can finish within one larger bounded request, keeping saved history', async t => {
  const root = await temp(), bridge = new ChatFixture(), bodies = [];
  const p = provider(async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (body.max_tokens < 6085) return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens: body.max_tokens, completion_tokens_details: { reasoning_tokens: body.max_tokens } } });
    return result('{"report":"本人使用年付，对方只做本地拷贝。"}', 6085);
  });
  const a = new AIAssistant({ dataRoot: root, bridge, provider: p }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(config); await a.scan();
  const r = (await a.analyze({ contacts: [bridge.contacts[0].id], request: '概括' })).reports[0];
  assert.equal(r.status, 'complete'); assert.equal(bodies.length, 1); assert.equal(bodies[0].max_tokens, 8192);
  assert.equal(bodies[0].reasoning_effort, 'low'); assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
  assert.equal(a.analysisReport(r.historyId).report, r.report); assert.equal(bridge.sent.length, 0);
});

test('reported output usage leaves only the remaining allowance for a format retry', async () => {
  const budgets = [];
  const p = provider(async (_url, init) => { budgets.push(JSON.parse(init.body).max_tokens);
    return budgets.length === 1 ? result('{}', 5000) : result('{"report":"完整报告"}', 1000); });
  assert.equal((await p.complete(config, 'JSON报告', {}, undefined, options)).report, '完整报告');
  assert.deepEqual(budgets, [8192, 7288]);
});

test('unknown transport usage conservatively reserves its requested output allowance', async () => {
  const budgets = [];
  const p = provider(async (_url, init) => { budgets.push(JSON.parse(init.body).max_tokens);
    if (budgets.length === 1) throw new TypeError('synthetic transport failure');
    return result('{"report":"恢复后报告"}'); });
  assert.equal((await p.complete(config, 'JSON报告', {}, undefined, options)).report, '恢复后报告');
  assert.deepEqual(budgets, [8192, 4096]);
});

test('missing usage cannot expand the previous three-times-4096 output ceiling', async () => {
  const budgets = [];
  const p = provider(async (_url, init) => { budgets.push(JSON.parse(init.body).max_tokens); return result('{}'); });
  await assert.rejects(p.complete(config, 'JSON报告', {}, undefined, options), { code: 'ai_model_format' });
  assert.deepEqual(budgets, [8192, 4096]); assert.equal(budgets.reduce((a, b) => a + b, 0), 12288);
});

test('bounded report cannot retry by silently dropping its output limit after a rejection', async () => {
  const budgets = [];
  const p = provider(async (_url, init) => { budgets.push(JSON.parse(init.body).max_tokens);
    return budgets.length === 1 ? Response.json({ error: { message: 'unsupported max_tokens' } }, { status: 400 }) : result('{"report":"不得无上限重发"}'); });
  await assert.rejects(p.complete(config, 'JSON报告', {}, undefined, options));
  assert.deepEqual(budgets, [8192]);
});

test('reasoning-only report exhausting its limit stops without another identical generation', async () => {
  let calls = 0;
  const p = provider(async () => { calls++; return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }],
    usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 } } }); });
  await assert.rejects(p.complete(config, 'JSON报告', {}, undefined, options), { code: 'ai_model_output_budget' });
  assert.equal(calls, 1);
});

test('provider length with no report stops even when usage rounds below the requested limit or is absent', async () => {
  for (const sample of [
    { content: '', usage: { completion_tokens: 8190, completion_tokens_details: { reasoning_tokens: 8190 } } },
    { content: '  ', usage: { completion_tokens: 8191 } },
    { content: '' },
    { content: null },
  ]) {
    let calls = 0;
    const p = provider(async () => ++calls === 1
      ? Response.json({ choices: [{ message: { content: sample.content }, finish_reason: 'length' }], ...(sample.usage ? { usage: sample.usage } : {}) })
      : result('{"report":"不得靠无意义重试得到的正文"}', 100));
    await assert.rejects(p.complete(config, 'JSON报告', {}, undefined, options), { code: 'ai_model_output_budget' });
    assert.equal(calls, 1, 'An explicit provider limit and absent visible report must not spend another request');
  }
});

test('a nonempty truncated report retains the existing bounded retry policy', async () => {
  const budgets = [];
  const p = provider(async (_url, init) => {
    budgets.push(JSON.parse(init.body).max_tokens);
    return budgets.length === 1
      ? Response.json({ choices: [{ message: { content: '{"report":"未完成', }, finish_reason: 'length' }], usage: { completion_tokens: 1000 } })
      : result('{"report":"完整报告"}', 1000);
  });
  assert.equal((await p.complete(config, 'JSON报告', {}, undefined, options)).report, '完整报告');
  assert.deepEqual(budgets, [8192, 8192]);
});

test('malformed or over-limit usage cannot return output allowance', async () => {
  for (const usage of [99999, -1, '0']) {
    const budgets = [];
    const p = provider(async (_url, init) => { budgets.push(JSON.parse(init.body).max_tokens);
      return budgets.length === 1 ? result('{}', usage) : result('{"report":"报告"}', 100); });
    assert.equal((await p.complete(config, 'JSON报告', {}, undefined, options)).report, '报告');
    assert.deepEqual(budgets, [8192, 4096]);
  }
});

test('media downgrade carries only the remaining allowance into its text request', async () => {
  const budgets = [];
  const p = provider(async (_url, init) => { const body = JSON.parse(init.body); budgets.push(body.max_tokens);
    if (budgets.length === 1) return Response.json({ error: { message: 'images unsupported' } }, { status: 400 });
    return result('{"report":"仅分析保留的文字"}', 100); });
  const input = { images: [{ messageId: 'picture', mime: 'image/png', data: 'AAAA' }],
    messages: [{ id: 'picture', direction: 'other', type: 'image', text: '[图片]' }, { id: 'text', direction: 'other', text: '收到的文字。' }] };
  assert.equal((await p.complete(config, 'JSON报告', input, undefined, options)).report, '仅分析保留的文字');
  assert.deepEqual(budgets, [8192, 4096]);
});

test('ordinary report models and custom gateways retain the existing 4096 request', async t => {
  for (const patch of [{ model: 'another-model' }, { baseUrl: 'https://custom.example.test/v1' }, { protocol: 'anthropic' }]) {
    const root = await temp(), bridge = new ChatFixture(), budgets = [];
    const p = provider(async (_url, init) => { budgets.push(JSON.parse(init.body).max_tokens);
      return patch.protocol === 'anthropic' ? Response.json({ content: [{ type: 'text', text: '{"report":"报告"}' }] }) : result('{"report":"报告"}'); });
    const a = new AIAssistant({ dataRoot: root, bridge, provider: p }); await a.init();
    t.after(async () => { await a.close(); await cleanup(root); });
    await a.configure({ ...config, ...patch }); await a.scan();
    assert.equal((await a.analyze({ contacts: [bridge.contacts[0].id], request: '概括' })).reports[0].status, 'complete');
    assert.deepEqual(budgets, [4096]);
  }
});
