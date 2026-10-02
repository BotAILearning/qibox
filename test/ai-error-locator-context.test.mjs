import test from 'node:test';
import assert from 'node:assert/strict';
import { aiAssistant } from '../web/ai-assistant.mjs';

// Exercise the real click handler with a delayed API response. This DOM surface
// models region replacement/connection and focus, without a browser or device.
function surface() {
  const nodes = new Map(), handlers = new Map();
  const attribute = key => 'data-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
  const button = dataset => {
    const value = { dataset, isConnected: true, disabled: false,
      attributes: Object.keys(dataset).map(key => ({ name: attribute(key) })),
      hasAttribute: name => Object.keys(dataset).some(key => attribute(key) === name),
      closest(selector) { const key = /^\[([a-z-]+)\]$/.exec(selector)?.[1]; return selector === 'button' || key && this.hasAttribute(key) ? this : null; } };
    return value;
  };
  const absent = new Set(['#ai-queue-live', '#ai-skip-records', '#ai-proactive-records', '#ai-live-box', '#ai-activity-entries']);
  const document = { activeElement: null, body: { append() {} }, querySelector: node, querySelectorAll: () => [],
    createElement: tag => tag === 'template' ? { innerHTML: '' } : node(`created-${tag}`) };
  function node(selector) {
    if (absent.has(selector) || /^#ai-.*-form$/.test(selector)) return null;
    if (selector === '#ai-recent-errors') return nodes.get(selector) || null;
    if (!nodes.has(selector)) nodes.set(selector, create(selector));
    return nodes.get(selector);
  }
  function create(selector) {
    let html = '', text = '', children = [];
    const value = { hidden: false, isConnected: true, dataset: {}, ownerDocument: document, options: [], classList: { toggle() {} },
      writes: 0, focusCalls: 0,
      get innerHTML() { return html; }, set innerHTML(next) {
        html = next; this.writes++;
        if (selector === '#ai-content') {
          const previous = nodes.get('#ai-recent-errors'); if (previous) previous.isConnected = false;
          nodes.delete('#ai-recent-errors');
          if (next.includes('id="ai-recent-errors"')) nodes.set('#ai-recent-errors', create('#ai-recent-errors'));
        }
      },
      get textContent() { return children.length ? children.map(child => child.textContent || '').join('') : text; },
      set textContent(next) { text = next; children = []; },
      setAttribute() {}, focus() { this.focusCalls++; document.activeElement = this; }, replaceChildren(...next) { children = next; }, append() {}, remove() {},
      querySelector: node, querySelectorAll: () => [], contains: () => false,
      addEventListener(type, handler) { const key = `${selector}:${type}`; const listeners = handlers.get(key) || []; listeners.push(handler); handlers.set(key, listeners); },
    };
    return value;
  }
  const dispatch = (type, event) => Promise.all((handlers.get(`#ai-panel:${type}`) || []).map(handler => handler(event)));
  return { document, node, button,
    click: target => dispatch('click', { target, preventDefault() {} }),
    navigate: next => dispatch('click', { target: button({ aiNav: next }), preventDefault() {} }),
    hide: () => dispatch('keydown', { target: button({}), key: 'Escape', stopPropagation() {} }),
  };
}
const snapshot = () => ({ account: 'synthetic-account', settings: { enabled: false, replyDelay: 8 },
  requirements: { proactive: '', reply: '' }, contacts: [{ id: 'synthetic-contact', label: 'Synthetic', kind: 'person' }],
  profiles: [], targets: [], strategy: {}, events: [], activity: [], queue: { status: 'idle', items: [] }, available: true });

async function fixture(t, fail = false) {
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  const dom = surface(), entered = Promise.withResolvers(), released = Promise.withResolvers(), calls = [];
  globalThis.document = dom.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const controller = aiAssistant({ api: async (url, payload) => {
    calls.push({ url, action: payload?.action });
    if (payload?.action === 'error-related-record') {
      entered.resolve(); await released.promise;
      if (fail) throw new Error('OLD_LOCATOR_FAILURE');
      return { source: 'proactive', record: { id: 'OLD_LOCATOR_RECORD', account: 'synthetic-account', taskId: 'OLD_TASK' } };
    }
    if (payload?.action === 'activity-records') return { records: [] };
    if (payload?.action === 'proactive-records') return { records: [], page: { hasMore: false } };
    return snapshot();
  } });
  t.after(() => { released.resolve(); controller.detach(); globalThis.document = originalDocument; globalThis.window = originalWindow; });
  await controller.attach('instance-a'); controller.show(); await dom.navigate('activity');
  assert.equal(dom.node('#ai-panel').hidden, false);
  assert.ok(dom.node('#ai-recent-errors')?.isConnected);
  const trigger = dom.button({ aiErrorRecordTarget: 'synthetic-error' });
  const pending = dom.click(trigger);
  await entered.promise;
  assert.equal(trigger.disabled, true);
  return { dom, controller, released, pending, trigger, calls };
}

for (const destination of ['instance-switch', 'hidden', 'page-return']) {
  test(`a delayed locator success cannot change records or focus after ${destination}`, { timeout: 2000 }, async t => {
    const f = await fixture(t);
    if (destination === 'instance-switch') { f.controller.detach(); await f.controller.attach('instance-b'); f.controller.show(); }
    else if (destination === 'hidden') { await f.dom.hide(); assert.equal(f.dom.node('#ai-panel').hidden, true); }
    else { await f.dom.navigate('overview'); await f.dom.navigate('activity'); }
    const content = f.dom.node('#ai-content'), feedback = f.dom.node('#ai-feedback');
    const writes = content.writes, markup = content.innerHTML, message = feedback.textContent, active = f.dom.document.activeElement;
    f.released.resolve(); await f.pending;
    assert.equal(content.writes, writes, 'obsolete success must not render another record list');
    assert.equal(content.innerHTML, markup); assert.equal(feedback.textContent, message);
    assert.equal(f.dom.document.activeElement, active, 'obsolete success must not move focus');
    assert.equal(f.trigger.disabled, false, 'the original connected trigger must recover');
    assert.equal(f.calls.filter(call => call.action === 'error-related-record').length, 1);
    assert.doesNotMatch(content.innerHTML, /OLD_LOCATOR_RECORD|OLD_TASK/);
  });
}

for (const destination of ['instance-switch', 'hidden', 'page-return', 'same-view']) {
  test(`a delayed locator failure ${destination === 'same-view' ? 'remains actionable in' : 'cannot contaminate'} ${destination}`, { timeout: 2000 }, async t => {
    const f = await fixture(t, true);
    if (destination === 'instance-switch') { f.controller.detach(); await f.controller.attach('instance-b'); f.controller.show(); }
    else if (destination === 'hidden') { await f.dom.hide(); assert.equal(f.dom.node('#ai-panel').hidden, true); }
    else if (destination === 'page-return') { await f.dom.navigate('overview'); await f.dom.navigate('activity'); }
    const content = f.dom.node('#ai-content'), feedback = f.dom.node('#ai-feedback');
    const writes = content.writes, message = feedback.textContent;
    f.released.resolve(); await f.pending;
    assert.equal(content.writes, writes, 'a failed lookup must retain the current list');
    assert.equal(f.trigger.disabled, false);
    if (destination === 'same-view') { assert.match(feedback.textContent, /OLD_LOCATOR_FAILURE/); assert.equal(feedback.hidden, false); }
    else assert.equal(feedback.textContent, message, 'obsolete failures must not replace current feedback');
    assert.equal(f.calls.filter(call => call.action === 'error-related-record').length, 1);
  });
}
