import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {styleSummaryInput,customStyleSummaryHint,customStyleSummaryValue} from '../web/ai-style-selector.mjs';

test('new custom summary is an empty editor with the unchanged starter wording as a hint',()=>{
 const html=styleSummaryInput({styleId:'draft:new',summary:'',__styleSummaryHint:customStyleSummaryHint});
 assert.match(html,/<textarea[^>]*placeholder="自然回应当前话题，简短清楚，不编造事实。"[^>]*><\/textarea>/);
 assert.match(html,/aria-describedby="ai-custom-style-summary-help"/);assert.match(html,/不填写时使用提示内容/);
 const data=new Map([['styleId','draft:new'],['summary',''],['__styleSummaryHint',customStyleSummaryHint]]);
 assert.equal(customStyleSummaryValue(data),customStyleSummaryHint);
 data.set('summary','直接接话，不加解释。');assert.equal(customStyleSummaryValue(data),'直接接话，不加解释。');
 data.set('summary','   ');assert.equal(customStyleSummaryValue(data),'   ','Validation still rejects an explicitly whitespace-only edit');
});
test('saved custom styles and existing invalid blank edits never acquire the new-draft fallback',()=>{
 for(const id of ['custom:saved','learned','','preset:natural']){
  const data=new Map([['styleId',id],['summary',''],['__styleSummaryHint',customStyleSummaryHint]]);
  assert.equal(customStyleSummaryValue(data),'');
  const html=styleSummaryInput({styleId:id,summary:customStyleSummaryHint,__styleSummaryHint:customStyleSummaryHint});
  assert(!html.includes('placeholder='));assert(html.includes('>'+customStyleSummaryHint+'</textarea>'));
 }
 const data=new Map([['styleId','draft:old'],['summary','']]);assert.equal(customStyleSummaryValue(data),'');
});
test('style pages no longer import, render or handle the removed paid trial',async()=>{
 for(const file of ['web/ai-assistant.mjs','web/ai-object-page-new.mjs']){
  const source=await readFile(new URL('../'+file,import.meta.url),'utf8');
  assert.doesNotMatch(source,/styleTrial|style-trial|生成试聊/);
 }
 await assert.rejects(access(new URL('../web/ai-style-trial.mjs',import.meta.url)),{code:'ENOENT'});
 await assert.rejects(access(new URL('../server/ai-style-trial.mjs',import.meta.url)),{code:'ENOENT'});
});
