import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AIAssistant } from '../server/ai-service.mjs';
import { memoryValue, mergeMemory, editMemory, readMemory } from '../server/ai-wiki.mjs';
import { selectMemoryForChat } from '../server/ai-memory-context.mjs';
import { buildAttributionContext } from '../server/ai-attribution-context.mjs';
import { encodeModelRequest } from '../server/ai-model-input.mjs';
import { ChatFixture, AIModelFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const vault={seal:value=>structuredClone(value),open:value=>structuredClone(value)};
const subjectA='member:'+key('memory-member-a'),subjectB='member:'+key('memory-member-b');
const fact=(subjectId,evidence,extra={})=>({field:'group_member',text:'成员喜欢喝无糖乌龙茶',subjectId,evidence:[evidence],observedAt:1000,...extra});
const apply=(p,entries,now=2000)=>Object.assign(p,mergeMemory(vault,p,{entries},now));

test('new scoped memory IDs distinguish explicit subjects while legacy and supplied IDs remain stable',()=>{
 const legacy={field:'other',text:'旧记忆原文'},oldId=createHash('sha256').update(JSON.stringify(['other',legacy.text,'','',null,null])).digest('hex').slice(0,24);
 assert.equal(memoryValue({entries:[legacy]}).entries[0].id,oldId);
 const rows=memoryValue({entries:[fact(subjectA,'a'),fact(subjectB,'b')]}).entries;
 assert.notEqual(rows[0].id,rows[1].id);
 assert.equal(memoryValue({entries:[{...rows[0],id:oldId}]}).entries[0].id,oldId,'do not rewrite existing explicit IDs');
});

test('same-text facts for separate subjects remain separate without merging their evidence',()=>{
 const p={};apply(p,[fact(subjectA,'a'),fact(subjectB,'b')]);
 const rows=readMemory(vault,p).entries;assert.equal(rows.length,2);
 assert.deepEqual(rows.map(r=>[r.subjectId,r.evidence]),[[subjectA,['a']],[subjectB,['b']]]);
 const before=structuredClone(rows[0]);
 apply(p,[{...rows[1],text:'成员改喝热水',evidence:['b-new'],observedAt:3000}],3000);
 const after=readMemory(vault,p).entries;assert.deepEqual(after.find(r=>r.subjectId===subjectA),before);
 assert.equal(after.find(r=>r.subjectId===subjectB).text,'成员改喝热水');
});

test('an update carrying another subjects ID is staged for review instead of transferring its identity or evidence',()=>{
 const p={};apply(p,[fact(subjectA,'a')]);const original=readMemory(vault,p).entries[0];
 apply(p,[{...fact(subjectB,'b',{observedAt:3000}),id:original.id}],3000);
 assert.deepEqual(readMemory(vault,p).entries,[original]);
 assert.equal(readMemory(vault,p,'memorySuggestion').entries[0].subjectId,subjectB);
});

test('address history and protected identity fields compare only the same explicit subject',()=>{
 const p={};apply(p,[{field:'residence',text:'住在杭州',subjectId:subjectA,observedAt:1000},{field:'residence',text:'住在苏州',subjectId:subjectB,observedAt:1000}]);
 apply(p,[{field:'residence',text:'搬到上海',subjectId:subjectA,observedAt:3000}],3000);
 const rows=readMemory(vault,p).entries;assert.equal(rows.find(r=>r.text==='住在杭州').status,'historical');assert.equal(rows.find(r=>r.subjectId===subjectB).status,undefined);
 const names={};apply(names,[{field:'name',text:'张一',subjectId:subjectA},{field:'name',text:'李二',subjectId:subjectB}]);
 assert.equal(readMemory(vault,names).entries.length,2);assert.equal(names.memorySuggestion,null);
});

test('deleting a scoped fact does not suppress a different subjects same text, and legacy deletion protection remains',()=>{
 const p={};apply(p,[fact(subjectA,'a')]);Object.assign(p,editMemory(vault,p,{entries:[]},3000));
 apply(p,[fact(subjectB,'b'),fact(subjectA,'a-repeat')],4000);
 assert.deepEqual(readMemory(vault,p).entries.map(r=>r.subjectId),[subjectB]);
 const legacy={};apply(legacy,[{field:'group_member',text:fact(subjectA,'a').text,evidence:['old']}]);Object.assign(legacy,editMemory(vault,legacy,{entries:[]},3000));
 apply(legacy,[fact(subjectB,'b')],4000);
 assert.equal(readMemory(vault,legacy).entries.length,0,'unscoped historical deletion keys keep their existing broad protection; do not guess the former subject');
});

test('unchanged UI saves that omit internal metadata preserve each subjects original provenance',()=>{
 const p={account:key('owner'),contact:key('group')};apply(p,[fact(subjectA,'a'),fact(subjectB,'b')]);
 const before=readMemory(vault,p).entries;
 Object.assign(p,editMemory(vault,p,{entries:before.map(({id,field,text})=>({id,field,text}))},4000));
 const rows=readMemory(vault,p).entries;
 assert.deepEqual(rows.map(r=>[r.subjectId,r.evidence,r.observedAt]),before.map(r=>[r.subjectId,r.evidence,r.observedAt]));
 assert(!readMemory(vault,p).blockedEvidence?.length);
});

test('an unchanged legacy duplicate-ID list preserves its explicit subjects without renumbering or borrowing the first rows metadata',()=>{
 const shared='f'.repeat(24),rows=memoryValue({entries:[{...fact(subjectA,'a'),id:shared},{...fact(subjectB,'b'),id:shared}]}).entries;
 const p={memory:vault.seal({entries:rows})};
 Object.assign(p,editMemory(vault,p,{entries:rows.map(({id,field,text})=>({id,field,text}))},4000));
 assert.deepEqual(readMemory(vault,p).entries,rows);
});

test('an ambiguous changed legacy duplicate-ID form preserves stored memory instead of guessing an owner',()=>{
 const shared='f'.repeat(24),rows=memoryValue({entries:[{...fact(subjectA,'a'),id:shared},{...fact(subjectB,'b'),id:shared}]}).entries;
 const p={memory:vault.seal({entries:rows})},before=structuredClone(p);
 const changed=rows.map(({id,field,text})=>({id,field,text}));changed[0].text='改了这条正文';
 assert.throws(()=>editMemory(vault,p,{entries:changed},4000),/重复编号/);
 assert.deepEqual(p,before);
 const explicit=rows.map(row=>({...row}));explicit[1].text='成员改喝热水';
 Object.assign(p,editMemory(vault,p,{entries:explicit},5000));
 assert.equal(readMemory(vault,p).entries[1].subjectId,subjectB);
});

test('production observed-group admission, persistence, restart, context selection and encoding retain both member facts',async t=>{
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();const contact={id:key('subject-group'),label:'合成记忆群',kind:'group'};
 bridge.contacts=[contact];bridge.messages=new Map([[contact.id,[]]]);
 const options={dataRoot:root,bridge,provider,now:()=>5000};let a=new AIAssistant(options);await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);
 t.after(async()=>{await a.close();await cleanup(root);});
 await a.configure(modelConfig);await a.scan();await a.saveReplyProfile({contact:contact.id,style:{summary:'自然接话'},strategy,replyEnabled:false});await a.settings({autoLearning:true});
 const p=a.profiles()[0],sources=[subjectA,subjectB].map((subject,i)=>({id:key('source-'+i),direction:'other',authorship:'other',text:'我喜欢喝无糖乌龙茶',sender:subject.slice(7),timestamp:i+1}));
 a.mergeObservedMemory(p,sources.map((m,i)=>fact(i?subjectB:subjectA,m.id)),sources);
 await a.save();assert.equal(readMemory(a.vault,p).entries.length,2);await a.close();
 a=new AIAssistant(options);await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);
 const stored=readMemory(a.vault,a.data.profiles[p.id]),selected=selectMemoryForChat(stored,{query:'喝茶',now:5000});
 assert.equal(selected.entries.length,2);assert.deepEqual(selected.entries.map(r=>r.subjectId),[subjectB,subjectA]);
 for(const [i,subject] of [subjectA,subjectB].entries())assert.deepEqual(stored.entries.find(r=>r.subjectId===subject).evidence,[sources[i].id]);
 const context=buildAttributionContext({memory:selected}),input={mode:'reply',memory:selected,attributionContext:context};const wire=encodeModelRequest('',input);
 assert.deepEqual(wire.decode(wire.input),input);assert.equal(new Set(wire.input.memory.entries.map(r=>r.subjectId)).size,2);
 assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);
});
