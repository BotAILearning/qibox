import test from 'node:test';import assert from 'node:assert/strict';
import {AIProvider} from '../server/ai-provider.mjs';import {modelConfig} from './ai-fixtures.mjs';
for(const [host,model,protocol,format,expected] of [
 ['open.bigmodel.cn','glm-5.3-flash','openai','json',true],['api.z.ai','glm-5.3','openai','json',true],
 ['open.bigmodel.cn','glm-5.3-flashx','openai','json',true],['models.example.test','glm-5.3','openai','json',false],
 ['open.bigmodel.cn','glm-4.5-air','openai','json',false],['open.bigmodel.cn','glm-5.3','anthropic','json',false],
 ['open.bigmodel.cn','glm-5.3','openai','report',false],
])test(`structured output scope ${host}/${model}/${protocol}/${format}`,async()=>{
 let calls=0;
 const provider=new AIProvider({fetcher:async(_url,init)=>{calls++;const body=JSON.parse(init.body);assert.deepEqual(body.response_format,expected?{type:'json_object'}:undefined);const result=format==='report'?{report:'报告正文'}:{action:'send',text:'收到'};return Response.json(protocol==='anthropic'?{content:[{type:'text',text:JSON.stringify(result)}]}:{choices:[{message:{content:JSON.stringify(result)}}]});}});
 await provider.complete({...modelConfig,baseUrl:`https://${host}/v1`,model,protocol},'请返回JSON',{mode:format==='report'?'analysis':'reply'},undefined,{format});assert.equal(calls,1);
});
