import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root=await temp(), bridge=new ChatFixture(), provider=new AIModelFixture();
  let now=1700000000000; bridge.stableMessageIds=true;
  const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{}});
  await a.init(); await a.configure(modelConfig); await a.scan();
  const contact=bridge.contacts[0].id;
  await a.setReplyOptions({contact,enabled:true,judgeReply:false}); await a.settings({enabled:true}); await a.tick();
  t.after(async()=>{await a.close();await cleanup(root);});
  return {a,bridge,provider,contact,receive:async()=>{
    Object.assign(bridge.push(contact,'other','请回复收到'),{timestamp:Math.floor(now/1000)});
    await a.tick();now+=3000;await a.tick();
  }};
}

test('judgment off retries a skipped text reply once and sends only the corrected answer',async t=>{
  const {a,bridge,provider,receive}=await fixture(t);
  provider.next=async()=>({action:'skip'});
  await receive();
  assert.equal(provider.calls.length,2);
  assert.equal(bridge.sent.length,1);
  assert.equal(a.data.events.some(e=>e.code==='skip'),false);
  assert.match(provider.calls[0].system,/不允许判断“要不要跳过”/);
});

test('two skipped answers become a visible error, do not silently consume the request or loop forever',async t=>{
  const {a,bridge,provider,receive}=await fixture(t);
  let calls=0; provider.complete=async()=>{calls++;return {action:'skip'};};
  await receive();await a.tick();await a.tick();
  assert.equal(calls,2);assert.equal(bridge.sent.length,0);
  assert.ok(a.data.events.some(e=>e.code==='error'&&/重试后仍未生成/.test(e.message||e.detail||''))||/重试后仍未生成/.test(a.notice));
  assert.equal(a.data.events.some(e=>e.code==='skip'),false);
  assert.equal(a.profiles()[0].handledIncomingId,undefined);
});

test('judgment on cannot skip an ordinary private reply',async t=>{
  const {a,bridge,provider,receive,contact}=await fixture(t);
  await a.setReplyOptions({contact,judgeReply:true});let calls=0;provider.complete=async()=>{calls++;return {action:'skip'};};
  await receive();await a.tick();assert.equal(calls,2);assert.equal(bridge.sent.length,0);
  assert.equal(a.data.events.some(e=>e.code==='skip'),false);assert.ok(a.data.events.some(e=>e.code==='error'));
});

test('explicit group @me retries a skipped model decision but never fabricates a canned answer', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.scan();
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: target.id, atMe: true }); await a.settings({ enabled: true }); await a.tick();
  let calls = 0;
  provider.complete = async () => (++calls === 1 ? { action: 'skip' } : { action: 'send', text: '我看到了这个问题，正在核对相关内容' });
  const incoming = Object.assign(bridge.push(target.id, 'other', '@我 请处理'), {
    timestamp: Math.floor(now / 1000), sender: 'a'.repeat(64),
    mentions: { verified: true, self: true, all: false, others: false },
  });
  await a.tick(); now += 3000; await a.tick();
  assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0].contact, target.id);
  assert.equal(bridge.sent[0].text, '我看到了这个问题，正在核对相关内容');
  assert.equal(calls, 2);
  assert.equal(a.data.events.some(e => e.code === 'skip' && e.target === a.profiles()[0].id), false);
  assert.ok(incoming.id);
  await a.close(); await cleanup(root);
});

test('repeated @me skips are visible errors and remain unsent', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: target.id, atMe: true }); await a.settings({ enabled: true }); await a.tick();
  let calls = 0; provider.complete = async () => { calls++; return { action: 'skip' }; };
  Object.assign(bridge.push(target.id, 'other', '@我 具体问题'), { timestamp: Math.floor(now / 1000), sender: 'a'.repeat(64), mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); now += 3000; await a.tick(); await a.tick();
  assert.equal(calls, 2); assert.equal(bridge.sent.length, 0);
  assert.match(a.notice, /重试后仍未生成本轮来信/);
  assert.equal(a.data.events.some(e => e.code === 'skip'), false);
  await a.close(); await cleanup(root);
});

test('@all cannot consume an incoming message through model skip', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: target.id, atAll: true }); await a.settings({ enabled: true }); await a.tick();
  let calls=0,lastCall;provider.complete=async(config,system,input)=>{calls++;lastCall={system,input};return { action: 'skip' };};
  Object.assign(bridge.push(target.id, 'other', '@所有人 通知'), { timestamp: Math.floor(now / 1000), sender: 'a'.repeat(64), mentions: { verified: true, self: false, all: true, others: false } });
  await a.tick(); now += 3000; await a.tick();
  await a.tick();assert.equal(calls, 2); assert.equal(bridge.sent.length, 0);
  assert.equal(lastCall.input.judgeReply, false);
  assert.match(lastCall.system, /不能返回skip/);
  assert.equal(a.data.events.some(e=>e.code==='skip'), false);assert.ok(a.data.events.some(e=>e.code==='error'));
  await a.close(); await cleanup(root);
});

test('unreadable image on @me reaches the model and is not silently skipped', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true; bridge.readImage = async () => null;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: target.id, atMe: true }); await a.settings({ enabled: true }); await a.tick();
  provider.next = async () => ({ action: 'send', text: '我这里看不到图片，可以请你用文字描述一下吗？' });
  const image = Object.assign(bridge.push(target.id, 'other', '[图片]'), { type: 'image', timestamp: Math.floor(now / 1000), sender: 'a'.repeat(64), mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); now += 3000; await a.tick();
  assert.equal(provider.calls.length, 1); assert.equal(bridge.sent.length, 1);
  assert.equal(provider.calls[0].input.messages.find(m => m.id === image.id).unresolved, true);
  await a.close(); await cleanup(root);
});

test('@me retries a model wait instead of scheduling or skipping it', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: target.id, atMe: true }); await a.settings({ enabled: true }); await a.tick();
  let calls = 0; provider.complete = async () => ++calls === 1 ? { action: 'wait', waitSeconds: 30 } : { action: 'send', text: '我来回答这个问题' };
  Object.assign(bridge.push(target.id, 'other', '@我 这个问题'), { timestamp: Math.floor(now / 1000), sender: 'a'.repeat(64), mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); now += 3000; await a.tick();
  assert.equal(calls, 2); assert.equal(bridge.sent.length, 1);
  assert.equal(a.data.events.some(e => ['wait', 'pause', 'skip'].includes(e.code)), false);
  await a.close(); await cleanup(root);
});

test('@me post-generation identity rejection is visible and not silently consumed', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: target.id, atMe: true }); await a.settings({ enabled: true }); await a.tick();
  provider.next = async () => ({ action: 'send', text: '我是AI，這個問題我來處理' });
  Object.assign(bridge.push(target.id, 'other', '@我 帮忙'), { timestamp: Math.floor(now / 1000), sender: 'a'.repeat(64), mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); now += 3000; await a.tick();
  assert.equal(bridge.sent.length, 0); assert.equal(a.profiles()[0].handledIncomingId, undefined);
  assert.match(a.notice, /未能生成可安全发送/);
  assert.ok(a.data.events.some(e => e.code === 'error' && e.source === 'atMe'));
  await a.close(); await cleanup(root);
});

test('@me post-generation unsupported media promise is visible and not silently consumed', async t => {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let now = 1700000000000; bridge.stableMessageIds = true;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} });
  await a.init(); await a.configure(modelConfig); await a.testProvider(); await a.scan();
  const target = bridge.contacts[0]; target.kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact: target.id, atMe: true }); await a.settings({ enabled: true }); await a.tick();
  provider.next = async () => ({ action: 'send', text: '我马上给你发图片' });
  Object.assign(bridge.push(target.id, 'other', '@我 发我图片'), { timestamp: Math.floor(now / 1000), sender: 'a'.repeat(64), mentions: { verified: true, self: true, all: false, others: false } });
  await a.tick(); now += 3000; await a.tick();
  assert.equal(bridge.sent.length, 0); assert.equal(a.profiles()[0].handledIncomingId, undefined);
  assert.match(a.notice, /未能生成可安全发送/);
  assert.ok(a.data.events.some(e => e.code === 'error' && e.source === 'atMe'));
  await a.close(); await cleanup(root);
});
