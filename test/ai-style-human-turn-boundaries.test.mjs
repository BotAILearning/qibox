import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';

const now=1800000000000,base=now/1000-10000;
const human=(id,text,timestamp)=>({id,direction:'self',authorship:'human',text,...(timestamp===undefined?{}:{timestamp})});
function observe(messages){
  const account='a'.repeat(64),contact='b'.repeat(64),profile={id:'profile',account,contact,kind:'person',sentMessages:[],styleRoundSequence:0};
  const assistant={preparedReplyKey:()=> 'existing-policy',now:()=>now,vault:{open:x=>x}};
  const original=structuredClone(messages);
  const plan=AIAssistant.prototype.prepareExpressionTendency.call(assistant,profile,messages,{revision:'scoped-human-boundaries'},{});
  assert.deepEqual(messages,original);assert.equal(profile.styleRoundSequence,1);
  return {state:profile.styleTendency,plan};
}

test('human messages separated by a long silent gap are independent expression observations',()=>{
  const {state,plan}=observe([human('burst-laugh','哈哈',base),human('same-burst','这也太离谱了',base+20),human('later-plain','好',base+7200)]);
  assert.equal(state.sampleCount,2,'Two hours without a reply cannot turn two expression turns into one');
  assert.equal(plan.traits.laughter.sampleCount,2);assert.equal(plan.traits.laughter.evidenceCount,1);assert.equal(plan.traits.laughter.rate,0.5);
});

test('missing or reversed source times do not certify messages as a single human turn',()=>{
  for(const timestamps of [[undefined,undefined],[base,undefined,base+1],[base+30,base]]){
    const {state}=observe(timestamps.map((at,i)=>human('unknown-time-'+i,i===0?'哈哈':'好',at)));
    assert.equal(state.sampleCount,timestamps.length,'No reliable short chronological gap means no burst merge');
  }
});

test('short consecutive human segments remain one observation across a display date boundary',()=>{
  const midnight=Math.floor(base/86400)*86400;
  const {state}=observe([human('before-midnight','哈哈',midnight-30),human('after-midnight','行',midnight+30),human('same-burst','收到',midnight+330)]);
  assert.equal(state.sampleCount,1);assert.equal(state.traits.laughter.evidenceCount,1);assert.equal(state.traits.laughter.rate,1);
});

test('another speaker and uncertain authorship break human bursts without promoting AI samples',()=>{
  const {state}=observe([human('h1','哈哈',base),{id:'other',direction:'other',authorship:'other',text:'普通补充',timestamp:base+1},human('h2','好',base+2),{...human('unknown','哈哈',base+3),authorship:'unknown'},human('h3','行',base+4),{...human('ai','哈哈',base+5),authorship:'ai',aiGenerated:true},human('h4','嗯',base+6)]);
  assert.equal(state.sampleCount,4);assert.equal(state.traits.laughter.evidenceCount,1);assert.equal(state.traits.laughter.rate,0.25);
});
