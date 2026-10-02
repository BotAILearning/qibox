import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsPage } from '../web/ai-settings-view.mjs';
import { activityPage } from '../web/ai-activity-view.mjs';
import { analysisPage } from '../web/ai-analysis-view.mjs';
import { providerPage } from '../web/ai-provider-view.mjs';
import { personalInformationPage, globalReplyStrategyPage } from '../web/ai-account-settings.mjs';
import { personalFieldDefinitions } from '../server/ai-personal-fields.mjs';
import { personMemoryTypes, groupMemoryTypes, memoryCategoryForField } from '../web/ai-memory-view.mjs';

function before(html, first, second) {
  const a = html.indexOf(first), b = html.indexOf(second);
  assert.ok(a >= 0 && b > a, `${first} must precede ${second}`);
}

test('frequent switches precede configuration while saved off states and waiting values survive', () => {
  const html = settingsPage({ settings: { enabled: false, acknowledgeAI: true, takeover: { enabled: false, minutes: 17 } } });
  before(html, 'id="ai-takeover-form"', 'data-ai-nav="global-reply"');
  before(html, 'name="master"', 'name="enabled"');
  before(html, 'name="minutes"', 'name="acknowledgeAI"');
  before(html, 'data-ai-nav="global-reply"', 'data-ai-nav="personal-info"');
  before(html, 'data-ai-nav="default-style"', 'data-ai-nav="provider"');
  assert.match(html, /name="master"[^>]*>/);
  assert.doesNotMatch(html, /name="master"[^>]*checked/);
  assert.doesNotMatch(html, /name="enabled"[^>]*checked/);
  assert.match(html, /name="minutes"[^>]*value="17"[^>]*disabled/);
  assert.match(html, /name="acknowledgeAI"[^>]*checked/);
});

test('execution records show reply, unanswered and exceptions in that order', () => {
  const state = { contacts: [], profiles: [], activity: [], events: [], live: [], tasks: [] };
  const html = activityPage(state, { source: 'reply' });
  before(html, 'data-ai-optional="activity-reply"', 'data-ai-optional="activity-skip"');
  before(html, 'data-ai-optional="activity-skip"', 'id="ai-recent-errors"');
  assert.equal((html.match(/id="ai-recent-errors"/g) || []).length, 1);
  const proactive = activityPage(state, { source: 'proactive' });
  before(proactive, 'data-ai-optional="activity-proactive"', 'id="ai-recent-errors"');
  assert.doesNotMatch(proactive, /data-ai-optional="activity-(skip|reply)"/);
});

test('analysis chooses contacts and dates before optional fields without dropping selected media or custom dates', () => {
  const state = { contacts: [{ id: 'c', kind: 'person', label: '示例' }], analysis: { history: [] } };
  const draft = { contacts: ['c'], from: '2026-09-01', to: '2026-09-17', request: '<自定义问题>', includeVoice: true, includeVisual: true };
  const html = analysisPage(state, draft, null, '', null, 'custom');
  before(html, 'ai-analysis-contact-entry', 'ai-analysis-time-entry');
  before(html, 'ai-analysis-time-entry', 'data-ai-optional="analysis"');
  before(html, 'data-ai-optional="analysis-media"', 'ai-analysis-submit-row');
  assert.match(html, /name="from" value="2026-09-01"/);
  assert.match(html, /name="to" value="2026-09-17"/);
  assert.match(html, /&lt;自定义问题&gt;/);
  assert.match(html, /name="includeVoice" checked/);
  assert.match(html, /name="includeVisual" checked/);
  assert.match(html, /data-ai-optional="analysis-media" open/);
  const defaults = analysisPage(state, { contacts: [] }, null);
  assert.doesNotMatch(defaults, /data-ai-optional="analysis-media" open/);
  assert.match(defaults, /aria-label="开始分析" disabled/);
});

function analysisOptionalSection(html, key) {
  const match = html.match(new RegExp(`<details\\b([^>]*data-ai-optional="${key}"[^>]*)>([\\s\\S]*?)<\\/details>`));
  assert.ok(match, `the ${key} optional section remains available`);
  const status = match[2].match(/<summary>[\s\S]*?class="ai-optional-status">([^<]*)<\/span>[\s\S]*?<\/summary>/)?.[1];
  assert.ok(status, `the ${key} section exposes its current status`);
  return { attributes: match[1], body: match[2], status };
}

test('analysis instructions treat whitespace as unfilled while preserving the actual input for editing', () => {
  const state = { contacts: [], analysis: { history: [] } };
  for (const [request, expected] of [
    ['', '点击展开'],
    ['   ', '点击展开'],
    ['\t\r\n\u3000 ', '点击展开'],
    [' \n  请梳理尚未完成的约定。\t ', '已填写'],
  ]) {
    const html = analysisPage(state, { contacts: [], request }, null);
    const section = analysisOptionalSection(html, 'analysis');
    assert.equal(section.status, expected, `request ${JSON.stringify(request)} has the right saved-state label`);
    assert.equal(section.body.match(/<textarea\b[^>]*name="request"[^>]*>([\s\S]*?)<\/textarea>/)?.[1], request, 'the status calculation does not rewrite the user input');
    assert.doesNotMatch(section.body.match(/<textarea\b[^>]*name="request"[^>]*>/)?.[0] || '', /\brequired\b/, 'instructions remain optional');
  }
});

test('analysis media summary reflects each explicit opt-in without silently selecting another type', () => {
  const state = { contacts: [], analysis: { history: [] } };
  for (const [includeVoice, includeVisual, expected] of [
    [false, false, '文字聊天'],
    [true, false, '已启用 1 项'],
    [false, true, '已启用 1 项'],
    [true, true, '已启用 2 项'],
  ]) {
    const section = analysisOptionalSection(analysisPage(state, { contacts: [], request: '', includeVoice, includeVisual }, null), 'analysis-media');
    assert.equal(section.status, expected);
    assert.equal(/\bopen\b/.test(section.attributes), includeVoice || includeVisual, 'saved media choices stay visible for review');
    for (const [name, selected] of [['includeVoice', includeVoice], ['includeVisual', includeVisual]]) {
      const input = section.body.match(new RegExp(`<input\\b[^>]*name="${name}"[^>]*>`))?.[0];
      assert.ok(input, `${name} remains independently editable`);
      assert.equal(/\bchecked\b/.test(input), selected, `${name} is checked only when explicitly selected`);
    }
  }
});

test('configured models prioritize assignments, but creating and editing models prioritize setup', () => {
  const state = { models: [{ id: 'one', model: '示例模型', baseUrl: 'https://model.test', tested: true }], assignments: { chat: 'one', learningAnalysis: 'one' }, schema: { providerPresets: [] } };
  before(providerPage(state, null), 'class="ai-card ai-assignment-card"', '<aside');
  const editing = providerPage(state, { models: state.models, assignments: state.assignments, editing: 'one', form: { keyStored: true, model: '待保存模型', baseUrl: 'https://draft.test', consent: true } });
  before(editing, 'id="ai-model-form"', 'class="ai-card ai-assignment-card"');
  assert.match(editing, /value="待保存模型"/);
  assert.match(editing, /value="https:\/\/draft.test"/);
  assert.match(editing, /value="\*{8}" data-key-stored="true"/);
  before(providerPage({ models: [], schema: {} }, null), '<aside', 'class="ai-card ai-assignment-card"');
});

test('personal priorities preserve draft content, group permission and the shared field schema', () => {
  const order = personalFieldDefinitions.map(field => field.key);
  const html = personalInformationPage({ account: 'test', personalInformation: { entries: [] } }, { status: { text: '本周休假', allowGroup: true, open: true }, city: { text: '深圳\n广州', allowGroup: false } });
  before(html, 'data-personal-field="status"', 'data-personal-field="city"');
  before(html, 'data-personal-field="boundaries"', 'data-personal-field="interests"');
  assert.match(html, /本周休假/);
  const statusCard = html.slice(html.indexOf('data-personal-field="status"'), html.indexOf('data-personal-field="plans"'));
  assert.match(statusCard, /data-personal-share checked/);
  assert.match(html, /深圳\n广州/);
  assert.deepEqual(personalFieldDefinitions.map(field => field.key), order);
});

test('global reply requirements and boundaries precede optional facts while all three fields remain editable', () => {
  const html = globalReplyStrategyPage({ replyStrategy: { replyGoal: '简短回复', boundaries: '费用需本人确认', facts: '<已确认事实>' } });
  before(html, 'name="replyGoal"', 'name="boundaries"');
  before(html, 'name="boundaries"', 'name="facts"');
  assert.match(html, /data-ai-optional="global-facts"><summary/);
  assert.match(html, /name="facts" maxlength="4000"/);
  assert.match(html, /&lt;已确认事实&gt;/);
});

test('daily memories and group agreements precede infrequent categories without changing field identities', () => {
  const person = personMemoryTypes.map(([key]) => key), group = groupMemoryTypes.map(([key]) => key);
  assert.ok(person.indexOf('other') < person.indexOf('phone'));
  assert.ok(person.indexOf('work') < person.indexOf('school'));
  assert.ok(group.indexOf('group_rule') < group.indexOf('group_member'));
  assert.ok(group.indexOf('group_plan') < group.indexOf('group_topic'));
  for (const field of ['name','addressing','phone','birthday','date','school','household','residence','workplace','employer','shipping','other']) assert.ok(person.includes(memoryCategoryForField(field)));
  for (const key of ['group_info','group_member','group_rule','group_topic','group_plan','group_event','other']) assert.ok(group.includes(key));
});
