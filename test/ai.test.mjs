import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider, providerValue } from '../server/ai-provider.mjs';
import { styleValue, defaultStyle } from '../server/ai-schema.mjs';
import { AIModelFixture, ChatFixture, modelConfig, strategy, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function fixture(t, { configured = true } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture(); let now = 1000000;
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now, interval: () => 180000 }); await assistant.init();
  t.after(async () => { await assistant.close(); await cleanup(root); });
  if (configured) {
    await assistant.configure(modelConfig); await assistant.testProvider(); await assistant.scan();
    await assistant.learn({ contacts: bridge.contacts.slice(0, 2).map(x => x.id) });
    await assistant.saveStrategy(strategy); await assistant.saveStrategy(strategy, undefined, 'reply'); await assistant.targets(assistant.profiles().map(p => p.id));
  }
  return { assistant, bridge, provider, root, advance: ms => now += ms, now: () => now };
}
async function enabled(ai, modes = { proactive: true, reply: true }) { await ai.settings(modes); await ai.settings({ enabled: true }); }

test('manual input waits for native cleanup and a held input prevents AI resuming after cooldown', async t => {
  const { assistant: a, bridge, advance } = await fixture(t);
  await enabled(a); await a.queueAction('start');
  const release = Promise.withResolvers(), signal = a.controller.signal;
  bridge.waitForIdle = () => release.promise;
  let forwarded = false;
  const barrier = a.manualInput({ source: 'desktop-one', type: 'pointer', held: true }).then(() => { forwarded = true; });
  assert.equal(signal.aborted, true); await Promise.resolve(); assert.equal(forwarded, false);
  release.resolve(); await barrier; advance(30000); await a.tick(); assert.equal(bridge.sent.length, 0);
  await a.manualInput({ source: 'desktop-two', type: 'pointer', held: true });
  await a.manualInput({ source: 'desktop-one', type: 'disconnect', held: false });
  advance(30000); await a.tick(); assert.equal(bridge.sent.length, 0);
  await a.manualInput({ source: 'desktop-two', type: 'pointer', held: false });
  advance(14999); await a.tick(); assert.equal(bridge.sent.length, 0);
  advance(1); await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('rescanning discards reply cursors tied to the old native ledger', async t => {
  const { assistant: a } = await fixture(t);
  await enabled(a, { reply: true }); await a.tick(); assert.ok(a.cursors.size);
  await a.scan(); assert.equal(a.cursors.size, 0); assert.equal(a.data.settings.enabled, true);
});

test('automatic draft verification never turns the master off or exposes a recovery step', async t => {
  const { assistant:a, bridge }=await fixture(t); await enabled(a); await a.queueAction('start');
  bridge.waitForIdle=async()=>{throw Error('pending input verification');};
  await assert.rejects(a.manualInput({type:'key',held:true}),/verification/);
  assert.equal(a.publicState().manualRecovery,false);assert.equal(a.data.settings.enabled,true);
  assert.equal(a.data.queue.status,'running');
  bridge.waitForIdle=async()=>{};await a.manualInput({type:'key',held:false});
  assert.equal(a.data.settings.enabled,true);assert.equal(bridge.sent.length,0);
});

test('learning completion, disabling and cancellation release native plaintext observations', async t => {
  const { assistant: a, bridge } = await fixture(t);
  let cleared = 0; bridge.clearContext = () => { cleared++; };
  await a.learn({ contacts: [bridge.contacts[0].id] }); assert.equal(cleared, 1);
  await enabled(a, { reply: true }); await a.tick(); const beforeDisable = cleared;
  await a.settings({ enabled: false }); assert.equal(cleared, beforeDisable + 1); assert.equal(a.cursors.size, 0);
  await a.cancel(); assert.equal(cleared, beforeDisable + 2);
});

test('model configuration enables the switch while proactive launch still validates targets and strategy', async t => {
  const { assistant: a, bridge } = await fixture(t, { configured: false });
  await assert.rejects(a.settings({ proactive: true, enabled: true }), /配置模型/);
  await a.configure(modelConfig); await a.testProvider();
  await a.settings({ proactive: true });
  await a.settings({ enabled: true }); assert.equal(a.data.settings.enabled, true);
  await a.scan(); await a.learn({ contacts: [bridge.contacts[0].id] }); await a.targets(a.profiles().map(x => x.id));
  await a.settings({ proactive: true });
  await a.settings({ enabled: true }); await assert.rejects(a.queueAction('start'), /主动策略/);
  await a.saveStrategy(strategy); await a.saveStrategy(strategy, undefined, 'reply'); await enabled(a); assert.equal(a.publicState().settings.enabled, true);
  await a.configure({ ...modelConfig, model: 'another' }); assert.equal(a.publicState().settings.enabled, true); assert.equal(a.publicState().provider.tested, false);
});

test('one launch sends once per target after random-range intervals without waiting for replies', async t => {
  const { assistant: a, bridge, advance, now } = await fixture(t);
  await enabled(a); await a.queueAction('start'); await a.tick(); assert.equal(bridge.sent.length, 1);
  assert.equal(a.publicState().queue.nextAt, now() + 180000);
  await a.tick(); advance(179999); await a.tick(); assert.equal(bridge.sent.length, 1);
  advance(1); await a.tick(); assert.equal(bridge.sent.length, 2); assert.equal(a.publicState().queue.status, 'completed');
  advance(600000); await a.tick(); assert.equal(bridge.sent.length, 2);
  for (let i = 0; i < 100; i++) { const interval = new AIAssistant({ dataRoot: '.', bridge }).interval(); assert.ok(interval >= 120000 && interval <= 300000); }
});

test('reply rounds merge bursts, can skip, refresh only enum style and do not respond to old history', async t => {
  const { assistant: a, bridge, provider, advance } = await fixture(t);
  await enabled(a, { reply: true }); await a.settings({ updateStyle: true, replyDelay: 8 }); await a.tick(); assert.equal(bridge.sent.length, 0);
  const contact = bridge.contacts[0].id;
  bridge.push(contact, 'other', '第一句'); await a.tick(); advance(5000); bridge.push(contact, 'other', '第二句'); await a.tick();
  advance(19999); await a.tick(); assert.equal(bridge.sent.length, 0); advance(1); await a.tick(); assert.equal(bridge.sent.length, 1);
  assert.equal(a.profiles()[0].style.warmth, '亲切');
  bridge.push(contact, 'other', '话题结束'); await a.tick(); advance(20000); provider.next = async () => ({ action: 'skip' }); await a.tick();
  assert.equal(bridge.sent.length, 1); advance(20000); await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('manual outgoing messages take over even when a new incoming message arrives in the same poll', async t => {
  const { assistant: a, bridge, advance } = await fixture(t);
  await enabled(a, { reply: true }); await a.tick(); const contact = bridge.contacts[0].id;
  bridge.push(contact, 'self', '用户接管'); bridge.push(contact, 'other', '同时收到'); await a.tick(); advance(10000); await a.tick();
  assert.equal(a.profiles()[0].paused, false); assert.equal(bridge.sent.length, 0);
  advance(290000); await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('deselecting a queued contact skips it when the remaining queue resumes', async t => {
  const { assistant: a, bridge, advance } = await fixture(t);
  await a.learn({ contacts: [bridge.contacts[2].id] });
  const [first, removed, remaining] = a.profiles(); await a.targets([first.id, removed.id, remaining.id]);
  await enabled(a); await a.queueAction('start'); await a.tick();
  await a.targets([first.id, remaining.id]);
  assert.equal(a.publicState().queue.items.find(x => x.id === removed.id).status, 'skipped');
  await a.settings({ enabled: true }); await a.queueAction('resume'); advance(180000); await a.tick();
  assert.deepEqual(bridge.sent.map(x => x.contact), [first.contact, remaining.contact]);
  assert.equal(a.publicState().queue.status, 'completed');
});

test('resuming a legacy queue rechecks pending contacts against the current selection', async t => {
  const { assistant: a, bridge, advance } = await fixture(t);
  const [selected, excluded] = a.profiles(); await a.targets([selected.id]); await enabled(a);
  // A previously persisted queue can predate a change of the selected scope.
  a.data.queue = { status: 'paused', items: [{ id: excluded.id, status: 'pending' }, { id: selected.id, status: 'pending' }], nextAt: null };
  await a.queueAction('resume'); advance(180000); await a.tick();
  assert.deepEqual(bridge.sent.map(x => x.contact), [selected.contact]);
  assert.equal(a.publicState().queue.items[0].status, 'skipped');
});

test('manual takeover is checked before a due proactive send in both mode combinations', async t => {
  for (const reply of [false, true]) await t.test(`reply=${reply}`, async t => {
    const { assistant: a, bridge, advance } = await fixture(t);
    await enabled(a, { proactive: true, reply }); await a.queueAction('start'); await a.tick();
    const next = a.profiles()[1]; bridge.push(next.contact, 'self', '用户已接管'); bridge.push(next.contact, 'other', '收到');
    advance(180000); await a.tick();
    assert.equal(bridge.sent.length, 1); assert.equal(next.paused, false);
    assert.equal(a.publicState().queue.items[1].status, 'skipped');
    assert.equal(a.publicState().queue.status, 'completed'); assert.equal(a.publicState().queue.nextAt, null);
    assert.equal(a.publicState().events.filter(x => x.code === 'manual' && x.target === next.id).length, 1);
  });
});

test('manual messages arriving during proactive generation pause the contact instead of regenerating', async t => {
  const { assistant: a, bridge, provider, advance } = await fixture(t);
  await enabled(a, { proactive: true }); await a.queueAction('start');
  const contact = bridge.contacts[0].id;
  provider.next = async () => { bridge.push(contact, 'self', '用户已接管'); return { action: 'send', text: '过时的自动消息' }; };
  await a.tick(); advance(10000); await a.tick();
  assert.equal(bridge.sent.length, 0); assert.equal(a.profiles()[0].paused, false);
  assert.equal(a.publicState().queue.items[0].status, 'skipped');
});

test('delivery rechecks selected scope after the send-intent write completes', async t => {
  const { assistant: a, bridge } = await fixture(t);
  await enabled(a); await a.queueAction('start');
  const [removed, selected] = a.profiles(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const save = a.save.bind(a); let gated = false;
  a.save = async () => {
    await save();
    if (!gated && removed.delivery?.status === 'sending') { gated = true; entered.resolve(); await release.promise; }
  };
  const work = a.tick(); await entered.promise; await a.targets([selected.id]); release.resolve(); await work;
  assert.equal(bridge.sent.length, 0);
  assert.equal(removed.delivery.status, 'cancelled');
  assert.equal(a.publicState().queue.items.find(x => x.id === removed.id).status, 'skipped');
});

test('generation rejects a profile outside the current selected scope before using its chat', async t => {
  const { assistant: a, bridge, provider } = await fixture(t);
  const [selected, excluded] = a.profiles(); await a.targets([selected.id]); await enabled(a);
  const snapshot = await bridge.read({ contact: excluded.contact }), calls = provider.calls.length;
  await a.generate(excluded, snapshot, 'proactive', a.revision, a.controller.signal);
  assert.equal(provider.calls.length, calls); assert.equal(bridge.sent.length, 0);
});

test('turning master off during generation cancels late delivery; pause and resume retain progress', async t => {
  const { assistant: a, bridge, provider, advance } = await fixture(t);
  await enabled(a); await a.queueAction('start'); const started = Promise.withResolvers(), complete = Promise.withResolvers();
  provider.next = async () => { started.resolve(); return complete.promise; };
  const work = a.tick(); await started.promise; await a.settings({ enabled: false }); complete.resolve({ action: 'send', text: 'late' }); await work;
  assert.equal(bridge.sent.length, 0); assert.equal(a.publicState().queue.status, 'paused');
  await a.settings({ enabled: true }); await a.queueAction('resume'); await a.tick(); assert.equal(bridge.sent.length, 0);
  advance(180000); await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('unknown send is never retried, and restart preserves settings with the queue settled', async t => {
  const { assistant: a, bridge, root, advance } = await fixture(t);
  bridge.delivery = async () => { throw new Error('connection lost after send'); };
  await enabled(a); await a.queueAction('start'); await a.tick(); assert.equal(a.publicState().queue.items[0].status, 'skipped');
  advance(900000); await a.tick(); assert.equal(a.publicState().queue.status, 'completed');
  const restarted = new AIAssistant({ dataRoot: root, bridge }); await restarted.init();
  assert.equal(restarted.publicState().settings.enabled, true); assert.equal(restarted.publicState().queue.items[0].status, 'skipped'); await restarted.close();
});

test('chat content, generated messages and plain API secrets never reach persistent AI state', async t => {
  const { assistant: a, root } = await fixture(t);
  await enabled(a); await a.queueAction('start'); await a.tick();
  const saved = await readFile(path.join(root, 'ai-assistant.json'), 'utf8');
  for (const marker of ['CHAT_PRIVATE_MARKER', 'GENERATED_PRIVATE_MARKER', 'only-a-test-key']) assert.equal(saved.includes(marker), false, marker);
  assert.equal(JSON.stringify(a.publicState()).includes('only-a-test-key'), false);
  assert.equal(Object.hasOwn(styleValue({ ...defaultStyle, text: 'secret', customTone: 'model-fact' }), 'text'), false);
  assert.equal(styleValue({ ...defaultStyle, customTone: 'model-fact' }).customTone, '');
  await assert.rejects(a.editProfile(a.profiles()[0].id, { style: { ...defaultStyle, warmth: '聊天中的秘密' } }));
});

test('account change clears targets and queue and never reuses the former account profiles', async t => {
  const { assistant: a, bridge } = await fixture(t);
  await enabled(a); bridge.account = key('another-account'); await a.scan();
  assert.equal(a.profiles().length, 0); assert.equal(a.publicState().targets.length, 0); assert.equal(a.publicState().settings.enabled, false);
});

test('cancelling a learning operation discards the returned style and original pasted text', async t => {
  const { assistant: a, provider, root } = await fixture(t);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  provider.next = async () => { entered.resolve(); return finish.promise; };
  const learn = a.learn({ label: '取消的风格', text: 'PASTE_PRIVATE_MARKER' }); const rejection = assert.rejects(learn, /取消/);
  await entered.promise; await a.cancel(); finish.resolve({ style: defaultStyle }); await rejection;
  assert.equal(a.profiles().some(p => p.label === '取消的风格'), false);
  assert.equal((await readFile(path.join(root, 'ai-assistant.json'), 'utf8')).includes('PASTE_PRIVATE_MARKER'), false);
});

test('changed context before delivery causes regeneration without sending stale text', async t => {
  const { assistant: a, bridge, provider, advance } = await fixture(t);
  await enabled(a); await a.queueAction('start'); provider.next = async () => { bridge.push(bridge.contacts[0].id, 'other'); return { action: 'send', text: 'stale' }; };
  await a.tick(); assert.equal(bridge.sent.length, 0); advance(10000); await a.tick(); assert.equal(bridge.sent.length, 1); assert.notEqual(bridge.sent[0].text, 'stale');
});

test('provider uses private server requests, rejects redirects and never echoes vendor errors', async () => {
  let request;
  const model = new AIProvider({ fetcher: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })); } });
  await model.test(modelConfig); assert.equal(request.url, 'https://models.example.test/v1/chat/completions'); assert.equal(request.options.redirect, 'error');
  const broken = new AIProvider({ fetcher: async () => new Response('vendor-secret', { status: 401 }) });
  await assert.rejects(broken.test(modelConfig), e => /认证失败/.test(e.message) && !e.message.includes('vendor-secret'));
  assert.throws(() => providerValue({ ...modelConfig, baseUrl: 'file:///tmp/data' }));
  assert.throws(() => providerValue({ ...modelConfig, baseUrl: 'https://name:password@example.com' }));
  assert.throws(() => providerValue({ ...modelConfig, baseUrl: 'http://169.254.169.254' }));
  assert.equal(providerValue({ ...modelConfig, baseUrl: 'https://other.example.test/v1', apiKey: '' }, modelConfig).apiKey, '');
  assert.equal(providerValue({ ...modelConfig, apiKey: '' }, modelConfig).apiKey, '');
  assert.equal(providerValue({ ...modelConfig, apiKey: undefined }, modelConfig).apiKey, modelConfig.apiKey);
  assert.equal(providerValue({ ...modelConfig, clearKey: true }, modelConfig).apiKey, '');
  assert.throws(() => providerValue({ ...modelConfig, apiKey: '********' }, modelConfig), /完整的 API Key/);
  assert.equal(providerValue({ ...modelConfig, baseUrl: 'http://192.168.1.2:11434/v1' }).baseUrl, 'http://192.168.1.2:11434/v1');
  assert.throws(() => providerValue({ ...modelConfig, baseUrl: 'http://192.168.public.example' }));
});

test('user interaction temporarily yields the desktop while preserving the queue', async t => {
  const { assistant: a, bridge, advance } = await fixture(t);
  await enabled(a); await a.queueAction('start'); a.userActivity();
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(a.publicState().queue.status, 'running');
  advance(15000); await a.tick(); assert.equal(bridge.sent.length, 1);
});

test('manual style corrections survive per-round model updates and repeated learning', async t => {
  const { assistant: a, bridge, advance } = await fixture(t);
  const profile = a.profiles()[0];
  await a.editProfile(profile.id, { style: { ...profile.style, customTone: '保持克制', customAvoid: '不要使用叹号' } });
  await a.learn({ contacts: [profile.contact] }); assert.equal(a.profiles()[0].style.customTone, '保持克制');
  await enabled(a, { reply: true }); await a.settings({ updateStyle: true }); await a.tick();
  bridge.push(profile.contact, 'other'); await a.tick(); advance(20000); await a.tick();
  assert.equal(a.profiles()[0].style.customTone, '保持克制'); assert.equal(a.profiles()[0].style.customAvoid, '不要使用叹号');
});

test('judgment-disabled skip is retried without becoming an implicit handoff', async t => {
  const { assistant: a, bridge, provider, advance } = await fixture(t);
  await enabled(a, { reply: true }); await a.settings({ judgeReply: false }); await a.tick();
  bridge.push(bridge.contacts[0].id, 'other'); await a.tick(); advance(20000);
  provider.next = async () => ({ action: 'skip' }); await a.tick();
  assert.equal(a.profiles()[0].paused, false); assert.equal(a.publicState().events[0].code, 'replied');
  assert.equal(bridge.sent.length, 1); assert.equal(a.publicState().events.some(e=>e.code==='handoff'),false);
});

test('pasted learning can bind explicitly to a detected contact without storing pasted content', async t => {
  const { assistant: a, bridge, root } = await fixture(t, { configured: false });
  await a.configure(modelConfig); await a.testProvider(); await a.scan();
  await a.learn({ contact: bridge.contacts[0].id, text: 'PASTED_BOUND_MARKER' });
  const profile = a.profiles()[0]; assert.equal(profile.contact, bridge.contacts[0].id); assert.equal(profile.account, bridge.account);
  await a.targets([profile.id]); assert.equal(a.publicState().targets.length, 1);
  assert.equal((await readFile(path.join(root, 'ai-assistant.json'), 'utf8')).includes('PASTED_BOUND_MARKER'), false);
});


test('model discovery validates drafts, retains only same-service credentials and never changes saved readiness', async t => {
  const { assistant: a, provider, root } = await fixture(t);
  const before = await readFile(path.join(root, 'ai-assistant.json'), 'utf8'); let received;
  provider.models = async config => { received = config; return ['chat']; };
  assert.deepEqual(await a.discoverModels({ ...modelConfig, model: '', apiKey: undefined }), { models: ['chat'] });
  assert.equal(received.apiKey, modelConfig.apiKey);
  await a.discoverModels({ ...modelConfig, model: '', apiKey: '' }); assert.equal(received.apiKey, '');
  await a.discoverModels({ ...modelConfig, model: '', baseUrl: 'https://new.example/v1', apiKey: '' });
  assert.equal(received.apiKey, '');
  assert.equal(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'), before);
  assert.deepEqual(await a.discoverModels({ ...modelConfig, model: '', consent: false }), { models: ['chat'] });
  assert.equal(await readFile(path.join(root, 'ai-assistant.json'), 'utf8'), before);
  await assert.rejects(a.discoverModels({ ...modelConfig, protocol: 'unsupported' }), /接口类型/);
  assert.equal(providerValue({ ...modelConfig, protocol: 'anthropic', apiKey: '' }, modelConfig).apiKey, '');
});

test('discovery handles complete endpoints, filters non-chat IDs and rejects malformed and failed responses', async () => {
  let request;
  const p = new AIProvider({ fetcher: async (url, options) => { request = { url, options }; return Response.json({ data: [{ id: 'chat' }, { id: 'chat' }, { id: 'text-embedding-3' }, { id: 'rerank' }, { id: 'whisper-1' }, { id: 'z-chat' }, { id: 12 }] }); } });
  assert.deepEqual(await p.models({ ...modelConfig, baseUrl: modelConfig.baseUrl + '/chat/completions' }), ['chat', 'z-chat']);
  assert.equal(request.url, modelConfig.baseUrl + '/models'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer ' + modelConfig.apiKey);
  for (const response of [Response.json({ bad: true }), Response.json({ data: [] }), new Response('SECRET', { status: 401 }), new Response('SECRET', { status: 404 }), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const broken = new AIProvider({ fetcher: async () => response });
    await assert.rejects(broken.models(modelConfig), e => !e.message.includes('SECRET'));
  }
});

test('Anthropic uses the selected model literally and supports paginated model lists', async () => {
  const requests = [], config = { ...modelConfig, protocol: 'anthropic', model: 'user-chosen-model' };
  const p = new AIProvider({ fetcher: async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') return Response.json({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' });
    return Response.json(url.includes('after_id=') ? { data: [{ id: 'second' }], has_more: false } : { data: [{ id: 'first' }], has_more: true, last_id: 'first' });
  } });
  await p.test(config);
  const request = requests[0], body = JSON.parse(request.options.body);
  assert.equal(request.url, config.baseUrl + '/messages'); assert.equal(request.options.headers['x-api-key'], config.apiKey);
  assert.equal(request.options.headers.Authorization, undefined); assert.equal(body.model, 'user-chosen-model');
  assert.ok(body.system); assert.equal(body.messages[0].role, 'user'); assert.ok(body.max_tokens > 0);
  assert.deepEqual(await p.models(config), ['first', 'second']); assert.ok(requests[2].url.includes('after_id=first'));
});

test('Anthropic normalizes SDK bases, versioned bases and explicit endpoints consistently for messages and models', async () => {
  const paths = [
    ['', '/v1/messages'], ['/', '/v1/messages'], ['/v1', '/v1/messages'], ['/v1/', '/v1/messages'],
    ['/anthropic', '/anthropic/v1/messages'], ['/anthropic/', '/anthropic/v1/messages'],
    ['/anthropic/v1', '/anthropic/v1/messages'], ['/anthropic/v1/', '/anthropic/v1/messages'],
    ['/anthropic/v1/messages', '/anthropic/v1/messages'], ['/anthropic/v1/messages/', '/anthropic/v1/messages'],
    ['/gateway/anthropic', '/gateway/anthropic/v1/messages'], ['/custom/messages', '/custom/messages'],
  ];
  for (const [basePath, messagePath] of paths) {
    const requests = [], origin = 'https://models.example.test';
    const config = { ...modelConfig, protocol: 'anthropic', baseUrl: origin + basePath, model: 'MiniMax-M3' };
    const provider = new AIProvider({ fetcher: async (url, options) => {
      requests.push({ url, options });
      return options.method === 'POST' ? Response.json({ content: [{ type: 'thinking', thinking: 'ignored' }, { type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }) : Response.json({ data: [{ id: config.model }], has_more: false });
    } });
    await provider.test(config);
    assert.deepEqual(await provider.models(config), [config.model]);
    assert.deepEqual(requests.map(x => x.url), [origin + messagePath, origin + messagePath.replace(/\/messages$/, '/models?limit=100')], basePath);
    assert.equal(JSON.parse(requests[0].options.body).model, 'MiniMax-M3');
    for (const { options } of requests) {
      assert.equal(options.headers['x-api-key'], config.apiKey);
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, 'error');
    }
  }
});

test('OpenAI endpoints keep provider-specific paths and complete URLs without inserting a version', async () => {
  for (const basePath of ['', '/v1', '/api/paas/v4', '/v1beta/openai', '/compatible-mode/v1']) {
    for (const suffix of ['', '/', '/chat/completions', '/chat/completions/']) {
      const origin = 'https://models.example.test', config = { ...modelConfig, protocol: 'openai', baseUrl: origin + basePath + suffix }, requests = [];
      const provider = new AIProvider({ fetcher: async (url, options) => {
        requests.push({ url, options });
        return options.method === 'POST' ? Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) : Response.json({ data: [{ id: config.model }] });
      } });
      await provider.test(config); await provider.models(config);
      assert.deepEqual(requests.map(x => x.url), [origin + basePath + '/chat/completions', origin + basePath + '/models']);
      for (const { options } of requests) {
        assert.equal(options.headers.Authorization, 'Bearer ' + config.apiKey);
        assert.equal(options.headers['x-api-key'], undefined);
      }
    }
  }
});

test('connection failures distinguish address/protocol, authentication and service failures without exposing vendor responses', async () => {
  for (const [status, expected] of [[400, /接口类型和模型名称/], [401, /认证失败/], [403, /认证失败/], [404, /服务地址、接口类型和模型名称/], [405, /服务地址和接口类型/], [429, /繁忙或额度不足/], [500, /暂时不可用/], [503, /暂时不可用/]]) {
    const provider = new AIProvider({ fetcher: async () => new Response('vendor-secret', { status }) });
    await assert.rejects(provider.test(modelConfig), error => expected.test(error.message) && !error.message.includes('vendor-secret'));
  }
});

for (const [request, reply] of [['请把文件发给我', '我现在不能发送文件，可以先用文字说明。'], ['现在给我打电话', '我不能打电话，但可以先用文字沟通。'], ['[语音]', '这段语音目前无法识别，请转成文字发我。']]) {
  test('text-only request gets an honest text response without pausing or retaining content: ' + request, async t => {
    const { assistant: a, bridge, advance, root, provider } = await fixture(t);
    provider.next = async () => ({ action: 'send', text: reply });
    await enabled(a); await a.tick();
    bridge.push(bridge.contacts[0].id, 'other', request); await a.tick(); advance(20000); await a.tick();
    const profile = a.profiles()[0]; assert.equal(profile.paused, false); assert.equal(profile.handoffReason, undefined);
    assert.equal(a.profiles()[1].paused, false); assert.equal(bridge.sent.length, 1); assert.equal(bridge.sent[0].text, reply);
    assert.equal((await readFile(path.join(root, 'ai-assistant.json'), 'utf8')).includes(request), false);
  });
}

test('proactive handoff skips only the affected contact and continues queue; generated false promises are stopped', async t => {
  const { assistant: a, bridge, provider, advance } = await fixture(t);
  await enabled(a); await a.queueAction('start');
  provider.next = async () => ({ action: 'send', text: '我马上给你打电话' });
  await a.tick(); assert.equal(bridge.sent.length, 0); assert.equal(a.profiles()[0].handoffReason, undefined); assert.equal(a.profiles()[0].paused,false);
  assert.equal(a.publicState().queue.items[0].status, 'skipped');
  advance(180000); await a.tick(); assert.equal(bridge.sent.length, 1); assert.equal(a.publicState().queue.status, 'completed');
});

test('text explanations remain available and a model skip is recorded without pausing', async t => {
  const { assistant: a, bridge, provider, advance } = await fixture(t);
  await enabled(a); await a.tick();
  bridge.push(bridge.contacts[0].id, 'other', '如何发送文件？'); await a.tick(); advance(20000); await a.tick();
  assert.equal(bridge.sent.length, 1);
  bridge.push(bridge.contacts[0].id, 'other', '帮我完成这笔转账'); await a.tick(); advance(20000);
  provider.next = async () => ({ action: 'skip' }); await a.tick();
  assert.equal(bridge.sent.length, 1); assert.equal(a.profiles()[0].paused, false);
  assert.equal(a.publicState().skipRecords[0].source, 'model-skip');
});
