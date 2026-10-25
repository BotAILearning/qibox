import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AIAssistant } from '../server/ai-service.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

// Legacy state may contain an explicit object switch without the old target lists.
// Exercise loading that durable state and the real polling/generation/delivery path.
for (const kind of ['person', 'group']) for (const index of ['unavailable', 'empty', 'present']) {
  test(`${kind}: persisted explicit reply on overrides selected fallback with ${index} session index`, async t => {
    const root = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
    bridge.contacts[0].kind = kind; bridge.stableMessageIds = true;
    const contact = bridge.contacts[0].id;
    let now = Date.parse('2026-10-25T18:00:00+08:00');
    let ai = new AIAssistant({ dataRoot: root, bridge, provider });
    const stop = () => { ai.closed = true; clearInterval(ai.timer); clearInterval(ai.warmupTimer); };
    t.after(async () => { stop(); await ai.actions; await ai.writes; await cleanup(root); });
    await ai.init(); clearInterval(ai.timer); clearInterval(ai.warmupTimer); ai.now = () => now; ai.delay = async () => {};
    await ai.configure(modelConfig); await ai.scan();
    await ai.settings({ enabled: true, reply: true, autoLearning: false, replyScope: 'selected', judgeReply: false });
    if (kind === 'person') await ai.setReplyOptions({ contact, enabled: true });
    else await ai.setGroupOptions({ contact, atMe: true });
    ai.data.targets = []; ai.data.replyTargets = []; ai.data.proactiveTargets = [];
    await ai.save(); const file = ai.file; stop(); await ai.writes;
    const durable = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(durable.targets, []); assert.deepEqual(durable.replyTargets, []);
    ai = new AIAssistant({ dataRoot: root, bridge, provider });
    await ai.init(); clearInterval(ai.timer); clearInterval(ai.warmupTimer); ai.now = () => now; ai.delay = async () => {}; await ai.scan();
    const profile = ai.profiles().find(p => p.contact === contact);
    assert.equal(ai.replySelected(profile), true);
    assert.deepEqual(ai.data.targets, []); assert.deepEqual(ai.data.replyTargets, []);
    if (index !== 'unavailable') bridge.sessions = async () => ({ sessions: index === 'empty' ? [] : [{ id: contact, at: now, last: bridge.sequence, unread: 1 }] });
    await ai.tick();
    const incoming = text => Object.assign(bridge.push(contact, 'other', text), {
      timestamp: Math.floor(now / 1000), ...(kind === 'group' ? { sender: 'synthetic-member', mentions: { verified: true, self: true, all: false, others: false } } : {}),
    });
    now += 1000; const first = incoming('First synthetic ordinary comment');
    provider.next = async () => ({ action: 'send', text: 'One synthetic reply', followUp: false });
    await ai.tick(); now += 60000; await ai.tick();
    assert.equal(provider.calls.length, 1, 'An explicit enabled object must reach generation despite missing legacy membership');
    assert.deepEqual(bridge.sent.map(s => s.text), ['One synthetic reply']);
    assert.deepEqual(provider.calls[0].input.conversation.pendingIncomingIds, [first.id]);
    await ai.tick(); now += 60000; await ai.tick();
    assert.equal(provider.calls.length, 1, 'Polling cannot generate twice for the same incoming');
    for (const disabled of ['object', 'reply', 'master']) {
      if (kind === 'person') profile.replyOptions.enabled = disabled !== 'object';
      else profile.groupOptions.atMe = disabled !== 'object';
      if (disabled === 'reply') await ai.settings({ reply: false });
      if (disabled === 'master') { await ai.settings({ reply: true }); await ai.settings({ enabled: false }); }
      now += 1000; incoming(`Synthetic comment while ${disabled} disabled`);
      await ai.tick(); now += 60000; await ai.tick();
      assert.equal(provider.calls.length, 1, `${disabled} off must prevent new model generation`);
      assert.equal(bridge.sent.length, 1, `${disabled} off must prevent delivery`);
    }
    t.diagnostic('Persisted-state/full-pipeline fixture; 0 actual model requests, 0 real WeChat sends');
  });
}
