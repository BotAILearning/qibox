import test from 'node:test';
import assert from 'node:assert/strict';
import { replyLimitControl, syncReplyLimitControl } from '../web/ai-reply-limit.mjs';
import { objectPage } from '../web/ai-object-page-new.mjs';

test('invalid unsaved limit is not described as a saved legacy limit or an applied pause',()=>{
 const html=replyLimitControl(0,'draft-limit',{savedValue:50});
 assert.match(html,/value="0"/);assert.match(html,/未保存/);assert.match(html,/已保存上限为 50/);assert.doesNotMatch(html,/旧上限：0|自动回复已暂缓/);assert.match(html,/max="2000"/);
});
test('correcting a real saved legacy limit keeps the saved blocker until the explicit save succeeds',()=>{
 const html=replyLimitControl(50,'legacy-limit',{savedValue:'unlimited'});
 assert.match(html,/旧上限：不限/);assert.match(html,/自动回复已暂缓/);assert.doesNotMatch(html,/旧上限：50/);assert.match(html,/name="maxRounds" value="50"/);
});
test('live limit edits update only the draft hint and retain the saved value for status',()=>{
 const choice={value:'custom'},custom={value:'0',focus(){}},value={value:'50'},warning={textContent:'',hidden:true};
 const control={getAttribute:name=>name==='data-ai-reply-limit-saved'?'50':null,querySelector:selector=>selector==='[data-ai-reply-limit-choice]'?choice:selector==='[data-ai-reply-limit-custom]'?custom:selector==='[name="maxRounds"]'?value:selector==='[data-ai-reply-limit-warning]'?warning:null};
 const target={closest:()=>control,matches:()=>true};assert(syncReplyLimitControl(target));assert.equal(value.value,'0');assert.equal(warning.hidden,false);assert.match(warning.textContent,/已保存上限为 50/);assert.doesNotMatch(warning.textContent,/自动回复已暂缓/);
 custom.value='50';assert(syncReplyLimitControl(target));assert.equal(value.value,'50');assert.equal(warning.hidden,true);assert.equal(warning.textContent,'');
});
for(const kind of ['person','group'])test(`${kind}: object refresh renders the dirty limit without changing the saved status`,()=>{
 const state={contacts:[{id:'c',label:'合成对象',kind}],profiles:[{id:'p',contact:'c',kind,replyStrategy:{maxRounds:50},replyOptions:{enabled:true},groupOptions:{atMe:true}}],settings:{replyScope:'all',enabled:true},schema:{defaultStyle:{}},replyStrategy:{maxRounds:100},replyRoundLimits:{[kind]:100},live:[]};
 const before=structuredClone(state),html=objectPage(state,{selected:'c',kind,section:'reply',draft:{maxRounds:'0'},search:''});
 assert.match(html,/已保存上限为 50/);assert.doesNotMatch(html,/旧上限：0|自动回复已暂缓/);assert.match(html,/name="maxRounds" value="0"/);assert.deepEqual(state,before);
});
test('an inherited invalid saved limit is not replaced in the warning by a valid unsaved draft',()=>{
 const state={contacts:[{id:'c',label:'合成对象',kind:'person'}],profiles:[{id:'p',contact:'c',kind:'person',inheritReplyStrategy:true,replyLimitNeedsReview:true}],settings:{enabled:true},schema:{defaultStyle:{}},replyStrategy:{maxRounds:100},replyRoundLimits:{person:2001},live:[]};
 const html=objectPage(state,{selected:'c',kind:'person',section:'reply',draft:{maxRounds:'50'},search:''});assert.match(html,/旧上限：2001/);assert.doesNotMatch(html,/旧上限：50/);assert.match(html,/name="maxRounds" value="50"/);
});
