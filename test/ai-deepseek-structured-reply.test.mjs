import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider, MODEL_RETRY_LIMIT } from '../server/ai-provider.mjs';
import { structuredReplyBody, structuredDeepSeekReply } from '../server/ai-deepseek-reply.mjs';
import { replyFixedRules } from '../server/ai-reply-prompt.mjs';
import { replyRoleAnchor } from '../server/ai-reply-role.mjs';
import { replyPerspective, withSpeaker } from '../server/ai-speakers.mjs';
import { validateReplyResult } from '../server/ai-prompts.mjs';
import { key } from './ai-fixtures.mjs';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

const config = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', protocol: 'openai', timeout: 60, consent: true, apiKey: 'synthetic-only' };
const profile = { account: key('structured-owner'), contact: key('structured-contact'), kind: 'person' };
function input() {
  const message = withSpeaker({ id: key('structured-incoming'), direction: 'other', text: '那几张纸已经摞好了，总算空出桌面。', timestamp: 1793000000, pending: true }, profile);
  return { currentTurnOnly: true, mode: 'reply', kind: 'person', allowSegments: false, multiTurn: false, followUpAllowed: false, followUp: false, updateStyle: false,
    roleAnchor: replyRoleAnchor(profile), replyPerspective: replyPerspective(profile), messages: [message],
    capabilities: { sendMedia: false, sendImages: false, sendAudio: false },
    style: { summary: '保留手动设置，普通分享自然接话。' },
    conversation: { pendingIncomingIds: [message.id], pendingIncomingMessages: [message] } };
}
const visible = result => ({ status: 'completed', output: [{ type: 'reasoning', content: [{ text: 'Never use reasoning as the answer' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ result }) }] }], usage: { input_tokens: 101, output_tokens: 37, input_tokens_details: { cached_tokens: 16 }, output_tokens_details: { reasoning_tokens: 21 } } });
function providerFor(response) {
  const calls = [], p = new AIProvider({ fetcher: async (url, options) => { calls.push({ url, body: JSON.parse(options.body), options }); return response(calls.length, options); } });
  p.backoff = async () => {};
  return { p, calls };
}
for (const result of [{ action: 'send', text: '这下不用在纸堆里找东西了', followUp: false }, { action: 'skip' }, { stop: true }]) {
  test(`official single reply preserves ${result.action || 'stop'} through original validation`, async () => {
    const { p, calls } = providerFor(() => Response.json(visible(result)));
    assert.deepEqual(await p.complete(config, replyFixedRules, input(), undefined, { validate: value => validateReplyResult(value) }), result);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.deepseek.com/responses');
    const b = calls[0].body;
    assert.equal(b.max_output_tokens, 8192); assert.deepEqual(b.reasoning, { effort: 'high' }); assert.equal(b.stream, false); assert.equal(b.store, false);
    assert.equal(b.text.format.type, 'json_schema'); assert.equal(b.text.format.strict, true);
    assert(!Object.hasOwn(b, 'tools')); assert(!Object.hasOwn(b, 'previous_response_id')); assert(!Object.hasOwn(b, 'response_format'));
    assert(b.instructions.includes(replyFixedRules)); assert(JSON.parse(b.input[0].content).conversation);
    assert.equal(calls[0].options.redirect, 'error'); assert(calls[0].options.signal instanceof AbortSignal);
    const variants = b.text.format.schema.properties.result.anyOf;
    assert(variants.some(x => x.properties.stop?.enum[0] === true));
    assert.equal(variants.some(x => x.properties.action?.enum[0] === 'skip'), false, 'mandatory reply does not gain a skip permission');
  });
}

test('body mapping preserves complete system, source text, output ceiling and effort', () => {
  const b = { model: 'deepseek-flash', max_tokens: 8192, reasoning_effort: 'high', messages: [{ role: 'system', content: 'All original policy' }, { role: 'user', content: '{"raw":"原话，我没说他已经收到了"}' }] };
  const mapped = structuredReplyBody(b);
  assert(mapped.instructions.startsWith(b.messages[0].content));
  assert.equal(mapped.input[0].content, b.messages[1].content); assert.equal(mapped.max_output_tokens, b.max_tokens);
  const branches = mapped.text.format.schema.properties.result.anyOf;
  assert(branches.some(x => x.properties.stop?.enum[0] === true));
  assert(branches.some(x => x.properties.action?.enum[0] === 'skip'));
});

test('an unverified request field, role layout or missing cap is rejected before dispatch rather than silently dropped', () => {
  const body = () => ({ model: 'deepseek-flash', max_tokens: 8192, reasoning_effort: 'high', messages: [{ role: 'system', content: 'Policy' }, { role: 'user', content: 'All evidence' }] });
  for (const change of [x => { x.temperature = 0.1; }, x => { x.messages.push({ role: 'assistant', content: 'Additional source must not disappear' }); }, x => { x.max_tokens = 0; }, x => { x.messages[1].content = []; }]) {
    const x = body(); change(x); assert.throws(() => structuredReplyBody(x), e => e.status === 400);
  }
});

for (const [name, change, override = {}] of [
  ['custom gateway', () => {}, { baseUrl: 'https://models.example.test/v1' }],
  ['other model', () => {}, { model: 'deepseek-v4-pro' }],
  ['custom path', () => {}, { baseUrl: 'https://api.deepseek.com/private/v1' }],
  ['automatic learning', x => { x.styleLearningMessageIds = []; }],
  ['style update', x => { x.updateStyle = true; }],
  ['segments', x => { x.allowSegments = true; }],
  ['multi-turn', x => { x.multiTurn = true; }],
  ['continuation', x => { x.followUp = true; }],
  ['followup allowed', x => { x.followUpAllowed = true; }],
  ['media generation', x => { x.capabilities.sendMedia = true; }],
  ['audio generation', x => { x.capabilities.sendAudio = true; }],
  ['image generation', x => { x.capabilities.sendImages = true; }],
  ['images even invalid', x => { x.images = [{ mime: 'image/unknown', data: 'x' }]; }],
  ['non-current-turn caller', x => { delete x.currentTurnOnly; }],
]) test(`${name} keeps its legacy request route`, async () => {
  const x = input(); change(x);
  const { p, calls } = providerFor(() => Response.json({ choices: [{ message: { content: '{"action":"send","text":"原路径"}' }, finish_reason: 'stop' }] }));
  const value = await p.complete({ ...config, ...override }, replyFixedRules, x, undefined, { retry: false });
  assert.equal(value.text, '原路径'); assert(calls[0].url.endsWith('/chat/completions')); assert.equal(calls[0].body.max_tokens, 8192);
});

test('standalone callers do not silently switch protocol', async () => {
  const { p, calls } = providerFor(() => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
  await p.complete(config, 'Connection test', input()); assert(calls[0].url.endsWith('/chat/completions'));
});

test('groups, proactive/trial/report requests and incomplete capability contracts are outside the structured subset', () => {
  const eligible = () => structuredDeepSeekReply(config, input(), { completePolicy: true, format: 'json', imageCount: 0 });
  assert.equal(eligible(), true);
  for (const change of [x => { x.kind = 'group'; }, x => { x.mode = 'proactive'; }, x => { x.mode = 'style-trial'; }, x => { delete x.capabilities; }, x => { delete x.roleAnchor; }, x => { delete x.updateStyle; }]) {
    const x = input(); change(x); assert.equal(!!structuredDeepSeekReply(config, x, { completePolicy: true, format: 'json', imageCount: 0 }), false);
  }
  assert.equal(!!structuredDeepSeekReply(config, input(), { completePolicy: true, format: 'report', imageCount: 0 }), false);
  assert.equal(!!structuredDeepSeekReply(config, input(), { completePolicy: false, format: 'json', imageCount: 0 }), false);
});

test('structured HTTP400 retains the cap and never falls back to another paid route', async () => {
  const { p, calls } = providerFor(() => Response.json({ error: { message: 'Invalid schema' } }, { status: 400 }));
  await assert.rejects(p.complete(config, replyFixedRules, input()));
  assert.equal(calls.length, 1); assert.equal(calls[0].body.max_output_tokens, 8192);
});

for (const status of ['in_progress', 'failed', 'cancelled', 'queued']) test(`HTTP200 ${status} is not accepted or automatically regenerated`, async () => {
  const data = visible({ action: 'send', text: 'must not send', followUp: false }); data.status = status;
  const { p, calls } = providerFor(() => Response.json(data));
  await assert.rejects(p.complete(config, replyFixedRules, input()), e => e.code === 'ai_model_result_unknown'); assert.equal(calls.length, 1);
});

test('transport interruption remains unknown and does not replay', async () => {
  const { p, calls } = providerFor(() => { throw new TypeError('Synthetic connection interruption'); });
  await assert.rejects(p.complete(config, replyFixedRules, input()), e => e.code === 'ai_model_result_unknown'); assert.equal(calls.length, 1);
});

test('only the original retry ceiling applies to invalid structured output; reasoning is never recovered', async () => {
  const { p, calls } = providerFor(() => Response.json({ status: 'completed', output: [{ type: 'reasoning', content: [{ text: '{"result":{"action":"send","text":"wrong channel"}}' }] }] }));
  await assert.rejects(p.complete(config, replyFixedRules, input()), e => e.code === 'ai_model_format');
  assert.equal(calls.length, MODEL_RETRY_LIMIT + 1); assert(calls.every(x => x.url === 'https://api.deepseek.com/responses' && x.body.max_output_tokens === 8192));
});

test('role override inside an envelope is still rejected by the existing local role guard', async () => {
  const { p, calls } = providerFor(() => Response.json(visible({ action: 'send', text: 'fixture', author: 'other' })));
  await assert.rejects(p.complete(config, replyFixedRules, input(), undefined, { retry: false }), e => e.code === 'ai_role_blocked'); assert.equal(calls.length, 1);
});

test('truncated JSON is never accepted as a complete reply', async () => {
  const data = visible({ action: 'send', text: 'partial body', followUp: false }); data.status = 'incomplete'; data.incomplete_details = { reason: 'max_output_tokens' };
  const { p, calls } = providerFor(() => Response.json(data));
  await assert.rejects(p.complete(config, replyFixedRules, input(), undefined, { retry: false }), e => e.code === 'ai_model_incomplete'); assert.equal(calls.length, 1);
});

test('business validation still rejects an empty send and disallowed segments', async () => {
  for (const result of [{ action: 'send', text: ' ' }, { action: 'send', segments: ['fixture'] }]) {
    const { p, calls } = providerFor(() => Response.json(visible(result)));
    await assert.rejects(p.complete(config, replyFixedRules, input(), undefined, { retry: false, validate: x => validateReplyResult(x) }), e => e.code === 'ai_model_schema');
    assert.equal(calls.length, 1);
  }
});

test('cancellation does not accept a completed upstream draft or invoke a fallback route', async () => {
  const c = new AbortController(), { p, calls } = providerFor(() => { c.abort(); throw new DOMException('fixture cancel', 'AbortError'); });
  await assert.rejects(p.complete(config, replyFixedRules, input(), c.signal), e => e.status === 409);
  assert.equal(calls.length, 1);
});

for (const result of [{ action: 'send', text: '总算不用在纸堆里翻东西了', followUp: false }, { action: 'skip' }, { stop: true }, { action: 'send', text: '只发本轮', followUp: true }]) {
  test(`full assistant preserves single-send/stop state for ${JSON.stringify(result)}`, async t => {
    const root = await temp(), bridge = new ChatFixture(); let now = Date.parse('2026-10-27T11:00:00+08:00');
    bridge.stableMessageIds = true;
    const a = new AIAssistant({ dataRoot: root, bridge, provider: new AIModelFixture(), now: () => now, delay: async () => {} });
    t.after(async () => { await a.close(); await cleanup(root); });
    await a.init(); await a.configure(config); await a.scan();
    const contact = bridge.contacts[0].id;
    await a.setReplyOptions({ contact, enabled: true, judgeReply: result.action === 'skip' });
    await a.settings({ enabled: true, autoLearning: false, updateStyle: false, multiTurn: false, segmentReplies: false, followUpEnabled: false }); await a.tick();
    const { p, calls } = providerFor(() => Response.json(visible(result))); a.provider = p;
    Object.assign(bridge.push(contact, 'other', result.stop ? '先不要回复我了' : '纸摞好了，终于空出桌面了。'), { timestamp: Math.floor(now / 1000) });
    await a.tick(); now += 20000; await a.tick();
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.deepseek.com/responses');
    assert.equal(calls[0].body.text.format.schema.properties.result.anyOf.some(x => x.properties.action?.enum[0] === 'skip'), result.action === 'skip');
    assert.deepEqual(bridge.sent.map(x => x.text), result.action === 'send' ? [result.text] : []);
    const profile = a.profiles().find(x => x.contact === contact);
    if (result.stop) assert(profile.stopUntil > now);
    now += 180000; await a.tick();
    assert.equal(calls.length, 1, 'multiTurn=false must not schedule another request even if a nonconforming response asks for followUp');
    assert.equal(Object.hasOwn(profile, 'modelRequestUnknown'), false);
  });
}
