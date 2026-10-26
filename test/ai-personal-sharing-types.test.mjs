import test from'node:test';
import assert from'node:assert/strict';
import{personalInformation,selfContext}from'../server/ai-account-configuration.mjs';
import{AIAssistant}from'../server/ai-service.mjs';
import{ChatFixture,AIModelFixture,modelConfig}from'./ai-fixtures.mjs';
import{temp,cleanup}from'./fixtures.mjs';

test('only explicit boolean true in stored personal information can grant group sharing',()=>{
 const entries=[true,false,undefined,'true','false',1,0,{},[]].map((allowGroup,i)=>({id:'sharing-'+i,field:'other',text:'合成本人资料'+i,...(allowGroup===undefined?{}:{allowGroup})}));
 const a={data:{account:'owner',personalInformation:{owner:{entries}}},vault:{open:value=>structuredClone(value)},now:()=>1000},before=structuredClone(a.data);
 assert.deepEqual(selfContext(a,'group').map(e=>e.id),['sharing-0']);
 assert.equal(selfContext(a,'person').length,entries.length,'private context remains available');
 assert.deepEqual(a.data,before,'reading cannot rewrite old values or permissions');
 assert.deepEqual(personalInformation(a).entries.map(e=>e.allowGroup),entries.map(e=>e.allowGroup===true),'API views must not expose invalid truthy values that a checkbox would render as checked');
});

test('personal history also presents strict sharing booleans while the stored old payload remains untouched',()=>{
 const body={entries:[{id:'old',field:'other',text:'合成私密资料',allowGroup:'false'}],history:[{at:1,entries:[{field:'other',text:'合成历史资料',allowGroup:1},{field:'other',text:'合成已授权资料',allowGroup:true}]}]};
 const a={data:{account:'owner',personalInformation:{owner:structuredClone(body)}},vault:{open:value=>structuredClone(value)},now:()=>1000};
 const view=personalInformation(a);assert.deepEqual(view.entries.map(e=>e.allowGroup),[false]);assert.deepEqual(view.history[0].entries.map(e=>e.allowGroup),[false,true]);assert.deepEqual(a.data.personalInformation.owner,body);
});

test('normal personal-information saves keep the existing strict boolean sharing policy without a model request',async t=>{
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture(),a=new AIAssistant({dataRoot:root,bridge,provider});
 await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);t.after(async()=>{await a.close();await cleanup(root);});
 await a.configure(modelConfig);await a.scan();
 await a.configuration({type:'personal-information',entries:[{field:'other',text:'合成私密资料',allowGroup:'false'},{field:'preferences',text:'喜欢清淡口味',allowGroup:true}]});
 assert.deepEqual(selfContext(a,'group').map(e=>e.text),['喜欢清淡口味']);
 assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);
});
