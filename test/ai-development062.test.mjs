import test from 'node:test';
import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {readMemory,mergeMemory,editMemory,memoryValue,memoryMergePrompt} from '../server/ai-wiki.mjs';
import {ChatFixture,AIModelFixture,modelConfig,strategy} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
import {validateClipboardFiles} from '../server/clipboard.mjs';
import {wikiEntryMarkup,memoryFields,sameWikiEntries} from '../web/ai-memory-view.mjs';
import {objectList,objectPage} from '../web/ai-object-view.mjs';
async function fixture(t){
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let now=Date.UTC(2026,8,17,0);
 const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{}});await a.init();
 t.after(async()=>{await a.close();await cleanup(root);});await a.configure(modelConfig);await a.scan();
 return {a,bridge,provider,advance:ms=>now+=ms};
}
test('Wiki appends facts, protects manual entries, retains others, encrypts history, and rolls back',async t=>{
 const {a}=await fixture(t),p={};
 Object.assign(p,editMemory(a.vault,p,{summary:'本人明确的旧约定'},1));
 const manual=readMemory(a.vault,p).entries[0];
 Object.assign(p,mergeMemory(a.vault,p,{entries:[{id:manual.id,text:'相反的新约定'},{text:'新事实',manual:true}]},2));
 assert.equal(readMemory(a.vault,p).summary,'本人明确的旧约定\n新事实');
 assert.equal(readMemory(a.vault,p).entries[1].manual,undefined);
 assert.equal(readMemory(a.vault,p,'memorySuggestion').summary,'相反的新约定');
 assert.doesNotMatch(JSON.stringify(p),/旧约定|新事实/);
 Object.assign(p,editMemory(a.vault,p,{restoreId:p.memoryHistory[0].id},3));
 assert.equal(readMemory(a.vault,p).summary,'本人明确的旧约定');
 assert.throws(()=>editMemory(a.vault,{}, {restoreId:p.memoryHistory[0].id},4),/历史版本/);
});
test('chat memory accepts only evidence IDs actually supplied for this contact',async t=>{
 const {a}=await fixture(t),p={};
 Object.assign(p,mergeMemory(a.vault,p,{entries:[{text:'有依据',evidence:['m1']},{text:'未发送承诺',evidence:['planned']},{text:'无证据'}]},1,{evidence:new Set(['m1'])}));
 assert.equal(readMemory(a.vault,p).summary,'有依据');
});
test('memory learning preserves model field assignments as grouped pending Wiki entries',async t=>{
 const {a,bridge,provider}=await fixture(t),contact=bridge.contacts[0].id;
 bridge.messages.set(contact,[{id:'peer-1',direction:'other',text:'我是林女士，电话 13800000001，生日正月初八，毕业于浙江大学，户籍在杭州，平时喜欢徒步。'}]);
 provider.complete=async(_config,prompt,input)=>{
  assert.match(prompt,/基础资料字段描述当前聊天对象（对方）本人/);
  assert.deepEqual(input.material.map(message=>message.direction),['other']);
  return {memory:{entries:[
   {field:'name',text:'林女士'}, {field:'phone',text:'13800000001'}, {field:'birthday',calendar:'lunar',text:'正月初八'},
   {field:'school',degree:'本科',text:'浙江大学'}, {field:'household',text:'杭州市'}, {field:'other',text:'喜欢徒步'}
  ]}};
 };
 await a.learn({contacts:[contact],target:'memory',perspective:'other'});
 const profile=a.profiles().find(item=>item.contact===contact),pending=a.pendingMemoryOf(profile);
 assert.deepEqual(pending.entries.map(entry=>entry.field),['name','phone','birthday','school','household','other']);
 assert.equal(pending.entries[2].calendar,'lunar');assert.equal(pending.entries[3].degree,'本科');
 const markup=memoryFields({memory:{entries:pending.entries}});
 for(const field of ['name','phone','birthday','school','household','other']) assert.match(markup,new RegExp(`data-ai-wiki-field="${field}"[\\s\\S]*?${field==='name'?'林女士':field==='phone'?'13800000001':field==='birthday'?'正月初八':field==='school'?'浙江大学':field==='household'?'杭州市':'喜欢徒步'}`));
});
test('legacy wiki text migrates to other and typed facts preserve calendar and period',()=>{
 const old=memoryValue({summary:'旧版学校记忆\n旧版住址'});
 assert.deepEqual(old.entries.map(e=>e.field),['other','other']);
 const typed=memoryValue({entries:[{field:'birthday',calendar:'lunar',text:'正月初八'},{field:'residence',from:1000,to:2000,text:'杭州市'},{field:'school',degree:'本科',text:'浙江大学'}]});
 assert.equal(typed.entries[0].calendar,'lunar'); assert.equal(typed.entries[1].from,1000); assert.equal(typed.entries[1].to,2000); assert.equal(typed.entries[2].degree,'本科');
});
test('a contact can create and edit a Wiki without creating or enabling a reply profile',async t=>{
 const {a,bridge}=await fixture(t),contact=bridge.contacts[0];
 assert.equal(a.profiles().some(profile=>profile.contact===contact.id),false);
 await a.editContactMemory(contact.id,{entries:[{field:'residence',text:'地址',recordedAt:1234}]});
 const profile=a.profiles().find(item=>item.contact===contact.id);
 assert.ok(profile);assert.equal(profile.replyStrategy,undefined);assert.equal(profile.style,undefined);
 assert.equal(a.data.replyTargets.includes(profile.id),false);assert.equal(a.data.proactiveTargets.includes(profile.id),false);
 assert.equal(readMemory(a.vault,a.data.profiles[profile.id]).entries[0].recordedAt,1234);
 const before=a.data.profiles[profile.id].memory;
 await assert.rejects(a.editContactMemory(contact.id,{entries:[{field:'residence',text:'坏地址',from:20,to:10}]}),/结束时间不能早于开始时间/);
 assert.deepEqual(a.data.profiles[profile.id].memory,before);
});
test('address learning records one time point and merges repeated address text idempotently',async t=>{
 const {a}=await fixture(t), profile={}, entries=[
  {field:'residence',text:'杭州市',from:1000,to:2000},
  {field:'residence',text:'杭州市',from:3000,to:4000},
 ];
 const parsed=memoryValue({entries}), savedAgain=memoryValue({entries});
 assert.notEqual(parsed.entries[0].id,parsed.entries[1].id);
 assert.deepEqual(savedAgain.entries.map(e=>e.id),parsed.entries.map(e=>e.id));
 assert.equal(sameWikiEntries(parsed.entries,[{...parsed.entries[0],updatedAt:77,source:'learning'},parsed.entries[1]]),true);
 assert.equal(sameWikiEntries([parsed.entries[0]],[parsed.entries[1]]),false);
 Object.assign(profile,mergeMemory(a.vault,profile,{entries},100));
 assert.equal(readMemory(a.vault,profile).entries.length,1);
 assert.equal(readMemory(a.vault,profile).entries[0].from,undefined);
 assert.equal(readMemory(a.vault,profile).entries[0].to,undefined);
 assert.equal(readMemory(a.vault,profile).entries[0].recordedAt,undefined,'没有模型给出的消息时间时不使用学习执行时间');
 const historyBefore=profile.memoryHistory.length;
 Object.assign(profile,mergeMemory(a.vault,profile,{entries},101));
 assert.equal(readMemory(a.vault,profile).entries.length,1);
 assert.equal(profile.memoryHistory.length,historyBefore);
});
test('Wiki merge persists same-text field and metadata changes and prompt preserves full entry schema',async t=>{
 const {a}=await fixture(t), profile={};
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{id:'aaaaaaaaaaaaaaaa',field:'other',text:'同一段文本'}]},100));
 const historyBefore=profile.memoryHistory.length;
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{id:'aaaaaaaaaaaaaaaa',field:'school',degree:'本科',text:'同一段文本'}]},101));
 const updated=readMemory(a.vault,profile);
 assert.equal(updated.entries[0].field,'school');
 assert.equal(updated.entries[0].degree,'本科');
 assert.equal(profile.memoryHistory.length,historyBefore+1);
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{id:'aaaaaaaaaaaaaaaa',field:'birthday',calendar:'lunar',from:1000,to:2000,text:'同一段文本'}]},102));
 const dated=readMemory(a.vault,profile).entries[0];
 assert.equal(dated.field,'birthday');assert.equal(dated.calendar,'lunar');assert.equal(dated.from,1000);assert.equal(dated.to,2000);
 assert.equal(profile.memoryHistory.length,historyBefore+2);
 assert.match(memoryMergePrompt,/field、text、degree、calendar、recordedAt/);
 assert.match(memoryMergePrompt,/不保留或推断 from\/to 时间段/);
 assert.match(memoryMergePrompt,/不可把 entries 展平/);
});
test('candidate memory merge sends all Wiki fields to the model and retains them in its result',async t=>{
 const {a,bridge,provider}=await fixture(t),contact=bridge.contacts[0];
 await a.saveReplyProfile({contact:contact.id,style:a.publicState().schema.defaultStyle,strategy:{replyGoal:'整理',facts:'事实',boundaries:'边界'}});
 const profile=a.profiles().find(item=>item.contact===contact.id);
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{field:'birthday',calendar:'lunar',text:'正月初八'},{field:'residence',text:'杭州',recordedAt:2500}]},100));
 const incoming={entries:[{field:'school',degree:'本科',text:'浙江大学'},{field:'residence',from:1000,to:2000,text:'杭州市'}]};
 a.setPendingMemory(profile,incoming);let sent;
 provider.complete=async(_config,_prompt,input)=>{sent=input;return {memory:{entries:[...input.current.entries,...input.incoming.entries]}};};
 await a.finishMemoryMerge(profile.id);
 assert.deepEqual(sent.current.entries.map(({field,calendar,recordedAt})=>({field,calendar,recordedAt})),[{field:'birthday',calendar:'lunar',recordedAt:undefined},{field:'residence',calendar:undefined,recordedAt:2500}]);
 assert.deepEqual(sent.incoming.entries.map(({field,degree,from,to})=>({field,degree,from,to})),[{field:'school',degree:'本科',from:undefined,to:undefined},{field:'residence',degree:undefined,from:undefined,to:undefined}]);
 assert.deepEqual(a.pendingMemoryOf(a.profile(profile.id)).entries.map(e=>[e.field,e.calendar,e.degree,e.from,e.to]),[['birthday','lunar',undefined,undefined,undefined],['residence',undefined,undefined,undefined,undefined],['school',undefined,'本科',undefined,undefined],['residence',undefined,undefined,undefined,undefined]]);
 assert.equal(a.pendingMemoryOf(a.profile(profile.id)).entries.find(e=>e.field==='residence'&&e.text==='杭州').recordedAt,2500);
});
test('wiki address fields use one recorded time and unchanged edits ignore audit metadata',()=>{
 const markup=wikiEntryMarkup({field:'residence',text:'杭州市',from:Date.parse('2026-09-24T16:00:00Z'),to:Date.parse('2026-09-25T15:59:59Z')});
 assert.doesNotMatch(markup,/aria-label="开始时间"|aria-label="结束时间"/);
 assert.match(markup,/时间：/);
 const values=[{id:'wiki-one',field:'name',text:' 小王 '}];
 assert.equal(sameWikiEntries(values,[{...values[0],updatedAt:100,manual:true,source:'manual'}]),true);
 assert.equal(sameWikiEntries(values,[{...values[0],text:'小张'}]),false);
 assert.match(wikiEntryMarkup({field:'birthday',text:'正月初八'}),/option value="" selected>未确定/);
 assert.doesNotMatch(wikiEntryMarkup({field:'birthday',text:'正月初八'}),/option value="solar" selected/);
 assert.match(wikiEntryMarkup({field:'residence',text:'旧地址'}),/时间：未知/);
 assert.doesNotThrow(()=>wikiEntryMarkup({field:'residence',text:'坏时间',from:Number.MAX_SAFE_INTEGER}));
 assert.equal(sameWikiEntries(values,[{...values[0],recordedAt:1234}]),false);
});
test('chat memory renders a fixed empty field template, groups addresses and keeps legacy text under other',()=>{
 const markup=memoryFields({kind:'person',memory:{summary:'旧版自由文本'}});
 assert.match(markup,/<h4>聊天记忆<\/h4>/);
 for(const field of ['name','phone','birthday','date','school','household','residence','work','shipping','other']) assert.match(markup,new RegExp(`data-ai-wiki-field="${field}"`));
 assert.doesNotMatch(markup,/data-ai-wiki-field="workplace"|data-ai-wiki-field="employer"/);
 assert.match(markup,/相识、确定关系或结婚纪念日/);
 assert.match(markup,/data-ai-wiki-field="other"[\s\S]*旧版自由文本/);
 assert.match(markup,/兴趣爱好、稳定偏好，以及双方其他聊天中值得保留的内容/);
 assert.match(markup,/data-ai-wiki-add data-ai-wiki-add-field="other">添加信息/);
 assert.doesNotMatch(markup,/每条信息单独编辑和删除/);
 const names=memoryFields({memory:{entries:[{field:'name',text:'小王'},{field:'name',text:'王女士'}]}});
 assert.equal((names.match(/data-ai-wiki-field="name"/g)||[]).length,1);
 assert.equal((names.match(/aria-label="信息内容"/g)||[]).length,2);
 assert.match(wikiEntryMarkup({field:'other',text:'喜欢徒步'}),/<textarea[^>]*aria-label="信息内容"/);
});
test('empty pending learning result explains that saved memory stays and cannot be applied',()=>{
 const markup=memoryFields({id:'profile-1',memory:{entries:[{field:'other',text:'已有记忆'}]},pendingMemory:{entries:[],summary:''}});
 assert.match(markup,/本次学习未提取到记忆/);
 assert.match(markup,/已有记忆未改变/);
 assert.doesNotMatch(markup,/data-ai-memory-apply|data-ai-memory-merge/);
 assert.match(markup,/data-ai-memory-discard/);
});
test('Wiki retains recordedAt through edit and restore while manual legacy ranges remain readable',async t=>{
 const {a}=await fixture(t),profile={};
 assert.throws(()=>memoryValue({entries:[{field:'residence',text:'住址',from:2000,to:1000}]}),/结束时间不能早于开始时间/);
 const invalid=memoryValue({entries:[{field:'residence',text:'坏时间',from:Number.MAX_SAFE_INTEGER,to:Number.MAX_SAFE_INTEGER}]});
 assert.equal(invalid.entries[0].from,undefined);assert.equal(invalid.entries[0].to,undefined);
 assert.equal(memoryValue({entries:[{field:'residence',text:'旧住址',recordedAt:''}]}).entries[0].recordedAt,undefined);
 Object.assign(profile,editMemory(a.vault,profile,{entries:[{field:'residence',text:'住址',from:1000,to:2000,recordedAt:3000},{field:'workplace',text:'单位',recordedAt:4000}]},10));
 assert.deepEqual(readMemory(a.vault,profile).entries.map(e=>e.recordedAt),[3000,4000]);
 Object.assign(profile,editMemory(a.vault,profile,{entries:[{field:'residence',text:'新住址',recordedAt:5000}]},11));
 assert.deepEqual(readMemory(a.vault,profile).entries.map(e=>e.recordedAt),[5000]);
 const restoreId=profile.memoryHistory[0].id;
 Object.assign(profile,editMemory(a.vault,profile,{restoreId},12));
 assert.deepEqual(readMemory(a.vault,profile).entries.map(e=>e.recordedAt),[3000,4000]);
});
test('manually deleted Wiki facts stay suppressed on incremental learning and can be re-added',async t=>{
 const {a}=await fixture(t),profile={};
 Object.assign(profile,editMemory(a.vault,profile,{entries:[{field:'phone',text:'123'}]},1));
 Object.assign(profile,editMemory(a.vault,profile,{entries:[]},2));
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{field:'phone',text:'123'}]},3));
 assert.deepEqual(readMemory(a.vault,profile).entries,[]);
 Object.assign(profile,editMemory(a.vault,profile,{entries:[{field:'phone',text:'123'}]},4));
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{field:'phone',text:'123'}]},5));
 assert.equal(readMemory(a.vault,profile).entries.length,1);
 const old=readMemory(a.vault,profile).entries[0];
 Object.assign(profile,editMemory(a.vault,profile,{entries:[{...old,text:'456'}]},6));
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{...old}]},7));
 assert.deepEqual(readMemory(a.vault,profile).entries.map(entry=>entry.text),['456'],'编辑过的旧事实不应被学习回填');
 Object.assign(profile,editMemory(a.vault,profile,{entries:[{...old},{...readMemory(a.vault,profile).entries[0]}]},8));
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[{...old}]},9));
 assert.deepEqual(readMemory(a.vault,profile).entries.map(entry=>entry.text).sort(),['123','456'],'用户手动重新加入后解除该条抑制');
});
test('editing one Wiki bubble only marks changed and added facts manual',async t=>{
 const {a}=await fixture(t),profile={};
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[
  {id:'aaaaaaaaaaaaaaaa',field:'phone',text:'旧号码'},
  {id:'bbbbbbbbbbbbbbbb',field:'school',degree:'本科',text:'浙江大学'},
 ]},1));
 const learned=readMemory(a.vault,profile).entries;
 assert.ok(learned.every(entry=>entry.manual===undefined),'学习条目起初保持自动状态');
 Object.assign(profile,editMemory(a.vault,profile,{entries:[
  {...learned[0],text:'新号码'},
  learned[1],
  {field:'name',text:'手动新增'},
 ]},2));
 const saved=readMemory(a.vault,profile).entries;
 assert.equal(saved.find(entry=>entry.id==='aaaaaaaaaaaaaaaa').manual,true,'改过的事实转为手动维护');
 assert.equal(saved.find(entry=>entry.id==='bbbbbbbbbbbbbbbb').manual,undefined,'未改的学习事实仍可自动更新');
 assert.equal(saved.find(entry=>entry.text==='手动新增').manual,true,'新条目是手动维护');
 Object.assign(profile,mergeMemory(a.vault,profile,{entries:[
  {id:'aaaaaaaaaaaaaaaa',field:'phone',text:'旧号码'},
  {id:'bbbbbbbbbbbbbbbb',field:'school',degree:'本科',text:'浙江大学'},
 ]},3));
 const afterLearning=readMemory(a.vault,profile).entries;
 assert.equal(afterLearning.find(entry=>entry.id==='aaaaaaaaaaaaaaaa').text,'新号码','已编辑旧事实不会回填');
 assert.equal(afterLearning.find(entry=>entry.id==='bbbbbbbbbbbbbbbb').manual,undefined,'未编辑学习事实保持自动状态');
});
test('applying a reply limit updates only the selected object type and preserves pause and counters',async t=>{
 const {a,bridge}=await fixture(t), contact=bridge.contacts[0];
 await a.saveReplyProfile({contact:contact.id,style:a.publicState().schema.defaultStyle,strategy:{replyGoal:'回答活动问题',facts:'已确认事实',boundaries:'不可承诺',maxRounds:3}});
 const profile=a.profiles().find(p=>p.contact===contact.id); profile.paused=true;profile.rounds=2;profile.manualPause=true;
 const group={id:'group-profile',account:a.data.account,contact:'group-contact',kind:'group',replyStrategy:{replyGoal:'群目标',facts:'群事实',boundaries:'群边界',maxRounds:4}};a.data.profiles[group.id]=group;
 const wikiOnly={id:'wiki-only',account:a.data.account,contact:'wiki-only-contact',kind:'person',memoryCiphertext:'fixture'};a.data.profiles[wikiOnly.id]=wikiOnly;
 const result=await a.applyReplyLimitToKind('person',12);
 assert.equal(result.appliedReplyLimit.count,1); assert.equal(profile.replyStrategy.maxRounds,12);
 assert.equal(profile.paused,true);assert.equal(profile.manualPause,true);assert.equal(profile.rounds,2);
 assert.equal(a.data.replyStrategy.maxRounds,50); assert.equal(group.replyStrategy.maxRounds,4);
 assert.equal(wikiOnly.replyStrategy,undefined,'批量上限不应给 Wiki-only 档案创建回复策略');
 assert.equal(a.data.replyRoundLimits.person,12,'Wiki-only 新联系人使用联系人类型默认上限');
 assert.equal(a.strategy({kind:'person'},'reply').maxRounds,12); assert.equal(a.strategy({kind:'group'},'reply').maxRounds,50);
 await a.applyReplyLimitToKind('group',8);
 assert.equal(group.replyStrategy.maxRounds,8); assert.equal(a.data.replyStrategy.maxRounds,50);
 assert.equal(a.strategy({kind:'person'},'reply').maxRounds,12); assert.equal(a.strategy({kind:'group'},'reply').maxRounds,8);
 a.data.settings.proactive=true;
 const continuingPerson={id:'continuing-person',kind:'person',continuation:{strategy:{replyGoal:'续聊目标',maxRounds:50}}};
 const continuingGroup={id:'continuing-group',kind:'group',continuation:{strategy:{replyGoal:'群续聊目标',maxRounds:50}}};
 a.data.profiles[continuingPerson.id]=continuingPerson;a.data.profiles[continuingGroup.id]=continuingGroup;
 a.data.proactiveTargets.push(continuingPerson.id,continuingGroup.id);
 assert.equal(a.strategy(continuingPerson,'reply').maxRounds,12);
 assert.equal(a.strategy(continuingGroup,'reply').maxRounds,8);
 const state=a.publicState();
 assert.deepEqual(state.replyRoundLimits,{person:12,group:8});
 const listState={...state,contacts:[{id:'new-person',kind:'person',label:'新联系人'},{id:'new-group',kind:'group',label:'新群聊'}],profiles:[{contact:'new-person',rounds:12},{contact:'new-group',rounds:100,mentionRounds:8,groupOptions:{atMe:true}}],replyRoundLimits:{person:12,group:8}};
 const personList=objectList(listState,{search:'',kind:'person'}),groupList=objectList(listState,{search:'',kind:'group'});
 assert.match(personList,/12\/12/);assert.match(groupList,/8\/8/);
 const personDetail=objectPage(listState,{selected:'new-person',kind:'person',search:''}),groupDetail=objectPage(listState,{selected:'new-group',kind:'group',search:''});
 assert.match(personDetail,/<input\b[^>]*name="maxRounds"[^>]*value="12"/);assert.match(groupDetail,/<input\b[^>]*name="maxRounds"[^>]*value="8"/);
});
test('unlimited bulk setting reaches the selected type without showing a limit badge',async t=>{
 const {a,bridge}=await fixture(t),contact=bridge.contacts[0];
 await a.saveReplyProfile({contact:contact.id,style:a.publicState().schema.defaultStyle,strategy:{maxRounds:50}});
 const result=await a.applyReplyLimitToKind('person','unlimited');
 assert.equal(result.replyRoundLimits.person,'unlimited');assert.equal(result.appliedReplyLimit.count,1);
 const profile=a.profiles().find(p=>p.contact===contact.id);profile.rounds=10000;
 assert.equal(a.strategy(profile,'reply').maxRounds,'unlimited');
 const row=objectList({...a.publicState(),profiles:[profile],contacts:[contact]},{search:'',kind:'person'});
 assert.doesNotMatch(row,/已达自动回复上限/);
 assert.equal(a.data.replyRoundLimits.group,null);
});
test('analysis omits unreadable bodies but keeps database errors visible',async t=>{
 const {a,bridge,provider}=await fixture(t);let fail=false;
 bridge.readRange=async args=>{assert.equal(args.skipUnparsed,true);if(fail)throw Error('database unavailable');return {account:args.account,contact:args.contact,messages:[{id:'bad',text:'',timestamp:args.from},{id:'ok',text:'有效信息',timestamp:args.from+1}]};};
 provider.complete=async(_c,_s,input)=>{assert.deepEqual(input.messages.map(m=>m[2]),['有效信息']);return {report:'完成'};};
 const args={contacts:[bridge.contacts[0].id],request:'总结',from:'2026-09-01',to:'2026-09-02'};
 const result=await a.analyze(args);assert.equal(result.reports[0].skipped,1);assert.equal(result.reports[0].count,1);
 fail=true;assert.equal((await a.analyze(args)).reports[0].status,'error');
});
test('clipboard rejects paths, duplicate filenames and invalid base64 before staging',()=>{
 const good={name:'截图.png',type:'image/png',data:Buffer.from('fixture').toString('base64')};
 assert.equal(validateClipboardFiles([good]).length,1);
 for(const files of [[{...good,name:'../x'}],[good,good],[{...good,data:'!!!'}],Array(11).fill(good)])assert.throws(()=>validateClipboardFiles(files));
});

test('individual task pause/edit/resume retains its target and uses saved edits at execution',async t=>{
 const {a,bridge,provider}=await fixture(t);
 await a.saveStrategy(strategy);await a.prepareTargets({contacts:bridge.contacts.slice(0,2).map(c=>c.id)});
 await a.settings({enabled:true,proactive:true,reply:false});await a.queueAction('start');
 const id=a.data.queue.items[0].id;
 await a.queueAction({command:'pause',id});assert.equal(a.data.queue.items[0].status,'paused');
 await a.queueAction({command:'edit',id,value:{...strategy,purpose:'修改后的邀请'}});
 await a.tick();assert.equal(bridge.sent.length,1);assert.equal(a.data.queue.items[0].status,'paused');
 assert.notEqual(a.data.queue.status,'completed');
 await a.queueAction({command:'resume',id});
 provider.next=async input=>{assert.equal(input.strategy.purpose,'修改后的邀请');return {action:'send',text:'新的邀请。'};};
 await a.tick();assert.equal(bridge.sent.length,2);assert.equal(a.data.queue.status,'completed');
 await assert.rejects(a.queueAction({command:'resume',id}),/任务已变化/);
});

test('scheduled task edits replace the paused occurrence and keep future schedule paused',async t=>{
 const {a,bridge,advance}=await fixture(t);
 await a.settings({enabled:true,proactive:true,reply:false});
 await a.scheduleAction({time:'每天上午9点',strategy,contacts:[bridge.contacts[0].id]});
 const s=a.data.schedules[0];await a.scheduleAction({command:'pause',id:s.id});advance(86400000);
 await a.scheduledTick(a.revision);assert.equal(a.data.queue.status,'idle');
 await a.scheduleAction({command:'edit',id:s.id,time:'每天上午10点',strategy:{...strategy,purpose:'新目标'},contacts:[bridge.contacts[1].id]});
 assert.equal(s.status,'paused');assert.equal(s.targets.length,1);assert.equal(s.strategy.purpose,'新目标');
 await a.scheduleAction({command:'resume',id:s.id});assert.equal(s.status,'active');
});

test('pre-submit failures stop after three attempts; unknown sends settle without retry',async t=>{
 const {a,bridge,advance}=await fixture(t);let sends=0;
 await a.saveStrategy(strategy);await a.prepareTargets({contacts:[bridge.contacts[0].id]});await a.settings({enabled:true,proactive:true,reply:false});await a.queueAction('start');
 bridge.send=async()=>{sends++;return {status:'not-sent',diagnostic:{phase:'native-navigation',code:'controls-unavailable'}};};
 for(let i=0;i<4;i++){a.available=true;await a.proactiveTick(a.revision,a.controller.signal);advance(100000);}
 assert.equal(sends,3);assert.equal(a.data.queue.status,'failed');assert.equal(a.data.queue.items[0].diagnostic.phase,'native-navigation');
 a.available=true;await a.queueAction({command:'resume',id:a.data.queue.items[0].id});
 bridge.send=async()=>{sends++;return {status:'uncertain'};};await a.proactiveTick(a.revision,a.controller.signal);
 await assert.rejects(a.queueAction({command:'resume',id:a.data.queue.items[0].id})); assert.equal(a.data.queue.items[0].status,'skipped'); advance(100000);await a.proactiveTick(a.revision,a.controller.signal);assert.equal(sends,4);
});

test('WeChat remark capability is default-deny and requires a verified provider receipt',async t=>{
 const {a,bridge}=await fixture(t),contact=bridge.contacts[0];
 await a.saveReplyProfile({contact:contact.id,style:a.publicState().schema.defaultStyle,strategy:{replyGoal:'测试',facts:'已确认',boundaries:'不承诺',maxRounds:3}});
 const profile=a.profiles().find(item=>item.contact===contact.id);
 assert.equal(a.publicState().capabilities.writeContactRemark,false);
 assert.doesNotMatch(wikiEntryMarkup({field:'name',text:'测试姓名'}),/data-ai-wiki-remark/);
 assert.match(wikiEntryMarkup({field:'name',text:'测试姓名'},true),/data-ai-wiki-remark/);
 assert.match(wikiEntryMarkup({field:'other',text:'新增条目'},true),/data-ai-wiki-remark[^>]*hidden/);
 assert.doesNotMatch(memoryFields({...profile,capabilities:a.publicState().capabilities}),/当前微信连接没有受支持的备注写入接口/);
 assert.doesNotMatch(memoryFields({...profile,capabilities:a.publicState().capabilities}),/data-ai-wiki-remark/);
 const before=readMemory(a.vault,profile);
 await assert.rejects(a.setContactRemark(profile.id,{remark:'临时备注'}),/受支持的备注写入接口/);
 assert.deepEqual(readMemory(a.vault,profile),before);
 bridge.setContactRemark=async request=>({updated:true,verified:true,account:request.account,contact:request.contact,remark:request.remark});
 assert.equal(a.publicState().capabilities.writeContactRemark,true);
 const after=await a.setContactRemark(profile.id,{remark:'测试姓名'});
 assert.equal(after.capabilities.writeContactRemark,true);
});
