import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider} from '../server/ai-provider.mjs';
import {AIAssistant} from '../server/ai-service.mjs';
import {AppError} from '../server/files.mjs';
import {AIModelFixture,ChatFixture,modelConfig,key} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {startModelRequest,closeModelRequest} from '../server/ai-model-request-journal.mjs';
import {replyFlowMarkup} from '../web/ai-reply-flow-view.mjs';

for(const name of ['TimeoutError','AbortError','TypeError'])test(`unknown ${name} stops before a second automatic provider fetch`,async t=>{
 t.mock.method(console,'info',()=>{});let calls=0;
 const provider=new AIProvider({fetcher:async()=>{calls++;throw name==='TypeError'?new TypeError('connection lost after dispatch'):new DOMException('outcome unknown',name);}});provider.backoff=async()=>{};
 let failure;try{await provider.complete(modelConfig,'only JSON',{test:true});}catch(e){failure=e;}
 t.diagnostic(`simulatedFetches=${calls};actualHTTP=0;errorCode=${failure?.code}`);
 assert.equal(calls,1,'No automatic replay when upstream may already have processed the request');
 assert.equal(failure?.code,'ai_model_result_unknown');
});

test('deadline during a known HTTP body does not retry a request with unknown completion/usage',async t=>{
 t.mock.method(console,'info',()=>{});const deadline=new AbortController();t.mock.method(AbortSignal,'timeout',()=>deadline.signal);let calls=0;
 const provider=new AIProvider({fetcher:async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"choices":'));setImmediate(()=>{deadline.abort(new DOMException('deadline','TimeoutError'));controller.close();});}}),{status:200});}});provider.backoff=async()=>{};
 await assert.rejects(provider.complete(modelConfig,'only JSON',{test:true}),e=>e.code==='ai_model_result_unknown');assert.equal(calls,1);
});

async function fixture(t,{group=false}={}){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();bridge.stableMessageIds=true;let now=Date.parse('2026-10-26T08:00:00+08:00'),a;
 if(group)bridge.contacts[0].kind='group';
 const create=async()=>{a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{},random:min=>min});await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);};
 await create();await a.configure(modelConfig);await a.scan();for(const c of bridge.contacts.slice(0,2))if(c.kind==='group')await a.setGroupOptions({contact:c.id,atMe:true});else await a.setReplyOptions({contact:c.id,enabled:true,judgeReply:false});await a.settings({enabled:true,autoLearning:false,segmentReplies:false});await a.tick();
 t.after(async()=>{await a.close();await cleanup(root);});t.mock.method(console,'error',()=>{});
 return{bridge,provider,get a(){return a;},get p(){return a.profiles().find(p=>p.contact===bridge.contacts[0].id);},advance:ms=>now+=ms,
  async incoming(contact,text){const m=bridge.push(contact,'other',text);m.timestamp=Math.floor(now/1000);if(bridge.contacts.find(x=>x.id===contact).kind==='group')Object.assign(m,{sender:key('group-member'),mentions:{verified:true,self:true,all:false,others:false}});await a.tick();return m;},async restart(){await a.close();await create();}};
}

test('unknown generation survives restart without background replay; another contact and a new incoming still work',async t=>{
 const f=await fixture(t),contact=f.bridge.contacts[0].id,other=f.bridge.contacts[1].id;
 const first=await f.incoming(contact,'合成长来信，交谈中普通分享，不是让程序重复生成。');f.provider.next=async()=>{throw new AppError('请求结果未知',504,'ai_model_result_unknown');};f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,0);
 f.advance(3600000);await f.a.tick();assert.equal(f.provider.calls.length,1,'One hour passing cannot silently regenerate the same incoming');
 await f.restart();await f.a.scan();await f.a.tick();assert.equal(f.provider.calls.length,1,'Restart cannot clear unresolved request outcome');assert.equal(f.p.modelRequestUnknown.incomingId,first.id);
 await f.incoming(other,'另一位联系人正常来信。');f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,2);assert.equal(f.bridge.sent[0].contact,other);
 await f.incoming(contact,'这是一条新的补充消息，沿新的交流继续。');f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,3);assert.equal(f.bridge.sent.at(-1).contact,contact);assert.equal(f.p.modelRequestUnknown,undefined);
});

test('existing explicit retry resumes only the selected unresolved object and does not mark the unknown call as sent',async t=>{
 const f=await fixture(t),contact=f.bridge.contacts[0].id;await f.incoming(contact,'合成来信');f.provider.next=async()=>{throw new AppError('结果未知',504,'ai_model_result_unknown');};f.advance(20000);await f.a.tick();
 const row=f.a.liveStates().find(x=>x.id===f.p.id);assert(row?.modelResultUnknown&&row.canRetry);assert.equal(f.bridge.sent.length,0);
 const html=replyFlowMarkup(f.p,row,{allowSkip:true});assert(html.includes('模型结果未知')&&html.includes('上游仍可能计费')&&html.includes('重新请求模型'));assert(!html.includes('已发送'));
 await f.a.skipReplyWait(f.p.id);for(let n=0;n<30&&f.provider.calls.length<2;n++)await new Promise(r=>setImmediate(r));if(f.a.ticking)await f.a.tickFinished.promise;await Promise.all([...f.a.activeRuns.values()]);
 assert.equal(f.provider.calls.length,2);assert.equal(f.bridge.sent.length,1);assert.equal(f.p.modelRequestUnknown,undefined);
 const failures=f.a.data.events.filter(x=>x.code==='error');assert(failures.length>0,'The original unknown error remains in history after a new explicit attempt');
 assert(f.a.data.errorLog.some(x=>x.context?.errorCode==='ai_model_result_unknown'),'The independent error ledger retains the original unknown outcome');
});

test('in-flight request intent is durable before dispatch and interrupted restart cannot replay it',async t=>{
 const f=await fixture(t),contact=f.bridge.contacts[0].id;await f.incoming(contact,'合成来信，进程中断验证。');let entered;
 const ready=new Promise(resolve=>entered=resolve);
 f.provider.next=async(_input,signal)=>{entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 f.advance(20000);const running=f.a.tick();await ready;
 const saved=JSON.parse(await readFile(path.join(path.dirname(f.a.file),'ai-model-requests',f.p.id+'.json'),'utf8'));assert.equal(saved.state,'requesting');assert.equal(f.provider.calls.length,1);
 await f.restart();await running;await f.a.scan();f.advance(3600000);await f.a.tick();assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,0);assert(f.a.liveStates().some(x=>x.modelResultUnknown));
});

test('failure to persist a request intent stops before any model call',async t=>{
 const f=await fixture(t),contact=f.bridge.contacts[0].id;await f.incoming(contact,'合成来信，写入失败验证。');const blocked=path.join(path.dirname(f.a.file),'ai-model-requests');await writeFile(blocked,'fixture blocks directory creation');
 f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);assert.equal(f.p.modelRequestUnknown,undefined);
 await rm(blocked);f.advance(30001);await f.a.tick();assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,1);
});

test('an unrelated state save cannot close a returned request before its reply is durably prepared or handled',async t=>{
 const f=await fixture(t),contact=f.bridge.contacts[0].id,incoming=await f.incoming(contact,'合成来信，提交窗口验证。');
 const snapshot=await f.bridge.read({contact});await startModelRequest(f.a,f.p,incoming,snapshot.revision);closeModelRequest(f.p);await f.a.save();
 const journal=path.join(path.dirname(f.a.file),'ai-model-requests',f.p.id+'.json');assert((await readFile(journal,'utf8')).includes(incoming.id));
 await f.restart();await f.a.scan();f.advance(3600000);await f.a.tick();assert.equal(f.provider.calls.length,0);assert(f.p.modelRequestUnknown);
});

test('group unknown intent survives restart while a new verified mention opens a new task',async t=>{
 const f=await fixture(t,{group:true}),contact=f.bridge.contacts[0].id;await f.incoming(contact,'群成员已验证提及本人的合成来信');f.provider.next=async()=>{throw new AppError('结果未知',504,'ai_model_result_unknown');};f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,1);
 await f.restart();await f.a.scan();f.advance(3600000);await f.a.tick();assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,0);
 await f.incoming(contact,'新的已验证提及，继续当前交流');f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,2);assert.equal(f.bridge.sent.length,1);
});

test('corrupt intent is preserved and isolates only its object without silently regenerating',async t=>{
 const f=await fixture(t),contact=f.bridge.contacts[0].id;await f.incoming(contact,'请求记录损坏的合成来信');const dir=path.join(path.dirname(f.a.file),'ai-model-requests');await mkdir(dir,{recursive:true});const file=path.join(dir,f.p.id+'.json');await writeFile(file,'broken journal');
 await f.restart();await f.a.scan();f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,0);assert.equal(f.p.modelRequestUnknown.state,'unreadable');await assert.rejects(f.a.skipReplyWait(f.p.id),e=>e.code==='ai_request_journal_corrupt');assert.equal(await readFile(file,'utf8'),'broken journal');
 await f.incoming(f.bridge.contacts[1].id,'其他对象仍正常');f.advance(20000);await f.a.tick();assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent[0].contact,f.bridge.contacts[1].id);
});

test('failed explicit-retry save retains the unresolved marker and dispatches nothing',async t=>{
 const f=await fixture(t),contact=f.bridge.contacts[0].id;await f.incoming(contact,'合成来信');f.provider.next=async()=>{throw new AppError('结果未知',504,'ai_model_result_unknown');};f.advance(20000);await f.a.tick();
 const before=structuredClone(f.p.modelRequestUnknown);f.a.storageError=new Error('fixture write blocked');
 try{await assert.rejects(f.a.skipReplyWait(f.p.id),/fixture write blocked/);assert.deepEqual(f.p.modelRequestUnknown,before);assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,0);}finally{f.a.storageError=null;}
});
