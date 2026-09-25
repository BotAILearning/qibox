import test from 'node:test';
import assert from 'node:assert/strict';
import { aiAssistant } from '../web/ai-assistant.mjs';
import { categories, styleOptions, avoidOptions, defaultStyle } from '../server/ai-schema.mjs';
import { replyPresets } from '../server/ai-presets.mjs';

let originalWindow;
test.beforeEach(() => {
  originalWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
});
test.afterEach(() => { globalThis.window = originalWindow; });

// Exercise the real controller's async click handler at its API boundary. The
// minimal DOM surface only supplies elements used by attach/render; no browser,
// model service or native desktop is involved in these context-switch tests.
function surface() {
  const nodes = new Map(), handlers = new Map(), forms = new Map();
  const attribute = key => 'data-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
  const buttonNode = dataset => ({ dataset, attributes: Object.keys(dataset).map(key => ({ name: attribute(key) })),
    closest: selector => selector === '[data-proactive-root]' && Object.keys(dataset).some(key => key.startsWith('proactive')) ? {} : null,
    hasAttribute: name => Object.keys(dataset).some(key => attribute(key) === name) });
  const node = selector => {
    if (selector === '#ai-queue-live') return null;
    if (['#ai-proactive-form', '#ai-reply-form', '#ai-provider-form', '#ai-model-form', '#ai-profile-form', '#ai-paste-form', '#ai-manual-reply-form', '#ai-object-form', '#ai-analysis-form'].includes(selector)) return forms.get(selector) || null;
    if (!nodes.has(selector)) {
      let html = '';
      nodes.set(selector, {
      hidden: false, dataset: {}, options: [], classList: { toggle() {} },
      writes: 0, get innerHTML() { return html; }, set innerHTML(value) { html = value; this.writes++; },
      setAttribute() {}, focus() {}, replaceChildren() {}, append() {}, remove() {},
      close() { handlers.get(`${selector}:close`)?.(); }, showModal() {},
      querySelector: node, querySelectorAll: () => [],
      addEventListener(type, handler) { handlers.set(`${selector}:${type}`, handler); },
      });
    }
    return nodes.get(selector);
  };
  return { document: { body: { append() {} }, querySelector: node, querySelectorAll: () => [], createElement: tag => node(`created-${tag}`) },
    node,
    applyDialog: () => handlers.get('created-dialog:click')({ target: { closest: () => ({ hasAttribute: name => name === 'data-apply' }) } }),
    form: (selector, entries) => { const form = { id: selector.slice(1), entries, querySelector: () => null }; forms.set(selector, form); return form; },
    unmount: selector => forms.delete(selector),
    navigate: aiNav => handlers.get('#ai-panel:click')({ target: { closest: () => buttonNode({ aiNav }) } }),
    change: target => { target.closest ||= () => null; return handlers.get('#ai-panel:change')({ target }); },
    input: target => handlers.get('#ai-panel:input')({ target: { closest: () => null, ...target } }),
    submit: form => handlers.get('#ai-panel:submit')({ preventDefault() {}, target: form }),
    click: action => handlers.get('#ai-panel:click')({ target: { closest: () => buttonNode(action === 'new-proactive' ? { proactiveNew: '' } : { aiAction: action }) } }),
    button: dataset => handlers.get('#ai-panel:click')({ preventDefault() {}, target: { closest: () => buttonNode(dataset) } }) };
}

const availableState = () => ({ settings: { enabled: false, replyDelay: 8 },
  requirements: { proactive: '', reply: '' }, contacts: [{ id: 'contact', label: 'Fixture', kind: 'person' }],
  profiles: [], targets: [], strategy: {}, events: [], queue: { status: 'idle', items: [] }, available: true,
});

test('reply contact search filters by name without requests and survives editing and refresh', async t => {
  const originalDocument = globalThis.document, dom = surface(), calls = [];
  globalThis.document = dom.document;
  const snapshot = { ...availableState(), settings: { enabled: true, reply: true }, contacts: [
    { id: 'target', label: '林宝平_Bot', kind: 'person' }, { id: 'other', label: '其他联系人', kind: 'person' },
  ] };
  const controller = aiAssistant({ api: async (_url, payload) => { if (payload) calls.push(payload); return snapshot; } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a');
  assert.match(dom.node('#ai-content').innerHTML, /aria-label="AI 页面"/);
  dom.input({ id: 'ai-object-search', value: 'ＢＯＴ' });
  assert.match(dom.node('#ai-object-list').innerHTML, /林宝平_Bot/);
  assert.doesNotMatch(dom.node('#ai-object-list').innerHTML, /其他联系人/);
  assert.deepEqual(calls, []);
  await dom.click('scan');
  assert.match(dom.node('#ai-content').innerHTML, /value="ＢＯＴ"/);
  assert.doesNotMatch(dom.node('#ai-content').innerHTML, /其他联系人/);
  assert.equal(dom.node('[data-ai-panel-master]').checked, true);
  dom.input({ id: 'ai-object-search', value: '不存在' });
  assert.match(dom.node('#ai-object-list').innerHTML, /暂无匹配/);
  await controller.attach('instance-b');
  assert.match(dom.node('#ai-content').innerHTML, /其他联系人/);
});

for (const action of ['scan', 'learn-selected']) for (const destination of ['instance-b', 'instance-a']) {
  test(`pending ${action} cannot redraw or continue after leaving and opening ${destination}`, { timeout: 2000 }, async t => {
    const originalDocument = globalThis.document, dom = surface();
    globalThis.document = dom.document;
    const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
    const controller = aiAssistant({ api: async (url, payload) => {
      calls.push({ url, action: payload?.action });
      if (payload?.action === (action === 'scan' ? 'scan' : 'learn')) { entered.resolve(); await released.promise; }
      return availableState();
    } });
    t.after(() => { released.resolve(); controller.detach(); globalThis.document = originalDocument; });
    await controller.attach('instance-a');
    if (action === 'learn-selected') await dom.click('select-contacts');
    const detecting = dom.click(action);
    await entered.promise;
    controller.detach();
    await controller.attach(destination);
    const renderCount = dom.node('#ai-content').writes;
    released.resolve();
    await detecting;
    assert.deepEqual(calls.filter(call => call.action), [{ url: '/instances/instance-a/ai', action: action === 'scan' ? 'scan' : 'learn' }]);
    assert.equal(dom.node('#ai-content').writes, renderCount);
  });
}

test('pulling the chat list waits for explicit selection and never starts learning automatically', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), calls = [];
  globalThis.document = dom.document;
  const controller = aiAssistant({ api: async (url, payload) => { calls.push({ url, ...payload }); return availableState(); } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a');
  await dom.click('scan');
  assert.deepEqual(calls.filter(call => call.action), [
    { url: '/instances/instance-a/ai', action: 'scan' },
  ]);
});

test('opening reply configuration loads missing contacts without starting learning', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), calls = [];
  globalThis.document = dom.document;
  let snapshot = { ...availableState(), available: false, contacts: [] };
  const controller = aiAssistant({ api: async (_url, payload, timeout) => {
    if (payload) calls.push({ ...payload, timeout });
    if (payload?.action === 'settings') snapshot = { ...snapshot, settings: { ...snapshot.settings, ...payload.value } };
    if (payload?.action === 'scan') snapshot = { ...snapshot, available: true, contacts: availableState().contacts, operation: { phase: 'contacts', completed: 1, total: 1 } };
    return snapshot;
  } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a');
  await dom.change({ dataset: { aiSetting: 'reply' }, checked: true });
  assert.deepEqual(calls.map(x => x.action), ['settings', 'scan']);
  assert.equal(calls[1].timeout, 30 * 60 * 1000);
  assert.match(dom.node('#ai-content').innerHTML, /data-ai-object="contact"/);
  assert.match(dom.node('#ai-content').innerHTML, /选择联系人或群聊/);
  assert.equal(dom.node('#ai-operation').hidden, true);
});

test('cached contacts remain available across learning and proactive navigation without pausing active tasks', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), calls = [];
  globalThis.document = dom.document;
  const snapshot = { ...availableState(), settings: { enabled: true, reply: true }, schema: { categories } };
  const controller = aiAssistant({ api: async (_url, payload) => { if (payload) calls.push(payload); return snapshot; } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a'); dom.node('#ai-open').onclick();
  await dom.navigate('learning'); await dom.navigate('proactive'); await dom.click('new-proactive');
  assert.match(dom.node('#ai-content').innerHTML, /data-proactive-pick/);
  assert.deepEqual(calls, []);
  assert.equal(dom.node('[data-ai-panel-master]').checked, true);
});

test('a later invalidation of a previously loaded contact list triggers recovery on proactive selection', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), calls = [];
  globalThis.document = dom.document;
  let snapshot = { ...availableState(), contacts: [], available: false };
  const controller = aiAssistant({ api: async (_url, payload) => {
    if (payload) calls.push(payload.action);
    if (payload?.action === 'scan') snapshot = availableState();
    if (payload?.action === 'settings') snapshot = { ...availableState(), contacts: [], available: false };
    return snapshot;
  } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a'); await dom.navigate('learning');
  await dom.change({ dataset: { aiSetting: 'proactive' }, checked: true });
  await dom.navigate('proactive'); await dom.click('new-proactive');
  assert.deepEqual(calls, ['scan', 'settings', 'scan']);
  assert.match(dom.node('#ai-content').innerHTML, /data-proactive-pick/);
});

test('bulk learning keeps selections beyond the former ten-contact cap', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), calls = [];
  globalThis.document = dom.document;
  const snapshot = { ...availableState(), contacts: Array.from({ length: 12 }, (_, index) => ({ id: `person-${index + 1}`, label: `Person ${index + 1}`, kind: 'person' })) };
  const controller = aiAssistant({ api: async (_url, payload) => { if (payload) calls.push(payload); return snapshot; } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a'); await dom.navigate('learning');
  await dom.click('select-contacts');
  const eleventh = { dataset: { aiContact: 'person-11' }, checked: true };
  await dom.change(eleventh);
  assert.equal(eleventh.checked, true);
  assert.doesNotMatch(dom.node('#ai-feedback').textContent, /最多学习/);
  assert.doesNotMatch(dom.node('#ai-content').innerHTML, /标签分组|按风格|data-ai-source/);
  await dom.click('learn-selected');
  assert.deepEqual(calls, [{ action: 'learn', value: { contacts: snapshot.contacts.map(c => c.id), target:'both',previewOnly:true,scope:'range',from:'',to:'' } }]);
});

test('learning and applying one contact preserves other contacts reply strategies and targets', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData, dom = surface(), calls = [];
  globalThis.document = dom.document;
  globalThis.FormData = class extends OriginalFormData { constructor(form) { super(); for (const [key, value] of form?.entries || []) this.append(key, value); } };
  const snapshot = { ...availableState(), schema: { categories, styleOptions, avoidOptions },
    contacts: [{ id: 'existing', label: 'Existing friend', kind: 'person' }, { id: 'new', label: 'New friend', kind: 'person' }],
    profiles: [{ id: 'existing-profile', contact: 'existing', label: 'Existing friend', learnedAt: 1, style: defaultStyle, learnedStyle: defaultStyle, replyStrategy: { replyGoal: 'Keep original goal', boundaries: 'Keep original boundary', maxRounds: 4 } },
      { id: 'new-profile', contact: 'new', label: 'New friend', learnedAt: 1, style: defaultStyle, learnedStyle: defaultStyle }],
    replyTargets: ['existing-profile'],
  };
  const controller = aiAssistant({ api: async (_url, payload) => { if (payload) calls.push(payload); return snapshot; } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; });
  await controller.attach('instance-a');
  const learning = dom.button({ aiLearnContact: 'new' });
  await new Promise(resolve => setImmediate(resolve)); dom.applyDialog(); await learning;
  assert.match(dom.node('#ai-content').innerHTML, /New friend/);
  assert.doesNotMatch(dom.node('#ai-content').innerHTML, /Existing friend/);
  await dom.button({aiApplyResult:'new-profile'});
  const applied=calls.filter(x=>x.action==='reply-profile');assert.equal(applied.length,1);
  assert.equal(applied[0].value.contact,'new');assert.equal(applied[0].value.preserveSwitches,true);
  assert.equal(calls.some(x=>x.action==='targets'),false);
  assert.equal(snapshot.profiles[0].replyStrategy.replyGoal, 'Keep original goal');
});

const manualState = () => ({ ...availableState(), schema: { categories, styleOptions, avoidOptions, defaultStyle, replyPresets }, settings: { enabled: false, reply: true } });
const manualEntries = () => Object.entries({ replyPreset: 'custom', summary: '自然简短', ...defaultStyle, replyGoal: 'Only discuss the planned event', facts: 'Saturday afternoon', boundaries: 'Confirm timing with me', maxRounds: '3' }).flatMap(([key, value]) => Array.isArray(value) ? value.map(item => [key, item]) : [[key, String(value)]]);

test('a manual reply strategy applies an unlearned contact without invoking learning or enabling AI', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData, dom = surface(), calls = [];
  globalThis.document = dom.document;
  globalThis.FormData = class extends OriginalFormData { constructor(form) { super(); for (const [key, value] of form?.entries || []) this.append(key, value); } };
  let snapshot = manualState();
  const controller = aiAssistant({ api: async (_url, payload) => {
    if (payload) calls.push(payload);
    if (payload?.action === 'reply-profile') snapshot = { ...snapshot, profiles: [{ id: 'manual-profile', contact: 'contact', label: 'Fixture', source: 'manual', learnedAt: null, replyConfiguredAt: 1, style: payload.value.style, replyStrategy: payload.value.strategy }], replyTargets: ['manual-profile'] };
    return snapshot;
  } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; });
  await controller.attach('instance-a'); await dom.button({ aiManualContact: 'contact' });
  assert.match(dom.node('#ai-content').innerHTML, /自然交流/);
  assert.match(dom.node('#ai-content').innerHTML, /简短直接/);
  assert.deepEqual(calls, []);
  const form = dom.form('#ai-manual-reply-form', manualEntries()); form.dataset = { contact: 'contact' };
  await dom.submit(form);
  assert.deepEqual(calls.map(x => x.action), ['reply-profile']);
  assert.equal(calls[0].value.contact, 'contact');
  assert.equal(calls[0].value.style.summary, '自然简短');
  assert.equal(calls[0].value.strategy.maxRounds, 3);
  await dom.button({ aiObject: 'contact' });
  assert.match(dom.node('#ai-content').innerHTML, /Only discuss the planned event/);
  assert.equal(dom.node('[data-ai-panel-master]').checked, false);
});

test('choosing another contacts learned style never copies their facts, boundaries or reply goal', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData, dom = surface(), calls = [];
  globalThis.document = dom.document;
  globalThis.FormData = class extends OriginalFormData { constructor(form) { super(); for (const [key, value] of form?.entries || []) this.append(key, value); } };
  const snapshot = { ...manualState(), profiles: [{ id: 'other-profile', contact: 'other-contact', label: 'Other contact', learnedAt: 1,
    style: { ...defaultStyle, formality: '正式' }, learnedStyle: { ...defaultStyle, formality: '正式' }, replyStrategy: { replyGoal: 'Other private goal', facts: 'Other private appointment', boundaries: 'Other private agreement', maxRounds: 75 } }] };
  const controller = aiAssistant({ api: async (_url, payload) => { if (payload) calls.push(payload); return snapshot; } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; });
  await controller.attach('instance-a'); await dom.button({ aiManualContact: 'contact' });
  const form = dom.form('#ai-manual-reply-form', manualEntries()); form.dataset = { contact: 'contact' };
  await dom.change({ id: 'ai-reply-preset', value: 'learned:other-profile', dataset: {} });
  const html = dom.node('#ai-content').innerHTML;
  assert.match(html, /正式，适度/);
  assert.match(html, /Only discuss the planned event/);
  assert.match(html, /Saturday afternoon/);
  assert.match(html, /Confirm timing with me/);
  assert.doesNotMatch(html, /Other private goal|Other private appointment|Other private agreement/);
  assert.deepEqual(calls, []);
});

test('cancelling manual setup keeps only a local draft and reopening the instance clears it', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData, dom = surface(), calls = [];
  globalThis.document = dom.document;
  globalThis.FormData = class extends OriginalFormData { constructor(form) { super(); for (const [key, value] of form?.entries || []) this.append(key, value); } };
  const controller = aiAssistant({ api: async (_url, payload) => { if (payload) calls.push(payload); return manualState(); } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; });
  await controller.attach('instance-a'); await dom.button({ aiManualContact: 'contact' });
  const form = dom.form('#ai-manual-reply-form', manualEntries()); form.dataset = { contact: 'contact' };
  await dom.click('back-reply-contacts'); dom.unmount('#ai-manual-reply-form');
  assert.match(dom.node('#ai-content').innerHTML, /选择联系人或群聊/);
  await dom.button({ aiManualContact: 'contact' });
  assert.match(dom.node('#ai-content').innerHTML, /Only discuss the planned event/);
  controller.detach(); await controller.attach('instance-a'); await dom.button({ aiManualContact: 'contact' });
  assert.doesNotMatch(dom.node('#ai-content').innerHTML, /Only discuss the planned event/);
  assert.deepEqual(calls, []);
});

test('a pending manual strategy save cannot paint an old contact after an instance switch', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData, dom = surface();
  globalThis.document = dom.document;
  globalThis.FormData = class extends OriginalFormData { constructor(form) { super(); for (const [key, value] of form?.entries || []) this.append(key, value); } };
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
  const controller = aiAssistant({ api: async (url, payload) => {
    if (payload) calls.push({ url, action: payload.action });
    if (payload?.action === 'reply-profile') { entered.resolve(); await released.promise; }
    return manualState();
  } });
  t.after(() => { released.resolve(); controller.detach(); globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; });
  await controller.attach('instance-a'); await dom.button({ aiManualContact: 'contact' });
  const form = dom.form('#ai-manual-reply-form', manualEntries()); form.dataset = { contact: 'contact' };
  const pending = dom.submit(form); await entered.promise;
  controller.detach(); dom.unmount('#ai-manual-reply-form'); await controller.attach('instance-b');
  const renders = dom.node('#ai-content').writes;
  released.resolve(); await pending;
  assert.equal(dom.node('#ai-content').writes, renders);
  assert.deepEqual(calls, [{ url: '/instances/instance-a/ai', action: 'reply-profile' }]);
});

test('an unlearned paused contact exposes no verification hyperlink and preserves unsaved strategy drafts', async t => {
  const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData, dom = surface(), calls = [];
  globalThis.document = dom.document;
  globalThis.FormData = class extends OriginalFormData { constructor(form) { super(); for (const [key, value] of form?.entries || []) this.append(key, value); } };
  const profile = { id: 'manual-profile', contact: 'contact', label: 'Fixture', style: defaultStyle, paused: true, delivery: { status: 'unknown' } };
  const controller = aiAssistant({ api: async (_url, payload) => { if (payload) calls.push(payload); return { ...manualState(), profiles: [profile], replyTargets: [profile.id] }; } });
  t.after(() => { controller.detach(); globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; });
  await controller.attach('instance-a'); await dom.button({ aiManualContact: 'contact' });
  assert.doesNotMatch(dom.node('#ai-content').innerHTML, /data-ai-review|核验发送结果|待核对/);
  const form = dom.form('#ai-manual-reply-form', manualEntries()); form.dataset = { contact: 'contact' };
  await dom.click('back-reply-contacts'); dom.unmount('#ai-manual-reply-form'); await dom.button({ aiManualContact: 'contact' });
  assert.match(dom.node('#ai-content').innerHTML, /Only discuss the planned event/); assert.deepEqual(calls, []);
});

for (const destination of ['learning', 'proactive']) {
  test(`entering ${destination} retrieves an unavailable contact list before selection`, { timeout: 2000 }, async t => {
    const originalDocument = globalThis.document, dom = surface(), calls = [];
    globalThis.document = dom.document;
    const controller = aiAssistant({ api: async (_url, payload) => {
      if (payload) { calls.push(payload); return availableState(); }
      return { ...availableState(), available: false, contacts: [] };
    } });
    t.after(() => { controller.detach(); globalThis.document = originalDocument; });
    await controller.attach('instance-a'); await dom.navigate(destination); if (destination === 'proactive') await dom.click('new-proactive');
    assert.deepEqual(calls, [{ action: 'scan' }]);
    assert.match(dom.node('#ai-content').innerHTML, destination === 'proactive' ? /data-proactive-pick/ : /data-ai-contact="contact"/);
    assert.doesNotMatch(dom.node('#ai-content').innerHTML, /data-ai-contact(?:-proactive)?="contact" checked/);
  });
}

for (const mode of ['reply', 'proactive']) for (const destination of ['instance-b', 'instance-a']) {
  test(`pending ${mode} strategy save cannot apply targets or start chat after opening ${destination}`, { timeout: 2000 }, async t => {
    const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData, dom = surface();
    globalThis.document = dom.document;
    globalThis.FormData = class extends OriginalFormData {
      constructor(form) { super(); for (const [key, value] of form?.entries || []) this.append(key, value); }
    };
    const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
    const controller = aiAssistant({ api: async (url, payload) => {
      calls.push({ url, action: payload?.action });
      if (payload?.action === (mode === 'reply' ? 'reply-profile' : 'proactive-task')) { entered.resolve(); await released.promise; }
      return { ...availableState(), profiles: [{id:'profile',contact:'contact',label:'Fixture',style:defaultStyle,learnedStyle:defaultStyle,learnedAt:1}],
        proactiveTasks: [{id:'task',name:'Invite',goal:'Invite to an event',requirements:'No invented facts',status:'paused',version:1,contacts:[{id:'contact',label:'Fixture',profileId:'profile'}],schedule:{cycle:'once'}}] };
    } });
    t.after(() => { released.resolve(); controller.detach(); globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; });
    await controller.attach('instance-a');
    if (mode === 'proactive') {
      await dom.navigate('proactive'); await dom.button({proactiveCommand:'edit',taskId:'task'});
    }
    const entries = mode === 'reply' ? [['replyProfiles', 'profile'], ['replyGoal', 'Continue the conversation'], ['boundaries', 'No invented facts'], ['maxRounds', '3']]
      : [['name', 'Invite'], ['goal', 'Invite to an event'], ['requirements', 'No invented facts'], ['cycle', 'once']];
    const pending = mode === 'reply' ? dom.button({aiApplyResult:'profile'}) : dom.submit(dom.form('#ai-'+mode+'-form', entries));
    await Promise.race([entered.promise, pending.then(() => { throw new Error(`Strategy save did not start: ${dom.node('#ai-feedback').textContent}`); })]);
    controller.detach(); await controller.attach(destination);
    const renderCount = dom.node('#ai-content').writes;
    released.resolve(); await pending;
    assert.deepEqual(calls.filter(call => call.action), [{ url: '/instances/instance-a/ai', action: mode === 'reply' ? 'reply-profile' : 'proactive-task' }]);
    assert.equal(dom.node('#ai-content').writes, renderCount);
  });
}

function captureIntervals(t) {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval, intervals = [];
  globalThis.setInterval = callback => { intervals.push(callback); return intervals.length; };
  globalThis.clearInterval = () => {};
  t.after(() => { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; });
  return intervals;
}

test('a delayed old poll cannot replace a successfully saved switch state', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), intervals = captureIntervals(t);
  globalThis.document = dom.document;
  const entered = Promise.withResolvers(), released = Promise.withResolvers(); let reads = 0;
  const controller = aiAssistant({ api: async (_url, payload) => {
    if (payload?.action === 'settings') return { ...availableState(), settings: { enabled: true, replyDelay: 8 } };
    if (++reads === 2) { entered.resolve(); await released.promise; }
    return availableState();
  } });
  t.after(() => { released.resolve(); controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a');
  const polling = intervals[0](); await entered.promise;
  await dom.change({ dataset: { aiPanelMaster: '' }, checked: true });
  assert.equal(dom.node('[data-ai-panel-master]').checked, true);
  released.resolve(); await polling;
  assert.equal(dom.node('[data-ai-panel-master]').checked, true);
  assert.doesNotMatch(dom.node('#ai-content').innerHTML, /ai-rail-status|data-ai-master/);
});

test('a failed old initial request neither reports its error nor installs a poll on the new instance', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), intervals = captureIntervals(t);
  globalThis.document = dom.document;
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const controller = aiAssistant({ api: async url => {
    if (url.includes('/instance-a/')) { entered.resolve(); await released.promise; throw new Error('Obsolete request failure'); }
    return availableState();
  } });
  t.after(() => { released.resolve(); controller.detach(); globalThis.document = originalDocument; });
  const oldAttach = controller.attach('instance-a'); await entered.promise;
  controller.detach(); await controller.attach('instance-b');
  assert.equal(intervals.length, 1);
  released.resolve(); await oldAttach;
  assert.equal(dom.node('#ai-feedback').textContent, '');
  assert.equal(intervals.length, 1);
});

test('a cancelled learning response cannot later navigate to results or report completion', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(); globalThis.document = dom.document;
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
  const controller = aiAssistant({ api: async (_url, payload) => {
    if (payload?.action) calls.push(payload.action);
    if (payload?.action === 'learn') { entered.resolve(); await released.promise; }
    return availableState();
  } });
  t.after(() => { released.resolve(); controller.detach(); globalThis.document = originalDocument; });
  await controller.attach('instance-a'); await dom.click('select-contacts');
  const learning = dom.click('learn-selected'); await entered.promise;
  await dom.click('cancel');
  const renderCount = dom.node('#ai-content').writes, cancelledMessage = dom.node('#ai-feedback').textContent;
  assert.match(cancelledMessage, /已取消/);
  released.resolve(); await learning;
  assert.equal(dom.node('#ai-content').writes, renderCount);
  assert.equal(dom.node('#ai-feedback').textContent, cancelledMessage);
  assert.deepEqual(calls, ['learn', 'cancel']);
});

const storedProvider = { protocol: 'openai', baseUrl: 'https://models.example.test/v1', model: 'fixture-model', timeout: 30, consent: true, hasKey: true };
const providerState = () => ({ ...availableState(), provider: { ...storedProvider }, schema: { providerPresets: [] } });

function providerSurface(dom) {
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class extends OriginalFormData {
    constructor(form) {
      super();
      for (const [name, input] of Object.entries(form?.elements || {})) {
        if (input.type !== 'checkbox' || input.checked) this.append(name, input.value);
      }
    }
  };
  const mount = () => {
    const form = dom.form('#ai-model-form', []);
    form.elements = Object.fromEntries(Object.entries({ ...storedProvider, apiKey: '********' }).filter(([name]) => name !== 'hasKey').map(([name, value]) => [name, {
      name, value: String(value), checked: !!value, type: name === 'apiKey' ? 'password' : name === 'consent' ? 'checkbox' : 'text',
      dataset: name === 'apiKey' ? { keyStored: 'true' } : {}, closest: selector => selector === '#ai-model-form' ? form : null,
      reportValidity: () => true,
    }]));
    form.reportValidity = () => true;
    return form;
  };
  mount.restore = () => { globalThis.FormData = OriginalFormData; };
  return mount;
}

for (const destination of ['instance-b', 'instance-a', 'hide-reopen', 'navigate-back', 'cancel-reveal', 'change-service']) {
  test(`a pending saved-key reveal cannot expose its result after ${destination}`, { timeout: 2000 }, async t => {
    const originalDocument = globalThis.document, dom = surface(), mountProvider = providerSurface(dom);
    globalThis.document = dom.document;
    const entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
    const controller = aiAssistant({ api: async (url, payload) => {
      if (payload?.action) calls.push({ url, action: payload.action });
      if (payload?.action === 'reveal-key') { entered.resolve(); await released.promise; return { ...storedProvider, apiKey: 'OLD_CONTEXT_SECRET' }; }
      return providerState();
    } });
    t.after(() => { released.resolve(); controller.detach(); mountProvider.restore(); globalThis.document = originalDocument; });
    await controller.attach('instance-a'); dom.node('#ai-open').onclick(); await dom.navigate('provider'); await dom.button({ aiModelEdit: 'legacy' });
    const originalForm = mountProvider(), originalInput = originalForm.elements.apiKey;
    const pending = dom.click('toggle-key');
    await Promise.race([entered.promise, pending.then(() => { throw new Error(`Key reveal did not start: ${dom.node('#ai-feedback').textContent}`); })]);
    let currentInput = originalInput;
    if (destination.startsWith('instance-')) {
      controller.detach(); await controller.attach(destination); dom.node('#ai-open').onclick(); await dom.navigate('provider'); await dom.button({ aiModelEdit: 'legacy' });
      currentInput = mountProvider().elements.apiKey;
    } else if (destination === 'hide-reopen') {
      dom.node('#ai-close').onclick(); dom.node('#ai-open').onclick();
    } else if (destination === 'navigate-back') {
      await dom.navigate('overview'); await dom.navigate('provider');
    } else if (destination === 'cancel-reveal') {
      await dom.click('toggle-key');
    } else {
      originalForm.elements.baseUrl.value = 'https://different.example.test/v1';
      dom.input(originalForm.elements.baseUrl);
    }
    const renders = dom.node('#ai-content').writes;
    released.resolve(); await pending;
    assert.equal(originalInput.value.includes('OLD_CONTEXT_SECRET'), false);
    assert.ok(['', '********'].includes(currentInput.value), 'stale responses must leave only an empty or masked key');
    assert.equal(currentInput.type, 'password');
    assert.equal(dom.node('#ai-content').writes, renders);
    assert.deepEqual(calls, [{ url: '/instances/instance-a/ai', action: 'reveal-key' }]);
  });
}

test('a reveal response for a different provider is rejected without displaying its key', { timeout: 2000 }, async t => {
  const originalDocument = globalThis.document, dom = surface(), mountProvider = providerSurface(dom);
  globalThis.document = dom.document;
  const controller = aiAssistant({ api: async (_url, payload) => payload?.action === 'reveal-key'
    ? { ...storedProvider, baseUrl: 'https://changed.example.test/v1', apiKey: 'CHANGED_PROVIDER_SECRET' }
    : providerState() });
  t.after(() => { controller.detach(); mountProvider.restore(); globalThis.document = originalDocument; });
  await controller.attach('instance-a'); dom.node('#ai-open').onclick(); await dom.navigate('provider');
  const input = mountProvider().elements.apiKey;
  await dom.click('toggle-key');
  assert.equal(input.value, '********'); assert.equal(input.type, 'password');
  assert.match(dom.node('#ai-feedback').textContent, /模型配置已变化/);
});



