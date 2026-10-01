import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider } from '../server/ai-provider.mjs';
import { withSpeaker, replyPerspective } from '../server/ai-speakers.mjs';
import { modelConfig, key } from './ai-fixtures.mjs';

for (const protocol of ['openai', 'anthropic']) test(`${protocol}: native provider roles bind owner history and incoming messages, with task and images in the final user turn`, async () => {
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
    const content = bodies.length === 1 ? '{"action":"send","text":"收到"}' : '{"consistent":true}';
    return Response.json(protocol === 'anthropic' ? { content: [{ type: 'text', text: content }] } : { choices: [{ message: { content } }] });
  } });
  await provider.complete({ ...modelConfig, protocol }, '只能按已验证归属回复。', input);
  assert.equal(bodies.length, 2);
  const body = bodies[0], turns = protocol === 'anthropic' ? body.messages : body.messages.slice(1);
  assert.equal(turns[0].role, 'user'); assert.equal(turns.at(-1).role, 'user');
  assert.deepEqual(turns.slice(1, -1).map(t => t.role), ['assistant', 'user', 'user', 'user', 'user', 'assistant']);
  assert.deepEqual(turns.slice(1, -1).map(t => JSON.parse(t.content).id), messages.map(m => m.id));
  assert.equal(JSON.parse(turns[1].content).text, '我提议周六。');
  assert.equal(JSON.parse(turns[2].content).text, '我提议改周日。');
  assert.equal(JSON.parse(turns[5].content).speaker.role, 'unknown');
  const last = turns.at(-1).content;
  assert.equal(last[2].type, protocol === 'anthropic' ? 'image' : 'image_url');
  assert.equal(JSON.parse(last[0].text).strategy.purpose, input.strategy.purpose);
  assert.ok(JSON.parse(last[0].text).messages.every(m => !Object.hasOwn(m, 'text')));
  const groups = JSON.parse(last[0].text).replySpeakerHistory;
  assert.equal(groups[0].referenceInReply, '我（当前回信者本人）');
  assert.deepEqual(groups[0].messages.map(m => m.text), ['我提议周六。', '好，周日。']);
  assert.equal(groups[1].messages[0].text, '我提议改周日。');
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

test('a swapped draft is corrected before returning to the sender and cannot change action or follow-up controls', async () => {
  const profile = { account: key('account'), contact: key('contact'), kind: 'person' }, calls = [];
  const input = { mode: 'reply', replyPerspective: replyPerspective(profile), messages: [
    withSpeaker({ id: 'mine', direction: 'self', text: '我提的周六。' }, profile),
    withSpeaker({ id: 'theirs', direction: 'other', text: '我改周日。' }, profile),
  ] };
  const provider = new AIProvider({ fetcher: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    const result = calls.length === 1 ? { action: 'send', text: '你提周六，我改周日。', followUp: false }
      : calls.length === 2 ? { consistent: false, text: '我提周六，你改周日。', action: 'stop', followUp: true } : { consistent: true };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  const result = await provider.complete({ ...modelConfig, protocol: 'openai' }, '回信', input);
  assert.equal(calls.length, 3); assert.deepEqual(result, { action: 'send', text: '我提周六，你改周日。', followUp: false });
  const auditInput = JSON.parse(calls[1].messages.at(-1).content);
  assert.equal(auditInput.mode, 'speaker-audit');
  assert.equal(auditInput.speakerHistory[0].messages[0].text, '我提的周六。');
});

test('an invalid attribution check blocks the draft, and corrected audio must be verified alongside text', async () => {
  const profile = { account: key('account'), contact: key('contact'), kind: 'person' };
  const input = { mode: 'reply', replyPerspective: replyPerspective(profile), messages: [withSpeaker({ id: 'mine', direction: 'self', text: '我住杭州。' }, profile)] };
  for (const audit of [{ text: '缺少核对结论' }, { consistent: false, text: '我住杭州。' }]) {
    let calls = 0;
    const provider = new AIProvider({ fetcher: async () => {
      const value = ++calls === 1 ? { action: 'send', text: '我住苏州。', media: [{ type: 'audio', text: '我住苏州。' }] } : audit;
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
    } });
    await assert.rejects(provider.complete({ ...modelConfig, protocol: 'openai' }, '回信', input, undefined, { retry: false }), /归属核对结果无效/);
    assert.equal(calls, 2);
  }
});

test('a correction that still conflicts is never returned, and a verified audio correction replaces both channels', async () => {
  const profile = { account: key('account'), contact: key('contact'), kind: 'person' };
  const input = { mode: 'reply', replyPerspective: replyPerspective(profile), messages: [withSpeaker({ id: 'mine', direction: 'self', text: '我住杭州。' }, profile)] };
  for (const verified of [false, true]) {
    let calls = 0;
    const provider = new AIProvider({ fetcher: async () => {
      const value = ++calls === 1 ? { action: 'send', text: '我住苏州。', media: [{ type: 'audio', text: '我住苏州。' }] }
        : calls === 2 || !verified ? { consistent: false, text: '我住杭州。', audioText: '我住杭州。' } : { consistent: true };
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
    } });
    const operation = provider.complete({ ...modelConfig, protocol: 'openai' }, '回信', input, undefined, { retry: false });
    if (verified) {
      const result = await operation; assert.equal(result.text, '我住杭州。'); assert.equal(result.media[0].text, '我住杭州。');
    } else await assert.rejects(operation, /归属仍有冲突/);
    assert.equal(calls, 3);
  }
});
