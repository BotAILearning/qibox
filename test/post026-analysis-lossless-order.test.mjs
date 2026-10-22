const request="按顺序保留关键否定、更正和引用，说明目前能确认的报名意向、地点及付款信息；未知的信息不要写成相反事实。";
const messages=[
  {
    "sequence": 1,
    "speaker": "对方",
    "beijingTime": "2026-10-21 16:00:00",
    "text": "周六的培训我还没确认参加。",
    "secondsSincePrevious": null
  },
  {
    "sequence": 2,
    "speaker": "本人",
    "beijingTime": "2026-10-21 16:00:30",
    "text": "好，等你自己确认，不替你报名。",
    "secondsSincePrevious": 30
  },
  {
    "sequence": 3,
    "speaker": "对方",
    "beijingTime": "2026-10-22 09:00:00",
    "text": "地点改了，原来的二楼作废，改为三楼A室。",
    "secondsSincePrevious": 61170
  },
  {
    "sequence": 4,
    "speaker": "本人",
    "beijingTime": "2026-10-22 09:00:20",
    "text": "收到，三楼A室。",
    "secondsSincePrevious": 20
  },
  {
    "sequence": 5,
    "speaker": "对方",
    "beijingTime": "2026-10-22 09:02:00",
    "text": "我现在确认参加，只参加培训，不参加晚餐。",
    "secondsSincePrevious": 100
  },
  {
    "sequence": 6,
    "speaker": "本人",
    "beijingTime": "2026-10-22 09:02:10",
    "text": "明白，只参加培训。",
    "secondsSincePrevious": 10
  },
  {
    "sequence": 7,
    "speaker": "对方",
    "beijingTime": "2026-10-22 09:03:00",
    "text": "我没有同意任何人替我付钱；“我已经付款了”是小说台词，不是事实。",
    "secondsSincePrevious": 50
  },
  {
    "sequence": 8,
    "speaker": "本人",
    "beijingTime": "2026-10-22 09:03:30",
    "text": "明白，不把小说台词当作付款记录。",
    "secondsSincePrevious": 30
  }
];
const actual300="报名意向的确认\n2026-10-21 16:00:00，对方说：“周六的培训我还没确认参加。”此时能确认的是尚未确认，并非明确拒绝。\n2026-10-21 16:00:30，你回复：“好，等你自己确认，不替你报名。”你明确表示不会代为报名。\n\n后续报名更正\n2026-10-22 09:02:00，对方更正并确认：“我现在确认参加，只参加培训，不参加晚餐。”因此，目前可确认其报名意向为参加培训，并明确不参加晚餐。\n2026-10-22 09:02:10，你回复：“明白，只参加培训。”双方对培训范围的理解一致。\n\n培训地点更正\n2026-10-22 09:00:00，对方说：“地点改了，原来的二楼作废，改为三楼A室。”这是对先前地点的明确更正，原二楼信息已作废。\n2026-10-22 09:00:20，你回复：“收到，三楼A室。”目前能够确认的地点是三楼A室；材料没有提供更详细的地址。\n\n付款信息与引用辨析\n2026-10-22 09:03:00，对方说：“我没有同意任何人替我付钱；“我已经付款了”是小说台词，不是事实。”这里能确认的是对方未授权他人代付，且“我已经付款了”属于被引用的小说台词，不能视为付款记录。材料没有明确说明本人或他人是否实际付款，因此付款状态仍未知。\n2026-10-22 09:03:30，你回复：“明白，不把小说台词当作付款记录。”你已确认不会据此认定对方已付款。";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIModelFixture,ChatFixture,modelConfig,key} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';

const sections=actual300.split('\n\n');
const ordered=[sections[0],sections[2],sections[1],sections[3]].join('\n\n');
const countBlocks=text=>text.split(/\r?\n\r?\n/).slice().sort();
async function fixture(t, source=messages){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();
 bridge.contacts[0].label='全合成对象 NR-RX';
 let a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>Date.parse('2026-10-22T04:00:00.000Z')});
 const stop=()=>{clearInterval(a.timer);clearInterval(a.warmupTimer);};
 await a.init();stop();await a.configure(modelConfig);await a.scan();
 const contact=bridge.contacts[0].id;
 bridge.readRange=async args=>({account:args.account,contact:args.contact,messages:source.map(m=>({id:key('lossless-'+m.sequence),direction:m.speaker==='本人'?'self':m.speaker==='对方'?'other':'unknown',text:m.text,timestamp:Date.parse(m.beijingTime.replace(' ','T')+'+08:00')/1000}))});
 const restart=async()=>{await a.close();a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>Date.parse('2026-10-22T04:00:00.000Z')});await a.init();stop();await a.scan();return a;};
 t.after(async()=>{await a.close();await cleanup(root);});
 return {root,a,provider,contact,restart};
}
async function run(t,report,{source=messages,userRequest=request}={}){
 const f=await fixture(t,source);let calls=0;f.provider.complete=async()=>{calls++;return{report};};
 const result=(await f.a.analyze({contacts:[f.contact],request:userRequest,from:'2026-10-21',to:'2026-10-22'})).reports[0];
 assert.equal(calls,1,'one fake complete; local normalization must not regenerate');
 await f.a.tick();assert.equal(calls,1,'the next tick must not regenerate');
 return{...f,result};
}
test('actual026 #300 moves only whole exact-bound chapters, saves complete text and survives restart without replacing prior history',async t=>{
 const f=await fixture(t);let calls=0;
 f.provider.complete=async(_c,system,input)=>{calls++;if(calls===2){assert.equal(input.userRequest,request);assert.deepEqual(input.messages,messages);}return{report:calls===1?'原先已保存的有效报告。':actual300};};
 const old=(await f.a.analyze({contacts:[f.contact],request:'旧分析要求'})).reports[0];assert.equal(old.status,'complete');
 const previous=f.a.analysisReport(old.historyId),value={contacts:[f.contact],request,from:'2026-10-21',to:'2026-10-22'},original=structuredClone(value);
 const result=(await f.a.analyze(value)).reports[0];
 assert.equal(calls,2,'one fake complete for the actual300 replay');assert.equal(result.status,'complete');assert.equal(result.report,ordered);
 assert.equal(Buffer.byteLength(result.report),Buffer.byteLength(actual300));assert.deepEqual(countBlocks(result.report),countBlocks(actual300));assert.deepEqual(value,original);
 assert.equal(f.a.analysisHistory().length,2);assert.deepEqual(f.a.analysisReport(old.historyId),previous);assert.equal(f.a.analysisReport(result.historyId).request,request);
 const disk=JSON.parse(await readFile(f.a.file,'utf8'));assert.equal(disk.analysisReports.length,2);assert.equal(disk.analysisReports.find(r=>r.id===result.historyId).request,request);
 const restarted=await f.restart();assert.equal(restarted.analysisReport(result.historyId).report,ordered);assert.equal(restarted.analysisReport(result.historyId).request,request);assert.deepEqual(restarted.analysisReport(old.historyId),previous);
 await restarted.tick();assert.equal(calls,2);assert.equal(restarted.analysisHistory().length,2);
});
test('exact nested original quotation and CRLF blocks retain all original bytes while ordering chapters',async t=>{
 const report=actual300.replaceAll('\n','\r\n'),expected=ordered.replaceAll('\n','\r\n');
 const{result}=await run(t,report);assert.equal(result.status,'complete');assert.equal(result.report,expected);assert.equal(Buffer.byteLength(result.report),Buffer.byteLength(report));assert.deepEqual(countBlocks(result.report),countBlocks(report));
});
const invalid=[
 ['missing a source message',()=>actual300.replace(sections[1].split('\n')[2]+'\n','').replace(sections[1].split('\n')[2],'')],
 ['duplicate source anchor',()=>actual300.replace(sections[1],sections[1]+'\n'+sections[1].split('\n')[1])],
 ['timestamp mismatch',()=>actual300.replace('2026-10-22 09:02:00，','2026-10-22 09:02:01，')],
 ['speaker mismatch',()=>actual300.replace('09:02:00，对方更正','09:02:00，你更正')],
 ['missing speaker',()=>actual300.replace('09:02:00，对方更正并确认','09:02:00，更正并确认')],
 ['original text mismatch',()=>actual300.replace('“我现在确认参加，只参加培训，不参加晚餐。”','“我现在确认参加，也参加晚餐。”')],
 ['descending inside a chapter',()=>actual300.replace(sections[1],[sections[1].split('\n')[0],sections[1].split('\n')[2],sections[1].split('\n')[1]].join('\n'))],
 ['interleaving sequence ranges',()=>{const b=sections.map(s=>s.split('\n'));[b[0][2],b[2][1]]=[b[2][1],b[0][2]];return b.map(s=>s.join('\n')).join('\n\n');}],
 ['unbound narrative line',()=>actual300.replace(sections[1],sections[1]+'\n额外的独立总结。')],
 ['timestamp quoted paragraph',()=>actual300.replace(sections[1].split('\n')[1],'“'+sections[1].split('\n')[1]+'”')],
 ['all eight anchors but unsupported payment conclusion',()=>actual300+'这既否定了本人代付。'],
 ['two timeline lines without a complete source binding',()=> '2026-10-22 09:02:00，对方确认参加。\n2026-10-22 09:00:00，对方更正地点。'],
];
for(const[label,make]of invalid)test('unprovable chapter structure is not reordered: '+label,async t=>{
 const{a,result}=await run(t,make());assert.equal(result.status,'error');assert.equal(a.analysisHistory().length,0);const disk=JSON.parse(await readFile(a.file,'utf8'));assert.equal(disk.analysisReports.length,0);
});
test('duplicate same time speaker and full source text cannot be assigned a unique original sequence',async t=>{
 const source=structuredClone(messages);Object.assign(source[5],{speaker:source[4].speaker,beijingTime:source[4].beijingTime,text:source[4].text});
 const report=actual300.replace(sections[1].split('\n')[2],sections[1].split('\n')[1]);const{result}=await run(t,report,{source});assert.equal(result.status,'error');
});
test('a missing original source cannot authorize reordering the complete-looking report',async t=>{
 const{result}=await run(t,actual300,{source:messages.filter(m=>m.sequence!==4)});assert.equal(result.status,'error');
});
for(const userRequest of ['按主题分类，讨论顺序。','按时间倒序整理。','只分析报名意向。'])test('non-chronological request keeps original chapter order: '+userRequest,async t=>{
 const{result}=await run(t,actual300,{userRequest});assert.equal(result.status,'complete');assert.equal(result.report,actual300);
});
test('an already ordered exact-bound report is preserved byte for byte',async t=>{
 const{result}=await run(t,ordered);assert.equal(result.status,'complete');assert.equal(result.report,ordered);
});
