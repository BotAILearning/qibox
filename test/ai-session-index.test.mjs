import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t) {
  const root = await temp(), bridge = new ChatFixture();
  const a = new AIAssistant({dataRoot:root,bridge}); await a.init();
  t.after(async()=>{await a.close();await cleanup(root);});
  await a.configure(modelConfig);await a.scan();
  for(const contact of bridge.contacts) await a.setReplyOptions({contact:contact.id,enabled:true});
  bridge.sessions=async()=>({account:bridge.account,sessions:bridge.contacts.map((contact,index)=>({id:contact.id,at:100+index,last:index+1,unread:0,hidden:0}))});
  return {a,bridge,profiles:a.profiles()};
}

test('chat-index contact ids resolve to account-scoped profile ids and unchanged rows are skipped', async t=>{
  const {a,profiles}=await fixture(t);
  assert.ok(profiles.every(p=>p.id!==p.contact));
  const first=await a.watchBatch();assert.equal(first.length,3);
  first.forEach(id=>a.markSessionSeen(id));
  assert.deepEqual(await a.watchBatch(),[]);
});

test('a changed chat is read immediately even when its profile is last in the target list', async t=>{
  const {a,bridge,profiles}=await fixture(t);
  (await a.watchBatch()).forEach(id=>a.markSessionSeen(id));
  bridge.sessions=async()=>({account:bridge.account,sessions:bridge.contacts.map((contact,index)=>({id:contact.id,at:100+index,last:index===2?99:index+1,unread:index===2?1:0,hidden:0}))});
  assert.deepEqual(await a.watchBatch(),[profiles[2].id]);
});

test('an unchanged index still keeps a pending reply in the merge and retry flow',async t=>{
  const {a,profiles}=await fixture(t);
  (await a.watchBatch()).forEach(id=>a.markSessionSeen(id));
  a.cursors.set(profiles[1].id,{pending:true});
  assert.deepEqual(await a.watchBatch(),[profiles[1].id]);
});

test('explicitly paused contacts consume no background reads and retain their counters',async t=>{
  const {a,profiles}=await fixture(t);
  profiles[0].paused=true;profiles[0].pauseReason='explicit';profiles[0].rounds=17;
  const watched=await a.watchBatch();assert.equal(watched.includes(profiles[0].id),false);assert.equal(profiles[0].rounds,17);
  profiles[0].pauseReason='limit';assert.equal((await a.watchBatch()).includes(profiles[0].id),true);
});

test('only contacts missing from the chat index use the fallback rotation',async t=>{
  const {a,bridge,profiles}=await fixture(t);
  const sessions=await bridge.sessions();bridge.sessions=async()=>({...sessions,sessions:sessions.sessions.slice(0,2)});
  (await a.watchBatch()).forEach(id=>a.markSessionSeen(id));
  assert.deepEqual(await a.watchBatch(),[profiles[2].id]);
});
