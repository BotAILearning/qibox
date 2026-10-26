import test from'node:test';import assert from'node:assert/strict';import{styleFeedbackCopy,copiedStyleBase}from'../web/ai-style-feedback.mjs';import{saveObjectStyle}from'../server/ai-account-configuration.mjs';import{styleSelector}from'../web/ai-style-selector.mjs';
import{AIAssistant}from'../server/ai-service.mjs';import{AIProvider}from'../server/ai-provider.mjs';import{ChatFixture,modelConfig,key}from'./ai-fixtures.mjs';import{temp,cleanup}from'./fixtures.mjs';
const id='draft:30b14aae-84a3-43de-9df3-f3cdf2aab5ba';
test('explicit feedback makes a new draft, preserves old wording/options and never promotes it to personality',()=>{
 const style={summary:'原有明确要求：简洁、耐心。',customTone:'原有语气',customAvoid:'不要调侃'},value={styleId:'custom:original',style};
 const before=structuredClone(value),copy=styleFeedbackCopy(value,'只在对方求建议时再给建议',{id,name:'旧风格修订'}),base=copiedStyleBase(copy.__styleBase,copy.styleId);
 assert.deepEqual(value,before);assert.equal(copy.styleId,id);assert(copy.summary.startsWith(style.summary+'\n'));assert(copy.summary.endsWith('只在对方求建议时再给建议'));assert.equal(base.customTone,style.customTone);assert.equal(base.customAvoid,style.customAvoid);
 assert.equal(copiedStyleBase(copy.__styleBase,'custom:original'),null);assert.equal(copiedStyleBase('{bad',id),null);assert.equal(copiedStyleBase('[]',id),null);
 const personality=styleFeedbackCopy({style:{...style,personalityId:'gentle',traits:['x']}},'少一点固定追问',{id});assert(!Object.hasOwn(copiedStyleBase(personality.__styleBase,id),'personalityId'));
});
test('reject missing feedback, controls and limits without trimming away the original style',()=>{
 const value={style:{summary:'原文'}};
 for(const note of['','  ','x'.repeat(401),'不要\u0000改'])assert.throws(()=>styleFeedbackCopy(value,note,{id}));
 assert.throws(()=>styleFeedbackCopy({style:{summary:'字'.repeat(5999)}},'不要追加',{id}),/6000/);assert.equal(value.style.summary,'原文');
});
test('saved correction retains the old custom style and switching back restores exact original with no model call',()=>{
 const old={summary:'旧的本人习惯',customTone:'保留的称呼取向',customAvoid:'少追问'},profile={customStyles:[{id:'custom:original',label:'原风格',style:structuredClone(old)}]};
 const copy=styleFeedbackCopy({style:old,styleId:'custom:original'},'这类分享不要逐项复述',{id}),base=copiedStyleBase(copy.__styleBase,id),saved=saveObjectStyle(profile,base,id,null);
 assert.equal(profile.customStyles.length,2);assert.equal(saved.styleId,id.replace('draft:','custom:'));assert.deepEqual(profile.customStyles[0].style,old);assert(saved.style.summary.includes('这类分享不要逐项复述'));
 const restored=saveObjectStyle(profile,old,'custom:original',null);assert.deepEqual(restored.style,old);assert.equal(restored.styleId,'custom:original');assert.equal(profile.customStyles.length,2);
});
test('copy base stays escaped in form metadata and is absent from the normal visible style explanation',()=>{
 const text='<img src=x onerror=alert(1)>',copy=styleFeedbackCopy({style:{summary:'正常说明',customTone:text}},text,{id});
 const html=styleSelector({},{},copy,[]);assert(html.includes('name="__styleBase"'));assert(!html.includes('<img src=x'));assert(html.includes('&lt;img'));
});

test('saved feedback copy survives restart, stays in its account and restores old style without a provider call',async t=>{
 const root=await temp(),bridge=new ChatFixture();let calls=0, a;
 const provider=new AIProvider({fetcher:async()=>{calls++;throw Error('No model request allowed in style save/rollback');}});
 t.after(async()=>{await a?.close();await cleanup(root);});
 a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();await a.configure(modelConfig);await a.scan();const contact=bridge.contacts[0].id;
 const original={summary:'OLD-PRIVATE-ONLY-A：原有说话方式',customTone:'原有手动语气',customAvoid:'少问问题'};
 await a.saveReplyProfile({contact,strategy:{},style:original,styleId:'new-custom',styleName:'原风格',preserveSwitches:true});
 let profile=a.profiles().find(p=>p.contact===contact);const oldId=profile.styleId,oldStyle=structuredClone(profile.style);
 const copy=styleFeedbackCopy({style:oldStyle,styleId:oldId},'普通分享接一句，不逐项复述',{id});
 await a.saveReplyProfile({contact,strategy:{},style:copiedStyleBase(copy.__styleBase,id),styleId:id,styleName:copy.styleName,preserveSwitches:true});
 profile=a.profiles().find(p=>p.contact===contact);assert.equal(profile.customStyles.length,2);assert.deepEqual(profile.customStyles.find(x=>x.id===oldId).style,oldStyle);
 const newId=profile.styleId;await a.close();a=new AIAssistant({dataRoot:root,bridge,provider});await a.init();await a.scan();
 profile=a.profiles().find(p=>p.contact===contact);assert.equal(profile.styleId,newId);assert.deepEqual(profile.customStyles.find(x=>x.id===oldId).style,oldStyle);
 const account=bridge.account;bridge.account=key('style-copy-other-account');await a.scan();assert(a.publicState().profiles.every(p=>p.account===bridge.account));assert(!JSON.stringify(a.publicState().profiles).includes('OLD-PRIVATE-ONLY-A'));
 bridge.account=account;await a.scan();await a.saveReplyProfile({contact,strategy:{},style:oldStyle,styleId:oldId,preserveSwitches:true});profile=a.profiles().find(p=>p.contact===contact);assert.deepEqual(profile.style,oldStyle);assert.equal(profile.customStyles.length,2);assert.equal(calls,0);assert.equal(bridge.sent.length,0);
});
