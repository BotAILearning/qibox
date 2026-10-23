import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalStyleEvidence } from '../server/ai-natural-style.mjs';
const pair=(id,incoming,reply,timestamp=100)=>[
  {id:id+'i',direction:'other',authorship:'other',text:incoming,timestamp},
  {id:id+'s',direction:'self',authorship:'human',text:reply,timestamp:timestamp+1},
];
test('current incoming retrieves a related earlier human interaction beyond the newest three without changing facts or state',()=>{
  const rows=[...pair('p','字幕额度又快用完了','真能烧啊'),...pair('a','晚饭吃啥','随便吃点',200),...pair('b','明天几点','九点',300),...pair('c','照片挑完了','那就好',400),...pair('d','今天下雨了','带伞吧',500)];
  const before=structuredClone(rows),result=naturalStyleEvidence(rows,{query:'字幕项目，这额度烧得真快',maxPairs:1});
  assert.equal(result.pairedExamples[0].reply.id,'ps');assert.equal(result.pairedExamples[0].relation,'adjacent-context');assert.deepEqual(rows,before);
});
test('self answer keywords and AI text cannot win expression retrieval; missing relevance falls back to recent human examples',()=>{
  const rows=[...pair('bait','早上好','字幕额度字幕额度'),...pair('recent','晚上吃什么','吃面吧',200),...pair('ai','字幕额度怎么用','你这额度烧得狠',300)];rows.at(-1).aiGenerated=true;
  const result=naturalStyleEvidence(rows,{query:'字幕额度',maxPairs:1});assert.equal(result.pairedExamples[0].reply.id,'recents');assert(!result.samples.some(x=>x.id==='ais'));
});
test('selected related examples retain source chronology and the shared character budget',()=>{
  const rows=[...pair('a','字幕额度','慢点用',100),...pair('b','字幕项目','挺费的',200),...pair('c','字幕太长','分开弄',300)];
  const result=naturalStyleEvidence(rows,{query:'字幕项目额度',maxPairs:3,maxPairChars:14});assert(result.pairedExamples.length>0);
  assert(result.pairedExamples.reduce((n,p)=>n+p.incoming.text.length+p.reply.text.length,0)<=14);
  const ids=result.pairedExamples.map(p=>p.reply.id);assert.deepEqual(ids,[...ids].sort());
});
test('retrieval does not relax group quote, duplicate, uncertain receipt or sensitive self filters',()=>{
  const rows=[...pair('plain','字幕额度','真能烧啊'),...pair('unknown','字幕额度','不应学',200)];rows.at(-1).deliveryConfidence='unknown';
  assert.deepEqual(naturalStyleEvidence(rows,{kind:'group',query:'字幕额度'}).pairedExamples,[]);
  assert(!naturalStyleEvidence(rows,{query:'字幕额度'}).samples.some(x=>x.id==='unknowns'));
});
