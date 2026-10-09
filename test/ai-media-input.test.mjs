import test from 'node:test';
import assert from 'node:assert/strict';
import {readableMediaInput} from '../server/ai-media-input.mjs';
import {AIAssistant} from '../server/ai-service.mjs';
import {AIProvider} from '../server/ai-provider.mjs';
import {ChatFixture,AIModelFixture,modelConfig} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
import {liveActivityBox} from '../web/ai-activity-view.mjs';

test('unreadable media is omitted from every current-turn reference without changing raw history',()=>{
  const messages=[{id:'v',direction:'other',type:'voice',unresolved:true},{id:'i',direction:'other',type:'image'},{id:'t',direction:'other',text:'hello'}];
  const input={messages,conversation:{pendingIncomingIds:['v','i','t'],pendingIncomingMessages:messages,pendingBySender:[{sender:'x',messageIds:['v','i','t']}],incomingSinceLastSelf:['v','i','t']},groupState:{triggerMessages:messages}};
  const output=readableMediaInput(input,{dropImages:true});
  assert.deepEqual(output.messages,[messages[2]]);assert.deepEqual(output.conversation.pendingIncomingIds,['t']);assert.equal(output.conversation.latestIncoming.id,'t');
  assert.deepEqual(output.conversation.pendingBySender[0].messageIds,['t']);assert.deepEqual(output.groupState.triggerMessages,[messages[2]]);assert.equal(input.messages.length,3);
});
test('old server terminal rows never render inside real-time status',()=>{
  assert.equal(liveActivityBox({live:[{phase:'unconfirmed'},{phase:'sent'},{phase:'skipped'},{phase:'cancelled'},{phase:'partial'}]}),'');
});

for(const kind of ['person','group'])for(const type of ['voice','image'])test(`${kind}: failed ${type} is consumed without a model request or forced reply`,async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();bridge.contacts[0].kind=kind;let now=1700000000000;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now});await a.init();clearInterval(a.timer);clearInterval(a.warmupTimer);await a.configure(modelConfig);await a.scan();
  const contact=bridge.contacts[0].id;
  if(kind==='group')await a.setGroupOptions({contact,atMe:true});else await a.setReplyOptions({contact,enabled:true});
  await a.settings({enabled:true});await a.tick();
  t.after(async()=>{await a.close();await cleanup(root);});
  const message=Object.assign(bridge.push(contact,'other',type==='voice'?'[语音]':'[图片]'),{type,mentions:{verified:true,self:true,all:false,others:false}});
  bridge.transcribe=async()=>{throw new Error('conversion failed');};bridge.readImage=async()=>null;
  await a.tick();now+=20000;await a.tick();await a.tick();
  const p=a.profiles()[0];assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);assert.equal(p.handledIncomingId,message.id);assert.equal(p.paused,false);assert.equal(a.liveStates().some(r=>r.id===p.id),false);
  assert.equal(a.publicState().skipRecords[0].reasonCode,'unsupported-media');
});

for(const protocol of ['openai','anthropic'])test(`${protocol}: request carries image bytes and unsupported image-only requests stop after one call`,async()=>{
  const requests=[];const provider=new AIProvider({fetcher:async(_,args)=>{requests.push(JSON.parse(args.body));return Response.json({error:{message:'image input is not supported'}},{status:400});}});
  const result=await provider.complete({...modelConfig,protocol},'system',{onlyImages:true,images:[{messageId:'i',mime:'image/png',data:'AAAA'}]});
  assert.deepEqual(result,{action:'skip',mediaSkipped:true});assert.equal(requests.length,1);const content=requests[0].messages.at(-1).content;
  assert.equal(content[2].type,protocol==='anthropic'?'image':'image_url');assert.equal(protocol==='anthropic'?content[2].source.data:content[2].image_url.url,protocol==='anthropic'?'AAAA':'data:image/png;base64,AAAA');
});

test('unsupported images in a mixed reply are removed from all references before the existing text fallback',async()=>{
  const bodies=[];
  const provider=new AIProvider({fetcher:async(_,args)=>{
    bodies.push(JSON.parse(args.body));
    return bodies.length===1 ? Response.json({error:{message:'image input is not supported'}},{status:400})
      : Response.json({choices:[{message:{content:JSON.stringify({action:'send',text:'文字答复'})}}]});
  }});
  const messages=[{id:'image',direction:'other',type:'image',text:'[图片]'},{id:'text',direction:'other',text:'文字问题'}];
  const result=await provider.complete(modelConfig,'system',{mode:'reply',messages,images:[{messageId:'image',mime:'image/png',data:'AAAA'}],
    conversation:{pendingIncomingIds:['image','text'],pendingIncomingMessages:messages},groupState:{triggerMessages:messages}});
  assert.equal(result.text,'文字答复');assert.equal(bodies.length,2);
  const input=JSON.parse(bodies[1].messages.at(-1).content);
  assert.equal(input.messages.length,1);assert.equal(input.messages[0].text,'文字问题');
  assert.equal(input.conversation.pendingIncomingIds.length,1);assert.equal(input.groupState.triggerMessages.length,1);
});

test('disabling replies during a failed image read cannot consume the incoming message',async t=>{
  const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();let now=1700000000000;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now});await a.init();await a.configure(modelConfig);await a.scan();
  t.after(async()=>{await a.close();await cleanup(root);});
  const contact=bridge.contacts[0].id;await a.setReplyOptions({contact,enabled:true});await a.settings({enabled:true});await a.tick();
  Object.assign(bridge.push(contact,'other','[图片]'),{type:'image'});
  bridge.readImage=async()=>{await a.settings({enabled:false});return null;};
  await a.tick();now+=20000;await a.tick();
  assert.equal(a.profiles()[0].handledIncomingId,undefined);assert.equal(provider.calls.length,0);assert.equal(bridge.sent.length,0);
  assert.equal(a.data.events.some(e=>e.reasonCode==='unsupported-media'),false);
});
