import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { personalInformation, stageSelfSuggestions, selfContext } from '../server/ai-account-configuration.mjs';
import { personalFieldDefinitions } from '../server/ai-personal-fields.mjs';
import { readMemory, editMemory, mergeMemory } from '../server/ai-wiki.mjs';
import { timingValue, effectiveTiming, mergeDueAt } from '../server/ai-timing.mjs';
import { WechatScheduler } from '../server/scheduler.mjs';
import { deduplicateLearnedFacts } from '../server/ai-learning-policy.mjs';
import { ChatFixture, AIModelFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let now = Date.UTC(2026,9,18,2);
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); t.after(async () => { await a.close(); await cleanup(root); });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const c = bridge.contacts[0]; await a.saveReplyProfile({ contact: c.id, style: { summary: '自然简洁' }, strategy, replyEnabled: false });
  const p = a.profiles()[0], advance = ms => now += ms;
  const push = (direction, text, extra = {}) => Object.assign(bridge.push(c.id,direction,text), { timestamp: Math.floor(now/1000), ...extra });
  const enable = async () => { await a.settings({ autoLearning: true }); await a.tick(); };
  return { a,p,c,bridge,provider,root,advance,push,enable };
}

test('0.11 fields migrate independently without widening mixed sharing or clearing history', async t => {
  const f = await fixture(t), a = f.a;
  assert.equal(personalFieldDefinitions.length,12);
  assert.equal(a.data.settings.autoLearning,false);
  a.data.personalInformation = { [a.data.account]: a.vault.seal({ entries:[
    {id:'name-row',field:'name',text:'私密姓名',allowGroup:false,source:'manual'},
    {id:'nickname-row',field:'addressing',text:'公开昵称',allowGroup:true,source:'manual'},
    {id:'company-row',field:'organization',text:'私密单位',allowGroup:false,source:'manual'},
    {id:'plan-row',field:'plans',text:'2026年10月20日出差',allowGroup:false,source:'manual'},
  ],history:[{at:1,entries:[{field:'name',text:'旧称呼'}]}] }) };
  const entries = personalInformation(a).entries;
  assert.equal(entries.filter(row=>row.field==='addressing').length,2);
  assert.deepEqual(selfContext(a,'group').map(row=>row.text),['公开昵称']);
  await a.configuration({type:'personal-information',entries});
  assert.equal(personalInformation(a).history[0].entries[0].text,'旧称呼');
  assert.equal(personalInformation(a).entries.find(row=>row.id==='company-row').allowGroup,false);
});

test('0.11 automatic learning works while AI reply master is off and never sends', async t => {
  const f = await fixture(t); await f.enable(); f.advance(1000);
  const human = f.push('self','我现在住在深圳南山区'); const other=f.push('other','我喜欢喝普洱茶'); await f.a.tick();
  f.provider.complete=async()=>({memoryUpdates:[{field:'other',text:'对方喜欢普洱茶',evidence:[other.id]}],selfMemorySuggestions:[{field:'city',text:'常住深圳南山区',messageId:human.id}]});
  f.advance(21000);await f.a.tick();
  assert.equal(f.a.data.settings.enabled,false);assert.equal(f.bridge.sent.length,0);
  const mine=personalInformation(f.a).entries[0];assert.equal(mine.source,'auto');assert.equal(mine.allowGroup,false);assert.equal(mine.observedAt,human.timestamp*1000);
  const memory=readMemory(f.a.vault,f.p).entries[0];assert.equal(memory.object,f.c.id);assert.equal(memory.account,f.a.data.account);
  assert.doesNotMatch(await readFile(f.a.file,'utf8'),/深圳南山区|普洱茶/);
});

test('0.11 closing during a model request discards result; reopening never backfills disabled messages', async t => {
  const f = await fixture(t); await f.enable(); f.advance(1000); const msg=f.push('other','我住杭州');await f.a.tick();f.advance(21000);
  let entered;const started=new Promise(resolve=>entered=resolve);let release;const blocked=new Promise(resolve=>release=resolve);
  f.provider.complete=async()=>{entered();await blocked;return {memoryUpdates:[{text:'对方住杭州',evidence:[msg.id]}]};};
  const pending=f.a.tick();await started;await f.a.settings({autoLearning:false});release();await pending;
  assert.equal(readMemory(f.a.vault,f.p).entries.length,0);
  f.advance(1000);const disabled=f.push('other','我养了一只猫');await f.a.tick();f.advance(1000);await f.enable();
  assert.equal(f.p.memoryWatch.learned,disabled.id);f.advance(21000);await f.a.tick();assert.equal(readMemory(f.a.vault,f.p).entries.length,0);
});

test('0.11 manual facts are protected and deleted automatic evidence cannot resurrect', async t => {
  const f=await fixture(t);await f.enable(); const a=f.a;
  await a.configuration({type:'personal-information',entries:[{field:'city',text:'本人确认城市'}]});
  const source={id:key('city'),direction:'self',authorship:'human',text:'我现在住深圳',timestamp:1};
  assert.equal(stageSelfSuggestions(a,[{field:'city',text:'深圳',messageId:source.id}],[source]),false);
  const hobby={...source,id:key('hobby'),text:'我喜欢徒步'};
  assert.equal(stageSelfSuggestions(a,[{field:'interests',text:'喜欢徒步',messageId:hobby.id}],[hobby]),true);
  await a.configuration({type:'personal-information',entries:personalInformation(a).entries.filter(row=>row.field!=='interests')});
  assert.equal(stageSelfSuggestions(a,[{field:'interests',text:'常去徒步',messageId:hobby.id}],[hobby]),false);
  for(const extra of [{aiGenerated:true},{authorship:'unknown'},{type:'quote'},{forwarded:true}]) assert.equal(stageSelfSuggestions(a,[{field:'other',text:'不能保存',messageId:source.id}],[{...source,...extra}]),false);
});

test('0.11 learning results queued behind storage cannot cross a closing switch',async t=>{
 const f=await fixture(t);await f.enable();f.advance(1000);const other=f.push('other','我住苏州');const human=f.push('self','我喜欢徒步');await f.a.tick();f.advance(21000);
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();
 f.provider.complete=async()=>{f.a.writes=gate.promise;entered.resolve();return {memoryUpdates:[{text:'对方住苏州',evidence:[other.id]}],selfMemorySuggestions:[{field:'interests',text:'喜欢徒步',messageId:human.id}]};};
 const pending=f.a.tick();await entered.promise;await new Promise(setImmediate);
 const closing=f.a.settings({autoLearning:false});await new Promise(setImmediate);assert.equal(f.a.data.settings.autoLearning,false);
 gate.resolve();await Promise.all([pending,closing]);
 assert.equal(readMemory(f.a.vault,f.p).entries.length,0);assert.equal(personalInformation(f.a).entries.length,0);
});

test('0.11 style accumulates authorized samples across batches and one new sentence cannot replace it',async t=>{
 const f=await fixture(t);delete f.p.replyStyleSource;delete f.p.styleId;f.p.style={summary:'初始默认风格',customTone:'',customAvoid:''};await f.enable();
 let phase=0;f.provider.complete=async()=>({memoryUpdates:[],style:{summary:phase<4?'短句口语，温和简洁':'正式公文，不用表情'}});
 for(const text of ['嗯嗯，慢慢来🙂','好的呀，不着急哈','行的呀，再看看🙂','请采用正式公文口吻']){
  phase++;f.advance(121000);f.push('self',text);await f.a.tick();f.advance(21000);await f.a.tick();
  if(phase<3)assert.equal(f.p.learnedStyle,undefined);else assert.equal(f.p.learnedStyle.summary,'短句口语，温和简洁');
 }
 const evidence=[...f.p.styleLearning.evidence];assert.equal(evidence.length,3);
 await f.a.settings({autoLearning:false});f.advance(1000);const closed=[f.push('self','关闭期间的第一条'),f.push('self','关闭期间的第二条'),f.push('self','关闭期间的第三条')];f.advance(1000);await f.enable();f.advance(1000);f.push('self','重新开启后的单条');await f.a.tick();f.advance(21000);await f.a.tick();
 assert.deepEqual(f.p.styleLearning.evidence,evidence);const samples=f.a.automaticStyleSamples(f.p,f.bridge.messages.get(f.c.id).map(row=>({...row,authorship:'human'})));assert.ok(samples.every(row=>!closed.some(old=>old.id===row.id)));
});

test('0.11 timing persists, inherits and bounds the entire message burst independently of takeover', async t=>{
  const f=await fixture(t);await f.a.settings({replyDelay:7,replyMaxWait:15,segmentDelayMin:1,segmentDelayMax:2});
  await f.a.saveReplyProfile({contact:f.c.id,style:{summary:'自然简洁'},strategy,timing:{replyDelay:2,replyMaxWait:5},takeover:{enabled:true,minutes:9}});
  assert.equal(effectiveTiming(f.a.data.settings,f.p).replyDelay,2);
  assert.equal(mergeDueAt({changedAt:14000,pendingSince:0},effectiveTiming(f.a.data.settings,f.p)),5000);
  assert.equal(f.a.randomDelay('segmentDelay',f.p)>=1000,true);
  assert.throws(()=>timingValue({replyDelay:9,replyMaxWait:2}));
  const stored=JSON.parse(await readFile(f.a.file,'utf8'));assert.equal(stored.settings.replyDelay,7);assert.equal(stored.profiles[f.p.id].takeover.minutes,9);
  await f.a.saveReplyProfile({contact:f.c.id,style:{summary:'自然简洁'},strategy,timing:null,takeover:null});assert.equal(effectiveTiming(f.a.data.settings,f.p).replyDelay,7);
});

test('0.11 failed learning consumes its batch once without affecting normal chat',async t=>{
 const f=await fixture(t);await f.enable();f.advance(1000);const msg=f.push('other','我喜欢读书');await f.a.tick();let calls=0;
 f.provider.complete=async()=>{calls++;throw Error('offline');};f.advance(21000);await f.a.tick();f.advance(200000);await f.a.tick();assert.equal(calls,1);assert.equal(f.p.memoryWatch.learned,msg.id);assert.equal(f.bridge.sent.length,0);
});

test('0.11 deleted contact facts cannot return with reworded text from the same evidence',async t=>{
 const f=await fixture(t);const source=key('deleted-source');
 Object.assign(f.p,mergeMemory(f.a.vault,f.p,{entries:[{field:'other',text:'对方养猫',evidence:[source]}]},f.a.now()));
 Object.assign(f.p,editMemory(f.a.vault,f.p,{entries:[]},f.a.now()));
 Object.assign(f.p,mergeMemory(f.a.vault,f.p,{entries:[{field:'other',text:'对方有一只宠物猫',evidence:[source]}]},f.a.now()));
 assert.equal(readMemory(f.a.vault,f.p).entries.length,0);
});

test('0.11 group facts require actual member ownership and sensitive or self-only evidence is excluded',async t=>{
 const f=await fixture(t);await f.enable();f.p.kind='group';
 const source={id:key('member'),direction:'other',authorship:'other',type:'text',sender:key('member-one'),text:'我喜欢咖啡',timestamp:1};
 f.a.mergeObservedMemory(f.p,[{field:'group_member',text:'成员喜欢咖啡',subjectId:'member:'+key('other-member'),evidence:[source.id]}],[source]);
 assert.equal(readMemory(f.a.vault,f.p).entries.length,0);
 f.a.mergeObservedMemory(f.p,[{field:'group_member',text:'成员喜欢咖啡',subjectId:'member:'+source.sender,evidence:[source.id]}],[source]);
 assert.equal(readMemory(f.a.vault,f.p).entries[0].subjectId,'member:'+source.sender);
 await assert.rejects(f.a.configuration({type:'personal-information',entries:[{field:'other',text:'API key: sk-do-not-store-this-private-value'}]}),/密码|密钥/);
});

test('0.11 legacy style permission never silently grants automatic learning of all facts',async t=>{
 const f=await fixture(t);await assert.rejects(f.a.settings({updateStyle:true}),/总开关/);assert.equal(f.a.data.settings.autoLearning,false);
});

test('0.11 relevant dietary safety is retrieved without exposing unrelated personal history',async t=>{
 const f=await fixture(t);await f.a.configuration({type:'personal-information',entries:[{field:'health',text:'花生过敏'},{field:'experiences',text:'曾经去过另一个城市'}]});
 const context=selfContext(f.a,'person','晚饭吃什么？');assert.equal(context.some(row=>row.field==='health'),true);assert.equal(context.some(row=>row.field==='experiences'),false);assert.deepEqual(selfContext(f.a,'group','晚饭吃什么？'),[]);
});

test('0.11 duplicate residence extraction keeps one fact while distinct experiences and member identities survive',()=>{
 const residence={field:'residence',text:'对方现居苏州园区，已搬好房子',subjectId:'contact:one',evidence:['one']};
 const duplicate={...residence,field:'other',text:'对方搬迁并入住苏州工业园区'};
 assert.equal(deduplicateLearnedFacts([residence,duplicate]).length,1);
 assert.equal(deduplicateLearnedFacts([duplicate,residence]).length,1);
 assert.equal(deduplicateLearnedFacts([residence,{...duplicate,text:'和本人一起搬家后很累'}]).length,2);
 assert.equal(deduplicateLearnedFacts([residence,{...residence,subjectId:'contact:two'}]).length,2);
});

test('0.11 a failed settings write cannot turn automatic learning on in memory',async t=>{
 const f=await fixture(t),save=f.a.save;f.a.save=async()=>{throw Error('disk failure');};
 try{await assert.rejects(f.a.settings({autoLearning:true}),/disk failure/);assert.equal(f.a.data.settings.autoLearning,false);}finally{f.a.save=save;}
});

test('0.11 idle scheduler yields to measured resources, resumes with low priority and respects user ownership',async t=>{
 const root=await temp();t.after(()=>cleanup(root));const runtime={status:'stopped'};let busy=true,starts=0,stops=0,priorities=0;
 const scheduler=new WechatScheduler({dataRoot:root,runtime,ready:()=>true,now:()=>new Date('2026-10-18T18:30:00Z'),resources:async()=>({allowed:!busy,reason:busy?'网络繁忙':''}),setPriority:async()=>{priorities++;return true;},start:async()=>{starts++;runtime.status='running';},stop:async()=>{stops++;runtime.status='stopped';}});
 await scheduler.init();await scheduler.save({mode:'idle',startTime:'02:00',endTime:'03:00'});await scheduler.tick();assert.equal(starts,0);
 busy=false;await scheduler.tick();assert.equal(starts,1);assert.equal(priorities,1);
 busy=true;await scheduler.tick();assert.equal(stops,1);busy=false;await scheduler.tick();assert.equal(starts,2);
 await scheduler.interact();busy=true;await scheduler.tick();assert.equal(stops,1);assert.equal(runtime.status,'running');await scheduler.close();
});

test('0.11 explicit event dates stay separate from source and save times, automatic changes retain history and privacy',async t=>{
 const f=await fixture(t);await f.enable();
 const first=f.push('self','2026年10月20日已确定去杭州出差，住处一直在南京。',{authorship:'human'});
 stageSelfSuggestions(f.a,[{field:'status',text:'2026年10月20日已确定去杭州出差',messageId:first.id},{field:'city',text:'住在南京',messageId:first.id}],[first]);
 const old=personalInformation(f.a).entries.find(row=>row.field==='city');
 f.advance(1000);const change=f.push('self','我现在已经搬到苏州了。',{authorship:'human'});
 stageSelfSuggestions(f.a,[{field:'city',text:'常住苏州',messageId:change.id,replaces:old.id}],[change]);
 const rows=personalInformation(f.a).entries;
 assert.equal(rows.find(row=>row.id===old.id).status,'historical');assert.equal(rows.find(row=>row.text==='常住苏州').allowGroup,false);
 const plan=rows.find(row=>row.field==='status');assert.equal(plan.factTime,'2026-10-20');assert.equal(plan.observedAt,first.timestamp*1000);assert.notEqual(plan.factTime,plan.observedAt);assert.equal(rows.find(row=>row.text==='常住苏州').factTime,null);
});
