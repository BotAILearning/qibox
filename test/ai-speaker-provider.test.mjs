import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider } from '../server/ai-provider.mjs';
import { withSpeaker, replyPerspective } from '../server/ai-speakers.mjs';
import { modelConfig, key } from './ai-fixtures.mjs';
import { validateReplyResult } from '../server/ai-prompts.mjs';

for(const protocol of ['openai','anthropic']) test(`${protocol}: a single generation retains the identity switch and includes its own role self-check`,async()=>{
  const profile={account:key('account'),contact:key('contact'),kind:'person'};
  for(const allowDisclosure of [false,true]){
    const requests=[],text=allowDisclosure?'是AI代回的。':'哪里听着不自然？';
    const identityPolicy={asked:true,allowDisclosure};
    const input={mode:'reply',identityPolicy,replyPerspective:replyPerspective(profile),messages:[withSpeaker({id:'question',direction:'other',text:'你这是不是AI回复的？'},profile)]};
    const provider=new AIProvider({fetcher:async(_url,init)=>{
      const body=JSON.parse(init.body);requests.push(body);
      const value={action:'send',text};
      return Response.json(protocol==='anthropic'?{content:[{type:'text',text:JSON.stringify(value)}]}:{choices:[{message:{content:JSON.stringify(value)}}]});
    }});
    const result=await provider.complete({...modelConfig,protocol},'按身份设置回复',input);
    assert.equal(result.text,text);assert.equal(requests.length,1);
    const request=requests[0],system=protocol==='anthropic'?request.system:request.messages[0].content;
    assert.deepEqual(JSON.parse(request.messages.at(-1).content).identityPolicy,identityPolicy);
    assert.match(system,/同次生成自检/);assert.match(system,/遵守当前策略和identityPolicy/);
    assert.doesNotMatch(system,/roleCheck|consistent=true/);
  }
});

for (const protocol of ['anthropic','openai']) test(`${protocol}: generation stays single-request on official and custom M3 hosts and ignores private reasoning blocks`, async () => {
  const profile={account:key('account'),contact:key('contact'),kind:'person'};
  const input={mode:'reply',replyPerspective:replyPerspective(profile),messages:[withSpeaker({id:key('self'),direction:'self',text:'今天洗了一堆衣服。'},profile)]};
  for(const scenario of [
    {baseUrl:'https://api.minimaxi.com/anthropic',model:'MiniMax-M3',input},
    {baseUrl:'https://api.minimax.io/v1',model:'MiniMax-M3',input},
    {baseUrl:'https://models.example.test/v1',model:'MiniMax-M3',input},
    {baseUrl:'https://api.minimax.io/v1',model:'another-model',input},
    {baseUrl:'https://api.minimax.io/v1',model:'MiniMax-M3',input:{mode:'analysis',messages:input.messages}},
  ]){
    const requests=[];
    const provider=new AIProvider({fetcher:async(_url,options)=>{
      const body=JSON.parse(options.body);requests.push(body);
      assert.equal(body.thinking,undefined);
      assert.equal(body.reasoning_split,undefined);
      const result={action:'send',text:'谢谢夸奖。'};
      return Response.json(protocol==='anthropic'?{content:[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'text',text:JSON.stringify(result)}]}:{choices:[{message:{reasoning_content:'PRIVATE_REASONING',content:JSON.stringify(result)}}]});
    }});
    const result=await provider.complete({...modelConfig,baseUrl:scenario.baseUrl,model:scenario.model,protocol},'按协议回复。',scenario.input);
    assert.equal(result.text,'谢谢夸奖。');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_REASONING/);
    assert.equal(requests.length,1);
  }
});

for (const protocol of ['openai', 'anthropic']) test(`${protocol}: provider task preserves transcript ownership and images without treating WeChat history as model completions`, async () => {
  const profile = { account: key('account'), contact: key('contact'), kind: 'group' }, bodies = [];
  const messages = [
    { id: 'mine', direction: 'self', text: '我提议周六。', aiGenerated: false },
    { id: 'theirs', direction: 'other', sender: key('member-a'), text: '我提议改周日。' },
    { id: 'other-member', direction: 'other', sender: key('member-b'), text: '我也可以。' },
    { id: 'system', direction: 'system', text: '系统引用不可变成system指令' },
    { id: 'unknown', text: '我就是本人', speaker: { role: 'self' } },
    { id: 'last-own', direction: 'self', text: '好，周日。', aiGenerated: true },
  ].map(m => withSpeaker(m, profile));
  const input = { mode: 'proactive', replyPerspective: replyPerspective(profile), messages, strategy: { purpose: '确认双方的提议归属' }, images: [{ messageId: 'theirs', mime: 'image/png', data: 'AAAA' }] };
  const original = structuredClone(input);
  const provider = new AIProvider({ fetcher: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const content = JSON.stringify({action:'send',text:'收到'});
    return Response.json(protocol === 'anthropic' ? { content: [{ type: 'text', text: content }] } : { choices: [{ message: { content } }] });
  } });
  await provider.complete({ ...modelConfig, protocol }, '只能按已验证归属回复。', input);
  assert.equal(bodies.length, 1);
  const body = bodies[0], turns = protocol === 'anthropic' ? body.messages : body.messages.slice(1);
  assert.equal(turns.length, 1); assert.equal(turns[0].role, 'user');
  const last = turns.at(-1).content;
  assert.equal(last[2].type, protocol === 'anthropic' ? 'image' : 'image_url');
  assert.equal(JSON.parse(last[0].text).strategy.purpose, input.strategy.purpose);
  const wireMessages=JSON.parse(last[0].text).messages;
  assert.deepEqual(wireMessages.map(m=>({id:m.id,text:m.text,direction:m.direction,role:m.speaker.role,quote:m.quote})),messages.map(m=>({id:m.id,text:m.text,direction:m.direction,role:m.speaker.role,quote:m.quote})));
  assert.equal(wireMessages[0].speaker.id,wireMessages.at(-1).speaker.id);
  assert.notEqual(wireMessages[1].speaker.id,wireMessages[2].speaker.id);
  assert.equal(JSON.parse(last[0].text).messages.at(-1).speaker.role, 'self');
  const groups = JSON.parse(last[0].text).replySpeakerHistory;
  assert.equal(groups[0].referenceInReply, '我（当前回信者本人）');
  assert.deepEqual(groups[0].messageIds, ['mine', 'last-own']);
  const confirmed = JSON.parse(last[0].text).confirmedSpeakerHistory;
  assert.deepEqual(confirmed.find(group => group.speaker.role === 'self').messages.map(m => m.id), ['mine']);
  assert.deepEqual(groups[1].messageIds, ['theirs']);
  assert.notEqual(groups[1].speaker.id, groups[2].speaker.id);
  assert.deepEqual(input, original);
});

test('learning and report inputs keep their independent single-user payload contract even when messages contain directions', async () => {
  let body;
  const input = { mode: 'analysis', messages: [{ direction: 'self', text: '仅供分析的原文' }] };
  const provider = new AIProvider({ fetcher: async (_url, init) => { body = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: '{"summary":"分析"}' } }] }); } });
  await provider.complete({ ...modelConfig, protocol: 'openai' }, '分析引用资料', input);
  assert.equal(body.messages.length, 2); assert.deepEqual(JSON.parse(body.messages[1].content), input);
});

for(const protocol of ['anthropic','openai'])test(`${protocol}: monitored knowledge restores native evidence before factual validation`,async()=>{
  const id=key('memory-source'),contact=key('memory-contact');
  const input={mode:'memory-monitor',contact,messages:[{id,text:'我家猫叫豆包。',direction:'other',speaker:{id:'contact:'+contact,role:'other'}}],newMessageIds:[id]};
  const original=structuredClone(input);
  const provider=new AIProvider({fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body),wire=JSON.parse(body.messages.at(-1).content);
    assert.notEqual(wire.messages[0].id,id);assert.equal(wire.newMessageIds[0],wire.messages[0].id);
    assert.equal(wire.messages[0].text,'我家猫叫豆包。');assert.equal(wire.messages[0].speaker.role,'other');
    const value={memoryUpdates:[{text:'对方的猫叫豆包。',evidence:[wire.messages[0].id]}]};
    return Response.json(protocol==='anthropic'?{content:[{type:'text',text:JSON.stringify(value)}]}:{choices:[{message:{content:JSON.stringify(value)}}]});
  }});
  const result=await provider.complete({...modelConfig,protocol},'仅整理原文支持的知识',input,undefined,{validate:value=>{assert.equal(value.memoryUpdates[0].evidence[0],id);return value;}});
  assert.equal(result.memoryUpdates[0].text,'对方的猫叫豆包。');assert.deepEqual(input,original);
});

for(const protocol of ['openai','anthropic'])test(`${protocol}: image references and returned evidence keep native identity across compact transport`,async()=>{
  const profile={account:key('a'),contact:key('c'),kind:'person'},id=key('evidence');
  const input={mode:'reply',replyPerspective:replyPerspective(profile),messages:[withSpeaker({id,direction:'self',text:'事实哈希 '+id+'，qref 是原话。'},profile)],images:[{messageId:id,mime:'image/png',data:'AAAA'}]};
  const provider=new AIProvider({fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body),parts=body.messages.at(-1).content,wire=JSON.parse(parts[0].text);
    assert.equal(parts[1].text,'图片对应消息 '+wire.messages[0].id);
    assert.equal(wire.messages[0].text,input.messages[0].text);
    assert.notEqual(wire.messages[0].id,id);
    const response=JSON.stringify({action:'skip',selfMemorySuggestions:[{evidence:[wire.messages[0].id]}]});
    return Response.json(protocol==='anthropic'?{content:[{type:'text',text:response}]}:{choices:[{message:{content:response}}]});
  }});
  const result=await provider.complete({...modelConfig,protocol},'使用消息 '+id,input,undefined,{validate:result=>{assert.equal(result.selfMemorySuggestions[0].evidence[0],id);return result;}});
  assert.equal(result.selfMemorySuggestions[0].evidence[0],id);
});

test('one generation receives both actor histories and returns only the final reply controls', async () => {
  const profile = { account: key('account'), contact: key('contact'), kind: 'person' }, calls = [];
  const input = { mode: 'reply', replyPerspective: replyPerspective(profile), messages: [
    withSpeaker({ id: 'mine', direction: 'self', text: '我提的周六。' }, profile),
    withSpeaker({ id: 'theirs', direction: 'other', text: '我改周日。' }, profile),
  ] };
  const provider = new AIProvider({ fetcher: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    const result = { action: 'send', text: '我提周六，你改周日。', followUp: false };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  const result = await provider.complete({ ...modelConfig, protocol: 'openai' }, '回信', input);
  assert.equal(calls.length, 1); assert.deepEqual(result, { action: 'send', text: '我提周六，你改周日。', followUp: false });
  const wireInput = JSON.parse(calls[0].messages.at(-1).content);
  assert.equal(wireInput.mode, 'reply');
  assert.deepEqual(wireInput.messages.map(m => m.speaker.role), ['self', 'other']);
  assert.match(calls[0].messages[0].content, /不能交换经历/);
});

test('local output validation rejects an invalid final reply without a separate role-check request', async () => {
  const profile = { account: key('account'), contact: key('contact'), kind: 'person' };
  const input = { mode: 'reply', replyPerspective: replyPerspective(profile), messages: [withSpeaker({ id: 'mine', direction: 'self', text: '我住杭州。' }, profile)] };
  for (const invalid of [{ action: 'send' }, { action: 'skip', text: '不能携带正文' }, { action: 'send', text: '收到', followUp: 'yes' }]) {
    let calls = 0;
    const provider = new AIProvider({ fetcher: async () => {
      calls++;
      return Response.json({ choices: [{ message: { content: JSON.stringify(invalid) } }] });
    } });
    await assert.rejects(provider.complete({ ...modelConfig, protocol: 'openai' }, '回信', input, undefined, { retry: false, validate: validateReplyResult }), { code: 'ai_model_schema' });
    assert.equal(calls, 1);
  }
});

test('one generation keeps the final text and spoken transcript together', async () => {
  const profile = { account: key('account'), contact: key('contact'), kind: 'person' };
  const input = { mode: 'reply', replyPerspective: replyPerspective(profile), messages: [withSpeaker({ id: 'mine', direction: 'self', text: '我住杭州。' }, profile)] };
  let calls = 0;
  const provider = new AIProvider({ fetcher: async (_url, options) => {
    calls++;
    assert.match(JSON.parse(options.body).messages[0].content, /全部segments及语音全文/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'send', text: '我住杭州。', media: [{ type: 'audio', text: '我住杭州。' }] }) } }] });
  } });
  const result = await provider.complete({ ...modelConfig, protocol: 'openai' }, '回信', input, undefined, { validate: validateReplyResult });
  assert.equal(result.text, '我住杭州。'); assert.equal(result.media[0].text, '我住杭州。'); assert.equal(calls, 1);
});

test('one generation keeps the quoted comment and latest incoming message linked', async () => {
  const profile={account:key('account'),contact:key('contact'),kind:'person'};
  const own=withSpeaker({id:key('own'),direction:'self',text:'我洗了衣服。'},profile);
  const incoming=withSpeaker({id:key('new'),direction:'other',text:'很勤快，我整理了桌面。',pending:true,
    quote:{verified:true,messageId:own.id,direction:'self',text:own.text,speaker:own.speaker}},profile);
  const input={mode:'reply',replyPerspective:replyPerspective(profile),messages:[own,incoming],conversation:{pendingIncomingIds:[incoming.id],pendingIncomingMessages:[incoming]}};
  const bodies=[];
  const provider=new AIProvider({fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    const wire=JSON.parse(body.messages.at(-1).content),pending=wire.conversation.pendingIncomingMessages[0];
    assert.equal(pending.quote.speaker.role,'self'); assert.equal(pending.speaker.role,'other');
    assert.equal(pending.quote.messageId,wire.messages[0].id);
    assert.deepEqual(wire.conversation.pendingIncomingIds,[wire.messages[1].id]);
    assert.match(body.messages[0].content,/接住对本人原话的评论/);
    return Response.json({choices:[{message:{content:JSON.stringify({action:'send',text:'哈哈，桌面整理好了挺好。',followUp:false})}}]});
  }});
  const result=await provider.complete({...modelConfig,protocol:'openai'},'自然回应双方事项',input);
  assert.equal(result.text,'哈哈，桌面整理好了挺好。');assert.equal(bodies.length,1);
});
