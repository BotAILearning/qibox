import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { authoredMessages, contextualReplyStyle, validatedMonitorMemory } from '../server/ai-context-learning.mjs';
import { readMemory, editMemory } from '../server/ai-wiki.mjs';
import { ChatFixture, AIModelFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('malformed monitored facts consume the failed batch once and never write',async t=>{
  for(const value of [{memoryUpdates:[{text:'事实',newMessageIds:['source']}]},{memoryUpdates:[{text:'事实',evidence:[]}]},{memoryUpdates:[{text:' ',evidence:['source']}]},{memoryUpdates:[null]}])
    assert.throws(()=>validatedMonitorMemory(value),{code:'ai_model_schema'});
  const f=await fixture(t);f.advance(1000);f.push('self','收到');await f.a.tick();const fact=f.push('other','我家猫叫豆包');await f.a.tick();f.advance(21000);
  const learned=f.p.memoryWatch.learned;
  f.provider.complete=async()=>({memoryUpdates:[{text:'对方的猫叫豆包',newMessageIds:[fact.id]}]});
  await f.a.tick();assert.equal(f.p.memoryWatch.learned,fact.id);assert.equal(readMemory(f.a.vault,f.p).entries.length,0);assert.ok(f.p.memoryLearningNotice);
  f.advance(121000);f.provider.complete=async()=>({memoryUpdates:[{text:'对方的猫叫豆包',evidence:[fact.id]}]});
  await f.a.tick();assert.equal(readMemory(f.a.vault,f.p).entries.length,0);assert.equal(f.p.memoryWatch.learned,fact.id);
});

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let now = Date.UTC(2026,9,2,2);
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const c = bridge.contacts[0]; await a.saveReplyProfile({ contact: c.id, style: { summary: '自然简洁' }, strategy, replyEnabled: true });
  const p = a.profiles()[0]; await a.settings({ enabled: true, autoLearning: true }); await a.tick();
  const push = (direction, text) => { const m = bridge.push(c.id, direction, text); m.timestamp = Math.floor(now / 1000); return m; };
  const advance = ms => now += ms;
  return { a, p, c, root, bridge, provider, push, advance };
}

test('current reply uses recent human samples immediately with automatic style updates off and never includes AI or unknown samples', async t => {
  const f = await fixture(t); await f.a.settings({ autoLearning:false }); f.advance(1000);
  const human = f.push('self', '行呀 咱就这么定~');
  const auto = f.push('self', '敬爱的先生您好。'); f.p.generatedIds = [auto.id];
  const ambiguous = f.push('self', '来源不明的相同正文'); f.push('self', ambiguous.text);
  f.p.sentMessages = [{ id: 'intent', at: f.a.now(), source: 'reply', deliveryConfidence: 'unknown', baseline: auto.id, body: f.a.vault.seal({ text: ambiguous.text }) }];
  f.push('other', '接下来呢？'); await f.a.tick(); f.advance(301000); await f.a.tick();
  const call = f.provider.calls.findLast(call => call.input.mode === 'reply');
  assert.deepEqual(call.input.contextualStyle.samples.map(m => m.id), [f.bridge.messages.get(f.c.id)[0].id, human.id]);
  assert.equal(call.input.updateStyle, false); assert.match(call.system, /生成当前这条回复时立即参考/);
  assert.equal(call.input.messages.find(m => m.id === auto.id).authorship, 'ai');
  assert.equal(call.input.messages.find(m => m.id === ambiguous.id).authorship, 'unknown');
});

test('explicit style learning reaches generation as observations while custom requirements and later manual edits stay authoritative', async t => {
  const f=await fixture(t);await f.a.settings({autoLearning:false});
  await f.a.saveReplyProfile({contact:f.c.id,style:{summary:'原口吻',customTone:'保留具体解释',customAvoid:'不要使用亲密称呼'},strategy,replyEnabled:true});
  f.advance(1000);f.push('self','行呀');f.advance(1000);f.push('self','这个我再说具体点');
  await f.a.learn({contacts:[f.c.id],target:'style',scope:'all',perspective:'self'});
  const learned=f.a.profiles().find(p=>p.contact===f.c.id),saved=structuredClone(learned.style);
  assert.equal(saved.customTone,'保留具体解释');assert.equal(saved.customAvoid,'不要使用亲密称呼');
  f.push('other','现在说说这件事');await f.a.tick();f.advance(301000);await f.a.tick();
  const first=f.provider.calls.findLast(c=>c.input.mode==='reply');
  assert.equal(first.input.styleOrigin.summary,'learned-observation');assert.deepEqual(first.input.style,saved);
  assert.match(first.system,/未编辑的学习摘要是观察/);assert.equal(first.input.updateStyle,false);
  assert.equal(f.provider.calls.filter(c=>c.input.mode==='reply').length,1,'the source hint adds no reviewer request');
  await f.a.saveReplyProfile({contact:f.c.id,style:{...saved,summary:saved.summary+'\n用户明确追加：每次详细解释'},strategy,replyEnabled:true});
  f.advance(1000);f.push('other','还有另一件事');await f.a.tick();f.advance(301000);await f.a.tick();f.advance(1000);await f.a.tick();
  assert.equal(f.provider.calls.filter(c=>c.input.mode==='reply').length,2,'saving an already enabled style must not leave the next incoming bound to an aborted controller');
  const edited=f.provider.calls.findLast(c=>c.input.mode==='reply');
  assert.equal(edited.input.styleOrigin.summary,'user-setting');assert.match(edited.input.style.summary,/用户明确追加：每次详细解释/);
  assert.match(edited.system,/本轮用户为当前联系人设置的风格/);
});

test('monitor learns facts during manual takeover wait without sending and deduplicates unchanged polls', async t => {
  const f = await fixture(t); f.advance(1000); const human = f.push('self','好的 记下啦'); await f.a.tick();
  const fact = f.push('other','我住在杭州，搬家已经办完了'); await f.a.tick();
  let calls = 0; const complete = f.provider.complete.bind(f.provider);
  f.provider.complete = async (...args) => args[2].mode === 'memory-monitor' ? (++calls, { memoryUpdates: [{ field: 'residence', text: '对方住在杭州', evidence: [fact.id] }] }) : complete(...args);
  f.advance(21000); await f.a.tick();
  assert.equal(calls,1); assert.equal(f.bridge.sent.length,0); assert.equal(readMemory(f.a.vault,f.p).entries[0].text,'对方住在杭州');
  assert.equal(readMemory(f.a.vault,f.p).entries[0].observedAt,fact.timestamp*1000);
  f.advance(21000); await f.a.tick(); assert.equal(calls,1);
  assert.doesNotMatch(await readFile(f.a.file,'utf8'), /好的 记下啦|搬家已经办完了/);
  assert.equal(f.p.lastManualId,human.id);
});

test('monitor hard-rejects AI, unknown and cross-contact evidence and protects manual memory', async t => {
  const f = await fixture(t); Object.assign(f.p,editMemory(f.a.vault,f.p,{summary:'本人维护的事实'},f.a.now()));
  const original = readMemory(f.a.vault,f.p).entries[0];
  f.advance(1000); f.push('self','知道了'); await f.a.tick();
  const fact = f.push('other','我喜欢喝茶'); const auto = f.push('self','AI编的住址'); f.p.generatedIds = [auto.id]; await f.a.tick();
  f.provider.complete = async () => ({ memoryUpdates: [
    {text:'没有依据',evidence:['another-contact']}, {text:'AI假事实',evidence:[auto.id]},
    {id:original.id,text:'覆盖手动事实',evidence:[fact.id]}, {text:'对方喜欢喝茶',evidence:[fact.id]}
  ] }); f.advance(21000); await f.a.tick();
  assert.equal(readMemory(f.a.vault,f.p).summary,'本人维护的事实\n对方喜欢喝茶');
  assert.equal(readMemory(f.a.vault,f.p,'memorySuggestion').summary,'覆盖手动事实');
});

test('a failed monitor request advances its batch without repeated calls or blocking ordinary replies', async t => {
  const f = await fixture(t); f.advance(1000); f.push('self','收到'); await f.a.tick(); f.push('other','我喜欢茶'); await f.a.tick();
  const complete = f.provider.complete.bind(f.provider); let attempts=0;
  f.provider.complete = async (...args) => { if(args[2].mode==='memory-monitor'){attempts++;throw Error('failure');} return complete(...args); };
  f.advance(21000); await f.a.tick(); assert.equal(attempts,1); assert.ok(f.p.memoryLearningNotice);
  f.advance(30000); await f.a.tick(); assert.equal(attempts,1);
  f.advance(91000); await f.a.tick(); assert.equal(attempts,1);
  f.advance(160000); await f.a.tick(); assert.ok(f.bridge.sent.length); assert.ok(!f.a.retryAt || f.a.retryAt <= f.a.now());
});

test('cancelled or account-switched monitor results never write and monitoring off makes no model request', async t => {
  const f = await fixture(t); f.advance(1000); f.push('self','收到'); await f.a.tick(); const fact=f.push('other','住在杭州'); await f.a.tick(); f.advance(21000);
  f.provider.complete=async()=>{f.a.invalidate();return {memoryUpdates:[{text:'迟到事实',evidence:[fact.id]}]};};
  await f.a.tick(); assert.equal(readMemory(f.a.vault,f.p).entries.length,0);
  await f.a.settings({enabled:false}); f.provider.complete=async()=>{assert.fail('disabled monitor called model');}; await f.a.tick();
});

test('unknown duplicate receipts remain excluded from human style until exact source is confirmed', async t => {
  const f=await fixture(t); const first=f.push('self','相同内容'); const second=f.push('self','相同内容');
  f.p.sentMessages=[{id:'attempt',source:'reply',at:f.a.now(),baseline:f.bridge.messages.get(f.c.id)[0].id,deliveryConfidence:'unknown',body:f.a.vault.seal({text:first.text})}];
  const messages=authoredMessages(f.a.vault,f.p,f.bridge.messages.get(f.c.id));
  assert.ok(messages.filter(m=>[first.id,second.id].includes(m.id)).every(m=>m.authorship==='unknown'));
  assert.ok(contextualReplyStyle(messages).samples.every(m=>![first.id,second.id].includes(m.id)));
});

test('monitor progress survives restart and newly arriving facts during an in-flight request remain pending', async t => {
  const f=await fixture(t); f.advance(1000);f.push('self','收到');await f.a.tick();const old=f.push('other','我喜欢茶');await f.a.tick();f.advance(21000);
  let release; const response=new Promise(resolve=>release=resolve);
  f.provider.complete=async()=>response;
  const task=f.a.learnMonitoredMemory(f.p,await f.a.read(f.p,f.a.controller.signal),f.a.revision,f.a.controller.signal);
  f.advance(1000);const fresh=f.push('other','也喜欢咖啡'); const snapshot=await f.a.read(f.p,f.a.controller.signal);await f.a.observe(f.p,snapshot);
  release({memoryUpdates:[{text:'对方喜欢茶',evidence:[old.id]}]});await task;
  assert.equal(f.p.memoryWatch.seen,fresh.id);assert.equal(f.p.memoryWatch.learned,old.id);assert.ok(f.p.memoryWatch.pendingAt);
  await f.a.save();const disk=JSON.parse(await readFile(f.a.file,'utf8'));assert.equal(disk.profiles[f.p.id].memoryWatch.learned,old.id);
});

test('oversized monitor batches process earliest new evidence and retain the remaining checkpoint',async t=>{
 const f=await fixture(t);f.advance(1000);f.push('self','收到');await f.a.tick();
 f.a.finishMemoryWatch(f.p,await f.a.read(f.p,f.a.controller.signal));
 const added=Array.from({length:90},(_,i)=>f.push('other',`新事实${i}`));await f.a.tick();f.advance(21000);
 const inputs=[];f.provider.complete=async(_config,_system,input)=>{inputs.push(input);return {memoryUpdates:[]};};
 await f.a.tick();assert.equal(inputs.length,1);assert.deepEqual(inputs[0].newMessageIds,added.slice(0,80).map(m=>m.id));
 assert.equal(f.p.memoryWatch.learned,added[79].id);assert.ok(f.p.memoryWatch.pendingAt!==undefined);
 f.advance(120000);await f.a.tick();assert.equal(inputs.length,2);assert.deepEqual(inputs[1].newMessageIds,added.slice(80).map(m=>m.id));
 assert.equal(f.p.memoryWatch.learned,added[89].id);assert.equal(f.p.memoryWatch.pendingAt,undefined);
});
