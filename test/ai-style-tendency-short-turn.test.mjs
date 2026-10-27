import test from 'node:test';
import assert from 'node:assert/strict';
import { learnStyleTendency, planStyleTendency } from '../server/ai-style-tendency.mjs';
import { AIAssistant } from '../server/ai-service.mjs';

const account='a'.repeat(64),contact='b'.repeat(64),now=1800000000000;
const human=(id,text)=>({id,direction:'self',authorship:'human',text,timestamp:now/1000-60,styleRoundId:id});
const send=(id,text,at,round)=>({id,operationId:id,source:'reply',confirmed:true,deliveryConfidence:'confirmed',text,at,styleRoundId:round});

test('one-character human replies remain negative observations in the per-turn expression frequency',()=>{
  const samples=[...Array.from({length:3},(_,i)=>human('laugh'+i,'哈哈')),
    ...Array.from({length:20},(_,i)=>human('plain'+i,['好','嗯','行'][i%3]))];
  const state=learnStyleTendency({account,contact,samples,now});
  assert.equal(state.sampleCount,23);
  assert.equal(state.traits.laughter.sampleCount,23);
  assert.equal(state.traits.laughter.evidenceCount,3);
  assert.equal(state.traits.laughter.rate,0.13);
  assert.equal(state.traits.laughter.preference,'neutral','Three laughter turns among23 cannot become a100% habit by dropping short confirmations');
});

test('the most recent eight confirmed reply rounds include one-character sends',()=>{
  const recentSends=[send('old-laugh','哈哈',now-10000,1),
    ...Array.from({length:8},(_,i)=>send('plain'+i,['好','嗯','行'][i%3],now-8000+i*1000,i+2))];
  const state=learnStyleTendency({account,contact,samples:[human('h1','哈哈'),human('h2','哈哈'),human('h3','哈哈')],recentSends,now});
  assert.equal(state.confirmedSendCount,9);
  assert.equal(state.recentUsage.roundCount,8);
  assert.equal(state.recentUsage.traits.laughter.rounds,0);
  assert.equal(state.recentUsage.traits.laughter.latestUsed,false);
  const {plan}=planStyleTendency({state,account,contact,styleRoundId:10,now});
  assert.doesNotMatch(plan.traits.laughter.guidance,/上一轮实际用过|最近连续/u,'Old decoration must age out after eight actually sent plain rounds');
});

test('ordinary assistant tendency preparation retains eligible short turns and still rejects unknown or whitespace sources',()=>{
  const profile={id:'profile',account,contact,kind:'person',sentMessages:[],styleRoundSequence:0};
  const messages=[];
  for(let i=0;i<23;i++){
    messages.push({id:'other'+i,direction:'other',authorship:'other',text:'普通补充',timestamp:now/1000-120+i*2});
    messages.push({...human('h'+i,i<3?'哈哈':'好'),timestamp:now/1000-119+i*2});
  }
  messages.push({...human('unknown','哈'),authorship:'unknown'},{...human('ai','哈'),authorship:'ai',aiGenerated:true},human('blank','  '));
  const assistant={preparedReplyKey:()=> 'fixed-existing-policy',now:()=>now,vault:{open:x=>x}};
  const before=structuredClone(messages);
  const plan=AIAssistant.prototype.prepareExpressionTendency.call(assistant,profile,messages,{revision:'synthetic-scoped-snapshot'},{});
  assert.equal(plan.traits.laughter.sampleCount,23);
  assert.equal(plan.traits.laughter.evidenceCount,3);
  assert.equal(plan.traits.laughter.rate,0.13);
  assert.equal(plan.traits.laughter.preference,'neutral');
  assert.equal(profile.styleTendency.sampleCount,23);
  assert.deepEqual(messages,before);
  assert.equal(profile.styleRoundSequence,1);
});

test('short confirmed text does not admit failed, unknown, future, other-account or empty observations',()=>{
  const samples=[human('valid','好'),{...human('unknown','哈'),authorship:'unknown'},
    {...human('ai','哈'),aiGenerated:true},human('blank',' '),{...human('future','哈'),timestamp:now/1000+1}];
  const recentSends=[send('ok','好',now-1000,1),{...send('unknown','哈',now-500,2),deliveryConfidence:'unknown'},
    {...send('failed','哈',now-500,3),confirmed:false},send('blank',' ',now-100,4),send('future','好',now+1,5)];
  const state=learnStyleTendency({account,contact,samples,recentSends,now});
  assert.equal(state.sampleCount,1);assert.equal(state.confirmedSendCount,1);assert.equal(state.traits.laughter.evidenceCount,0);
  const other=learnStyleTendency({account:'c'.repeat(64),contact,existing:state,samples:[],recentSends:[],now});
  assert.equal(other.sampleCount,0);assert.equal(other.confirmedSendCount,0);assert.notEqual(other.scopeKey,state.scopeKey);
});

test('existing authorship, receipt and empty-text safeguards also hold with a multi-character control',()=>{
  const samples=[human('valid','收到'),{...human('unknown','哈'),authorship:'unknown'},
    {...human('ai','哈'),aiGenerated:true},human('blank',' '),{...human('future','哈'),timestamp:now/1000+1}];
  const recentSends=[send('ok','收到',now-1000,1),{...send('unknown','哈',now-500,2),deliveryConfidence:'unknown'},
    {...send('failed','哈',now-500,3),confirmed:false},send('blank',' ',now-100,4),send('future','好',now+1,5)];
  const state=learnStyleTendency({account,contact,samples,recentSends,now});
  assert.equal(state.sampleCount,1);assert.equal(state.confirmedSendCount,1);assert.equal(state.traits.laughter.evidenceCount,0);
});
