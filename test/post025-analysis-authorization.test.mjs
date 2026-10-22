import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AIAssistant} from '../server/ai-service.mjs';
import {analysisEvidenceViolation} from '../server/ai-analysis-evidence.mjs';
import {AIModelFixture,ChatFixture,modelConfig,key} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
const request='按顺序保留关键否定、更正和引用，说明目前能确认的报名意向、地点及付款信息；未知的信息不要写成相反事实。';
const originals=[
 ['对方','2026-10-21 16:00:00','周六的培训我还没确认参加。'],['本人','2026-10-21 16:00:30','好，等你自己确认，不替你报名。'],
 ['对方','2026-10-22 09:00:00','地点改了，原来的二楼作废，改为三楼A室。'],['本人','2026-10-22 09:00:20','收到，三楼A室。'],
 ['对方','2026-10-22 09:02:00','我现在确认参加，只参加培训，不参加晚餐。'],['本人','2026-10-22 09:02:10','明白，只参加培训。'],
 ['对方','2026-10-22 09:03:00','我没有同意任何人替我付钱；“我已经付款了”是小说台词，不是事实。'],['本人','2026-10-22 09:03:30','明白，不把小说台词当作付款记录。'],
];
const messages=originals.map(([speaker,beijingTime,text],i)=>({sequence:i+1,speaker,beijingTime,text}));
const actual298=`报名意向的变化
2026-10-21 16:00:00，对方说：“周六的培训我还没确认参加。”这是当时尚未确认的状态。30秒后，你说：“好，等你自己确认，不替你报名。”这句话也明确承接了当时的选择。

2026-10-22 09:02:00，对方更正并确认：“我现在确认参加，只参加培训，不参加晚餐。”这能确认其最新报名意向为参加培训、不参加晚餐；至于此前是否已办理报名，聊天中没有说明。

地点的确认与更正
2026-10-22 09:00:00，对方说：“地点改了，原来的二楼作废，改为三楼A室。”因此，目前可确认的地点是三楼A室，原二楼已明确作废。20秒后，你回复：“收到，三楼A室。”

付款信息的否定与引用
2026-10-22 09:03:00，对方明确说：“我没有同意任何人替我付钱；‘我已经付款了’是小说台词，不是事实。”这既否定了本人代付，也澄清“我已经付款了”不能作为付款事实。现有材料未显示对方本人是否另有付款。

目前可确认的信息
截至2026-10-22 09:03:30，对方的最新意向是参加培训但不参加晚餐，地点为三楼A室，并明确不同意任何人替其付款。材料没有提供报名是否提交或完成、费用金额、付款时间、付款方式，也没有确认对方本人是否已经付款；这些均应保留为未知，不能反向理解为未报名或未付款。`;
const source=(speaker,text)=>({sequence:1,speaker,beijingTime:'2026-10-22 09:03:00',text});

test('actual025 #298 authorization denial cannot establish that the owner did not pay',()=>{
 assert.equal(analysisEvidenceViolation('这既否定了本人代付。',messages),'payment-event');
 assert.equal(analysisEvidenceViolation(actual298,messages),'payment-event');
 for(const report of ['本人没有代付。','因此，本人并未代付。'])assert.equal(analysisEvidenceViolation(report,messages),'payment-event',report);
});
test('payment support is an independent same-actor, same-matter denial, never a quoted or double-negative substring',()=>{
 const auth=source('对方','培训费我没有同意任何人替我付钱。');
 for(const extra of [source('本人','培训费我并未代付。'),source('对方','培训费没有人替我付钱。')])
  assert.equal(analysisEvidenceViolation('本人没有代付培训费。',[auth,extra]),'');
 for(const extra of [source('本人','午餐费我并未代付。'),source('对方','培训费我并未代付。'),source('本人','培训费“我并未代付”是小说台词。'),source('本人','如果培训费我并未代付，就再核对。'),source('本人','培训费我并未代付吗？'),source('本人','他表示，培训费我并未代付。'),source('本人','培训费我不是没代付。'),source('本人','培训费我没有付款。')])
  assert.equal(analysisEvidenceViolation('本人没有代付培训费。',[auth,extra]),'payment-event',extra.text);
 assert.equal(analysisEvidenceViolation('这否定了本人代付。',[source('对方','我没有不同意任何人替我付钱。')]),'','a double negative is not a denial of authorization');
 assert.equal(analysisEvidenceViolation('本人没有代付培训费。',[source('对方','我没同意别人替我付培训费。'),source('本人','培训费我没有付款。')]),'payment-event','explicit fee wording still cannot borrow an ordinary payment denial');
 assert.equal(analysisEvidenceViolation('本人没有代付培训费。',[source('对方','我没同意别人替我付培训费。'),source('本人','培训费我并未代付。')]),'');
});
test('questions, conditions, reports, quotation and unknown are not asserted non-payment',()=>{
 for(const report of ['本人没有代付吗？','如果本人没有代付，就继续核对。','他表示，本人没有代付。','对方说“本人没有代付”。','不能把未授权理解为本人没有代付。','未授权不代表本人没有代付。','付款是否发生仍未知。'])assert.equal(analysisEvidenceViolation(report,messages),'',report);
});
test('a rejected payment proposal, authorization or intention is not asserted non-payment',()=>{
 for(const tail of ['的提议','的授权','的意向'])assert.equal(analysisEvidenceViolation('这既否定了本人代付'+tail+'。',messages),'',tail);
 assert.equal(analysisEvidenceViolation('这说明本人并未代付。',messages),'payment-event');
});
const backwards='2026-10-22 09:02:00，对方确认参加。\n2026-10-22 09:00:00，对方更正地点。';
test('explicit chronological request rejects a new complete line-leading anchor going backwards',()=>{
 for(const r of [request,'请按时间顺序列出。','按原始顺序整理。','请按时间线整理。','按时间顺序，不要按主题分类。','麻烦不要按主题分类，按时间顺序。','请不要倒序，按时间顺序。'])assert.equal(analysisEvidenceViolation(backwards,messages,{request:r}),'timeline-order',r);
 for(const r of ['', '分析参与意向。','按主题分类，讨论顺序。','按时间倒序整理。','不要按时间顺序，按主题分析。','请不要按时间顺序整理。','请勿按时间线，直接总结。','“按时间顺序”是引用，只分析其含义。'])assert.equal(analysisEvidenceViolation(backwards,messages,{request:r}),'',r);
});
test('chronological anchors exclude body quotations, as-of summaries and repeated recaps',()=>{
 for(const report of ['2026-10-22 09:00:00，更正地点。\n2026-10-22 09:02:00，确认参加。\n截至2026-10-21 16:00:00，当时未确认。', '2026-10-22 09:00:00，更正地点。\n2026-10-22 09:02:00，确认参加。\n回顾2026-10-21 16:00:00，当时未确认。','2026-10-22 09:00:00，更正地点。\n2026-10-22 09:02:00，确认参加。\n2026-10-22 09:00:00，重复回顾已引用的地点更正。','2026-10-22 09:02:00，确认参加。\n“2026-10-22 09:00:00，更正地点。”是原文引用。','正文回顾2026-10-22 09:00:00；随后说明2026-10-21 16:00:00。'])assert.equal(analysisEvidenceViolation(report,messages,{request}),'',report);
});
const speakerAnchor=m=>`${m.speaker==='本人'?'你':m.speaker}：${m.beijingTime}“${m.text}”`;
const thematicOutOfOrder=`报名意向的变化\n${[0,1,4,5].map(i=>speakerAnchor(messages[i])).join('\n')}\n\n地点的更正\n${[2,3].map(i=>speakerAnchor(messages[i])).join('\n')}\n\n付款信息\n${[6,7].map(i=>speakerAnchor(messages[i])).join('\n')}`;
test('speaker-first exact source anchors reject the actual thematic chapter inversion',()=>{
 assert.equal(analysisEvidenceViolation(thematicOutOfOrder,messages,{request}),'timeline-order');
});
test('speaker-first anchors accept chronology and ignore ambiguous sources, quoted dates and retrospective duplicate anchors',()=>{
 const ordered=`时间线\n${messages.map(speakerAnchor).join('\n')}\n回顾旧情况：2026-10-21 16:00:00时尚未确认。\n${speakerAnchor(messages[0])}`;
 assert.equal(analysisEvidenceViolation(ordered,messages,{request}),'');
 const duplicate=[...messages,{...messages[2],sequence:9}];
 const ambiguous=`时间线\n${speakerAnchor(messages[4])}\n${speakerAnchor(messages[2])}`;
 assert.equal(analysisEvidenceViolation(ambiguous,duplicate,{request}),'');
 for(const otherRequest of ['按主题分类，讨论顺序。','按时间倒序整理。'])
  assert.equal(analysisEvidenceViolation(thematicOutOfOrder,messages,{request:otherRequest}),'');
});
async function fixture(t){const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture(),a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);t.after(async()=>{await a.close();await cleanup(root);});await a.configure(modelConfig);await a.scan();const contact=bridge.contacts[0].id;bridge.readRange=async args=>({account:args.account,contact:args.contact,messages:messages.map(m=>({id:key('analysis-authorization-'+m.sequence),direction:m.speaker==='本人'?'self':'other',text:m.text,timestamp:Date.parse(m.beijingTime.replace(' ','T')+'+08:00')/1000}))});return{root,a,provider,contact};}
for(const[label,report]of [['actual298',actual298],['payment-only','这既否定了本人代付。'],['timeline-only',backwards]])test(`production ${label} is rejected after one complete and retains prior saved report and request`,async t=>{
 const{root,a,provider,contact}=await fixture(t);let calls=0;provider.complete=async()=>{calls++;return{report:calls===1?'原先已保存的有效报告。':report};};
 const old=(await a.analyze({contacts:[contact],request:'旧分析要求'})).reports[0];assert.equal(old.status,'complete');const previous=a.analysisReport(old.historyId);const value={contacts:[contact],request},copy=structuredClone(value);
 const result=(await a.analyze(value)).reports[0];assert.equal(calls,2,'only one new complete, no local-guard regeneration');assert.equal(result.status,'error');assert.match(result.error,/原文不一致/);assert.deepEqual(value,copy);assert.equal(a.analysisHistory().length,1);assert.deepEqual(a.analysisReport(old.historyId),previous);
 const disk=JSON.parse(await readFile(a.file,'utf8'));assert.equal(disk.analysisReports.length,1);assert.equal(disk.analysisReports[0].request,'旧分析要求');assert.equal(a.operation,null);await a.tick();assert.equal(calls,2);assert.equal(a.analysisHistory().length,1);
});
test('ordered format and prompt preserve a valid complete report without a new review call',async t=>{
 const{a,provider,contact}=await fixture(t);const report='# 时间线\n2026-10-22 09:00:00，对方更正地点。\n2026-10-22 09:02:00，对方确认参加。\n付款是否发生仍未知。';let calls=0;provider.complete=async(_c,system,input)=>{calls++;assert.equal(input.userRequest,request);assert.match(system,/授权.*实际发生|实际发生.*授权/);assert.match(system,/顺序.*默认章节|默认章节.*顺序/);return{report};};
 const result=(await a.analyze({contacts:[contact],request})).reports[0];assert.equal(calls,1);assert.equal(result.status,'complete');assert.equal(result.report,report);assert.equal(a.analysisReport(result.historyId).request,request);
});
