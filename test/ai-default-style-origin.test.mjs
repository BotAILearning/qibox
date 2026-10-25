import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const dataRoot=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();
  let clock=Date.parse('2026-10-25T20:00:00+08:00');
  const a=new AIAssistant({dataRoot,bridge,provider,now:()=>clock,random:min=>min,delay:async ms=>{clock+=ms;}});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);
  t.after(async()=>{await a.close();await cleanup(dataRoot);});
  await a.configure(modelConfig);await a.scan();
  await a.settings({enabled:true,replyScope:'all',autoLearning:false,segmentReplies:false,followUpEnabled:false});
  await a.tick();const contact=bridge.contacts[0].id;
  return {a,bridge,provider,contact,dataRoot,async reply(){clock+=1000;bridge.push(contact,'other','把几笔支出摆一起看，折扣就没单看时那么明显了。').timestamp=Math.floor(clock/1000);await a.tick();clock+=301000;await a.tick();const calls=provider.calls.filter(x=>x.input.mode==='reply');assert.equal(calls.length,1);return calls[0];}};
}

test('manual account default is an explicit expression requirement without becoming contact-specific evidence', async t=>{
  const f=await fixture(t),summary='保留本人手动口吻：简短接话，不逐项复述，不主动给建议。';
  await f.a.saveDefaultStyle({summary});const before=structuredClone(f.a.activeDefaultStyle());
  const call=await f.reply();
  assert.equal(call.input.style.summary,summary);
  assert.equal(call.input.styleOrigin.summary,'user-setting');
  assert.equal(call.input.addressing.styleScope,'reference','Global style must not import another contact name or personal facts');
  assert.match(call.system,/明确保存的默认/);
  assert.doesNotMatch(call.system,/这是账号默认风格，来自其他联系人或粘贴资料/);
  assert.deepEqual(f.a.activeDefaultStyle(),before,'Generating must not rewrite saved user settings');
});

for(const method of ['saveDefaultStyle','commitDefaultStyle'])test(`${method} records an actual edit of learned default but does not promote an unchanged learning result`,async t=>{
  const f=await fixture(t);
  await f.a.learn({contacts:[f.contact],asDefault:true});
  const candidate=structuredClone(f.a.data.learnedDefaultStyle);
  assert.equal(candidate.summaryOrigin,'learned-observation');
  await f.a[method]({summary:candidate.style.summary});
  assert.equal(f.a.activeDefaultStyle().summaryOrigin,'learned-observation','Accepting an unchanged observation must not turn it into mandatory tasks');
  await f.a[method]({summary:candidate.style.summary+'\n本人明确补充：不逐项复述。'});
  assert.equal(f.a.activeDefaultStyle().summaryOrigin,'user-setting');
  assert.equal(f.a.activeDefaultStyle().source,candidate.source,'Retain original learning provenance');
  f.provider.calls.length=0;const call=await f.reply();
  assert.equal(call.input.styleOrigin.summary,'user-setting');
  assert.equal(call.input.addressing.styleScope,'reference');
});

test('old manual defaults need no migration or bulk inference to retain their explicit priority',async t=>{
  const f=await fixture(t);await f.a.saveDefaultStyle({summary:'旧版手写默认摘要'});
  delete f.a.data.learnedDefaultStyle.summaryOrigin;delete f.a.data.learnedDefaultStyle.summaryOriginHash;await f.a.save();
  const before=structuredClone(f.a.activeDefaultStyle());const call=await f.reply();
  assert.equal(call.input.styleOrigin.summary,'user-setting');
  assert.deepEqual(f.a.activeDefaultStyle(),before);
});

test('an accepted unedited learned default stays an observation on the actual reply path',async t=>{
  const f=await fixture(t);await f.a.learn({contacts:[f.contact],asDefault:true});await f.a.applyDefaultStyle();
  const before=structuredClone(f.a.activeDefaultStyle());f.provider.calls.length=0;
  const call=await f.reply();assert.equal(call.input.styleOrigin.summary,'learned-observation');
  assert.equal(call.input.addressing.styleScope,'reference');assert.match(call.system,/不是每轮必须完成的沟通任务/);
  assert.deepEqual(f.a.activeDefaultStyle(),before);
});

test('unmarked legacy learning is not bulk reclassified, while a new explicit edit records its priority',async t=>{
  const f=await fixture(t);await f.a.learn({contacts:[f.contact],asDefault:true});
  delete f.a.data.learnedDefaultStyle.summaryOrigin;delete f.a.data.learnedDefaultStyle.summaryOriginHash;await f.a.applyDefaultStyle();
  const before=structuredClone(f.a.activeDefaultStyle());f.provider.calls.length=0;
  const legacy=await f.reply();assert.equal(legacy.input.styleOrigin.summary,'reference-style');
  assert.deepEqual(f.a.activeDefaultStyle(),before,'No new provenance is guessed or stored for old records');
  await f.a.saveDefaultStyle({summary:before.style.summary+'\n我明确要求：直接接话，不逐项总结。'});
  f.provider.calls.length=0;const edited=await f.reply();assert.equal(edited.input.styleOrigin.summary,'user-setting');
  assert.equal(edited.input.addressing.styleScope,'reference');
});

test('an older-version summary edit cannot retain stale learned authority after upgrading',async t=>{
  const f=await fixture(t);await f.a.learn({contacts:[f.contact],asDefault:true});await f.a.applyDefaultStyle();
  assert.match(f.a.activeDefaultStyle().summaryOriginHash,/^[a-f0-9]{64}$/);
  // The previous server saved summary while retaining the enclosing object.
  f.a.data.learnedDefaultStyle.style.summary+='\n本人明确要求：不逐项复述。';await f.a.save();
  const before=structuredClone(f.a.activeDefaultStyle());f.provider.calls.length=0;
  const call=await f.reply();assert.equal(call.input.styleOrigin.summary,'user-setting');
  assert.equal(call.input.style.summary,before.style.summary);assert.equal(call.input.addressing.styleScope,'reference');
  assert.deepEqual(f.a.activeDefaultStyle(),before,'Reading a changed binding must not bulk rewrite history');
});
