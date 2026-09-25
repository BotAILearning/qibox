import test from 'node:test';
import assert from 'node:assert/strict';
import { providerPage } from '../web/ai-provider-view.mjs';

const presets = [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] }, { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic', models: ['claude-3-5-sonnet'] }];

test('provider page renders the legacy model name with both feature groups assigned', () => {
  const state = { provider: { baseUrl: 'https://x.test/v1', model: 'm1', protocol: 'openai', timeout: 30, consent: true, hasKey: true, tested: true }, models: [], assignments: { chat: 'legacy', learningAnalysis: 'legacy' }, schema: { providerPresets: presets } };
  const html = providerPage(state, null);
  assert.match(html, /m1/);
  assert.match(html, /聊天类/); assert.match(html, /主动聊天/); assert.match(html, /学习风格和记忆/); assert.match(html, /分析报告/);
  assert.match(html, /data-ai-model-edit="legacy"/); assert.match(html, /data-ai-model-test="legacy"/); assert.match(html, /data-ai-model-apply="legacy"/); assert.match(html, /data-ai-model-delete="legacy"/);
  assert.match(html, /添加模型/); assert.match(html, /models-save/); assert.match(html, /data-ai-assignment="chat"/);
  assert.match(html, /selected/); // legacy selected in all dropdowns
  assert.equal((html.match(/value="legacy"/g) || []).length, 2);
});

test('provider page renders multi-model list and editor', () => {
  const state = { provider: null, models: [{ id: 'm1', label: '模型A', baseUrl: 'https://a.test/v1', model: 'm-a', protocol: 'openai', timeout: 30, consent: true, hasKey: true, tested: true, usedBy: ['chat'] }, { id: 'm2', label: '模型B', baseUrl: 'https://b.test/v1', model: 'm-b', protocol: 'openai', timeout: 30, consent: true, hasKey: true, tested: false, usedBy: [] }], assignments: { chat: 'm1', proactive: 'm1', learning: 'm1', analysis: 'm1' }, schema: { providerPresets: presets } };
  const html = providerPage(state, null);
  assert.match(html, /m-a/); assert.match(html, /m-b/);
  assert.match(html, /用于：聊天类/); assert.match(html, /未分配功能/);
  const edit = providerPage(state, { models: state.models, assignments: state.assignments, editing: 'new', form: { label: '', preset: 'openai', protocol: 'openai', baseUrl: '', apiKey: '', keyStored: false, model: '', timeout: 60, consent: false }, status: '' });
  assert.match(edit, /id="ai-model-form"/); assert.match(edit, /name="model"/); assert.match(edit, /id="ai-model-preset"/); assert.match(edit, /data-ai-action="test"/); assert.match(edit, /保存模型/);
});

test('left model usage stays committed while right side shows pending assignment changes', () => {
  const state = { provider: null, models: [{ id: 'm1', label: '模型A', baseUrl: 'https://a.test/v1', model: 'm-a', protocol: 'openai', tested: true }, { id: 'm2', label: '模型B', baseUrl: 'https://b.test/v1', model: 'm-b', protocol: 'openai', tested: true }], assignments: { chat: 'm1', learningAnalysis: 'm1' }, schema: { providerPresets: presets } };
  const draft = { models: state.models, assignments: { chat: 'm2', learningAnalysis: 'm1' }, editing: null, status: '' };
  const html = providerPage(state, draft);
  const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  assert.match(sidebar, /m-a[\s\S]*用于：聊天类、学习分析类/);
  assert.match(html.slice(html.indexOf('<section class="ai-card ai-assignment-card"')), /data-ai-assignment="chat"[\s\S]*<option value="m2"[^>]*selected/);
});

test('provider page escapes labels and model names', () => {
  const state = { provider: null, models: [{ id: 'm1', label: '<img src=x onerror=alert(1)>', baseUrl: 'https://a.test/v1', model: 'm-a"onclick="x', protocol: 'openai', timeout: 30, consent: true, hasKey: true, tested: false, usedBy: [] }], assignments: { chat: 'm1', proactive: 'm1', learning: 'm1', analysis: 'm1' }, schema: { providerPresets: presets } };
  const html = providerPage(state, null);
  assert.ok(!html.includes('<img src=x onerror')); assert.ok(!html.includes('onclick="x'));
});
