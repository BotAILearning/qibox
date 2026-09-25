import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { groupDefaults, groupOptions, groupTrigger, groupDecision, groupRealtimeIntervalMs } from '../server/ai-group.mjs';
import { DockerRuntime } from '../server/docker-runtime.mjs';
import { Instances } from '../server/instances.mjs';
import { testDefinition as applicationDefinition, testCatalog } from './fixtures/app-catalog.mjs';
import { LoginState } from '../server/login-state.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup, runtimeFactory, delay } from './fixtures.mjs';

async function aiFixture(t) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  let time = 100000;
  const a = new AIAssistant({ dataRoot: root, bridge, provider, now: () => time });
  await a.init(); await a.configure(modelConfig); await a.testProvider(); await a.scan();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { a, root, bridge, provider, advance: n => time += n };
}

test('verified provider replacement preserves saved config on failure and discards a cancelled verification', async t => {
  const { a, provider, root } = await aiFixture(t), before = await readFile(path.join(root, 'ai-assistant.json'), 'utf8');
  provider.test = async () => { throw new Error('connection failure'); };
  await assert.rejects(a.verifyProvider({ ...modelConfig, model: 'new-model' }));
  assert.equal(a.config.model, modelConfig.model); assert.equal(a.configured(), true);
  assert.equal(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'), before);
  const entered = Promise.withResolvers(), done = Promise.withResolvers();
  provider.test = async () => { entered.resolve(); await done.promise; };
  const verification = a.verifyProvider({ ...modelConfig, model: 'cancelled-model' }); await entered.promise;
  await a.cancel(); done.resolve(); await assert.rejects(verification, /变化/);
  assert.equal(a.config.model, modelConfig.model);
  provider.test = async () => {};
  await a.verifyProvider({ ...modelConfig, model: 'new-model' }); assert.equal(a.config.model, 'new-model'); assert.equal(a.configured(), true);
  assert.equal('apiKey' in a.publicState().provider, false);
});

test('contact parent toggle preserves children, aborts its pending work and reenables from a fresh baseline', async t => {
  const { a, bridge } = await aiFixture(t), contact = bridge.contacts[0].id;
  await a.setReplyOptions({ contact, multiTurn: true, judgeReply: false });
  const profile = a.profiles().find(p => p.contact === contact), controller = new AbortController();
  a.replyControllers.set(profile.id, controller);
  await a.setReplyOptions({ contact, enabled: false }); assert.equal(controller.signal.aborted, true);
  assert.deepEqual(a.replyOptions(profile), { enabled: false, multiTurn: true, judgeReply: false });
  bridge.push(contact, 'other', 'disabled-period');
  await a.setReplyOptions({ contact, enabled: true });
  assert.equal(a.cursors.get(profile.id)?.pending ?? false, false); assert.equal(a.replyOptions(profile).judgeReply, false);
  await a.settings({ enabled: true }); await a.tick();
  assert.equal(bridge.sent.length, 0);
});

test('group trigger matrix never guesses mentions or lets realtime bypass a disabled mention switch', () => {
  const message = flags => ({ direction: 'other', mentions: { verified: true, self: false, all: false, others: false, ...flags } });
  const realtime = { ...groupDefaults(), realtime: true };
  assert.throws(() => groupOptions({ realtime: true }));
  assert.deepEqual(groupOptions({ realtime: true, confirmRealtime: true }), realtime);
  assert.equal(groupTrigger(message({}), realtime), 'realtime');
  for (const flags of [{ self: true }, { all: true }, { others: true }, { verified: false }]) assert.equal(groupTrigger(message(flags), realtime), null);
  assert.equal(groupTrigger(message({ self: true }), { ...realtime, atMe: true }), 'atMe');
  assert.equal(groupTrigger(message({ all: true }), { ...realtime, atAll: true }), 'atAll');
  assert.equal(groupDecision({ action: 'wait', waitSeconds: 31 }), null);
  assert.equal(groupDecision({ action: 'pause', pauseSeconds: 10 }), null);
  for (let bits = 0; bits < 8; bits++) {
    const options = { atMe: !!(bits & 1), atAll: !!(bits & 2), realtime: !!(bits & 4) };
    assert.equal(groupTrigger(message({ self: true }), options), options.atMe ? 'atMe' : null);
    assert.equal(groupTrigger(message({ all: true }), options), options.atAll ? 'atAll' : null);
    assert.equal(groupTrigger(message({ others: true }), options), null);
    assert.equal(groupTrigger(message({}), options), options.realtime ? 'realtime' : null);
    assert.equal(groupTrigger(message({ self: true, all: true }), options), options.atMe ? 'atMe' : options.atAll ? 'atAll' : null);
  }
});

test('group trigger decisions no longer accept model waits; internal rate controls remain separate', async t => {
  const { a, bridge, provider, advance } = await aiFixture(t), contact = bridge.contacts[0].id;
  bridge.contacts[0].kind = 'group'; await a.scan();
  await a.setGroupOptions({ contact, atMe: true, realtime: true, confirmRealtime: true });
  const profile = a.profiles().find(p => p.contact === contact), atMe = new AbortController(), live = new AbortController();
  a.replyControllers.set(`${profile.id}:atMe`, atMe); a.replyControllers.set(`${profile.id}:realtime`, live);
  await a.setGroupOptions({ contact, atMe: false }); assert.equal(atMe.signal.aborted, true); assert.equal(live.signal.aborted, false);
  await a.settings({ enabled: true, replyScope: 'selected' }); await a.tick();
  Object.assign(bridge.push(contact, 'other'), { sender: key('group-member'), mentions: { verified: true, self: false, all: false, others: false } });
  await a.tick(); provider.next = async () => ({ action: 'send', text: '群聊正常回复' }); advance(groupRealtimeIntervalMs); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(profile.groupWait, undefined);
  assert.equal(a.cursors.get(profile.id).pending, false);
});

test('activity log survives restart and only exposes the current account', async t => {
  const { a, root, bridge, provider } = await aiFixture(t);
  for (let i = 0; i < 2005; i++) a.event('skip');
  a.data.events.push({ code: 'error', account: key('different-account'), at: 1 }); await a.save();
  assert.equal(a.publicState().events.length, 2000);
  const copy = new AIAssistant({ dataRoot: root, bridge, provider }); await copy.init();
  assert.equal(copy.publicState().events.length, 2000); await copy.close();
  assert.doesNotMatch(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'), /CHAT_PRIVATE_MARKER/);
});

test('native and container instances require no WeChat installation or AI timers and survive WeChat data cleanup', async t => {
  const dataRoot = await temp(), library = { installed: () => null };
  const owner = new Instances({ appCatalog: testCatalog, appRoot: path.resolve('.'), dataRoot, host: 'fnos', dev: true, runtimeFactory, library }); await owner.init();
  t.after(async () => { await owner.close(); await cleanup(dataRoot); });
  const space = await owner.get('1000'); await space.setConsent(true);
  for (const appId of ['calculator', 'static-site']) {
    const meta = await space.add(appId, appId), item = space.get(meta.id);
    assert.equal(item.ai.timer, undefined); assert.equal(item.scheduler.timer, undefined);
    await space.start(meta.id); assert.equal(item.runtime.status, 'running');
    await space.clearData(); assert.equal(space.get(meta.id), item);
    await space.remove(meta.id); const restored = await space.restore(meta.id); assert.equal(restored.appId, appId);
  }
  await assert.rejects(space.add('微信', 'wechat'), /安装微信/);
});

test('Docker ownership and loopback port checks prevent stopping or proxying a foreign container', async t => {
  const dataRoot = await temp(), calls = []; t.after(() => cleanup(dataRoot));
  const runtime = new DockerRuntime({ dataRoot, definition: applicationDefinition('static-site'), command: async args => {
    calls.push(args);
    if (args[0] === 'ps') return runtime.name;
    if (args[0] === 'inspect') return JSON.stringify([{ Config: { Labels: { 'com.qibox.instance': 'foreign' } } }]);
    assert.fail('must not mutate a foreign container');
  } });
  await assert.rejects(runtime.start(), /归属/); await assert.rejects(runtime.stop(), /归属/);
  assert.equal(runtime.webPort, null); assert.equal(calls.some(c => ['stop', 'start', 'run'].includes(c[0])), false);
});

test('a hung login probe times out, retains the confirmed entry and allows a new probe', async () => {
  let time = 100000;
  const state = new LoginState({ timeoutMs: 10, now: () => time, probe: async () => ({ status: 'logged-in' }) });
  await state.refresh(); state.probe = () => new Promise(() => {}); time += 26000;
  await Promise.all([state.refresh(true), delay(20)]);
  assert.equal(state.details(true).loginCheckTimedOut, true); assert.equal(state.entryAvailable(true), true);
  state.probe = async () => ({ status: 'logged-out' }); await state.refresh(true); assert.equal(state.entryAvailable(true), false);
});

test('shutdown tolerates an unavailable Docker service without reporting a stopped container', async t => {
  const dataRoot = await temp(); t.after(() => cleanup(dataRoot));
  const runtime = new DockerRuntime({ dataRoot, definition: applicationDefinition('static-site'), command: async () => {
    throw Object.assign(new Error('service unavailable'), { code: 'docker-unavailable' });
  } });
  await assert.rejects(runtime.stop(), /service unavailable/);
  await runtime.stop({ shutdown: true });
  assert.equal(runtime.status, 'unavailable'); assert.equal(runtime.webPort, null);
});
