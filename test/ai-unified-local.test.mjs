import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIProvider } from '../server/ai-provider.mjs';
import { AIModelFixture, ChatFixture, modelConfig, key } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const responseBody = (protocol, text) => protocol === 'anthropic'
  ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
  : { choices: [{ message: { content: text }, finish_reason: 'stop' }] };

for (const protocol of ['openai', 'anthropic']) {
  for (const text of ['', '{"report":', 'this is not JSON']) {
    test(`${protocol} rejects empty/malformed output without reporting success or hidden retries: ${JSON.stringify(text)}`, async () => {
      let calls = 0;
      const provider = new AIProvider({ fetcher: async () => { calls++; return Response.json(responseBody(protocol, text)); } });
      await assert.rejects(provider.complete({ ...modelConfig, protocol }, 'Return JSON', { mode: 'analysis', messages: [] }, undefined, { retry: false }), error => /^ai_model_/.test(error.code) || /模型尚未返回完整正文/.test(error.message));
      assert.equal(calls, 1);
    });
  }
  test(`${protocol} repairs a malformed attempt with one bounded request using the same material`, async () => {
    const requests = [];
    const provider = new AIProvider({ fetcher: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json(responseBody(protocol, requests.length === 1 ? '{"report":' : '{"report":"saved synthetic report"}'));
    } });
    provider.backoff = async () => {};
    const result = await provider.complete({ ...modelConfig, protocol }, 'Return JSON', { mode: 'analysis', material: 'same synthetic material' });
    assert.deepEqual(result, { report: 'saved synthetic report' });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages.filter(message => message.role === 'user'), requests[1].messages.filter(message => message.role === 'user'));
  });
}

async function assistantFixture(t, { groups = false } = {}) {
  const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  bridge.stableMessageIds = true;
  if (groups) { bridge.contacts[1].kind = 'group'; bridge.contacts[2].kind = 'group'; }
  let now = Date.parse('2026-10-11T00:00:00Z');
  const options = { dataRoot: root, bridge, provider, now: () => now, delay: async ms => { now += ms; } };
  const a = new AIAssistant(options);
  await a.init(); await a.verifyProvider(modelConfig); await a.scan();
  t.after(async () => { await a.close(); await cleanup(root); });
  return { root, bridge, provider, a, options, advance: ms => { now += ms; },
    incoming(index) {
      const message = Object.assign(bridge.push(bridge.contacts[index].id, 'other', `synthetic incoming ${bridge.sequence}`), { timestamp: Math.floor(now / 1000) });
      if (bridge.contacts[index].kind === 'group') Object.assign(message, { sender: key(`member-${index}`), mentions: { verified: true, self: true, all: false, others: false } });
      return message;
    } };
}

test('one person and two groups count only confirmed sends, reset on explicit master reopen and preserve the new round on restart', async t => {
  const f = await assistantFixture(t, { groups: true });
  await f.a.setReplyOptions({ contact: f.bridge.contacts[0].id, enabled: true, judgeReply: true });
  for (const contact of f.bridge.contacts.slice(1)) await f.a.setGroupOptions({ contact: contact.id, atMe: true });
  await f.a.settings({ enabled: true }); await f.a.tick();
  f.incoming(0);
  f.provider.next = async () => ({ action: 'skip' });
  await f.a.tick(); f.advance(21000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 0);
  assert.ok(f.a.profiles().every(profile => profile.rounds === 0));
  for (let index = 0; index < 3; index++) f.incoming(index);
  await f.a.tick(); f.advance(21000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 3);
  for (const contact of f.bridge.contacts) assert.equal(f.a.profiles().find(profile => profile.contact === contact.id).rounds, 1);
  await f.a.settings({ enabled: false }); await f.a.settings({ enabled: true }); await f.a.scan();
  assert.ok(f.a.profiles().every(profile => profile.rounds === 0), 'explicit master reopen ends the old round by the established product rule');
  await f.a.tick();
  assert.equal(f.bridge.sent.length, 3, 'master reopen never replays a skipped or confirmed old message');
  f.advance(1000);
  for (let index = 0; index < 3; index++) f.incoming(index);
  await f.a.tick(); f.advance(21000); await f.a.tick();
  assert.equal(f.bridge.sent.length, 6);
  assert.ok(f.a.profiles().every(profile => profile.rounds === 1));
  await f.a.close();
  const restarted = new AIAssistant(f.options); await restarted.init();
  try {
    await restarted.scan(); await restarted.tick();
    assert.equal(f.bridge.sent.length, 6, 'restart never replays an already confirmed send or skipped message');
    assert.ok(restarted.profiles().every(profile => profile.rounds === 1));
    f.incoming(1); await restarted.tick(); f.advance(21000); await restarted.tick();
    assert.equal(f.bridge.sent.length, 7);
    assert.deepEqual(f.bridge.contacts.map(contact => restarted.profiles().find(profile => profile.contact === contact.id).rounds), [1, 2, 1]);
  } finally { await restarted.close(); }
});

async function savedReport(f, report) {
  f.bridge.readRange = async args => ({ account: args.account, contact: args.contact, messages: [{ id: key(report), direction: 'other', text: 'synthetic analysis material', timestamp: 1791676800 }] });
  f.provider.complete = async () => { f.provider.calls.push({ mode: 'analysis' }); return { report }; };
  const result = await f.a.analyze({ contacts: [f.bridge.contacts[0].id], request: 'synthetic report' });
  assert.equal(result.reports[0].status, 'complete');
  return result.reports[0].historyId;
}

test('stored history/detail survive service restart with the provider and chat-data reader unavailable', async t => {
  const f = await assistantFixture(t), id = await savedReport(f, 'immutable offline synthetic report');
  await f.a.close();
  const calls = f.provider.calls.length;
  f.provider.complete = async () => { throw new Error('provider explicitly offline'); };
  f.provider.test = async () => { throw new Error('provider explicitly offline'); };
  f.bridge.readRange = async () => { throw new Error('chat reader explicitly offline'); };
  const reopened = new AIAssistant(f.options); await reopened.init();
  try {
    assert.equal(reopened.analysisHistory().length, 1);
    assert.equal(reopened.analysisReport(id).report, 'immutable offline synthetic report');
    assert.equal(f.provider.calls.length, calls);
    assert.equal(f.bridge.sent.length, 0);
  } finally { await reopened.close(); }
});

test('two independent instances with identical account/contact identities isolate stored reports and model secrets', async t => {
  const one = await assistantFixture(t), two = await assistantFixture(t);
  const [first, second] = await Promise.all([savedReport(one, '合成标题一\n\nprivate synthetic instance one'), savedReport(two, '合成标题二\n\nprivate synthetic instance two')]);
  assert.equal(one.bridge.account, two.bridge.account);
  assert.notEqual(first, second);
  assert.throws(() => one.a.analysisReport(second));
  assert.throws(() => two.a.analysisReport(first));
  assert.equal(one.a.analysisHistory().length, 1);
  assert.equal(two.a.analysisHistory().length, 1);
  const [oneFile, twoFile] = await Promise.all([readFile(one.a.file, 'utf8'), readFile(two.a.file, 'utf8')]);
  assert.equal(oneFile.includes('private synthetic instance two'), false);
  assert.equal(twoFile.includes('private synthetic instance one'), false);
  assert.equal(oneFile.includes(modelConfig.apiKey), false);
  assert.equal(twoFile.includes(modelConfig.apiKey), false);
  assert.equal(one.bridge.sent.length + two.bridge.sent.length, 0);
});

test('a corrupted assistant-state copy fails explicitly, keeps original bytes, and can reopen after restoring its exact backup', async t => {
  const f = await assistantFixture(t), id = await savedReport(f, 'retained synthetic snapshot');
  await f.a.close();
  const backup = await readFile(f.a.file);
  const corrupt = Buffer.from('{"version":1,"profiles":');
  await writeFile(f.a.file, corrupt);
  const broken = new AIAssistant(f.options);
  await assert.rejects(broken.init());
  assert.deepEqual(await readFile(f.a.file), corrupt, 'failed initialization never overwrites a damaged state with defaults');
  await writeFile(f.a.file, backup);
  const restored = new AIAssistant(f.options); await restored.init();
  try { assert.equal(restored.analysisReport(id).report, 'retained synthetic snapshot'); }
  finally { await restored.close(); }
});
