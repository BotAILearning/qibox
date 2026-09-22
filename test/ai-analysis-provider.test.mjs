import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
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

test('chat and analysis share one encrypted model; changing it pauses the queue and cancels old work', async t => {
  const {root,a,provider,request}=await fixture(t), revision=a.revision;
  a.data.queue.status='running';
  await a.verifyProvider(analysisConfig,'analysis');
  assert.equal(a.config.model,analysisConfig.model);assert.equal(a.data.queue.status,'paused');assert.ok(a.revision>revision);
  assert.equal(a.publicState().analysis.mode,'shared');assert.deepEqual(a.publicState().provider,a.publicState().analysis.effectiveProvider);
  provider.complete=async c=>{assert.equal(c.apiKey,analysisConfig.apiKey);return {report:'报告'};};
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
