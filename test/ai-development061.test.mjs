import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { readStableRange, dateRange } from '../server/ai-range.mjs';
import { strategyValue } from '../server/ai-schema.mjs';
import { identityPrompt } from '../server/ai-reply-rules.mjs';
import { ensureAudio } from '../server/audio.mjs';
import { promisesMedia } from '../server/ai-capabilities.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root=await temp(), bridge=new ChatFixture(), provider=new AIModelFixture();let now=1700000000000;bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{}});await a.init();
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.configure(modelConfig);await a.scan();await a.setReplyOptions({contact:bridge.contacts[0].id,enabled:true});await a.settings({enabled:true});await a.tick();
  const p=a.profiles().find(p=>p.contact===bridge.contacts[0].id);
  const push=(direction,text='text',extra={})=>Object.assign(bridge.push(p.contact,direction,text),{timestamp:Math.floor(now/1000),...extra});
  const receive=async(text,result,extra={})=>{push('other',text,extra);await a.tick();now+=3000;if(result)provider.next=async()=>result;await a.tick();};
  return {a,bridge,provider,p,push,receive,advance:ms=>{now+=ms;a.lastScanAt=now;}};
}
test('selected material is read once, keeps the latest contents and still rejects a foreign account', async()=>{
  let reads=0;
  const args={account:'a',contact:'c',from:0,to:100,cursor:['legacy']};
  const calls=[];
  const bridge={readRange:async value=>{calls.push(value);return {account:'a',contact:'c',rangeRevision:String(++reads),messages:[{id:'m',timestamp:2,text:'same'}]};}};
  assert.equal((await readStableRange(bridge,args)).count,1);assert.equal(reads,1);
  assert.equal(Object.hasOwn(calls[0],'cursor'),false);
  // WeChat keeps writing while a long read runs; a changed range is live data,
  // not a failure. The newest read is what the caller asked for.
  bridge.readRange=async()=>({account:'a',contact:'c',messages:[{id:'m',timestamp:2,text:'changed'}]});
  assert.equal((await readStableRange(bridge,args)).count,1);
  bridge.readRange=async()=>({account:'b',contact:'c',messages:[]});await assert.rejects(readStableRange(bridge,args),/归属/);
  assert.equal(dateRange({}).from,0);assert.throws(()=>dateRange({from:'2026-02-30',to:'2026-03-02'}));
});
test('range material is returned once, supports the raised bound, and rejects malformed order', async()=>{
  const args={account:'a',contact:'c',from:0,to:40000};
  const messages = count => Array.from({length:count},(_,i)=>({id:`m-${i}`,timestamp:i,text:'x'}));
  let result=await readStableRange({readRange:async()=>({account:'a',contact:'c',messages:messages(301),truncated:false})},args);
  assert.equal(result.count,301);assert.equal(result.messages.length,301);assert.equal(result.truncated,false);
  result=await readStableRange({readRange:async()=>({account:'a',contact:'c',messages:messages(30000),truncated:true})},args);
  assert.equal(result.count,30000);assert.equal(result.truncated,true);
  await assert.rejects(readStableRange({readRange:async()=>({account:'a',contact:'c',messages:[{id:'a',timestamp:1},{id:'a',timestamp:2}]})},args),/顺序完整性/);
  await assert.rejects(readStableRange({readRange:async()=>({account:'a',contact:'c',messages:[{id:'a',timestamp:2},{id:'b',timestamp:1}]})},args),/顺序完整性/);
  await assert.rejects(readStableRange({readRange:async()=>({account:'a',contact:'c',messages:[{id:'a',timestamp:40000}]})},args),/顺序完整性/);
});
test('manual reply waits; repeated model skip reports an error without pausing the contact',async t=>{
  const f=await fixture(t);
  f.push('self','我手动回一句');await f.a.tick();f.advance(3000);
  assert.equal(f.p.paused,false);assert.equal(f.p.pauseReason,undefined);
  let calls=0;f.provider.complete=async()=>{calls++;return {action:'skip'};};
  await f.receive('发个文件给我',{action:'skip'});
  f.advance(297000);await f.a.tick();
  assert.equal(calls,2);assert.equal(f.p.paused,false);assert.equal(f.a.publicState().skipRecords.length,0);
  assert.ok(f.a.publicState().events.some(e=>e.code==='error'));
  f.push('self','文件我发了');await f.a.tick();
  assert.equal(f.bridge.sent.length,0);
});
test('identity setting only allows AI disclosure in response to an identity question',async t=>{
  const f=await fixture(t);assert.match(identityPrompt(false),/表示是本人/);
  await f.a.settings({acknowledgeAI:true});await f.receive('你是AI吗',{action:'send',text:'我是AI，代为回复。'});assert.equal(f.bridge.sent.length,1);
  await f.receive('今天天气怎么样',{action:'send',text:'我是AI。'});assert.equal(f.bridge.sent.length,1);
  await f.a.settings({acknowledgeAI:false});await f.receive('你是AI吗',{action:'send',text:'我是AI。'});assert.equal(f.bridge.sent.length,1);
});
test('repeated model skip has no review flow; later incoming messages remain eligible',async t=>{
  const f=await fixture(t);const complete=f.provider.complete.bind(f.provider);let calls=0;f.provider.complete=async()=>{calls++;return {action:'skip'};};await f.receive('给我发文件',{action:'skip'});assert.equal(f.p.paused,false);assert.equal(f.bridge.sent.length,0);
  assert.equal(calls,2);assert.equal(f.a.publicState().skipRecords.length,0);assert.ok(f.a.publicState().events.some(e=>e.code==='error'));
  f.provider.complete = complete;
  await f.receive('算了，今晚聊什么',{action:'send',text:'聊聊最近看的书吧。'});assert.equal(f.bridge.sent.length,1);
});
test('missing image is skipped even with judgment off; available image reaches only current chat model',async t=>{
  const f=await fixture(t);await f.a.setReplyOptions({contact:f.p.contact,judgeReply:false});
  await f.receive('[图片]',null,{type:'image'});assert.equal(f.bridge.sent.length,0);assert.equal(f.p.paused,false);
  // Reply resets the pending conversation, allowing this new picture to stand alone.
  f.bridge.push(f.p.contact,'self','人工说明'); f.p.generatedIds=[f.bridge.messages.get(f.p.contact).at(-1).id];await f.a.tick();
  f.bridge.readImage=async args=>({messageId:args.messageId,mime:'image/png',data:'AAAA'});
  await f.receive('[图片]',{action:'send',text:'看起来不错。'},{type:'image'});
  assert.equal(f.provider.calls.at(-1).input.images.length,1);assert.equal(f.bridge.sent.length,1);
});
for(const protocol of ['openai','anthropic'])test(`${protocol} serializes images and skips unsupported image-only input without guessing`,async()=>{
  const bodies=[];const provider=new AIProvider({fetcher:async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response('{}',{status:400});}});
  const result=await provider.complete({...modelConfig,protocol},'system',{onlyImages:true,images:[{messageId:'m',mime:'image/png',data:'AAAA'}]});
  assert.deepEqual(result,{action:'skip',mediaSkipped:true});assert.equal(bodies.length,1);
  const content=bodies[0].messages.at(-1).content;assert.equal(content[2].type,protocol==='openai'?'image_url':'image');assert.doesNotMatch(content[0].text,/AAAA/);
});
test('image rejection falls back to text once; auth failures do not retry or expose provider detail',async()=>{
  let calls=0;const provider=new AIProvider({fetcher:async()=>++calls===1?new Response('{}',{status:415}):Response.json({choices:[{message:{content:'{"action":"send","text":"好。"}'}}]})});
  assert.equal((await provider.complete(modelConfig,'s',{messages:[{text:'hello'}],images:[{mime:'image/png',data:'AAAA'}]})).text,'好。');assert.equal(calls,2);
  provider.fetcher=async()=>{calls++;return new Response('secret',{status:401});};await assert.rejects(provider.complete(modelConfig,'s',{images:[{mime:'image/png',data:'AAAA'}]}),/认证失败/);assert.equal(calls,3);
});
test('audio recovery shares one restart and never restarts a stopped instance',async()=>{
  const runtime={status:'running',audioEnv:{HOME:'instance'}};let starts=0;const done=Promise.withResolvers();
  const start=async()=>{starts++;await done.promise;runtime.audioSocket='pcm';runtime.audioProcess={exitCode:null,signalCode:null};};
  const one=ensureAudio(runtime,start),two=ensureAudio(runtime,start);assert.equal(starts,1);done.resolve();await Promise.all([one,two]);
  await ensureAudio(runtime,start);assert.equal(starts,1);runtime.status='stopped';await assert.rejects(ensureAudio(runtime,start));assert.equal(starts,1);
});
test('reply limit defaults to 50, permits 1000, preserves existing values and rejects overflow',()=>{
  assert.equal(strategyValue({}).maxRounds,50);assert.equal(strategyValue({maxRounds:1000}).maxRounds,1000);assert.equal(strategyValue({maxRounds:7}).maxRounds,7);assert.throws(()=>strategyValue({maxRounds:1001}));
});
test('media send promises are held while truthful text alternatives remain available',()=>{
  assert.equal(promisesMedia('我马上发照片给你。'),true);assert.equal(promisesMedia('图片已经发给你了。'),true);
  assert.equal(promisesMedia('我不能发图片，不过可以文字说明。'),false);assert.equal(promisesMedia('照片拍得很好。'),false);
});
test('canceling an operation preserves the master choice',async t=>{const {a}=await fixture(t);await a.cancel();assert.equal(a.data.settings.enabled,true);});
test('preview learning preserves active style until explicit application and keeps other contacts unchanged',async t=>{
  const {a,bridge}=await fixture(t), contact=bridge.contacts[0].id;
  const before=structuredClone(a.profiles().find(p=>p.contact===contact).style);
  await a.learn({contacts:bridge.contacts.slice(0,2).map(c=>c.id),previewOnly:true});
  const p=a.profiles().find(p=>p.contact===contact), other=a.profiles().find(p=>p.contact===bridge.contacts[1].id);
  assert.deepEqual(p.style,before);assert.ok(p.pendingStyle);const untouched=JSON.stringify(other);
  await a.saveReplyProfile({contact,style:p.pendingStyle,styleId:'learned',preserveSwitches:true,strategy:p.replyStrategy||a.data.replyStrategy});
  assert.ok(!p.pendingStyle);assert.equal(JSON.stringify(other),untouched);assert.equal(a.data.settings.enabled,true);
});
test('multi-segment reply cannot exceed remaining confirmed-message allowance',async t=>{
  const f=await fixture(t);await f.a.setReplyOptions({contact:f.p.contact,multiTurn:true});await f.a.saveStrategy({maxRounds:2},undefined,'reply');
  await f.receive('详细说说',{action:'send',segments:['第一条。','第二条。','第三条。']});
  assert.equal(f.bridge.sent.length,2);assert.equal(f.p.rounds,2);
  await f.receive('还有呢');assert.equal(f.bridge.sent.length,2);assert.equal(f.p.pauseReason,'limit');
});
