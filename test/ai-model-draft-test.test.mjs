import test from 'node:test';
import assert from 'node:assert/strict';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';

test('testing an edited draft preserves active verification; saving transfers only matching validation',async t=>{
 const root=await temp(), provider=new AIModelFixture();
 const a=new AIAssistant({dataRoot:root,bridge:new ChatFixture(),provider});await a.init();
 t.after(async()=>{await a.close();await cleanup(root);});
 let s=await a.saveModels({models:[{label:"测试模型",...modelConfig}]});const id=s.models[0].id;
 await a.testModel({modelId:id,...modelConfig});
 assert.equal(a.publicState().models[0].tested,true);
 const draft={...modelConfig,model:'edited-draft'};
 await a.testModel({modelId:id,...draft});
 assert.equal(a.publicState().models[0].model,modelConfig.model);
 assert.equal(a.publicState().models[0].tested,true);
 s=await a.saveModels({models:[{id,label:"测试模型",...draft}]});
 assert.equal(s.models[0].tested,true);
 s=await a.saveModels({models:[{id,label:"测试模型",...draft,model:'never-tested'}]});
 assert.equal(s.models[0].tested,false);
});

test('new draft verification survives save without overwriting another model',async t=>{
 const root=await temp(),a=new AIAssistant({dataRoot:root,bridge:new ChatFixture(),provider:new AIModelFixture()});await a.init();
 t.after(async()=>{await a.close();await cleanup(root);});
 await a.testModel({modelId:'draft-acceptance',...modelConfig});
 assert.equal(a.publicState().models.length,0);
 const s=await a.saveModels({models:[{id:'draft-acceptance',label:'测试模型',...modelConfig}]});
 assert.equal(s.models[0].tested,true);
});

