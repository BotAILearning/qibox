import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AIAssistant} from '../server/ai-service.mjs';
import {ChatFixture,AIModelFixture,modelConfig,strategy,key} from './ai-fixtures.mjs';
import {temp,cleanup} from './fixtures.mjs';
async function fixture(t){const root=await temp(),bridge=new ChatFixture(),provider=new AIModelFixture();bridge.stableMessageIds=true;let now=Date.parse('2026-10-22T12:00:00+08:00');const a=new AIAssistant({dataRoot:root,bridge,provider,now:()=>now,delay:async()=>{},random:min=>min});await a.init();await a.configure(modelConfig);await a.scan();const contact=bridge.contacts[0].id;await a.setReplyOptions({contact,enabled:true,judgeReply:false});const save=a.save;t.after(async()=>{a.save=save;await a.close();await cleanup(root);});return{a,root,bridge,provider,contact,p:a.profiles()[0],save,advance:ms=>now+=ms};}
async function holdWrite(f,fail){const entered=Promise.withResolvers(),held=Promise.withResolvers(),file=f.a.file,blocked=path.join(f.root,'blocked-visibility-json');await mkdir(blocked);let first=true;f.a.save=function(...args){if(!first)return f.save.apply(this,args);first=false;entered.resolve();return held.promise.then(async()=>{if(fail)this.file=blocked;try{return await f.save.apply(this,args);}finally{this.file=file;}});};return{entered:entered.promise,release:()=>held.resolve()};}
async function proof(name,value){if(!process.env.QIBOX_VISIBILITY_OUTPUT)return;const out=path.resolve(process.env.QIBOX_VISIBILITY_OUTPUT);await mkdir(out,{recursive:true});const source=await readFile(new URL('../server/ai-service.mjs',import.meta.url));await writeFile(path.join(out,`${name}.json`),JSON.stringify({at:new Date().toISOString(),sourceSha256:createHash('sha256').update(source).digest('hex'),realProviderCalls:0,realWechatSends:0,...value},null,2));}
for(const fail of [false,true])test(`pending parent enable ${fail?'failure':'success'} cannot run a production reply before persistence`,async t=>{
 const f=await fixture(t);await f.a.observe(f.p,await f.bridge.read({contact:f.contact}));const gate=await holdWrite(f,fail),operation=f.a.settings({enabled:true}),completed=fail?assert.rejects(operation):operation;await gate.entered;
 f.advance(1000);const incoming=f.bridge.push(f.contact,'other','这条合成消息在开启保存期间收到');incoming.timestamp=Math.floor(f.a.now()/1000);const observation=f.a.observe(f.p,await f.bridge.read({contact:f.contact}));await new Promise(resolve=>setImmediate(resolve));f.advance(20000);f.provider.next=async()=>({action:'stop',stop:true});
 const tick=f.a.tick();await new Promise(resolve=>setTimeout(resolve,50));const during={enabled:f.a.data.settings.enabled,providerCalls:f.provider.calls.length,sends:f.bridge.sent.length,canDeliver:f.a.canDeliver(f.p,'reply',f.a.revision,f.a.controller.signal)};gate.release();await completed;await observation;await tick;await proof(`settings-${fail?'failure':'success'}`,{during,after:{enabled:f.a.data.settings.enabled,providerCalls:f.provider.calls.length,sends:f.bridge.sent.length}});
 assert.equal(during.providerCalls,0);assert.equal(during.sends,0);assert.equal(during.canDeliver,false);assert.equal(f.a.data.settings.enabled,!fail);assert.equal(!!f.a.pendingSettingsEnable,false);if(!fail){await f.a.tick();assert.equal(f.provider.calls.length,1,'successful enable resumes the real production reply path');await proof('settings-success-resumed',{enabled:f.a.data.settings.enabled,pendingFence:!!f.a.pendingSettingsEnable,simulatedProviderCalls:f.provider.calls.length,simulatedSends:f.bridge.sent.length});}assert.equal(f.bridge.sent.length,0);t.diagnostic(`pending simulatedProviderCalls=${during.providerCalls}; final simulatedProviderCalls=${f.provider.calls.length}; realProviderCalls=0 sends=0`);
});
for(const fail of [false,true])test(`pending auto-learning enable ${fail?'failure':'success'} cannot start background model work before persistence`,async t=>{
 const f=await fixture(t);await f.a.testProvider();for(const messages of f.bridge.messages.values())for(const message of messages)message.timestamp=Math.floor(f.a.now()/1000);await f.a.settings({autoLearning:true});await f.a.tick();await f.a.settings({autoLearning:false});await f.a.observe(f.p,await f.bridge.read({contact:f.contact}));const gate=await holdWrite(f,fail),operation=f.a.settings({autoLearning:true}),completed=fail?assert.rejects(operation):operation;await gate.entered;
 const baseline=f.a.observe(f.p,await f.bridge.read({contact:f.contact}));await new Promise(resolve=>setImmediate(resolve));f.advance(1000);Object.assign(f.bridge.push(f.contact,'other','我喜欢喝合成测试茶'),{authorship:'other',timestamp:Math.floor(f.a.now()/1000)});const observation=f.a.observe(f.p,await f.bridge.read({contact:f.contact}));await new Promise(resolve=>setImmediate(resolve));f.advance(21000);const tick=f.a.tick({background:true});await new Promise(resolve=>setTimeout(resolve,50));const during={autoLearning:f.a.data.settings.autoLearning,providerCalls:f.provider.calls.length,memoryRuns:f.a.memoryRuns.size,sends:f.bridge.sent.length};gate.release();await completed;await baseline;await observation;await tick;await Promise.all([...f.a.memoryRuns.values()]);await proof(`learning-${fail?'failure':'success'}`,{during,after:{autoLearning:f.a.data.settings.autoLearning,providerCalls:f.provider.calls.length,sends:f.bridge.sent.length}});
 assert.equal(during.providerCalls,0);assert.equal(during.memoryRuns,0);assert.equal(during.sends,0);assert.equal(f.a.data.settings.autoLearning,!fail);assert.equal(!!f.a.pendingSettingsEnable,false);if(!fail){await f.a.tick({background:true});await Promise.all([...f.a.memoryRuns.values()]);assert.equal(f.provider.calls.length,1,'committed automatic learning must resume the real background provider path');await proof('learning-success-resumed',{autoLearning:f.a.data.settings.autoLearning,pendingFence:!!f.a.pendingSettingsEnable,simulatedProviderCalls:f.provider.calls.length,simulatedSends:f.bridge.sent.length});}assert.equal(f.bridge.sent.length,0);t.diagnostic(`pending simulatedProviderCalls=${during.providerCalls}; final simulatedProviderCalls=${f.provider.calls.length}; realProviderCalls=0 sends=0`);
});
for(const newer of [false,true])test(`failed legacy target removal retains ${newer?'newer':'original'} unscheduled continuation`,async t=>{
 const f=await fixture(t);await f.a.settings({proactive:true});await f.a.targets([f.p.id],'proactive');f.p.continuation={startedAt:f.a.now(),strategy:{...strategy}};await f.a.save();const before=structuredClone(f.p.continuation),gate=await holdWrite(f,true),operation=f.a.targets([],'proactive'),rejected=assert.rejects(operation);await gate.entered;if(newer)f.p.continuation={startedAt:f.a.now()+1,strategy:{...strategy,purpose:'newer continuation'}};const expected=newer?structuredClone(f.p.continuation):before;const background=f.a.save();gate.release();await rejected;await background;const disk=JSON.parse(await readFile(f.a.file,'utf8'));await proof(`continuation-${newer?'newer':'original'}`,{before,expected,after:f.p.continuation||null,disk:disk.profiles[f.p.id].continuation||null,simulatedProviderCalls:f.provider.calls.length,simulatedSends:f.bridge.sent.length});assert.deepEqual(f.p.continuation,expected);assert.deepEqual(disk.profiles[f.p.id].continuation,expected);assert.equal(f.a.continuing(f.p),true);assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);
});
for(const fail of [false,true])test(`pending lower bulk limit ${fail?'failure':'success'} cannot pause an active round before commit`,async t=>{
 const f=await fixture(t);await f.a.settings({enabled:true});await f.a.applyReplyLimitToKind('person',10);await f.a.observe(f.p,await f.bridge.read({contact:f.contact}));f.p.rounds=3;await f.a.save();const gate=await holdWrite(f,fail),operation=f.a.applyReplyLimitToKind('person',1),completed=fail?assert.rejects(operation):operation;await gate.entered;
 f.advance(1000);const incoming=f.bridge.push(f.contact,'other','合成批量上限等待中的新来信');incoming.timestamp=Math.floor(f.a.now()/1000);const observation=f.a.observe(f.p,await f.bridge.read({contact:f.contact}));await new Promise(resolve=>setImmediate(resolve));f.advance(20000);const tick=f.a.tick();await new Promise(resolve=>setTimeout(resolve,50));const during={paused:f.p.paused,pauseReason:f.p.pauseReason||null,rounds:f.p.rounds,providerCalls:f.provider.calls.length,sends:f.bridge.sent.length};gate.release();await completed;await observation;await tick;await proof(`bulk-${fail?'failure':'success'}`,{during,after:{paused:f.p.paused,pauseReason:f.p.pauseReason||null,maxRounds:f.a.strategy(f.p,'reply').maxRounds,providerCalls:f.provider.calls.length,sends:f.bridge.sent.length}});assert.equal(during.paused,false);assert.equal(during.providerCalls,0);assert.equal(during.sends,0);assert.equal(!!f.a.pendingBulkReplyLimit,false);assert.equal(f.a.strategy(f.p,'reply').maxRounds,fail?10:1);if(fail)assert.equal(f.p.paused,false);else{await f.a.tick();assert.equal(f.p.paused,true);assert.equal(f.p.pauseReason,'limit');}assert.equal(f.provider.calls.length,0);assert.equal(f.bridge.sent.length,0);
});

async function mixedFixture(t) {
 const f = await fixture(t);
 f.bridge.contacts[1].kind = 'group'; await f.a.scan();
 await f.a.setGroupOptions({ contact: f.bridge.contacts[1].id, atMe: true });
 await f.a.settings({ enabled: true }); await f.a.tick();
 return { ...f, group: f.a.profiles().find(p => p.contact === f.bridge.contacts[1].id) };
}
test('pending group bulk limit allows another-kind person reply to start and retains new group messages', async t => {
 const f = await mixedFixture(t);
 f.advance(1000); const incoming = f.bridge.push(f.contact, 'other', '合成另一类型待回复消息');
 incoming.timestamp = Math.floor(f.a.now() / 1000);
 await f.a.observe(f.p, await f.bridge.read({ contact: f.contact })); f.advance(20000);
 const gate = await holdWrite(f, true), operation = f.a.applyReplyLimitToKind('group', 1), rejected = assert.rejects(operation);
 await gate.entered;
 const groupIncoming = Object.assign(f.bridge.push(f.group.contact, 'other', '合成保存期间群聊新消息'), {
  timestamp: Math.floor(f.a.now() / 1000), sender: key('bulk-pending-member'), mentions: { verified: true, self: true, all: false, others: false }
 });
 let personCanDeliver = false;
 const providerEntered = Promise.withResolvers();
 f.provider.next = async () => { personCanDeliver = f.a.canDeliver(f.p, 'reply', f.a.revision, f.a.controller.signal); providerEntered.resolve(); return { action: 'stop', stop: true }; };
 const tick = f.a.tick(); let timeout;
 // Observe the required interleaving, not filesystem/journal completion in 50ms.
 // The group write remains held; a configuration-wide deadlock still fails.
 try { await Promise.race([providerEntered.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Unrelated person reply did not reach the provider while the group write was held')), 5000); })]); }
 catch (error) { gate.release(); await rejected; await tick; throw error; }
 finally { clearTimeout(timeout); }
 assert.equal(f.a.pendingBulkReplyLimit?.kind, 'group');
 const during = { providerCalls: f.provider.calls.length, kinds: f.provider.calls.map(call => call.input.kind), sends: f.bridge.sent.length,
  groupHandled: f.group.handledIncomingId === groupIncoming.id, personCanDeliver };
 gate.release(); await rejected; await tick;
 await proof('bulk-other-kind-start', { during, after: { providerCalls: f.provider.calls.length, sends: f.bridge.sent.length, groupHandled: f.group.handledIncomingId === groupIncoming.id } });
 assert.equal(during.providerCalls, 1, 'unrelated person reply must reach the provider while only group limits are pending');
 assert.deepEqual(during.kinds, ['person']); assert.equal(during.personCanDeliver, true);
 assert.equal(during.groupHandled, false); assert.equal(f.group.handledIncomingId === groupIncoming.id, false);
 assert.notEqual(f.a.cursors.get(f.group.id)?.last, groupIncoming.id, 'pending group message is left unread for the next committed-state tick');
 assert.equal(f.p.handledIncomingId, incoming.id); assert.equal(f.provider.calls.length, 1); assert.equal(f.bridge.sent.length, 0);
});
test('pending person bulk limit does not cancel an already generating other-kind group reply', async t => {
 const f = await mixedFixture(t); f.advance(1000);
 const incoming = Object.assign(f.bridge.push(f.group.contact, 'other', '合成已生成群聊回复测试'), {
  timestamp: Math.floor(f.a.now() / 1000), sender: key('bulk-running-member'), mentions: { verified: true, self: true, all: false, others: false }
 });
 await f.a.observe(f.group, await f.bridge.read({ contact: f.group.contact })); f.advance(20000);
 const providerEntered = Promise.withResolvers(), providerRelease = Promise.withResolvers();
 f.provider.next = async () => { providerEntered.resolve(); await providerRelease.promise; return { action: 'send', text: '合成群聊答复' }; };
 const tick = f.a.tick(); await providerEntered.promise;
 const gate = await holdWrite(f, true), operation = f.a.applyReplyLimitToKind('person', 1), rejected = assert.rejects(operation);
 await gate.entered; providerRelease.resolve(); await new Promise(resolve => setTimeout(resolve, 50));
 const during = { providerCalls: f.provider.calls.length, sends: f.bridge.sent.length, groupCanDeliver: f.a.canDeliver(f.group, 'reply', f.a.revision, f.a.controller.signal) };
 gate.release(); await rejected; await tick;
 await proof('bulk-other-kind-in-flight', { during, after: { providerCalls: f.provider.calls.length, sends: f.bridge.sent.length, groupRounds: f.group.rounds, groupPending: f.a.cursors.get(f.group.id)?.pending } });
 assert.equal(during.groupCanDeliver, true); assert.equal(f.provider.calls.length, 1, 'the existing generated reply must not need regeneration');
 assert.equal(f.bridge.sent.length, 1); assert.equal(f.bridge.sent[0].contact, f.group.contact); assert.equal(f.bridge.sent[0].text, '合成群聊答复');
 assert.equal(f.group.rounds, 1); assert.equal(f.a.cursors.get(f.group.id).pending, false);
});
