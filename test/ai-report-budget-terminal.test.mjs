import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider } from '../server/ai-provider.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const openai = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', protocol: 'openai', apiKey: 'synthetic-only-key', timeout: 60, consent: true };
const configFor = protocol => protocol === 'openai' ? openai : { ...openai, baseUrl: 'https://models.example.test/anthropic', model: 'synthetic-reasoning-model', protocol };
const response = (protocol, text, finish = 'stop', usage = true) => protocol === 'openai'
  ? { choices: [{ message: { content: text }, finish_reason: finish === 'length' ? 'length' : 'stop' }],
      ...(usage ? { usage: { prompt_tokens: 2068, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } } } : {}) }
  : { content: [{ type: 'thinking', thinking: 'Synthetic reasoning placeholder; no private upstream reasoning is stored.' }, ...(text == null ? [] : [{ type: 'text', text }])], stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn',
      ...(usage ? { usage: { input_tokens: 2068, output_tokens: 4096 } } : {}) };

for (const protocol of ['openai', 'anthropic']) {
  for (const sample of [
    { name: 'reasoning-only exhausted response', text: '', usage: true },
    { name: 'explicit exhausted response without usage', text: null, usage: false },
    { name: 'whitespace exhausted response', text: ' \n\t ', usage: true },
  ]) {
    test(`${protocol}: generic report ${sample.name} stops after one request`, async () => {
      const requests = [];
      const provider = new AIProvider({ fetcher: async (_url, init) => {
        requests.push(JSON.parse(init.body)); return Response.json(response(protocol, sample.text, 'length', sample.usage));
      } });
      provider.backoff = async () => {};
      await assert.rejects(provider.complete(configFor(protocol), 'Synthetic report task', { source: 'synthetic' }, undefined,
        { format: 'report', budget: 4096 }), error => error.code === 'ai_model_output_budget');
      assert.equal(requests.length, 1, 'do not buy another report after an explicit exhausted empty response');
      assert.equal(requests[0].max_tokens, 4096);
    });
  }
}

test('a generic report budget rejection never retries with its output ceiling removed', async () => {
  const requests = [];
  const provider = new AIProvider({ fetcher: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? Response.json({ error: { message: 'max_tokens is unsupported', type: 'invalid_request_error' } }, { status: 400 })
      : Response.json(response('openai', '{"report":"This uncapped request must never occur."}'));
  } });
  provider.backoff = async () => {};
  await assert.rejects(provider.complete(openai, 'Synthetic report task', {}, undefined, { format: 'report', budget: 4096 }));
  assert.equal(requests.length, 1); assert.equal(requests[0].max_tokens, 4096);
});

test('non-report legacy budget compatibility is retained', async () => {
  const requests = [];
  const provider = new AIProvider({ fetcher: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? Response.json({ error: { message: 'max_tokens is unsupported' } }, { status: 400 })
      : Response.json(response('openai', '{"ok":true}'));
  } });
  provider.backoff = async () => {};
  assert.equal((await provider.complete(openai, 'Synthetic connection test', { test: true }, undefined, { budget: 4096 })).ok, true);
  assert.equal(requests.length, 2); assert.equal(requests[0].max_tokens, 4096); assert.equal(Object.hasOwn(requests[1], 'max_tokens'), false);
});

test('a nonempty truncated report keeps its existing bounded-per-attempt retry behavior', async () => {
  const requests = [];
  const provider = new AIProvider({ fetcher: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(response('openai', requests.length === 1 ? '{"report":"partial' : '{"report":"完整合成报告"}', requests.length === 1 ? 'length' : 'stop'));
  } });
  provider.backoff = async () => {};
  assert.equal((await provider.complete(openai, 'Synthetic report', {}, undefined, { format: 'report', budget: 4096 })).report, '完整合成报告');
  assert.equal(requests.length, 2); assert.deepEqual(requests.map(x => x.max_tokens), [4096, 4096]);
});

test('an empty ordinary-stop report retains its existing terminal body error', async () => {
  let calls = 0;
  const provider = new AIProvider({ fetcher: async () => Response.json(response('openai', ++calls === 1 ? '' : '{"report":"完整合成报告"}')) });
  provider.backoff = async () => {};
  await assert.rejects(provider.complete(openai, 'Synthetic report', {}, undefined, { format: 'report', budget: 4096 }), error => error.code === undefined && /完整正文/.test(error.message));
  assert.equal(calls, 1);
});

test('normal analysis preserves old history and reports exhausted empty output without a second request', async t => {
  const root = await temp(), bridge = new ChatFixture(); let calls = 0, exhausted = false;
  const provider = new AIProvider({ fetcher: async () => { calls++; return Response.json(response('openai', exhausted ? '' : '{"report":"已有合成报告"}', exhausted ? 'length' : 'stop')); } });
  provider.backoff = async () => {};
  const a = new AIAssistant({ dataRoot: root, bridge, provider });
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer); await a.configure(openai); await a.scan();
  const request = { request: '只整理已给的合成聊天', contacts: [bridge.contacts[0].id] };
  assert.equal((await a.analyze(request)).reports[0].status, 'complete');
  const history = structuredClone(a.data.analysisReports), beforeCalls = calls; exhausted = true;
  const result = await a.analyze(request);
  assert.equal(result.reports[0].status, 'error'); assert.equal(calls - beforeCalls, 1);
  assert.match(result.reports[0].error, /输出上限/); assert.deepEqual(a.data.analysisReports, history);
});
