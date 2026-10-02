const recordAttributes = ['data-ai-skip-record', 'data-proactive-record'];
const recordSelector = recordAttributes.map(attribute => `[${attribute}]`).join(',');
const actionAttributes = ['data-ai-open-conversation', 'data-ai-mark-reply',
  'data-ai-skip-more', 'data-ai-retry-skips', 'data-proactive-record-more'];
const renderedMarkup = new WeakMap();

export function skipDisclosureKeys(host, expandedKeys = []) {
  const expanded = new Set(expandedKeys);
  for (const disclosure of host?.querySelectorAll('details[data-ai-skip-messages]') || []) {
    const key = disclosure.getAttribute('data-ai-skip-messages');
    if (!key) continue;
    if (disclosure.open) expanded.add(key);
    else expanded.delete(key);
  }
  return [...expanded];
}

function focusIdentity(host) {
  const active = host.ownerDocument?.activeElement;
  if (!active || !host.contains(active)) return null;
  const record = active.closest(recordSelector);
  const recordAttribute = record && recordAttributes.find(attribute => record.hasAttribute(attribute));
  const recordId = recordAttribute && record.getAttribute(recordAttribute);
  const identity = recordId ? { recordAttribute, recordId } : {};
  const actionAttribute = actionAttributes.find(attribute => active.hasAttribute(attribute));
  if (actionAttribute) return record && !recordId ? null : { ...identity, actionAttribute, actionId: active.getAttribute(actionAttribute) };
  if (active.tagName === 'SUMMARY') {
    const disclosure = active.closest('details[data-ai-skip-messages]');
    if (disclosure) return { ...identity, disclosureId: disclosure.getAttribute('data-ai-skip-messages') };
  }
  return null;
}

function restoreFocus(host, identity) {
  if (!identity) return;
  const scope = identity.recordAttribute
    ? [...host.querySelectorAll(`[${identity.recordAttribute}]`)]
      .find(record => record.getAttribute(identity.recordAttribute) === identity.recordId)
    : host;
  if (!scope) return;
  const target = identity.disclosureId !== undefined
    ? [...scope.querySelectorAll('details[data-ai-skip-messages]')]
      .find(disclosure => disclosure.getAttribute('data-ai-skip-messages') === identity.disclosureId)?.querySelector('summary')
    : [...scope.querySelectorAll(`[${identity.actionAttribute}]`)]
      .find(action => action.getAttribute(identity.actionAttribute) === identity.actionId);
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

// render may first copy current disclosure.open values into its view state.
// Keeping the host also preserves scroll position and delegated listeners.
export function refreshRecordContent(host, render, { outerMarkup = false } = {}) {
  if (!host) return false;
  const focus = focusIdentity(host);
  const markup = typeof render === 'function' ? render() : render;
  if (renderedMarkup.get(host) === markup) return false;
  const template = host.ownerDocument.createElement('template');
  template.innerHTML = markup;
  const wrapper = outerMarkup ? template.content.firstElementChild : null;
  if (outerMarkup && (!wrapper || wrapper.id !== host.id || wrapper.nextElementSibling)) {
    throw new Error('Record renderer must retain its root');
  }
  const content = outerMarkup ? wrapper.innerHTML : template.innerHTML;
  renderedMarkup.set(host, markup);
  if (host.innerHTML === content) return false;
  host.innerHTML = content;
  restoreFocus(host, focus);
  return true;
}
