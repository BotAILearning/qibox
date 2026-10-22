import test from 'node:test';import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig,strategy,key} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
async function fixture(t) {
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let now=Date.parse('2026-10-23T01:00:00+08:00'),a;
  bridge.stableMessageIds=true;
  const boot=async()=>{a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,random:min=>min,delay:async()=>{}});await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);};
  await boot();await a.configure(modelConfig);await a.scan();const c=bridge.contacts[0];
  await a.saveReplyProfile({contact:c.id,style:{summary:'用户明确设置：自然短句，保留原设置。'},strategy:{...strategy,maxRounds:20},replyEnabled:true});
  await a.settings({enabled:true,autoLearning:false,segmentReplies:false,followUpEnabled:false});await a.tick();
  const p=()=>a.profiles().find(row=>row.contact===c.id),push=(direction,text)=>{const m=bridge.push(c.id,direction,text);m.timestamp=Math.floor(now/1000);return m;};
  t.after(async()=>{await a.close();await cleanup(root);});
  return{get a(){return a;},bridge,provider,c,p,push,advance:ms=>{now+=ms;},async receive(text,wait=21000){push('other',text);await a.tick();now+=wait;await a.tick();},async restart(){await a.close();await boot();},root};
}
const reply=text=>({action:'send',text,followUp:false});
test('production request binds recent self picture to its original author and keeps explicit style, all in one call',async t=>{
  const f=await fixture(t),pic=f.push('self','[图片]');Object.assign(pic,{type:'image',authorship:'human'});f.push('self','我用的这个套餐额度是自己的');
  f.bridge.readImage=async req=>{assert.equal(req.account,f.bridge.account);assert.equal(req.contact,f.c.id);assert.equal(req.messageId,pic.id);return{messageId:pic.id,mime:'image/png',data:'c3ludGhldGlj',thumbnail:true};};
  f.provider.next=async input=>{assert.equal(input.images.length,1);assert.equal(input.images[0].messageId,pic.id);assert.equal(input.attributionContext.imageEvidence[0].speaker.role,'self');assert.equal(input.messages.find(x=>x.id===pic.id).imageQuality,'thumbnail');assert.equal(input.style.summary,'用户明确设置：自然短句，保留原设置。');assert(input.expressionTendency.instruction.includes('不是配额'));return reply('嗯，是我这边的额度。');};
  await f.receive('这个说的是你自己的额度吧？',301000);assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,1);assert.equal(f.p().styleTendency.roundCount,1);
});
test('mismatched image response is omitted without changing the account or dropping a readable incoming obligation',async t=>{
  const f=await fixture(t),pic=f.push('self','[图片]');pic.type='image';f.bridge.readImage=async()=>({messageId:key('other-picture'),mime:'image/png',data:'c3ludGhldGlj'});
  f.provider.next=async input=>{assert.equal(input.images.length,0);assert.equal(input.attributionContext.imageEvidence.length,0);assert(input.conversation.pendingIncomingMessages.some(x=>x.text==='文字问题仍需回应'));return reply('收到。');};
  await f.receive('文字问题仍需回应',301000);assert.equal(f.bridge.sent.length,1);
});
test('each actual response gets its own style round even inside one existing replyRoundVersion',async t=>{
  const f=await fixture(t),epoch=f.p().replyRoundVersion;for(const text of ['第一条合成来信','第二条合成来信','第三条合成来信']){f.provider.next=async()=>reply('收到，谢谢。');await f.receive(text);}
  assert.equal(f.p().replyRoundVersion,epoch);assert.equal(f.p().styleTendency.roundCount,3);assert.deepEqual(f.p().sentMessages.map(x=>x.styleRoundId),[1,2,3]);
  assert.equal(f.p().styleTendency.confirmedSendCount,2,'third plan sees prior two confirmed rounds, not a single conversation epoch');
  assert.equal(f.a.publicProfile(f.p()).styleTendency,undefined);
});
test('definitely-not-sent retry reuses the original model result and plan across restart, then counts once',async t=>{
  const f=await fixture(t),send=f.bridge.send.bind(f.bridge);f.bridge.send=async()=>({status:'not-sent'});f.provider.next=async()=>reply('这是一条合成答复。');
  await f.receive('合成收件失败测试');assert.equal(f.provider.calls.length,1);assert.equal(f.p().styleTendency.roundCount,0);
  const plan=f.a.vault.open(f.p().preparedReply.body);assert.equal(plan.styleRoundId,1);const old=structuredClone(f.p().styleTendency.plans['1']);
  await f.restart();f.bridge.send=send;f.advance(61000);await f.a.tick();assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,1);assert.equal(f.p().styleTendency.roundCount,1);assert.deepEqual(f.p().styleTendency.plans['1'],old);
});
test('unknown send never counts until exact receipt reconciliation, repeated late receipt counts once',async t=>{
  const f=await fixture(t),send=f.bridge.send.bind(f.bridge);f.bridge.send=async req=>{await send(req);f.bridge.messages.get(f.c.id).at(-1).timestamp=Math.floor(f.a.now()/1000);return{status:'uncertain'};};f.provider.next=async()=>reply('等待补核的合成答复。');
  await f.receive('合成未知回执测试');assert.equal(f.provider.calls.length,1);assert.equal(f.bridge.sent.length,1);assert.equal(f.p().styleTendency.roundCount,0);assert.equal(f.p().delivery.status,'unknown');
  const snapshot=await f.bridge.read({contact:f.c.id});f.a.reconcileUnknownReplies(f.p(),snapshot);assert.equal(f.p().styleTendency.roundCount,1);assert.equal(f.p().delivery.status,'sent');f.a.reconcileUnknownReplies(f.p(),snapshot);assert.equal(f.p().styleTendency.roundCount,1);
});
test('confirmed multi-segment prefix is one style round and never trains a new human preference',async t=>{
  const f=await fixture(t);await f.a.settings({segmentReplies:true,segmentDelayMin:1,segmentDelayMax:1});
  f.provider.next=async()=>({action:'send',segments:['合成答复第一部分。','合成答复第二部分。'],followUp:false});await f.receive('合成多段测试');
  assert.equal(f.bridge.sent.length,2);assert.equal(f.p().styleTendency.roundCount,1);assert.deepEqual(f.p().sentMessages.map(x=>x.styleRoundId),[1,1]);assert.equal(f.p().styleTendency.roundLedger['1'].operationIds.length,2);
});
