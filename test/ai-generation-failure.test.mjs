import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIAssistant } from '../server/ai-service.mjs';
import { AIModelFixture, ChatFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('a failed reply request is not regenerated until a new incoming message arrives', async t => {
  const root = await temp();
  const bridge = new ChatFixture();
  const provider = new AIModelFixture();
  let now = 1000000;
  const assistant = new AIAssistant({ dataRoot: root, bridge, provider, now: () => now });
  t.after(async () => { await assistant.close(); await cleanup(root); });

  await assistant.init();
  await assistant.configure(modelConfig);
  await assistant.testProvider();
  await assistant.scan();
  await assistant.learn({ contacts: [bridge.contacts[0].id] });
  provider.calls.length = 0;
  const profile = assistant.profiles()[0];
  await assistant.targets([profile.id]);
  await assistant.settings({ reply: true });
  await assistant.settings({ enabled: true });
  await assistant.tick();

  const incoming = bridge.push(profile.contact, 'other', '第一条来信');
  now += 3000;
  provider.next = async () => { throw new Error('model unavailable'); };
  await assistant.tick();
  now += 3000;
  await assistant.tick();
  assert.equal(provider.calls.length, 1);
  assert.equal(assistant.cursors.get(profile.id).pending, false);
  assert.equal(profile.handledIncomingId, incoming.id);

  now += 30000;
  await assistant.tick();
  assert.equal(provider.calls.length, 1, 'the same failed message must not trigger another generation');

  bridge.push(profile.contact, 'other', '第二条来信');
  now += 3000;
  await assistant.tick();
  now += 3000;
  await assistant.tick();
  assert.equal(provider.calls.length, 2, 'a new incoming message must resume normal generation');
  assert.equal(bridge.sent.length, 1);
});
