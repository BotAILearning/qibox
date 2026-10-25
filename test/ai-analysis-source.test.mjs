import test from'node:test';import assert from'node:assert/strict';
import {analysisSourceIndex}from'../server/ai-analysis-source.mjs';
import {compactReportInput}from'../server/ai-model-input.mjs';
import {authoredMessages}from'../server/ai-context-learning.mjs';
import {AIAssistant}from'../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig,key}from'./ai-fixtures.mjs';
import {temp,cleanup}from'./fixtures.mjs';
const vault={open:value=>value},stamp=1792880000;
const row=(name,direction,text,extra={})=>({id:key(name),direction,text,timestamp:stamp,...extra});

test('known generated and ambiguous self sources supplement the original five-column report without text duplication',()=>{
  const rows=[row('generated','self','自动回复中的经历'),row('unknown','self','回执未知'),row('quoted','other','引用上一段',{quote:{verified:true,messageId:key('generated'),direction:'self',text:'自动回复中的经历',timestamp:stamp}})];
  const profile={generatedIds:[key('generated')],sentMessages:[{id:key('unknown'),confirmed:false}]},before=structuredClone(rows);
  const sourceIndex=analysisSourceIndex(rows,vault,profile);
  assert.deepEqual(sourceIndex,{generated:[1],unknown:[2],quotes:[{sequence:3,verified:true,speaker:'本人',sourceSequence:1}]});
  const input={userRequest:'概括',sourceIndex,messages:rows.map((m,index)=>({sequence:index+1,speaker:m.direction==='self'?'本人':'对方',beijingTime:'2026-10-25 09:00:00',text:m.text,secondsSincePrevious:index?0:null}))};
  const packed=compactReportInput(input);assert.deepEqual(packed.sourceIndex,sourceIndex);
  assert.deepEqual(packed.messages.map(values=>Object.fromEntries(packed.messageColumns.flatMap((name,index)=>name==='origin'?[]:[[name,values[index]]]))),input.messages);
  assert.deepEqual(packed.messages.map(values=>values[packed.messageColumns.indexOf('origin')]),[
    {authorship:'已知AI代发'},{authorship:'来源未核实'},{quote:{verified:true,speaker:'本人',sourceSequence:1}}
  ]);
  assert.deepEqual(rows,before);assert(!JSON.stringify(sourceIndex).includes('自动回复中的经历'));
});

test('out-of-range or partial quoted text is not appended, but a verified author is retained',()=>{
  const huge='OUTSIDE_PRIVATE_QUOTE'.repeat(10000),outside=row('outside','other','只看这次评论',{quote:{verified:true,messageId:key('old'),direction:'self',text:huge}});
  const result=analysisSourceIndex([outside],vault,{generatedIds:[key('old')]});
  assert.deepEqual(result,{quotes:[{sequence:1,verified:true,speaker:'本人',sourceReadable:false,generated:true}]});
  assert(JSON.stringify(result).length<300);assert(!JSON.stringify(result).includes('OUTSIDE_PRIVATE_QUOTE'));
  assert.deepEqual(analysisSourceIndex([outside],vault,{sentMessages:[{id:key('old'),confirmed:true,deliveryConfidence:'confirmed'}]}),result,'Legacy confirmed generated IDs remain known without a duplicate generatedIds entry');
  assert.deepEqual(analysisSourceIndex([outside],vault,{sentMessages:[{id:key('old'),confirmed:false}]}),{quotes:[{sequence:1,verified:true,speaker:'本人',sourceReadable:false,authorship:'unknown'}]});
  const partial=[row('source','self','被截断的尾部'),row('reply','other','看到了',{quote:{verified:true,messageId:key('source'),direction:'self',text:'原始完整正文，包含被截断的尾部'}})];
  assert.deepEqual(analysisSourceIndex(partial,vault),{quotes:[{sequence:2,verified:true,speaker:'本人',sourceReadable:false}]});
});

test('unverified, conflicting-author and duplicate-ID quote links do not become readable source claims',()=>{
  const source=row('source','self','原文');
  const quoted=(name,quote)=>row(name,'other','评论',{quote});
  const rows=[source,quoted('unverified',{verified:false,messageId:source.id,direction:'self',text:'原文'}),quoted('wrong-author',{verified:true,messageId:source.id,direction:'other',text:'原文'})];
  assert.deepEqual(analysisSourceIndex(rows,vault),{quotes:[{sequence:2,verified:false},{sequence:3,verified:false}]});
  const duplicates=[source,{...source},quoted('ambiguous',{verified:true,messageId:source.id,direction:'self',text:'原文'})];
  assert.deepEqual(analysisSourceIndex(duplicates,vault),{quotes:[{sequence:3,verified:true,speaker:'本人',sourceReadable:false}]});
  assert.equal(analysisSourceIndex([source,row('other','other','普通消息')],vault),undefined);
});

test('large source ranges decode each eligible uncertain intent once while retaining boundary and time semantics',()=>{
  const baseline=row('baseline','other','开始'),rows=[baseline,...Array.from({length:300},(_,i)=>row('r'+i,'self',i%2?'原意':'其他文字',{timestamp:stamp+1}))];
  const profile={sentMessages:[{id:key('unknown-id'),deliveryConfidence:'unknown',baseline:baseline.id,at:(stamp+1)*1000,body:{text:'原意'}}]};let opens=0;
  const result=authoredMessages({open:value=>{opens++;return value;}},profile,rows);
  assert.equal(opens,1);assert.equal(result.filter(x=>x.authorship==='unknown').length,150);
  opens=0;authoredMessages({open(){opens++;throw Error('unreadable');}},profile,[row('far','self','原意',{timestamp:stamp+1000})]);assert.equal(opens,0,'Do not open an intent outside its original time boundary');
  const unreadable=authoredMessages({open(){throw Error('unreadable');}},profile,rows);
  assert(unreadable.slice(1).every(x=>x.authorship==='unknown'));
});

test('normal analysis carries account-bound provenance in the same request and keeps all original text and counts',async t=>{
  const dataRoot=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture(),a=new AIAssistant({dataRoot,bridge,provider});
  await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);t.after(async()=>{await a.close();await cleanup(dataRoot);});
  await a.configure(modelConfig);await a.scan();await a.settings({enabled:true,replyScope:'all',autoLearning:false});const contact=bridge.contacts[0].id,p=a.profiles().find(x=>x.contact===contact);
  const rows=[row('generated','self','我去过合成A地。'),row('quote','other','引用这段',{timestamp:stamp+1,quote:{verified:true,messageId:key('generated'),direction:'self',text:'我去过合成A地。',timestamp:stamp}})];
  (p.generatedIds||=[]).push(rows[0].id);await a.save();bridge.messages.set(contact,rows);const before=structuredClone(rows);let calls=0,captures=[];
  provider.complete=async(_config,system,input)=>{calls++;captures.push({system,input});return{report:'本次核对账号原话与引用来源，暂不对经历作现实确认。'};};
  const first=await a.analyze({contacts:[contact],request:'概括谈了什么'});assert.equal(first.reports[0].status,'complete');assert.equal(calls,1);assert.equal(first.reports[0].count,2);
  assert.deepEqual(captures[0].input.sourceIndex,{generated:[1],quotes:[{sequence:2,verified:true,speaker:'本人',sourceSequence:1}]});
  assert.deepEqual(captures[0].input.messages.map(x=>x.text),rows.map(x=>x.text));assert(captures[0].input.messages.every(x=>Object.keys(x).length===5));assert.match(captures[0].system,/不证明本人亲历/);assert.equal(bridge.sent.length,0);assert.deepEqual(rows,before);
  bridge.account=key('different-account-same-native-row-id');await a.scan();
  await a.analyze({contacts:[contact],request:'概括谈了什么'});assert.equal(calls,2);assert.equal(captures[1].input.sourceIndex.generated,undefined,'An old account profile cannot label a new account row as its generated message');assert.equal(bridge.sent.length,0);
});
