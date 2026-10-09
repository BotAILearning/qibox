import test from 'node:test';
import assert from 'node:assert/strict';
import { DataChatBridge } from '../server/ai-data.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { withSpeaker, speakerHistory, speakerAuditInput, replyPerspective, applySpeakerAudit, naturalAttributionPrompt, naturalTurnBrief } from '../server/ai-speakers.mjs';
import { ChatFixture, AIModelFixture, key, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const account=key('natural-account'),contact=key('natural-group'),member=key('natural-member'),selfSender=key('self-member');
const group={id:contact,label:'聊天群',kind:'group',native:{account:key('native-account'),contact:key('native-group')}};
const own={id:key('laundry-own'),direction:'self',text:'今天我洗了好多衣服被子',timestamp:100,sender:selfSender,mentions:{verified:true,self:false,all:false,others:false}};
const quote={verified:true,messageId:own.id,direction:'self',text:own.text,timestamp:100,sender:selfSender};
const incoming={id:key('laundry-comment'),direction:'other',text:'很勤快了，很多被子了',timestamp:101,sender:member,mentions:{verified:true,self:false,all:false,others:false},quote};

function bridgeWithRows(rows) {
 const runtime={status:'running',desktopEnv:{},processes:[{name:'wechat',process:{pid:123}}]};
 return new DataChatBridge(runtime,{invoke(){assert.fail('Read must not navigate or send');},async invokeData(action){
  if(action==='contacts')return{available:true,account,contacts:[group]};
  if(action==='account')return{account};
  return{account,contact,label:group.label,native:group.native,revision:key('quote-read'),messages:structuredClone(rows)};
 }});
}

test('native bridge preserves a quoted owner without changing the new group author and rejects broken quote provenance',async()=>{
 const bridge=bridgeWithRows([own,incoming]);await bridge.scan();
 const snapshot=await bridge.read({account,contact});
 assert.equal(snapshot.messages[1].direction,'other');
 assert.deepEqual(snapshot.messages[1].quote,quote);
 for(const invalid of [{...quote,messageId:incoming.id},{...quote,timestamp:102},{...quote,sender:'unknown'},{...quote,direction:'system'}]){
  const bad=bridgeWithRows([own,{...incoming,quote:invalid}]);await bad.scan();await assert.rejects(bad.read({account,contact}));
 }
 const unknown=bridgeWithRows([own,{...incoming,quote:{verified:false,direction:'self',text:'forged'}}]);await unknown.scan();
 assert.deepEqual((await unknown.read({account,contact})).messages[1].quote,{verified:false});
});

test('natural compliments keep separate speaker and quote roles in waiting excerpts, delayed summaries and independent audit',async t=>{
 const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let now=101000;
 bridge.account=account;bridge.contacts=[group];bridge.messages=new Map([[contact,[structuredClone(own)]]]);bridge.stableMessageIds=true;
 const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{}});
 t.after(async()=>{await a.close();await cleanup(root);});
 await a.init();await a.configure(modelConfig);await a.scan();
 await a.setGroupOptions({contact,atMe:true,realtime:true,confirmRealtime:true,realtimeMode:'proactive'});
 await a.settings({enabled:true,reply:true,updateStyle:false});await a.tick();
 const profile=a.profiles().find(p=>p.contact===contact);
 bridge.messages.get(contact).push(structuredClone(incoming));provider.next=async()=>({action:'send',text:'趁天气好洗了一大堆。'});
 await a.tick();now+=20000;await a.tick();
 const call=provider.calls[0];assert.ok(call);
 assert.match(call.system,/自然接话的归属/);
 const message=call.input.messages.find(m=>m.id===incoming.id),excerpt=call.input.conversation.pendingIncomingMessages.find(m=>m.id===incoming.id);
 assert.equal(message.speaker.role,'group_member');assert.equal(message.quote.speaker.role,'self');assert.equal(message.quote.aiGenerated,false);
 assert.deepEqual(excerpt.quote,message.quote);
 const audit=speakerAuditInput(call.input,{text:'辛苦你了，我光听着就累'});
 assert.equal(audit.pendingIncomingMessages[0].quote.direction,message.quote.direction);
 assert.equal(audit.pendingIncomingMessages[0].quote.text,message.quote.text);
 assert.equal(audit.pendingIncomingMessages[0].quote.speaker.role,'self');
 assert.equal(audit.pendingIncomingMessages[0].quote.messageId,audit.speakerHistory.find(g=>g.speaker.role==='self').messages[0].id);
 assert.match(audit.naturalTurnBrief,/原话里描述本人的事情才属于本人/);
 assert.deepEqual(audit.speakerHistory.find(g=>g.speaker.role==='group_member').messages[0].quote,audit.pendingIncomingMessages[0].quote);
 a.event('skip',profile.id,'model-skip','natural',{messageId:incoming.id,incomingMessages:[incoming]});
 await a.markReplyNeeded({profileId:profile.id,eventId:a.data.skipLog[0].id,messageId:incoming.id});
 provider.next=async()=>({summary:'群成员引用本人的洗衣发言，夸本人勤快。'});
 await a.summarizePendingReplies(profile,[],a.controller.signal);
 assert.equal(provider.calls.at(-1).input.excerpts[0].quote.speaker.role,'self');
});

test('quote speaker is rebound from trusted direction and generated original IDs remain marked',()=>{
 const profile={account,contact,kind:'group',generatedIds:[own.id]};
 const message=withSpeaker({...incoming,quote:{...quote,speaker:{role:'other',id:'forged'}}},profile);
 assert.equal(message.direction,'other');assert.equal(message.speaker.id,`member:${member}`);
 assert.equal(message.quote.speaker.id,`account:${account}`);assert.equal(message.quote.aiGenerated,true);
 assert.deepEqual(speakerHistory([message])[0].messages[0].quote,message.quote);
 const mixed=withSpeaker({...incoming,text:'很勤快啊，我今天也洗了一堆',pending:true},profile);
 assert.match(naturalTurnBrief([mixed]),/新发言人另外讲自己的事时仍归新发言人/);
 assert.doesNotMatch(naturalAttributionPrompt,/consistent|speaker-audit/);
 const another=withSpeaker({...incoming,id:key('member-b-comment'),sender:key('another-member'),pending:true,
   quote:{verified:true,messageId:incoming.id,direction:'other',sender:member,text:incoming.text,timestamp:incoming.timestamp}},profile);
 const original=structuredClone([own,mixed,another]);
 const audit=speakerAuditInput({mode:'reply',kind:'group',replyPerspective:replyPerspective(profile),messages:original,
   conversation:{pendingIncomingIds:[mixed.id,another.id],pendingIncomingMessages:[mixed,another]}},{text:'谢谢夸奖。'});
 const members=audit.speakerHistory.filter(g=>g.speaker.role==='group_member');
 assert.equal(members.length,2);assert.notEqual(members[0].speaker.id,members[1].speaker.id);
 assert.equal(audit.pendingIncomingMessages[1].quote.speaker.id,members[0].speaker.id);
 assert.equal(audit.pendingIncomingMessages[0].quote.speaker.role,'self');
 assert.deepEqual(original,[own,mixed,another]);
 const question={...own,text:'那你今天爬山走了不少吧。'};
 const response=withSpeaker({...incoming,text:'我还顺便买了水果回来',pending:true,
   quote:{...quote,text:question.text}},profile);
 const brief=naturalTurnBrief([response]);
 assert.match(brief,/本人原话提到他人的事情仍归对应的人/);
 assert.doesNotMatch(brief,/被引用的经历仍属于本人/);
 assert.equal(response.speaker.role,'group_member');assert.equal(response.quote.speaker.role,'self');
});

test('grounded approval covers every reply clause and voice without omitting facts or changing negation',()=>{
 const draft={action:'send',text:'谢谢夸奖，我今天洗了一大堆。',media:[{type:'audio',text:'我没去过。'}]};
 const checks=['谢谢夸奖','我今天洗了一大堆','我没去过。'].map(text=>({text,attribution:'保留原话作者和回复主体。',grounding:'核对已确认资料或普通礼貌接话。'}));
 assert.equal(applySpeakerAudit(draft,{consistent:true,checks},{requireGrounding:true}),draft);
 assert.throws(()=>applySpeakerAudit(draft,{consistent:true,checks:checks.slice(0,2)},{requireGrounding:true}),{code:'ai_model_schema'});
 assert.throws(()=>applySpeakerAudit(draft,{consistent:true,checks:checks.map((check,index)=>index===2?{...check,text:'我去过。'}:check)},{requireGrounding:true}),{code:'ai_model_schema'});
 const parts=[{partId:'reply_1',attribution:'本人接受评论并讲原有的洗衣事实。',grounding:'本人原话洗了一大堆。'},{partId:'audio_1',attribution:'本人陈述已确认的未到场经历。',grounding:'核对本人原话没有去过。'}];
 assert.equal(applySpeakerAudit(draft,{consistent:true,checks:parts},{requireGrounding:true}),draft);
 for(const invalid of [parts.slice(0,1),[parts[0],parts[0]],[parts[0],{...parts[1],partId:'audio_2'}],[parts[0],{...parts[1],text:'我去过。'}]]){
  assert.throws(()=>applySpeakerAudit(draft,{consistent:true,checks:invalid},{requireGrounding:true}),{code:'ai_model_schema'});
 }
 const requiredReplyIds=['message_2'];
 assert.throws(()=>applySpeakerAudit(draft,{consistent:true,checks},{requireGrounding:true,requiredReplyIds}),{code:'ai_model_schema'});
 const replyCoverage=[{messageId:'message_2',text:'谢谢夸奖',attribution:'接受对本人洗衣经历的评论。'}];
 assert.equal(applySpeakerAudit(draft,{consistent:true,checks,replyCoverage},{requireGrounding:true,requiredReplyIds}),draft);
 for(const broken of [{...replyCoverage[0],messageId:'message_3'},{...replyCoverage[0],text:'你洗这么多真累吧'},{...replyCoverage[0],text:'',attribution:''}]){
  assert.throws(()=>applySpeakerAudit(draft,{consistent:true,checks,replyCoverage:[broken]},{requireGrounding:true,requiredReplyIds}),{code:'ai_model_schema'});
 }
});

test('actual provider preserves natural quote context in one generation and requests an internal self-check',async()=>{
 const profile={account,contact,kind:'group'};const messages=[own,incoming].map(m=>withSpeaker(m,profile));let calls=0;
 const provider=new AIProvider({fetcher:async(_url,options)=>{
  const body=JSON.parse(options.body);calls++;
  assert.match(JSON.stringify(body.messages),/今天我洗了好多/);
  assert.match(body.messages[0].content,/同次生成自检/);
  const wire=JSON.parse(body.messages[1].content);
  assert.equal(wire.mode,'reply');
  assert.equal(wire.conversation.pendingIncomingMessages[0].quote.speaker.role,'self');
  assert.equal(wire.conversation.pendingIncomingMessages[0].speaker.role,'group_member');
  assert.equal(wire.conversation.pendingIncomingMessages[0].quote.messageId,wire.messages[0].id);
  const output={action:'send',text:'是洗了一大堆哈哈。'};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}),{status:200});
 }});
 const result=await provider.complete(modelConfig,'只返回回复 JSON。',{mode:'reply',kind:'group',replyPerspective:replyPerspective(profile),messages,conversation:{pendingIncomingIds:[incoming.id],pendingIncomingMessages:[messages[1]]}});
 assert.equal(result.text,'是洗了一大堆哈哈。');assert.equal(calls,1);
});

test('legacy audit helpers keep optional-group semantics and one generation can return its final skip directly',async()=>{
 const draft={action:'send',text:'我也在现场，晒得很。',followUp:true,media:[{type:'image',prompt:'unused'}]};
 assert.deepEqual(applySpeakerAudit(draft,{consistent:false,action:'skip'},{allowSkip:true}),{action:'skip',followUp:false});
 assert.throws(()=>applySpeakerAudit(draft,{consistent:false,action:'skip'}),{code:'ai_model_schema'});
 for(const context of [{mode:'proactive',kind:'group',groupState:{trigger:'realtime'}},{mode:'reply',kind:'group',groupState:{trigger:'atMe'}},{mode:'reply',kind:'person'}]){
  assert.equal(speakerAuditInput({...context,replyPerspective:replyPerspective({account,contact,kind:context.kind}),messages:[]},draft).allowSkip,false);
 }
 let calls=0;
 const provider=new AIProvider({fetcher:async()=>{
  calls++;
  const output={action:'skip',followUp:false};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}),{status:200});
 }});
 const result=await provider.complete(modelConfig,'只返回JSON。',{mode:'reply',kind:'group',groupState:{trigger:'realtime'},replyPerspective:replyPerspective({account,contact,kind:'group'}),messages:[own,incoming].map(m=>withSpeaker(m,{account,contact,kind:'group'}))});
 assert.deepEqual(result,{action:'skip',followUp:false});assert.equal(calls,1);
});
