import test from 'node:test';import assert from 'node:assert/strict';
import {AIProvider,MODEL_RETRY_LIMIT} from '../server/ai-provider.mjs';
import {requestTrace} from '../server/ai-request-trace.mjs';import {modelConfig} from './ai-fixtures.mjs';
const reply=(usage={input_tokens:3,output_tokens:0})=>Response.json({content:[{type:'text',text:'{"ok":true}'}],usage});
const config={...modelConfig,protocol:'anthropic'};
function capture(t){const rows=[];t.mock.method(console,'info',(...args)=>{if(args[0]==='[ai-request-trace]')rows.push(JSON.parse(args[1]));});return rows;}
const run=provider=>provider.complete(config,'PRIVATE_SYSTEM_NOT_LOGGED',{test:true,body:'PRIVATE_CHAT_NOT_LOGGED'},undefined,{retry:false});

test('success records one existing fetch, correlates usage including zero, and never exposes private input/config',async t=>{
 const rows=capture(t);let calls=0;const p=new AIProvider({fetcher:async()=>{calls++;return reply();}});assert.deepEqual(await run(p),{ok:true});assert.equal(calls,1);
 assert.deepEqual(rows.map(x=>x.event),['dispatch','response','end']);assert.equal(new Set(rows.map(x=>x.requestId)).size,1);assert(rows.every(x=>x.attempt===1&&x.bestEffort));assert.equal(rows[2].outcome,'response-known');assert.equal(rows[2].status,200);assert.deepEqual(rows[2].usage,{inputTokens:3,outputTokens:0,cachedInputTokens:null,cacheWriteTokens:null});
 const text=JSON.stringify(rows);for(const secret of ['PRIVATE_SYSTEM_NOT_LOGGED','PRIVATE_CHAT_NOT_LOGGED',config.apiKey,config.baseUrl,config.model])assert(!text.includes(secret));
});

test('status retries keep the existing limit and one logical id while every actual response remains countable',async t=>{
 const rows=capture(t);let calls=0;const p=new AIProvider({fetcher:async()=>{calls++;return new Response('upstream private failure',{status:500});}});p.backoff=async()=>{};
 await assert.rejects(p.complete(config,'test',{test:true}),e=>e.code==='ai_model_retry');assert.equal(calls,MODEL_RETRY_LIMIT+1);assert.equal(rows.filter(x=>x.event==='dispatch').length,calls);assert.equal(rows.filter(x=>x.event==='response').length,calls);assert.equal(new Set(rows.map(x=>x.requestId)).size,1);
 assert.deepEqual(rows.filter(x=>x.event==='end').map(x=>[x.attempt,x.outcome,x.status,x.usage]),[[1,'response-known',500,null],[2,'response-known',500,null],[3,'response-known',500,null]]);assert(!JSON.stringify(rows).includes('upstream private failure'));
});

test('a transport timeout is an unconfirmed response rather than definite zero usage or failed dispatch',async t=>{
 const rows=capture(t);let calls=0;const p=new AIProvider({fetcher:async()=>{calls++;throw new DOMException('PRIVATE_TIMEOUT_CONTEXT','TimeoutError');}});
 await assert.rejects(run(p),e=>e.code==='ai_model_timeout');assert.equal(calls,1);assert.deepEqual(rows.map(x=>x.event),['dispatch','end']);assert.equal(rows[1].outcome,'response-unknown');assert.equal(rows[1].status,null);assert.equal(rows[1].usage,null);assert.equal(rows[1].failure,'timeout');assert(!JSON.stringify(rows).includes('PRIVATE_TIMEOUT_CONTEXT'));
});

test('cancelled in-flight fetch is recorded once without retry or leaked signal reason',async t=>{
 const rows=capture(t),controller=new AbortController();let started,calls=0;const ready=new Promise(r=>started=r);const p=new AIProvider({fetcher:async(_url,{signal})=>{calls++;started();return await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 const result=p.complete(config,'test',{test:true},controller.signal);await ready;controller.abort(new Error('PRIVATE_CANCEL_REASON'));await assert.rejects(result,e=>e.status===409);assert.equal(calls,1);const end=rows.find(x=>x.event==='end');assert(end&&end.outcome==='response-unknown'&&end.failure==='cancelled');assert(!JSON.stringify(rows).includes('PRIVATE_CANCEL_REASON'));
});

test('invalid body retains known response and unknown usage without additional requests when retry is off',async t=>{
 const rows=capture(t);let calls=0;const p=new AIProvider({fetcher:async()=>{calls++;return new Response('PRIVATE_INVALID_BODY',{status:200});}});await assert.rejects(run(p),e=>e.code==='ai_model_response');assert.equal(calls,1);const end=rows.find(x=>x.event==='end');assert.equal(end.outcome,'response-known');assert.equal(end.status,200);assert.equal(end.usage,null);assert(!JSON.stringify(rows).includes('PRIVATE_INVALID_BODY'));
});

test('concurrent calls retain distinct logical ids even when their responses finish in reverse order',async t=>{
 const rows=capture(t),pending=[];const p=new AIProvider({fetcher:async()=>await new Promise(r=>pending.push(r))});const a=run(p),b=run(p);while(pending.length<2)await new Promise(r=>setImmediate(r));pending[1](reply({input_tokens:22,output_tokens:2}));await b;pending[0](reply({input_tokens:11,output_tokens:1}));await a;
 const starts=rows.filter(x=>x.event==='dispatch');assert.equal(starts.length,2);assert.notEqual(starts[0].requestId,starts[1].requestId);const ends=rows.filter(x=>x.event==='end');assert.equal(ends.length,2);assert.equal(ends[0].requestId,starts[1].requestId);assert.equal(ends[0].usage.inputTokens,22);assert.equal(ends[1].requestId,starts[0].requestId);assert.equal(ends[1].usage.inputTokens,11);
});

test('local/no-dispatch outcomes, malformed usage and failing observer do not become model traffic',()=>{
 const rows=[],create=requestTrace({mode:'PRIVATE_ARBITRARY_MODE',emit:x=>rows.push(x),now:()=>0}),local=create(1);local.failed(new Error('PRIVATE_REASON'));local.end();local.end();assert.equal(rows.length,1);assert.equal(rows[0].kind,'generation');assert.equal(rows[0].outcome,'not-dispatched');assert.equal(rows[0].elapsedMs,null);
 const attempt=create(2);attempt.dispatch();attempt.response(200);attempt.usage({input_tokens:-1,output_tokens:'10',cache_read_input_tokens:0});attempt.end();assert.deepEqual(rows.at(-1).usage,{inputTokens:null,outputTokens:null,cachedInputTokens:0,cacheWriteTokens:null});
 const silent=requestTrace({emit(){throw Error('ObserverUnavailable');}})(1);assert.doesNotThrow(()=>{silent.dispatch();silent.response(200);silent.usage({});silent.end();});assert(!JSON.stringify(rows).includes('PRIVATE_'));
});
