import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider, modelResult } from '../server/ai-provider.mjs';
import { AppError } from '../server/files.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
const analysisConfig = { ...modelConfig, baseUrl: 'https://analysis.example.test/v1', apiKey: 'ANALYSIS_ONLY_KEY', model: 'analysis-reasoner' };
async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  const a = new AIAssistant({ dataRoot: root, bridge, provider }); await a.init();
  t.after(async () => { await a.close(); await cleanup(root); });
  await a.verifyProvider(modelConfig); await a.scan();
  bridge.readRange = async args => ({ account: args.account, contact: args.contact, rangeRevision: key(args.contact), messages: [{ id:key('message'), timestamp: args.from + 1, text: 'fixture-private-chat', direction: 'self' }] });
  const request = { request: '总结', from: '2026-09-01', to: '2026-09-02', contacts: [bridge.contacts[0].id] };
  return { root, bridge, provider, a, request };
}

test('single-contact report parser accepts JSON or plain text and rejects missing report data', () => {
  assert.deepEqual(modelResult('<think>hidden</think>\n```json\n{"report":"简明报告"}\n```', 'report'), { report: '简明报告' });
  assert.deepEqual(modelResult('纯文本报告正文', 'report'), { report: '纯文本报告正文' });
  assert.deepEqual(modelResult('"JSON 字符串报告"', 'report'), { report: 'JSON 字符串报告' });
  assert.throws(() => modelResult('{"excerptIds":[]}', 'report'), /有效报告正文/);
  assert.throws(() => modelResult('"  "', 'report'), /有效报告正文/);
});

test('single-contact parser uses a non-empty standard or alternate body and rejects ambiguity', () => {
  assert.deepEqual(modelResult('{"report":"","content":"可验证的完整报告"}', 'report'), { report: '可验证的完整报告' });
  assert.deepEqual(modelResult('{"report":{"text":"嵌套报告正文"}}', 'report'), { report: '嵌套报告正文' });
  assert.deepEqual(modelResult('[{"report":"单项报告"}]', 'report'), { report: '单项报告' });
  assert.throws(() => modelResult('{"report":"","summary":"只有短摘要"}', 'report'), /有效报告正文/);
  assert.throws(() => modelResult('[{"report":"报告一"},{"report":"报告二"}]', 'report'), /多个报告对象/);
  assert.throws(() => modelResult('{"report":"报告一"}\n{"report":"报告二"}', 'report'), /多个报告对象/);
});

test('empty report diagnostic logs only response shape metadata', async () => {
  const content = '{"report":"","content":"","privateBody":"SYNTHETIC_PRIVATE_SENTINEL"}';
  const provider = new AIProvider({ fetcher: async () => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
  const logs = [], originalWarn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    await assert.rejects(provider.complete({ ...analysisConfig, protocol: 'openai' }, 'system', {}, undefined, { format: 'report', budget: 4096, retry: false }), /有效报告正文/);
  } finally { console.warn = originalWarn; }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[ai-analysis-report-shape\]/);
  assert.doesNotMatch(logs[0], /SYNTHETIC_PRIVATE_SENTINEL|ANALYSIS_ONLY_KEY|contact-id/);
  const detail = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.equal(detail.fields.report.nonEmpty, false);
  assert.equal(detail.fields.content.nonEmpty, false);
  assert.equal(detail.finishReason, 'stop');
});

test('retry:false sends exactly one HTTP request for 429, 5xx, budget rejection and timeout', async () => {
  for (const failure of [429, 503, 400, 'timeout']) {
    let calls = 0;
    const provider = new AIProvider({ fetcher: async () => { calls++; if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError'); return Response.json({ error: 'fixture' }, { status: failure }); } });
    await assert.rejects(provider.complete(analysisConfig, 'system', {}, undefined, { format: 'report', budget: 4096, retry: false }));
    assert.equal(calls, 1, `failure ${failure} must not trigger a hidden retry`);
  }
});

test('business schema validation retries malformed model results within the shared provider attempt limit', async () => {
  let calls = 0; const systems = [];
  const provider = new AIProvider({ fetcher: async (_url, init) => {
    calls++; systems.push(JSON.parse(init.body).messages?.[0]?.content || JSON.parse(init.body).system);
    const content = calls < 3 ? '{"style":{"language":"only one layer"}}' : '{"style":{"language":"a","rhythm":"b","interaction":"c","emotion":"d","role":"e"}}';
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  }, backoff: async () => {} });
  provider.backoff = async () => {};
  const value = await provider.complete(analysisConfig, 'learn style', { contact: 'one-contact' }, undefined, {
    budget: 2048,
    validate: result => {
      if (!['language','rhythm','interaction','emotion','role'].every(key => typeof result.style?.[key] === 'string'))
        throw new AppError('schema failure', 502, 'ai_model_schema');
      return result;
    },
  });
  assert.equal(calls, 3);
  assert.equal(value.style.role, 'e');
  assert.match(systems[1], /重新回答|修正/);
});

test('business schema failure stops after the configured number of total model attempts', async () => {
  let calls = 0;
  const provider = new AIProvider({ fetcher: async () => {
    calls++; return Response.json({ choices: [{ message: { content: '{"style":{}}' }, finish_reason: 'stop' }] });
  }, backoff: async () => {} });
  provider.backoff = async () => {};
  await assert.rejects(provider.complete(analysisConfig, 'learn style', {}, undefined, {
    validate: () => { throw new AppError('schema failure', 502, 'ai_model_schema'); },
  }), /schema failure/);
  assert.equal(calls, 3);
});

test('default-style schema diagnostics expose shape and source counts without model text', async () => {
  const warnings = [], originalWarn = console.warn;
  console.warn = (label, detail) => warnings.push([label, JSON.parse(detail)]);
  try {
    const provider = new AIProvider({ fetcher: async () => Response.json({ choices: [{ message: { content: '{"summary":"private style prose"}' }, finish_reason: 'stop' }] }), backoff: async () => {} });
    provider.backoff = async () => {};
    await assert.rejects(provider.complete(analysisConfig, 'learn style', { defaultStyle: true, conversations: [{ material: [{ direction: 'self', text: 'private chat' }, { direction: 'other', text: 'other' }] }] }, undefined, {
      validate: result => { if (!result.style?.language) throw new AppError('schema failure', 502, 'ai_model_schema'); return result; },
    }));
    assert.equal(warnings.length, 3, 'schema failures retry only within the shared three-attempt budget');
    assert.deepEqual(warnings[0][1].responseKeys, ['summary']);
    assert.equal(warnings[0][1].finishReason, 'stop');
    assert.equal(warnings[0][1].truncated, false);
    assert.deepEqual(warnings[0][1].selfMessageCounts, [1]);
    assert.doesNotMatch(JSON.stringify(warnings), /private style prose|private chat/);
  } finally { console.warn = originalWarn; }
});

test('chat and analysis share one encrypted model; changing it pauses the queue and cancels old work', async t => {
  const {root,a,provider,request}=await fixture(t), revision=a.revision;
  a.data.queue.status='running';
  await a.verifyProvider(analysisConfig,'analysis');
  assert.equal(a.config.model,analysisConfig.model);assert.equal(a.data.queue.status,'paused');assert.ok(a.revision>revision);
  assert.equal(a.publicState().analysis.mode,'shared');assert.deepEqual(a.publicState().provider,a.publicState().analysis.effectiveProvider);
  provider.complete=async(c,system,input)=>{assert.equal(c.apiKey,analysisConfig.apiKey);assert.ok(Array.isArray(input.messages));assert.match(system,/4–6 个短章节/);assert.match(system,/标题不超过 20 字/);assert.match(system,/正文约 60–140 字/);assert.match(system,/全文约 900 字以内/);assert.match(system,/不用 Markdown # 标题或表格/);assert.match(system,/用户明确指定格式时优先/);assert.doesNotMatch(system,/excerptIds|精彩片段|聊天片段/);return {report:'报告'};};
  assert.equal((await a.analyze(request)).reports[0].status,'complete');
  assert.doesNotMatch(await readFile(a.file,'utf8'),/ANALYSIS_ONLY_KEY|analysis-reasoner/);
  const reopened=new AIAssistant({dataRoot:root,bridge:a.bridge,provider});await reopened.init();
  assert.equal(reopened.analysisModel().model,analysisConfig.model);await reopened.close();
});

test('legacy independent model is kept encrypted; existing chat wins, analysis-only becomes shared',async t=>{
  const {root,a,bridge,provider}=await fixture(t);
  const saved=JSON.parse(await readFile(a.file,'utf8'));
  saved.analysisProvider=a.vault.seal(analysisConfig);saved.analysisMode='independent';
  for(const hasChat of [true,false]) {
    const data=structuredClone(saved);if(!hasChat){data.provider=null;data.tested=null;}
    await writeFile(a.file,JSON.stringify(data));
    const reopened=new AIAssistant({dataRoot:root,bridge,provider});await reopened.init();
    assert.equal(reopened.config.model,hasChat?modelConfig.model:analysisConfig.model);
    assert.deepEqual(reopened.data.analysisProvider,saved.analysisProvider);assert.equal(reopened.data.analysisMode,'shared');
    await reopened.save();assert.doesNotMatch(await readFile(a.file,'utf8'),/ANALYSIS_ONLY_KEY/);await reopened.close();
  }
});

test('failed shared-model validation leaves the working configuration intact',async t=>{
  const {a,provider}=await fixture(t),before=structuredClone(a.config);
  provider.test=async()=>{throw Error('unavailable');};
  await assert.rejects(a.verifyProvider(analysisConfig,'analysis'));assert.deepEqual(a.config,before);
  assert.throws(()=>a.providerConfig('unknown'),/用途无效/);
});

test('changing shared model cancels in-flight analysis instead of mixing providers',async t=>{
  const {a,provider,request}=await fixture(t),started=Promise.withResolvers(),released=Promise.withResolvers();
  provider.complete=async(_c,_s,_i,signal)=>{started.resolve();await released.promise;signal.throwIfAborted();return {report:'stale'};};
  const result=a.analyze(request), rejection=assert.rejects(result);await started.promise;
  await a.configure(analysisConfig);released.resolve();await rejection;assert.equal(a.operation,null);
});

test('unreadable legacy analysis backup is retained without disabling a valid shared model',async t=>{
  const {root,a,bridge,provider}=await fixture(t),saved=JSON.parse(await readFile(a.file,'utf8'));
  saved.analysisProvider={...a.vault.seal(analysisConfig),tag:'invalid'};
  await writeFile(a.file,JSON.stringify(saved));
  const reopened=new AIAssistant({dataRoot:root,bridge,provider});await reopened.init();
  assert.equal(reopened.config.model,modelConfig.model);assert.deepEqual(reopened.data.analysisProvider,saved.analysisProvider);await reopened.close();
});
