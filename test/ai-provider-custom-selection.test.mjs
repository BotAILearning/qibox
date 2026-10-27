import test from 'node:test';
import assert from 'node:assert/strict';
import { providerPage } from '../web/ai-provider-view.mjs';

const presets = [{ id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai', models: ['fixture-model'] }];
const state = { models: [], assignments: {}, schema: { providerPresets: presets } };
for (const [preset, expected] of [['custom', 'custom'], ['retired-service', 'custom'], ['', 'custom'], ['deepseek', 'deepseek']]) {
  test(`model editor keeps service identity for ${preset || 'missing preset'}`, () => {
    const html = providerPage(state, { models: [], assignments: {}, editing: 'new', form: { preset, baseUrl: 'https://models.example.test/v1', apiKey: 'fixture-key', model: 'fixture-model', protocol: 'openai', consent: false } });
    const select = html.match(/<select id="ai-model-preset">([\s\S]*?)<\/select>/)?.[1];
    assert.ok(select);
    const selected = [...select.matchAll(/<option value="([^"]*)"([^>]*)>/g)].filter(row => /\bselected\b/.test(row[2])).map(row => row[1]);
    assert.deepEqual(selected, [expected], 'Exactly one native option must be selected; otherwise browsers silently choose the first service');
    assert.match(html, /value="https:\/\/models\.example\.test\/v1"/);
    assert.match(html, /data-key-stored="false"/);
  });
}
