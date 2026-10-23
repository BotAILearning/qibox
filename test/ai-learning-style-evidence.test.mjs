import test from'node:test';
import assert from'node:assert/strict';
import {learningStyleEvidence} from'../server/ai-context-learning.mjs';
const pair=(id,time)=>[{id:id+'o',direction:'other',authorship:'other',text:'合成来信'+id,timestamp:time},{id:id+'s',direction:'self',authorship:'human',text:'合成本人接话'+id,timestamp:time+1}];
test('learning supplement spans available time with whole actual interactions and explicitly limited coverage',()=>{
 const rows=[];for(let n=0;n<80;n++)rows.push(...pair(String(n),1000+n*86400));const before=structuredClone(rows),v=learningStyleEvidence(rows,{sourceTruncated:true});
 assert.equal(v.coverage.availableHumanMessages,80);assert.equal(v.coverage.sourceTruncated,true);assert.equal(v.coverage.firstHumanTimestamp,1001);assert.equal(v.coverage.lastHumanTimestamp,1001+79*86400);
 assert(v.samples.length<=12&&v.pairedExamples.length<=6);assert(v.samples.some(x=>x.id==='0s'));assert(v.samples.some(x=>x.id==='79s'));
 assert(v.pairedExamples.some(x=>x.reply.id==='0s'));assert(v.pairedExamples.some(x=>x.reply.id==='79s'));
 assert(v.samples.reduce((n,x)=>n+x.text.length,0)<=1800);assert(v.pairedExamples.reduce((n,x)=>n+x.incoming.text.length+x.reply.text.length,0)<=2400);assert.deepEqual(rows,before);
});
test('excluded AI remains an adjacency boundary; ambiguous IDs and unknown authors never become interaction evidence',()=>{
 const rows=[{id:'o',direction:'other',authorship:'other',text:'真正的前文',timestamp:100},{id:'ai',direction:'self',authorship:'ai',aiGenerated:true,text:'不能学这段AI口吻',timestamp:101},{id:'h',direction:'self',authorship:'human',text:'真人后来补了一句',timestamp:102},...pair('duplicate',200),...pair('duplicate',210),{id:'unknown',direction:'self',authorship:'unknown',text:'不能学未知来源',timestamp:300}];
 const v=learningStyleEvidence(rows);assert.deepEqual(v.pairedExamples,[]);assert.equal(v.samples.length,1);assert.equal(v.samples[0].id,'h');assert(!JSON.stringify(v).includes('不能学'));
});
test('group learning never invents private adjacent reply relations or missing scenes',()=>{
 const v=learningStyleEvidence(pair('g',100),{kind:'group'});assert.deepEqual(v.pairedExamples,[]);assert.equal(v.coverage.availableHumanMessages,1);assert.match(v.instruction,/没有覆盖/);assert(!Object.hasOwn(v,'personality'));
});
test('combined learning cannot recover omitted or partially clipped facts through style examples or invent adjacency across them',()=>{
 const rows=[...pair('old',100),...pair('kept',200),...pair('partial',300)];
 const material=[...rows.slice(2,4),{...rows[5],text:'截断片段'}];
 const result=learningStyleEvidence(rows,{material,sourceTruncated:true});
 assert.deepEqual(result.samples.map(x=>x.id),['kepts']);assert.deepEqual(result.pairedExamples.map(x=>x.reply.id),['kepts']);
 assert(!JSON.stringify(result).includes('合成本人接话old'));assert(!JSON.stringify(result).includes('合成本人接话partial'));
});
