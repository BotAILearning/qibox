import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { replyFlowMarkup } from '../web/ai-reply-flow-view.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(); let now = Date.parse('2026-10-09T14:00:00+08:00');
  const a = new AIAssistant({dataRoot:root,bridge,now:()=>now}); await a.init(); clearInterval(a.timer); clearInterval(a.warmupTimer);
  await a.configure(modelConfig); await a.scan(); await a.setReplyOptions({contact:bridge.contacts[0].id,enabled:true});
  const p = a.profiles()[0], baseline = bridge.push(p.contact,'other','待回复的问题'); baseline.timestamp = Math.floor(now / 1000);
  p.delivery = {operationId:'receipt-check-operation',status:'unknown',at:now,baseline:baseline.id,segmentsSent:0,segmentsTotal:1,source:'reply'};
  p.replyFlow = {phase:'confirming',startedAt:now,detail:'发送结果待核实，不会重复发送'};
  p.sentMessages = [{id:p.delivery.operationId,operationId:p.delivery.operationId,at:now,baseline:baseline.id,source:'reply',body:a.vault.seal({text:'收到'}),confirmed:false,deliveryConfidence:'unknown'}];
  let sends=0;bridge.send=async()=>{sends++;throw new Error('Receipt check must never dispatch');};
  t.after(async()=>{await a.close();await cleanup(root);});
  return {a,p,bridge,baseline,advance:ms=>now+=ms,sends:()=>sends};
}

test('unchanged chat and disabled AI still poll a delayed receipt and count it once',async t=>{
  const {a,p,bridge,advance,sends}=await fixture(t); advance(12000);
  const receipt=bridge.push(p.contact,'self','收到');receipt.timestamp=Math.floor(a.now()/1000);
  assert.equal(a.data.settings.enabled,false);await a.tick();await a.tick();
  assert.equal(p.delivery.status,'sent');assert.equal(p.rounds,1);assert.equal(p.replyFlow.phase,'sent');assert.equal(sends(),0);
});

test('a bounded historical range repairs a receipt absent from the latest snapshot',async t=>{
  const {a,p,bridge,baseline,advance,sends}=await fixture(t);advance(4*86400000);
  const receipt={id:key('old-delayed-receipt'),direction:'self',text:'收到',timestamp:Math.floor(p.delivery.at/1000)+1};
  bridge.read=async()=>({account:a.data.account,contact:p.contact,revision:key('newer-history'),messages:[]});
  bridge.readRange=async args=>{assert.ok(args.to-args.from<=362);return {account:args.account,contact:args.contact,messages:[baseline,receipt],truncated:false};};
  await a.checkDeliveryReceipts();assert.equal(p.delivery.status,'sent');assert.equal(p.rounds,1);assert.equal(sends(),0);
});

test('no unique receipt has a final honest conclusion, survives restart, and never resends',async t=>{
  const {a,p,advance,sends}=await fixture(t);advance(181000);await a.checkDeliveryReceipts();
  assert.equal(p.delivery.status,'unconfirmed');assert.equal(p.rounds,0);assert.equal(p.replyFlow.phase,'unconfirmed');
  assert.match(p.replyFlow.detail,/已结束核验.*不会自动重发/);assert.equal(p.sentMessages[0].deliveryConfidence,'unknown');
  assert.equal(a.liveStates().find(row=>row.id===p.id),undefined);
  assert.equal(replyFlowMarkup(p,undefined,{allowSkip:true}),'');
  await a.checkDeliveryReceipts();assert.equal(sends(),0);
  p.handledIncomingId = p.delivery.baseline;
  await a.settings({ enabled: true }); await a.tick(); await a.tick(); assert.equal(sends(), 0);
  const b=new AIAssistant({dataRoot:a.vault.file.replace(/[/\\]ai-secret\.key$/,''),bridge:a.bridge});await b.init();
  try{assert.equal(b.profiles()[0].delivery.status,'unconfirmed');assert.equal(b.profiles()[0].rounds,0);}finally{await b.close();}
});

test('a later authenticated receipt can correct a concluded attempt without a resend',async t=>{
  const {a,p,baseline,advance,sends}=await fixture(t);advance(181000);await a.checkDeliveryReceipts();
  const receipt={id:key('after-conclusion'),direction:'self',text:'收到',timestamp:Math.floor(p.delivery.at/1000)+1};
  a.reconcileUnknownReplies(p,{messages:[baseline,receipt]});a.reconcileUnknownReplies(p,{messages:[baseline,receipt]});
  assert.equal(p.delivery.status,'sent');assert.equal(p.rounds,1);assert.equal(p.replyFlow.phase,'sent');assert.equal(sends(),0);
});

test('wrong account range, duplicate text and unreadable encrypted intent cannot fabricate success',async t=>{
  const {a,p,bridge,baseline,advance}=await fixture(t);advance(181000);
  bridge.read=async()=>({account:a.data.account,contact:p.contact,revision:key('empty'),messages:[]});
  bridge.readRange=async()=>({account:key('wrong-account'),contact:p.contact,messages:[baseline,{id:key('untrusted'),direction:'self',text:'收到',timestamp:Math.floor(p.delivery.at/1000)+1}]});
  await a.checkDeliveryReceipts();assert.equal(p.delivery.status,'unconfirmed');assert.equal(p.rounds,0);
  a.reconcileUnknownReplies(p,{messages:[baseline,...[1,2].map(i=>({id:key('duplicate-'+i),direction:'self',text:'收到',timestamp:Math.floor(p.delivery.at/1000)+i}))]});assert.equal(p.rounds,0);
  p.sentMessages[0].body={};assert.doesNotThrow(()=>a.reconcileUnknownReplies(p,{messages:[baseline]}));
});

test('an authenticated different segment cannot repair an unknown body during restart',async t=>{
  const {a,p,baseline}=await fixture(t);p.delivery.body=a.vault.seal({text:'第二段'});
  const id=key('first-segment');p.generatedIds=[id];p.sentMessages.push({id,operationId:p.delivery.operationId,source:'reply',at:a.now(),baseline:baseline.id,body:a.vault.seal({text:'第一段'}),confirmed:true,deliveryConfidence:'confirmed'});
  a.restoreDeliveryReceipts(p);assert.equal(p.delivery.status,'unknown');assert.equal(p.rounds,0);
});

test('official GLM 5.3 chat and audit use supported low thinking; custom endpoints retain their settings',async()=>{
  for(const baseUrl of ['https://open.bigmodel.cn/api/paas/v4','https://api.z.ai/api/paas/v4','https://custom.example/v1'])for(const mode of ['reply','speaker-audit','analysis']){
    let body;const provider=new AIProvider({fetcher:async(_,args)=>{body=JSON.parse(args.body);return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));}});
    await provider.complete({...modelConfig,baseUrl,model:'glm-5.3-flash'},'JSON',{mode});
    const low=!baseUrl.includes('custom')&&mode!=='analysis';assert.equal(body.reasoning_effort,low?'low':undefined);assert.equal(body.thinking?.type,low?'enabled':undefined);
  }
});

test('real report-format requests without a mode use supported low thinking only on official GLM 5.3 endpoints',async()=>{
 for(const baseUrl of ['https://open.bigmodel.cn/api/paas/v4','https://api.z.ai/api/paas/v4','https://custom.example/v1'])for(const model of ['glm-5.3-flash','glm-4.5-air']){
  let body,calls=0;const provider=new AIProvider({fetcher:async(_,args)=>{calls++;body=JSON.parse(args.body);return new Response(JSON.stringify({choices:[{message:{content:'报告正文'}}]}));}});
  await provider.complete({...modelConfig,baseUrl,model},'报告',{userRequest:'回顾测试聊天'},undefined,{format:'report',retry:false});
  const low=!baseUrl.includes('custom')&&model==='glm-5.3-flash';
  assert.equal(body.reasoning_effort,low?'low':undefined);assert.equal(body.thinking?.type,low?'enabled':undefined);assert.equal(calls,1);
 }
});

test('learning options use supported low GLM 5.3 thinking without changing input, budgets or call counts',async()=>{
 for(const baseUrl of ['https://open.bigmodel.cn/api/paas/v4','https://api.z.ai/api/paas/v4','https://custom.example/v1'])for(const model of ['glm-5.3-flash','glm-4.5-air'])for(const purpose of ['learning',undefined]){
  let body,calls=0;const input={material:[{direction:'self',text:'口语短句'}]};
  const provider=new AIProvider({fetcher:async(_,args)=>{calls++;body=JSON.parse(args.body);return Response.json({choices:[{message:{content:'{"ok":true}'}}]});}});
  await provider.complete({...modelConfig,baseUrl,model},'学习',input,undefined,{purpose,budget:16384,retry:false});
  const low=purpose==='learning'&&!baseUrl.includes('custom')&&model==='glm-5.3-flash';
  assert.equal(body.reasoning_effort,low?'low':undefined);assert.equal(body.thinking?.type,low?'enabled':undefined);
  assert.equal(body.max_tokens,16384);assert.equal(calls,1);assert.deepEqual(input,{material:[{direction:'self',text:'口语短句'}]});
 }
});
