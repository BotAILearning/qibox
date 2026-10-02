import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';
import { objectList, objectExecutionStatus } from '../web/ai-object-view.mjs';
import { observeGroupInbox, readGroupInbox } from '../server/ai-group-inbox.mjs';

async function fixture(t, kind = 'person') {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true; bridge.contacts[0].kind = kind;
  let now = 1800000000000, a;
  const create = async () => { a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, delay: async () => {} }); await a.init(); await a.scan(); };
  await create(); await a.configure(modelConfig);
  const contact = bridge.contacts[0].id;
  if (kind === 'group') await a.setGroupOptions({ contact, atMe: true, realtime: true, confirmRealtime: true });
  else await a.setReplyOptions({ contact, enabled: true });
  await a.settings({ enabled: true }); await a.tick();
  const profile = () => a.profiles().find(p => p.contact === contact);
  t.after(async () => { await a.close(); await cleanup(root); });
  return { root, bridge, provider, contact, get a() { return a; }, get p() { return profile(); }, advance(ms = 1000) { now += ms; }, async restart() { await a.close(); await create(); },
    cap() { Object.assign(profile(), { rounds: 200, mentionRounds: kind === 'group' ? 24 : 0, replyStrategy: { maxRounds: 200 }, ...(kind === 'group' ? { groupReplyLimitBlocked: true } : { paused: true, pauseReason: 'limit' }) }); },
  };
}

for (const kind of ['person','group']) test(`${kind}: closing the last reply switch ends and persists the round while keeping the limit`, async t => {
  const f = await fixture(t, kind); f.cap();
  if (kind === 'group') await f.a.setGroupOptions({ contact: f.contact, atMe: false, realtime: false });
  else await f.a.setReplyOptions({ contact: f.contact, enabled: false });
  assert.equal(f.p.rounds, 0); assert.equal(f.p.mentionRounds, 0); assert.equal(f.p.groupReplyLimitBlocked, undefined); assert.equal(f.p.replyStrategy.maxRounds, 200);
  assert.doesNotMatch(objectList(f.a.publicState(), {kind}), /200\/200|已达回复次数上限/);
  await f.restart(); assert.equal(f.p.rounds, 0);
  if (kind === 'group') await f.a.setGroupOptions({ contact: f.contact, atMe: true });
  else await f.a.setReplyOptions({ contact: f.contact, enabled: true });
  assert.equal(f.p.rounds, 0); assert.equal(f.p.replyStrategy.maxRounds, 200);
});

test('disabling only one group mode and saving ordinary strategy keeps the current count', async t => {
  const f = await fixture(t, 'group'); f.cap();
  await f.a.setGroupOptions({ contact: f.contact, realtime: false });
  assert.equal(f.p.rounds, 200); assert.equal(f.p.groupReplyLimitBlocked, true);
  await f.a.saveStrategy({maxRounds:200,replyGoal:'回答问题'},f.p.id,'reply');
  assert.equal(f.p.rounds, 200);
});

for (const kind of ['person','group']) for (const enabled of [true,false]) test(`${kind}: a real manual reply ends the capped round with takeover ${enabled}`, async t => {
  const f = await fixture(t, kind); await f.a.settings({takeover:{enabled,minutes:1}}); f.cap(); f.advance();
  const message = Object.assign(f.bridge.push(f.contact,'self','手动接管'),{timestamp:Math.floor(f.a.now()/1000)});
  await f.a.tick();
  assert.equal(f.p.lastManualId,message.id); assert.equal(f.p.rounds,0); assert.equal(f.p.mentionRounds,0); assert.equal(f.p.groupReplyLimitBlocked,undefined);
  assert.equal(f.p.replyStrategy.maxRounds,200);
  assert.doesNotMatch(objectList(f.a.publicState(),{kind}),/200\/200/);
  if(enabled) assert.equal(f.p.manualWait.ownId,message.id); else assert.equal(f.a.replySelected(f.p),false);
});

for (const setting of ['enabled','reply']) test(`closing global ${setting} ends all rounds without altering per-object caps`, async t => {
  const f = await fixture(t,'group'); f.cap();
  await f.a.settings({[setting]:false}); assert.equal(f.p.rounds,0); assert.equal(f.p.groupReplyLimitBlocked,undefined);
  await f.a.settings({[setting]:true}); assert.equal(f.p.rounds,0); assert.equal(f.p.replyStrategy.maxRounds,200);
});

test('active round survives restart; legacy disabled or manually ended state is repaired once', async t => {
  const f = await fixture(t,'group'); f.cap(); await f.a.save();
  await f.restart(); assert.equal(f.p.rounds,200); assert.equal(f.p.groupReplyLimitBlocked,true);
  Object.assign(f.p,{groupOptions:{atMe:false,atAll:false,realtime:false},sentMessages:[{id:key('history'),at:f.a.now()-1000,source:'reply'}]});
  await f.a.save(); await f.restart(); assert.equal(f.p.rounds,0); assert.equal(f.p.sentMessages.length,1);
  const version=f.p.replyRoundVersion; await f.restart(); assert.equal(f.p.replyRoundVersion,version);
  assert.equal(JSON.parse(await readFile(f.a.file,'utf8')).profiles[f.p.id].rounds,0);
});

test('AI messages and unknown ownership never end a round', async t => {
  const f = await fixture(t,'group'); f.cap();
  for(const message of [{id:key('ai'),aiGenerated:true},{id:key('unknown'),authorship:'unknown'}])f.a.observeManual(f.p,message);
  assert.equal(f.p.rounds,200); assert.equal(f.p.groupReplyLimitBlocked,true);
});

test('late authentication of a previous-round receipt records delivery without resurrecting its count', async t => {
  const f=await fixture(t); const baseline=f.bridge.messages.get(f.contact).at(-1).id;
  f.p.sentMessages=[{id:'old-operation',operationId:'old-operation',at:f.a.now(),source:'reply',replyRoundVersion:f.p.replyRoundVersion||0,baseline,body:f.a.vault.seal({text:'旧轮发送'}),confirmed:false,deliveryConfidence:'unknown'}];
  f.advance();await f.a.setReplyOptions({contact:f.contact,enabled:false});await f.a.setReplyOptions({contact:f.contact,enabled:true});
  const receipt=Object.assign(f.bridge.push(f.contact,'self','旧轮发送'),{timestamp:Math.floor((f.a.now()-1000)/1000)});
  const snapshot=await f.bridge.read({contact:f.contact});
  assert.equal(f.a.reconcileUnknownReplies(f.p,snapshot),true);assert.equal(f.p.rounds,0);
  assert.ok(f.p.generatedIds.includes(receipt.id));assert.equal(f.p.sentMessages[0].confirmed,true);
});

test('switching off during native submission keeps a confirmed receipt historical and stops more segments', async t => {
  const f=await fixture(t); f.p.replyStrategy={maxRounds:200}; const fresh=await f.bridge.read({contact:f.contact});
  f.bridge.delivery=async()=>{
    await f.a.setReplyOptions({contact:f.contact,enabled:false});
    const message=f.bridge.push(f.contact,'self','已经提交的一条');const after=await f.bridge.read({contact:f.contact});
    return {status:'sent',messageId:message.id,revision:after.revision};
  };
  const result=await f.a.deliver(f.p,fresh,'reply',f.a.revision,f.a.controller.signal,null,['第一条','第二条'],f.a.strategy(f.p,'reply'));
  assert.equal(result,'partial');assert.equal(f.p.rounds,0);assert.equal(f.p.sentMessages.length,1);
});

test('closing a group settles the old pending round so reopening cannot reply to its backlog', async t => {
  const f=await fixture(t,'group');f.cap();
  const m=Object.assign(f.bridge.push(f.contact,'other','旧轮尚未回复'),{timestamp:Math.floor(f.a.now()/1000),mentions:{verified:true,self:true}});
  observeGroupInbox(f.a.vault,f.p,await f.bridge.read({contact:f.contact}),f.a.cursors.get(f.p.id),f.a.now());
  assert.ok(readGroupInbox(f.a.vault,f.p).pending.some(x=>x.id===m.id));
  await f.a.setGroupOptions({contact:f.contact,atMe:false,realtime:false});
  assert.equal(readGroupInbox(f.a.vault,f.p).pending.length,0);
});

test('both list and live status suppress ended-round badges even with a stale cached counter', async t => {
  const contact={id:'group',kind:'group',label:'群聊'},p={id:'profile',contact:contact.id,kind:'group',rounds:200,replyStrategy:{maxRounds:200},groupReplyLimitBlocked:true,groupOptions:{atMe:true}};
  for(const change of [{groupOptions:{}},{manualWait:{ownId:'manual'}}]){
    const state={contacts:[contact],profiles:[{...p,...change}],settings:{enabled:true,reply:true}};
    assert.doesNotMatch(objectList(state,{kind:'group'}),/200\/200/);assert.doesNotMatch(objectExecutionStatus(state,contact.id),/已达到回复次数上限/);
  }
});
