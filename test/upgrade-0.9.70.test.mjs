import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { Instances } from '../server/instances.mjs';
import { readMemory } from '../server/ai-memory.mjs';
import { personalInformation } from '../server/ai-account-configuration.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from './ai-fixtures.mjs';
import { temp, cleanup, runtimeFactory } from './fixtures.mjs';

// Synthetic data written by the verified stable 0.9.70 FPK's real AI/Vault
// implementation. The key and model credentials belong only to this fixture.
test('0.9.70 saved data upgrades without replacing identity, keys, memory, receipts, settings or files', async t => {
  const f = JSON.parse(await readFile(new URL('./fixtures/upgrade-0.9.70.json', import.meta.url)));
  assert.equal(f.provenance.version, '0.9.70');
  const root = await temp(), user = path.join(root, 'users/development'), data = path.join(user, 'instances', f.id);
  t.after(() => cleanup(root));
  for (const [name, value] of [['users.json', ['development']], ['users/development/instances.json', f.catalog], ['users/development/consent.json', { accepted: true, version: 1 }], [`users/development/instances/${f.id}/schedule.json`, f.schedule], [`users/development/instances/${f.id}/ai-assistant.json`, f.before]]) {
    const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value));
  }
  const key = Buffer.from(f.key, 'base64'); await writeFile(path.join(data, 'ai-secret.key'), key);
  for (const name of f.sentinels) { const file = path.join(data, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '0970_CONTENT_' + name); }
  const bridge = new ChatFixture(), provider = new AIModelFixture();
  const users = new Instances({ appRoot: path.resolve('.'), dataRoot: root, dev: true, host: 'fnos', library: { installed: () => ({ version: '4.1.13.23' }) }, runtimeFactory: (...args) => Object.assign(runtimeFactory(...args), { aiBridge: bridge }), aiProvider: provider });
  try {
    await users.init(); const space = await users.get('development'), item = space.get(f.id), a = item.ai;
    assert.deepEqual(JSON.parse(await readFile(path.join(user, 'instances.json'))), f.catalog);
    assert.equal(space.list().retained[0].id, f.removed);
    assert.deepEqual(item.scheduler.settings, f.schedule);
    assert.deepEqual(await readFile(path.join(data, 'ai-secret.key')), key);
    assert.equal(a.providerConfig('chat').apiKey, modelConfig.apiKey);
    assert.equal(a.data.account, f.before.account);
    assert.equal(a.data.settings.takeover.minutes, 7);
    const p = a.profiles()[0]; assert.equal(p.takeover.minutes, 9);
    assert.equal(p.style.language, '0970 中文🙂手动风格');
    assert.deepEqual(readMemory(a.vault, p), f.memoryBefore);
    assert.equal(p.delivery.operationId, 'completed-0970'); assert.equal(p.delivery.status, 'sent');
    assert.deepEqual(personalInformation(a).entries.map(({ id, field, text, allowGroup, updatedAt }) => ({ id, field, text, allowGroup, updatedAt })), f.info.entries);
    for (const name of f.sentinels) assert.equal(await readFile(path.join(data, name), 'utf8'), '0970_CONTENT_' + name);
    assert.equal(provider.calls.length, 0); assert.equal(bridge.sent.length, 0);
  } finally { await users.close(); }
});
