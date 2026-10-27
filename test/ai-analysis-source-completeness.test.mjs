import test from'node:test';
import assert from'node:assert/strict';
import{tailWithinLimit}from'../server/ai-analysis.mjs';
import{AIAssistant}from'../server/ai-service.mjs';
import{AIProvider}from'../server/ai-provider.mjs';
import{ChatFixture,AIModelFixture,modelConfig,key}from'./ai-fixtures.mjs';
import{temp,cleanup}from'./fixtures.mjs';

test('report budget retains whole messages instead of converting a lost negation into an affirmative source',()=>{
  const rows=[{id:'negation',direction:'other',timestamp:100,text:'我没有确认她已经收到了退款。'},{id:'known-self',direction:'self',timestamp:101,text:'我的车位费退款已经到账。'},{id:'known-third',direction:'other',timestamp:102,text:'阿杰已经把钥匙交给店员了。'}];
  const before=structuredClone(rows),tail='她已经收到了退款。',limit=Array.from(tail+rows[1].text+rows[2].text).length;
  const result=tailWithinLimit(rows,limit);
  assert.deepEqual(result.messages.map(x=>x.id),['known-self','known-third']);
  assert.deepEqual(result.messages,rows.slice(1));
  assert.equal(result.coverage.omittedBudgetMessages,1);assert.equal(result.coverage.omittedIncompleteMessages??0,0);
  assert.equal(result.coverage.omittedMessages,1);assert.equal(result.coverage.truncated,true);
  assert.equal(result.coverage.analyzedChars,Array.from(rows[1].text+rows[2].text).length);assert.deepEqual(rows,before);
});

test('native incomplete prefixes and tails are disclosed as omitted sources while other complete facts remain usable',()=>{
  const rows=[{id:'complete-before',direction:'self',timestamp:100,text:'我已收到车位费退款。'},{id:'prefix',direction:'other',timestamp:101,text:'阿杰转述了店员的留言：“我已经',textTruncated:true},{id:'tail',direction:'self',timestamp:102,text:'我已经把钥匙交给她了。”',textTruncated:true},{id:'complete-after',direction:'other',timestamp:103,text:'阿杰把钥匙交给店员了。'}];
  const before=structuredClone(rows),result=tailWithinLimit(rows,1000);
  assert.deepEqual(result.messages.map(x=>x.id),['complete-before','complete-after']);
  assert.equal(result.coverage.omittedIncompleteMessages,2);assert.equal(result.coverage.omittedBudgetMessages??0,0);
  assert.equal(result.coverage.analyzedMessages,2);assert.equal(result.coverage.totalReadableMessages,4);
  assert.equal(result.coverage.omittedMessages,2);assert.equal(result.coverage.truncated,true);assert.deepEqual(rows,before);
});

test('within-budget complete Unicode messages keep all original values and do not add incomplete-source warnings',()=>{
  const rows=[{id:'self',direction:'self',timestamp:100,text:'我已收到退款😀'},{id:'other',direction:'other',timestamp:101,text:'阿杰已把钥匙交给店员。'}],before=structuredClone(rows);
  const result=tailWithinLimit(rows,Array.from(rows.map(x=>x.text).join('')).length);
  assert.deepEqual(result.messages,rows);
  const chars=Array.from(rows.map(x=>x.text).join('')).length;
  assert.deepEqual(result.coverage,{totalReadableMessages:2,analyzedMessages:2,totalChars:chars,analyzedChars:chars,omittedMessages:0,partialMessages:0,truncated:false,from:100,to:101});assert.deepEqual(rows,before);
});

for(const mode of['native-incomplete','single-over-budget'])test(`${mode}: no reliable complete report source makes no model request and preserves existing history`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture(),a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();t.after(async()=>{await a.close();await cleanup(root);});await a.verifyProvider(modelConfig);await a.scan();const contact=bridge.contacts[0].id,at=1793034000;
  bridge.readRange=async args=>({account:args.account,contact:args.contact,messages:[{id:key('prior-whole-source'),direction:'self',timestamp:at,text:'我已经收到车位费退款。'}]});provider.next=async()=>({report:'原有已保存报告：本人确认车位费退款到账。'});
  const prior=(await a.analyze({contacts:[contact],request:''})).reports[0];assert.equal(prior.status,'complete');const history=structuredClone(a.publicState().analysis.history);assert.equal(history.length,1);provider.calls.length=0;
  const row={id:key(mode),direction:'other',timestamp:at+1,...(mode==='native-incomplete'?{text:'她已经收到了退款。',textTruncated:true}:{text:'长'.repeat(150001)})};
  bridge.readRange=async args=>({account:args.account,contact:args.contact,messages:[row]});
  provider.next=async()=>({report:'一个看似正常的合成报告正文；旧路径不能因模型返回正文就认定不完整来源可分析。'});
  const report=(await a.analyze({contacts:[contact],request:'保留我的原始分析要求'})).reports[0];
  t.diagnostic(JSON.stringify({status:report.status,modelCalls:provider.calls.length,historyCount:a.publicState().analysis.history.length}));
  assert.equal(provider.calls.length,0);assert.equal(report.status,'error');assert.match(report.error,/完整|过长|上限/);
  assert.deepEqual(a.publicState().analysis.history,history);assert.equal(a.operation,null);assert.equal(row.text.length,mode==='native-incomplete'?'她已经收到了退款。'.length:150001);
});

for(const protocol of['anthropic','openai'])test(`${protocol}: report wire omits incomplete source, keeps both complete facts and persists explicit coverage`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),requests=[];
  const provider=new AIProvider({fetcher:async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);const wire=JSON.parse(body.messages.find(x=>x.role==='user').content),rows=wire.messages.map(row=>Object.fromEntries(wire.messageColumns.map((name,i)=>[name,row[i]])));
    assert.deepEqual(rows.map(x=>[x.speaker,x.text]),[['本人','我的车位费退款已经到账。'],['对方','阿杰已经把钥匙交给店员了。']]);
    assert.equal(wire.readableCount,3);assert.equal(wire.analyzedCount,2);assert.equal(wire.metrics.total,2);assert.equal(wire.coverage.omittedIncompleteMessages,1);assert.equal(wire.coverage.partialMessages,0);assert(wire.coverage.reasons.includes('incomplete_source_excluded'));assert(!wire.coverage.reasons.includes('character_limit'));
    assert.equal(JSON.stringify(wire).includes('她已经收到了退款。'),false);
    const text=JSON.stringify({report:'本人确认自己的车位费退款已经到账；阿杰已经把钥匙交给店员。'});return Response.json(protocol==='anthropic'?{content:[{type:'text',text}]}:{choices:[{message:{content:text}}]});
  }});provider.test=async()=>{};const a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();t.after(async()=>{await a.close();await cleanup(root);});await a.verifyProvider({...modelConfig,protocol});await a.scan();
  const rows=[{id:key('partial-refund'),direction:'other',timestamp:1793034000,text:'她已经收到了退款。',textTruncated:true},{id:key('complete-self-refund'),direction:'self',timestamp:1793034001,text:'我的车位费退款已经到账。'},{id:key('complete-third-key'),direction:'other',timestamp:1793034002,text:'阿杰已经把钥匙交给店员了。'}],before=structuredClone(rows);bridge.readRange=async args=>({account:args.account,contact:args.contact,messages:rows});
  const report=(await a.analyze({contacts:[bridge.contacts[0].id],request:''})).reports[0];assert.equal(report.status,'complete');assert.equal(requests.length,1);assert.equal(report.analyzedCount,2);assert.equal(report.readableCount,3);assert.equal(report.omittedIncompleteMessages,1);assert.equal(report.omittedMessages,1);assert(report.truncatedReasons.includes('incomplete_source_excluded'));assert.equal(report.partialMessages,0);assert.match(report.report,/已经到账/);assert.match(report.report,/阿杰.*店员/);assert.deepEqual(rows,before);
  const history=a.publicState().analysis.history;assert.equal(history.length,1);assert.equal(history[0].omittedIncompleteMessages,1);assert.equal(history[0].analyzedCount,2);assert.equal(history[0].readableCount,3);
});

test('source omission coverage survives encrypted report storage and assistant restart without regenerating it',async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();t.after(async()=>{await a.close();await cleanup(root);});await a.verifyProvider(modelConfig);await a.scan();
  bridge.readRange=async args=>({account:args.account,contact:args.contact,messages:[{id:key('restart-incomplete'),direction:'other',timestamp:1793034000,text:'她已经收到了退款。',textTruncated:true},{id:key('restart-complete'),direction:'self',timestamp:1793034001,text:'我的车位费退款已经到账。'}]});provider.next=async()=>({report:'本人已收到自己的车位费退款。'});
  const report=(await a.analyze({contacts:[bridge.contacts[0].id],request:''})).reports[0];assert.equal(report.status,'complete');const id=a.publicState().analysis.history[0].id,before=await a.analysisReport(id);assert.equal(before.omittedIncompleteMessages,1);assert.equal(provider.calls.length,1);
  await a.close();provider.calls.length=0;a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();await a.scan();const saved=await a.analysisReport(id);assert.deepEqual(saved,before);assert.equal(a.publicState().analysis.history[0].omittedIncompleteMessages,1);assert.equal(provider.calls.length,0);
});
