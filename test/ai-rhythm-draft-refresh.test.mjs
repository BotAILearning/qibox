import test from 'node:test';import assert from 'node:assert/strict';
import {refreshObjectTiming} from '../web/ai-object-page-new.mjs';import {replyRhythm} from '../server/ai-reply-rhythm.mjs';
function formFixture(){
 const personal=replyRhythm({replyDelay:20}),box={dataset:{rhythmPersonal:JSON.stringify(personal),showingInherited:'false'},querySelector:()=>({hidden:false})};
 const elements={inheritRhythm:{checked:false},...Object.fromEntries(Object.entries(personal.timing).map(([key,value])=>[key,{type:'number',value:String(value)}])),takeoverEnabled:{type:'checkbox',checked:true},takeoverMinutes:{type:'number',value:'5'},segmentReplies:{type:'checkbox',checked:true},followUpEnabled:{type:'checkbox',checked:false}};
 return{form:{elements,querySelector:()=>box},box,elements,state:{settings:{replyDelay:20}}};
}
test('background status refresh preserves personal rhythm edits and unfinished numeric input',()=>{
 const {form,elements,state}=formFixture();elements.replyDelay.value='13';elements.followUpDelayMin.value='7';
 refreshObjectTiming(form,state);assert.equal(elements.replyDelay.value,'13');assert.equal(elements.followUpDelayMin.value,'7');
 elements.replyDelay.value='';refreshObjectTiming(form,state);assert.equal(elements.replyDelay.value,'','an unfinished number must not be replaced with a saved value');
});
test('inheritance roundtrip retains the edited personal rhythm while showing current global values',()=>{
 const {form,elements,state}=formFixture();elements.replyDelay.value='13';elements.takeoverMinutes.value='8';elements.followUpEnabled.checked=true;
 elements.inheritRhythm.checked=true;refreshObjectTiming(form,state);assert.equal(elements.replyDelay.value,20);assert.equal(elements.replyDelay.disabled,true);
 state.settings.replyDelay=31;refreshObjectTiming(form,state);assert.equal(elements.replyDelay.value,31);
 elements.inheritRhythm.checked=false;refreshObjectTiming(form,state);assert.equal(elements.replyDelay.value,13);assert.equal(elements.takeoverMinutes.value,8);assert.equal(elements.followUpEnabled.checked,true);assert.equal(elements.replyDelay.disabled,false);
});
