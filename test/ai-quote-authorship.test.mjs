import test from 'node:test';
import assert from 'node:assert/strict';
import { authoredMessages, contextualReplyStyle } from '../server/ai-context-learning.mjs';
import { withSpeaker, replyPerspective } from '../server/ai-speakers.mjs';
import { replyRoleAnchor } from '../server/ai-reply-role.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { replyFixedRules } from '../server/ai-reply-prompt.mjs';
import { key, modelConfig } from './ai-fixtures.mjs';

const profile=()=>({account:key('quote-owner'),contact:key('quote-peer'),kind:'person',generatedIds:[],sentMessages:[]});
const quote=(source)=>({verified:true,messageId:source.id,direction:source.direction,text:source.text,timestamp:source.timestamp});
const source={id:key('quote-source'),direction:'self',text:'我把旧相机送去维修了',timestamp:100};
const incoming={id:key('quote-incoming'),direction:'other',text:'这一下又得等挺久吧',timestamp:110,quote:quote(source)};
const vault={open:body=>body};

test('ordinary generation preserves unknown quoted authorship in source, pending turn and actual provider envelope',async()=>{
 const p=profile();p.sentMessages=[{id:source.id,confirmed:false,deliveryConfidence:'unknown',at:100000,body:{text:source.text}}];
 const original=structuredClone([source,incoming]);
 const messages=authoredMessages(vault,p,original).map(m=>withSpeaker({...m,pending:m.id===incoming.id},p));
 assert.equal(messages[0].authorship,'unknown');
 assert.equal(messages[1].quote.authorship,'unknown');
 const input={mode:'reply',kind:'person',roleAnchor:replyRoleAnchor(p),replyPerspective:replyPerspective(p),style:{summary:'简短接话'},contextualStyle:contextualReplyStyle(messages),messages,conversation:{pendingIncomingIds:[incoming.id],pendingIncomingMessages:[messages[1]]}};
 let wire,calls=0;const provider=new AIProvider({fetcher:async(_url,options)=>{calls++;wire=JSON.parse(options.body);return Response.json({choices:[{message:{content:'{"action":"send","text":"是得等一阵","followUp":false}'}}]});}});
 await provider.complete(modelConfig,replyFixedRules,input,undefined,{retry:false});
 const payload=JSON.parse(wire.messages.at(-1).content);
 assert.equal(payload.conversation.pendingIncomingMessages[0].quote.authorship,'unknown');
 assert.equal(payload.replyRelations[0].quotedMessage.authorship,'unknown');
 assert.equal(calls,1,'source metadata never adds a second request');
 assert.deepEqual(original,[source,incoming],'authorship annotation does not mutate native messages');
});

test('quotes outside the current window retain exact known AI and unknown receipt provenance without guessing missing human origin',()=>{
 for(const origin of ['ai','unknown']){
  const p=profile();if(origin==='ai')p.generatedIds=[source.id];else p.sentMessages=[{id:source.id,confirmed:false,deliveryConfidence:'unknown',at:100000,body:{text:source.text}}];
  const [row]=authoredMessages(vault,p,[incoming]);
  assert.equal(row.quote.authorship,origin);assert.equal(row.quote.text,source.text);
 }
 const [unrecorded]=authoredMessages(vault,profile(),[incoming]);
 assert.equal(unrecorded.quote.authorship,undefined,'an out-of-window unregistered source is not newly certified human');
});

test('quoted provenance keeps genuine self, counterpart and mixed narration distinct and preserves source text',()=>{
 const peer={...source,id:key('peer-quote'),direction:'other',text:'我哥拿走的是他自己的相机，我的还在家里'};
 const p=profile(),rows=[source,peer,{...incoming,quote:quote(source)},{...incoming,id:key('peer-incoming'),quote:quote(peer)}];
 const result=authoredMessages(vault,p,rows);
 assert.equal(result[2].quote.authorship,'human');assert.equal(result[3].quote.authorship,'other');
 assert.deepEqual(result.map(m=>m.text),rows.map(m=>m.text));assert.equal(result[3].quote.text,peer.text);
 assert.equal(result[2].direction,'other');assert.equal(result[3].direction,'other');
});

test('unknown source status is not upgraded by generated membership, a truncated quote or a repeated source ID',()=>{
 const p=profile();p.generatedIds=[source.id];p.sentMessages=[{id:source.id,confirmed:false,deliveryConfidence:'unknown',at:100000,body:{text:source.text}}];
 const short={...incoming,quote:{...quote(source),text:'我把旧相机',excerpt:true}};
 for(const rows of [[source,short],[short],[source,{...source},short]]){
  const result=authoredMessages(vault,p,rows),last=result.at(-1);
  assert.equal(last.quote.authorship,'unknown');assert.equal(last.quote.excerpt,true);assert.equal(last.quote.text,'我把旧相机');
 }
 const unverified={...incoming,quote:{verified:false}};
 assert.deepEqual(authoredMessages(vault,p,[unverified])[0].quote,{verified:false});
});

test('quoted provenance never transfers from another profile or an unmatched source body and preserves explicit uncertainty',()=>{
 const first=profile(),second={...profile(),account:key('second-owner'),contact:key('second-peer')};
 first.generatedIds=[source.id];
 assert.equal(authoredMessages(vault,first,[incoming])[0].quote.authorship,'ai');
 assert.equal(authoredMessages(vault,second,[incoming])[0].quote.authorship,undefined);
 for(const changed of [{...source,text:'另一段正文'},{...source,timestamp:99},{...source,direction:'other'}]){
  assert.equal(authoredMessages(vault,second,[changed,incoming])[1].quote.authorship,undefined);
 }
 const uncertain={...incoming,quote:{...incoming.quote,authorship:'unknown'}};
 assert.equal(authoredMessages(vault,second,[source,uncertain])[1].quote.authorship,'unknown');
});
