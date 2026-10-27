import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DataChatBridge } from '../server/ai-data.mjs';
import { safeFactMessage } from '../server/ai-learning-policy.mjs';
import { naturalStyleEvidence } from '../server/ai-natural-style.mjs';
import { tailWithinLimit, analysisPrompt } from '../server/ai-analysis.mjs';
import { python } from '../scripts/tooling.mjs';
import { key } from './ai-fixtures.mjs';

const account=key('partial-read-owner'),contact=key('partial-read-contact');
const person={id:contact,label:'合成读取对象',kind:'person',native:{account:key('native-owner'),contact:key('native-contact')}};
function reader(messages) {
 const runtime={status:'running',desktopEnv:{},processes:[{name:'wechat',process:{pid:123}}],foregroundRequested(){assert.fail('No native UI');}};
 return new DataChatBridge(runtime,{async invokeData(action,args){
  if(action==='account')return{available:true,account};
  if(['contacts','identity'].includes(action))return{available:true,account,contacts:[person]};
  return{available:true,account,contact:args.contact,label:person.label,native:person.native,revision:key('partial-read-revision'),messages:structuredClone(messages)};
 }});
}
test('native per-message partial markers survive bridge reads without marking complete neighbours',async t=>{
 const rows=[{id:key('partial'),direction:'other',text:'只读到开头',timestamp:100,textTruncated:true},{id:key('whole'),direction:'self',text:'完整原话',timestamp:101}];
 const bridge=reader(rows);t.after(()=>bridge.close());await bridge.scan();const result=await bridge.read({account,contact});
 assert.equal(result.messages[0].textTruncated,true);assert.equal(result.messages[0].text,rows[0].text);assert(!Object.hasOwn(result.messages[1],'textTruncated'));assert.equal(result.truncated,true);
});
test('bridge Unicode length fallback marks the exact shortened message',async t=>{
 const bridge=reader([{id:key('oversized'),direction:'other',text:'😀'.repeat(150001),timestamp:100}]);t.after(()=>bridge.close());await bridge.scan();const result=await bridge.read({account,contact});
 assert.equal(Array.from(result.messages[0].text).length,150000);assert.equal(result.messages[0].textTruncated,true);assert(result.truncatedReasons.includes('message_length'));
});
test('bridge rejects malformed partial flags instead of treating arbitrary truthy values as source metadata',async()=>{
 for(const textTruncated of ['false',1,{},[]]){
  const bridge=reader([{id:key('invalid-partial'),direction:'other',text:'合成原话',timestamp:100,textTruncated}]);
  try{await bridge.scan();await assert.rejects(bridge.read({account,contact}));}finally{await bridge.close();}
 }
});
test('a partial body is context but cannot certify learned facts or a complete human reply example',()=>{
 const partial={id:'partial-human',direction:'self',authorship:'human',text:'我已经确认收到了',timestamp:2,textTruncated:true};
 assert.equal(safeFactMessage(partial),false);assert.equal(safeFactMessage({...partial,textTruncated:undefined}),true);
 const evidence=naturalStyleEvidence([{id:'incoming',direction:'other',authorship:'other',text:'终于分清了',timestamp:1},partial]);assert.equal(evidence.samples.length,0);assert.equal(evidence.pairedExamples.length,0);
});
test('report selection excludes pre-existing prefix fragments and discloses their count without rewriting complete neighbours',()=>{
 const rows=[{id:'head',direction:'other',timestamp:1,text:'我说的到账',textTruncated:true},{id:'full',direction:'self',timestamp:2,text:'本人车位费已经到账'}],before=structuredClone(rows),selection=tailWithinLimit(rows);
 assert.deepEqual(selection.messages,[rows[1]]);assert.deepEqual(rows,before);assert.equal(selection.coverage.partialMessages,0);assert.equal(selection.coverage.omittedIncompleteMessages,1);assert.equal(selection.coverage.omittedMessages,1);assert.equal(selection.coverage.truncated,true);
 assert.doesNotMatch(analysisPrompt('',{partialSource:true}),/只保留原文尾段/);assert.match(analysisPrompt('',{partialSource:true}),/textTruncated/);assert.doesNotMatch(analysisPrompt(''),/textTruncated/);
});
test('native encrypted SQLite reader exposes its per-row clipping marker at both size boundaries',()=>{
 const result=spawnSync(python,[fileURLToPath(new URL('./wechat_data.py',import.meta.url)),'DataTest.test_recent_clipped_message_retains_partial_source_marker','DataTest.test_decoded_clipped_message_retains_partial_source_marker'],{encoding:'utf8',timeout:60000,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
});
