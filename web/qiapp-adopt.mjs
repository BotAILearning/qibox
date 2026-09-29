// Bind QIAPP's native control patterns to the existing product DOM. Product
// handlers keep ownership of state, validation, network requests and dialogs.
const controls = 'button.primary, button.secondary, button.danger, button.quiet, button.icon-button';
const fields = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]), select, textarea:not(#native-input)';
const surfaces = '.market-panel, .desktop-panel, .store-card, .mobile-ai-card, #ai-panel .ai-card, #ai-panel .ai-task-card';

export function adoptQiUI(root) {
  if (!root?.querySelectorAll) return;
  const visit = (selector, action) => {
    if (root.matches?.(selector)) action(root);
    for (const node of root.querySelectorAll(selector)) action(node);
  };
  visit(controls, node => {
    node.classList.add('qi-btn');
    if (node.matches('.secondary')) node.dataset.variant = 'secondary';
    else if (node.matches('.quiet')) node.dataset.variant = 'text';
    else if (node.matches('.danger')) node.dataset.variant = 'danger';
    else if (node.matches('.icon-button')) { node.dataset.variant = 'ghost'; node.setAttribute('data-icon', ''); }
  });
  visit(fields, node => node.classList.add('qi-input'));
  visit('label.field, label.ai-field', node => node.classList.add('qi-field'));
  visit(surfaces, node => node.classList.add('qi-card'));
  visit('input[role=switch]', node => node.classList.add('qi-switch'));
  visit('progress', node => node.classList.add('qi-progress'));
  visit('#ai-panel .ai-badge', node => node.classList.add('qi-tag'));
  visit('dialog', node => node.classList.add('qiapp-dialog'));
}

if (typeof document !== 'undefined') {
  adoptQiUI(document);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) adoptQiUI(node);
    }).observe(document.body, { childList: true, subtree: true });
  }
}
