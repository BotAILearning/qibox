/** QIAPP interactive components. No runtime dependencies; safe to import during SSR. */
const BaseHTMLElement = globalThis.HTMLElement || class {};
let sequence = 0;
const uid = (prefix = 'qi') => `${prefix}-${++sequence}`;
const textValue = (value) => value == null ? '' : String(value);
const fold = (value) => textValue(value).normalize('NFKC').toLocaleLowerCase();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const integer = (value, fallback) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
const emit = (element, type, detail) => element.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
const focusable = (root) => [...root.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((node) => !node.hidden && !node.closest('[hidden]'));
function node(tag, className, content) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content != null) result.textContent = String(content);
  return result;
}
function button(label, variant = 'secondary') {
  const result = node('button', 'qi-btn', label);
  result.type = 'button';
  result.dataset.variant = variant;
  return result;
}
function setContent(container, value) {
  if (value instanceof globalThis.Node) container.append(value);
  else container.textContent = textValue(value);
}
function sameValue(a, b) { return String(a) === String(b); }

/** Pure table pipeline: filter before stable sort; clamp page after filtering. */
export function getTableView(rows = [], columns = [], state = {}) {
  const search = fold(state.search || '').trim();
  const filters = state.filters || {};
  const searchable = columns.filter((column) => column.searchable !== false);
  let entries = rows.map((row, index) => ({ row, index }));
  entries = entries.filter(({ row }) => {
    if (search && !searchable.some((column) => fold(row[column.key]).includes(search))) return false;
    return Object.entries(filters).every(([key, value]) => {
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) return true;
      return Array.isArray(value) ? value.some((item) => sameValue(row[key], item)) : sameValue(row[key], value);
    });
  });
  const sort = state.sort;
  if (sort?.key && ['asc', 'desc'].includes(sort.direction)) {
    const direction = sort.direction === 'asc' ? 1 : -1;
    const column = columns.find((item) => item.key === sort.key);
    if (column) entries.sort((a, b) => {
      const av = a.row[sort.key];
      const bv = b.row[sort.key];
      // Missing values remain last in either sort direction.
      if (av == null && bv != null) return 1;
      if (bv == null && av != null) return -1;
      let compare = 0;
      if (av != null && bv != null) {
        compare = typeof av === 'number' && typeof bv === 'number'
          ? av - bv : textValue(av).localeCompare(textValue(bv), undefined, { numeric: true, sensitivity: 'base' });
      }
      return compare * direction || a.index - b.index;
    });
  }
  const total = entries.length;
  const pageSize = Math.max(1, integer(state.pageSize, 10));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clamp(integer(state.page, 1), 1, pageCount);
  return {
    rows: entries.slice((page - 1) * pageSize, page * pageSize).map((entry) => entry.row),
    filteredRows: entries.map((entry) => entry.row), total, page, pageSize, pageCount,
  };
}

/** Empty accept allows every type; extension, exact MIME and type/* are supported. */
export function fileAccepted(file, accept = '') {
  const rules = accept.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return rules.some((rule) => rule.startsWith('.') ? name.endsWith(rule)
    : rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : type === rule);
}

export function validateFiles(files, { accept = '', maxSize = 0, multiple = false } = {}) {
  const accepted = [];
  const rejected = [];
  for (const file of files) {
    let reason = '';
    if (!fileAccepted(file, accept)) reason = '文件类型不符合要求';
    else if (maxSize > 0 && file.size > maxSize) reason = '文件超过大小限制';
    else if (!multiple && accepted.length) reason = '仅支持选择一个文件';
    if (reason) rejected.push({ file, reason });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export function getCascadeLevels(options = [], value = []) {
  const levels = [];
  let choices = options;
  for (let index = 0; choices.length; index += 1) {
    levels.push(choices);
    const selected = choices.find((item) => sameValue(item.value, value[index]) && !item.disabled);
    if (!selected?.children?.length) break;
    choices = selected.children;
  }
  return levels;
}

export function normalizeCascadeValue(options = [], value = []) {
  const path = [];
  let choices = options;
  for (const part of value) {
    const selected = choices.find((item) => sameValue(item.value, part) && !item.disabled);
    if (!selected) break;
    path.push(selected.value);
    choices = selected.children || [];
  }
  return path;
}

class QiElement extends BaseHTMLElement {
  connectedCallback() {
    this._events?.abort();
    this._events = new AbortController();
    this.mount();
  }
  disconnectedCallback() { this._events?.abort(); this.unmount?.(); }
  listen(target, event, handler, options = {}) {
    target.addEventListener(event, handler, { ...options, signal: this._events.signal });
  }
}

export class QiTabs extends QiElement {
  static get observedAttributes() { return ['value', 'orientation']; }
  attributeChangedCallback(name, previous, value) {
    if (previous === value || !this._tabs) return;
    if (name === 'value') this.select(value);
    if (name === 'orientation') this.querySelector('[role="tablist"]')?.setAttribute('aria-orientation', value === 'vertical' ? 'vertical' : 'horizontal');
  }
  enabledTabs() { return (this._tabs || []).filter(tab => !tab.disabled && tab.getAttribute('aria-disabled') !== 'true'); }
  moveFocus(tab) {
    this._tabs.forEach(item => { item.tabIndex = item === tab ? 0 : -1; });
    tab?.focus();
  }
  mount() {
    this.classList.add('qi-tabs');
    this._tabs = [...this.querySelectorAll('[data-tab]')];
    this._panels = [...this.querySelectorAll('[data-panel]')];
    const tablist = this.querySelector('[data-tablist],[data-tab-list]') || this._tabs[0]?.parentElement;
    if (tablist && tablist !== this) { tablist.setAttribute('role', 'tablist'); tablist.classList.add('qi-tabs__list'); }
    else if (this._tabs.length) {
      const list = node('div', 'qi-tabs__list'); list.dataset.tablist = ''; list.setAttribute('role', 'tablist');
      this.prepend(list); this._tabs.forEach((tab) => list.append(tab));
    }
    this._tabs.forEach((tab) => {
      const panel = this._panels.find((item) => item.dataset.panel === tab.dataset.tab);
      tab.classList.add('qi-tabs__tab'); tab.setAttribute('role', 'tab');
      if (tab.tagName === 'BUTTON') tab.type = 'button';
      tab.id ||= uid('qi-tab');
      if (panel) {
        panel.classList.add('qi-tabs__panel'); panel.id ||= uid('qi-panel');
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
        panel.tabIndex = 0; tab.setAttribute('aria-controls', panel.id);
      }
      this.listen(tab, 'click', event => {
        if (!this.enabledTabs().includes(tab)) { event.preventDefault(); return; }
        this.select(tab.dataset.tab, true);
      });
      this.listen(tab, 'keydown', (event) => {
        const enabled = this.enabledTabs();
        if (!enabled.length || !enabled.includes(tab)) return;
        if (['Enter',' '].includes(event.key)) {
          event.preventDefault(); this.select(tab.dataset.tab, true); return;
        }
        let index = enabled.indexOf(tab);
        const vertical = this.getAttribute('orientation') === 'vertical';
        const rtl = getComputedStyle(this).direction === 'rtl';
        if (event.key === (vertical ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight')) index = (index + 1) % enabled.length;
        else if (event.key === (vertical ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft')) index = (index - 1 + enabled.length) % enabled.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = enabled.length - 1;
        else return;
        event.preventDefault(); this.moveFocus(enabled[index]);
        if (this.getAttribute('activation') !== 'manual') this.select(enabled[index]?.dataset.tab, true);
      });
    });
    this.querySelector('[role="tablist"]')?.setAttribute('aria-orientation', this.getAttribute('orientation') || 'horizontal');
    const requested = this._value || this.getAttribute('value') || this._tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.tab;
    this.select(this.enabledTabs().find(tab => tab.dataset.tab === requested)?.dataset.tab || this.enabledTabs()[0]?.dataset.tab);
  }
  select(value, notify = false) {
    const selected = this.enabledTabs().find(tab => tab.dataset.tab === String(value));
    if (!selected) return;
    const changed = this._value !== selected.dataset.tab;
    this._value = selected.dataset.tab;
    this._tabs.forEach((tab) => { const active = tab === selected; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
    this._panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== this._value; });
    if (notify && changed) emit(this, 'change', { value: this._value });
  }
  get value() { return this._value || ''; }
  set value(value) { if (this.isConnected) this.select(value); else this._value = String(value); }
}

export class QiDialog extends QiElement {
  mount() {
    this.classList.add(this.localName === 'qi-drawer' ? 'qi-drawer' : 'qi-dialog');
    this.dialog = this.querySelector('dialog');
    if (!this.dialog) {
      this.dialog = node('dialog');
      while (this.firstChild) this.dialog.append(this.firstChild);
      this.append(this.dialog);
    }
    this.dialog.classList.add(this.localName === 'qi-drawer' ? 'qi-drawer__surface' : 'qi-dialog__surface');
    if (!this.dialog.hasAttribute('aria-labelledby') && !this.dialog.hasAttribute('aria-label')) {
      const heading = this.dialog.querySelector('h1,h2,h3,[data-title]');
      if (heading) { heading.id ||= uid('qi-dialog-title'); this.dialog.setAttribute('aria-labelledby', heading.id); }
      else this.dialog.setAttribute('aria-label', this.getAttribute('label') || (this.localName === 'qi-drawer' ? '抽屉面板' : '对话框'));
    }
    this.listen(this.dialog, 'cancel', (event) => { event.preventDefault(); this.close('cancel'); });
    this.listen(this.dialog, 'close', () => {
      const value = this.dialog.returnValue;
      if (this._opener?.isConnected) this._opener.focus();
      emit(this, 'qi-close', { value, confirmed: value === 'confirm' });
    });
    this.listen(this.dialog, 'click', (event) => {
      const close = event.target.closest('[data-close]');
      if (close) { event.preventDefault(); this.close(close.getAttribute('data-close') || 'cancel'); }
      if (event.target === this.dialog && this.hasAttribute('close-on-backdrop')) {
        const rect = this.dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close('cancel');
      }
    });
  }
  show(opener) {
    if (!this.dialog || this.dialog.open) return;
    this._opener = opener || this.ownerDocument.activeElement;
    this.dialog.returnValue = '';
    this.dialog.showModal(); emit(this, 'qi-open', {});
  }
  close(value = 'cancel') { if (this.dialog?.open) this.dialog.close(String(value)); }
  get open() { return !!this.dialog?.open; }
  unmount() { if (this.dialog?.open) this.dialog.close('cancel'); }
}
export class QiDrawer extends QiDialog {}

class QiFloating extends QiElement {
  mount() {
    this.classList.add('qi-floating');
    this.trigger = this.querySelector('[data-trigger]');
    this.content = this.querySelector('[data-content],[data-menu]');
    if (!this.trigger || !this.content) return;
    this.content.classList.add('qi-floating__content'); this.content.id ||= uid('qi-floating');
    this._topLayer = typeof this.content.showPopover === 'function';
    if (this._topLayer) { this.content.setAttribute('popover', 'manual'); this.content.classList.add('qi-floating__content--top-layer'); }
    this.content.hidden = true; this._open = false;
    this.trigger.setAttribute('aria-controls', this.content.id); this.trigger.setAttribute('aria-expanded', 'false');
    if (this.trigger.tagName === 'BUTTON') this.trigger.type = 'button';
    this.listen(this.trigger, 'click', () => { if (!this.trigger.disabled && this.trigger.getAttribute('aria-disabled') !== 'true') this.toggle(); });
    this.listen(document, 'pointerdown', (event) => { if (this.open && !this.contains(event.target)) this.hide(false); });
    this.listen(this, 'keydown', (event) => {
      if (event.key === 'Escape' && this.open) { event.stopPropagation(); event.preventDefault(); this.hide(true); }
    });
    this.listen(document, 'focusin', (event) => { if (this.open && !this.contains(event.target)) this.hide(false); });
    this.listen(window, 'resize', () => { if (this.open) this.position(); });
    this.listen(window, 'scroll', event => { if (this.open && !this.content.contains(event.target)) this.position(); }, { capture:true });
  }
  position() {
    if (!this.content || !this.trigger) return;
    // CSS zoom scales fixed top-layer coordinates too; toolbar zoom already
    // changes innerWidth and therefore keeps this factor at one.
    const zoom = this.content.currentCSSZoom || 1;
    this.content.style.setProperty('--qi-float-available-width', `${Math.max(1,window.innerWidth - 24) / zoom}px`);
    this.content.style.removeProperty('--qi-float-shift');
    this.content.style.maxHeight = '';
    this.content.classList.remove('qi-floating__content--above');
    const trigger = this.trigger.getBoundingClientRect();
    const margin = 12, gap = 8;
    const below = Math.max(0, window.innerHeight - trigger.bottom - gap - margin);
    const above = Math.max(0, trigger.top - gap - margin);
    const rect = this.content.getBoundingClientRect();
    const placeAbove = rect.height > below && above > below;
    this.content.style.maxHeight = `${Math.max(1, Math.min(rect.height, placeAbove ? above : below)) / zoom}px`;
    if (this._topLayer) {
      this.content.style.left = `${clamp(getComputedStyle(this).direction === 'rtl' ? trigger.right - rect.width : trigger.left, margin, Math.max(margin, window.innerWidth - rect.width - margin)) / zoom}px`;
      this.content.style.top = `${(placeAbove ? Math.max(margin, trigger.top - gap - this.content.getBoundingClientRect().height) : trigger.bottom + gap) / zoom}px`;
      return;
    }
    if (rect.right > window.innerWidth - 12) this.content.style.setProperty('--qi-float-shift', `${window.innerWidth - 12 - rect.right}px`);
    else if (rect.left < 12) this.content.style.setProperty('--qi-float-shift', `${12 - rect.left}px`);
    this.content.classList.toggle('qi-floating__content--above', placeAbove);
  }
  show() {
    if (!this.content || !this.trigger || this.trigger.disabled || this.trigger.getAttribute('aria-disabled') === 'true') return;
    this._open = true; this.content.hidden = false;
    if (this._topLayer && !this.content.matches(':popover-open')) this.content.showPopover();
    this.trigger.setAttribute('aria-expanded', 'true'); this.position();
  }
  hide(returnFocus = false) {
    if (!this.content) return;
    if (this._topLayer && this.content.matches(':popover-open')) this.content.hidePopover();
    this._open = false; this.content.hidden = true; this.trigger?.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.trigger?.focus();
  }
  toggle() { this.open ? this.hide(false) : this.show(); }
  get open() { return !!this._open; }
  unmount() { this.hide(false); }
}

export class QiDropdown extends QiFloating {
  mount() {
    super.mount(); if (!this.content) return;
    this.classList.add('qi-dropdown'); this.content.classList.add('qi-menu'); this.content.setAttribute('role', 'menu');
    this.trigger.setAttribute('aria-haspopup', 'menu');
    [...this.content.querySelectorAll('button,[href],[data-action]')].forEach((item) => { item.setAttribute('role', 'menuitem'); item.tabIndex = -1; if (item.tagName === 'BUTTON') item.type = 'button'; });
    this.listen(this.trigger, 'keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); this.show(); const items = this.items(); (event.key === 'ArrowDown' ? items[0] : items.at(-1))?.focus();
      }
    });
    this.listen(this.content, 'keydown', (event) => {
      const items = this.items(); let index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') index = (index + 1) % items.length;
      else if (event.key === 'ArrowUp') index = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = items.length - 1;
      else if (event.key === 'Tab') { this.hide(true); return; }
      else if (['Enter', ' '].includes(event.key) && document.activeElement?.matches('[data-action]:not(button):not(a)')) {
        event.preventDefault(); document.activeElement.click(); return;
      }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        const match = items.find((item) => fold(item.textContent).trim().startsWith(fold(event.key)));
        match?.focus(); return;
      } else return;
      event.preventDefault(); items[index]?.focus();
    });
    this.listen(this.content, 'click', (event) => {
      const item = event.target.closest('[role="menuitem"]');
      if (item && !item.disabled && item.getAttribute('aria-disabled') !== 'true') {
        emit(this, 'select', { value: item.dataset.value ?? item.textContent.trim(), item }); this.hide(true);
      }
    });
  }
  items() { return [...this.content.querySelectorAll('button,[href],[data-action]')].filter((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true' && !item.hidden); }
  show() { super.show(); if (this.open) this.items()[0]?.focus(); }
}

export class QiPopover extends QiFloating {
  mount() {
    super.mount(); if (!this.content) return;
    this.classList.add('qi-popover'); this.content.classList.add('qi-popover__surface');
    this.content.setAttribute('role', 'dialog'); this.content.tabIndex = -1;
    this.content.setAttribute('aria-label', this.getAttribute('label') || '详细信息');
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.listen(this.content, 'click', (event) => { if (event.target.closest('[data-close]')) this.hide(true); });
  }
  show() { super.show(); if (this.open) (focusable(this.content)[0] || this.content).focus(); }
}

export class QiTooltip extends QiElement {
  mount() {
    this.classList.add('qi-tooltip'); this.trigger = this.querySelector('[data-trigger]') || this.firstElementChild;
    this.content = this.querySelector('[data-content]');
    if (!this.content) { this.content = node('span', '', this.getAttribute('text') || ''); this.content.dataset.content = ''; this.append(this.content); }
    if (!this.trigger || this.trigger === this.content) return;
    this.content.classList.add('qi-tooltip__content'); this.content.id ||= uid('qi-tooltip');
    this._topLayer = typeof this.content.showPopover === 'function';
    if (this._topLayer) { this.content.setAttribute('popover', 'manual'); this.content.classList.add('qi-tooltip__content--top-layer'); }
    this.content.setAttribute('role', 'tooltip'); this.content.hidden = true;
    const describedBy = new Set((this.trigger.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    describedBy.add(this.content.id); this.trigger.setAttribute('aria-describedby', [...describedBy].join(' '));
    this.listen(this, 'pointerenter', () => this.show());
    this.listen(this, 'pointerleave', () => { if (!this.contains(document.activeElement)) this._hideTimer = setTimeout(() => this.hide(), 150); });
    this.listen(this.trigger, 'focus', () => this.show()); this.listen(this.trigger, 'blur', () => this.hide());
    this.listen(this, 'keydown', (event) => { if (event.key === 'Escape') this.hide(); });
    this.listen(window, 'resize', () => { if (this.content && !this.content.hidden) this.position(); });
    this.listen(window, 'scroll', () => { if (this.content && !this.content.hidden) this.position(); }, { capture:true });
  }
  position() {
    if (!this._topLayer || !this.trigger || !this.content) return;
    const trigger = this.trigger.getBoundingClientRect(), rect = this.content.getBoundingClientRect();
    const margin = 12, gap = 8;
    this.content.style.left = `${clamp(trigger.left + (trigger.width - rect.width) / 2, margin, Math.max(margin, innerWidth - rect.width - margin))}px`;
    const above = trigger.top - gap - rect.height;
    this.content.style.top = `${clamp(above >= margin ? above : trigger.bottom + gap, margin, Math.max(margin, innerHeight - rect.height - margin))}px`;
  }
  show() {
    clearTimeout(this._hideTimer); if (!this.content || !this.trigger) return;
    this.content.hidden = false;
    if (this._topLayer && !this.content.matches(':popover-open')) this.content.showPopover();
    this.position();
  }
  hide() {
    clearTimeout(this._hideTimer); if (!this.content) return;
    if (this._topLayer && this.content.matches(':popover-open')) this.content.hidePopover();
    this.content.hidden = true;
  }
  unmount() { this.hide(); }
}

const TABLE_DEFAULTS = { columns: [], rows: [], rowKey: 'id', pageSize: 5, searchable: true, selectable: false, sticky: true, filters: [], loading: false, emptyText: '暂无数据', caption: '数据表格' };
export class QiTable extends QiElement {
  constructor() {
    super(); this._config = { ...TABLE_DEFAULTS }; this._state = { search: '', filters: {}, sort: null, page: 1 };
    this._selected = new Set();
  }
  mount() {
    // Input caret selection also fires selectionchange in modern browsers.
    // The public table event always describes selected rows, not input text.
    this.listen(this, 'selectionchange', event => {
      if (!(event instanceof CustomEvent) || event.target !== this) event.stopImmediatePropagation();
    }, { capture:true });
    this.classList.add('qi-table'); this.render();
  }
  configure(options = {}) {
    this._config = { ...this._config, ...options };
    if ('rows' in options) {
      const keys = new Set(this._config.rows.map((row, index) => this.key(row, index)));
      this._selected = new Set([...this._selected].filter((key) => keys.has(key)));
    }
    if (this.isConnected) this.render(); return this;
  }
  key(row, index) {
    return String(typeof this._config.rowKey === 'function' ? this._config.rowKey(row, index) : row[this._config.rowKey] ?? index);
  }
  rowId(row) { return this.key(row, this._config.rows.indexOf(row)); }
  get columns() { return this._config.columns; } set columns(value) { this.configure({ columns: Array.isArray(value) ? value : [] }); }
  get rows() { return this._config.rows; } set rows(value) { this.configure({ rows: Array.isArray(value) ? value : [] }); }
  get loading() { return this._config.loading; } set loading(value) { this.configure({ loading: Boolean(value) }); }
  get selected() { return [...this._selected]; }
  set selected(value) { this._selected = new Set((value || []).map(String)); if (this.isConnected) this.renderBody(); }
  get state() { return { ...this._state, filters: { ...this._state.filters }, sort: this._state.sort ? { ...this._state.sort } : null, pageSize: this._config.pageSize }; }
  setSearch(value) { this._state.search = String(value); this._state.page = 1; if (this._search) this._search.value = this._state.search; this.renderBody(); }
  setFilter(key, value) { this._state.filters[key] = value; this._state.page = 1; this.render(); }
  setSort(key, direction = 'asc') { this._state.sort = direction ? { key, direction } : null; this.renderBody(); }
  setPage(page) { this._state.page = page; this.renderBody(); }
  render() {
    if (!this.isConnected) return;
    this.replaceChildren(); const config = this._config;
    const toolbar = node('div', 'qi-table__toolbar');
    if (config.searchable) {
      const field = node('label', 'qi-table__search'); field.append(node('span', 'qi-sr-only', '搜索表格'));
      const input = node('input', 'qi-input'); input.type = 'search'; input.placeholder = '搜索…'; input.value = this._state.search;
      input.addEventListener('input', () => this.setSearch(input.value)); field.append(input); toolbar.append(field); this._search = input;
    }
    config.filters.forEach((filter) => {
      const label = node('label', 'qi-table__filter'); label.append(node('span', '', filter.label));
      const select = node('select', 'qi-input'); const all = node('option', '', '全部'); all.value = ''; select.append(all);
      (filter.options || []).forEach((option) => { const item = node('option', '', typeof option === 'object' ? option.label : option); item.value = typeof option === 'object' ? option.value : option; select.append(item); });
      select.value = this._state.filters[filter.key] ?? '';
      select.addEventListener('change', () => { this._state.filters[filter.key] = select.value; this._state.page = 1; this.renderBody(); });
      label.append(select); toolbar.append(label);
    });
    if (config.columns.some((column) => column.sortable)) {
      const label = node('label', 'qi-table__mobile-sort'); label.append(node('span', '', '排序'));
      const select = node('select', 'qi-input'); const none = node('option', '', '默认顺序'); none.value = ''; select.append(none);
      config.columns.filter((column) => column.sortable).forEach((column) => ['asc', 'desc'].forEach((direction) => {
        const option = node('option', '', `${column.label} ${direction === 'asc' ? '升序' : '降序'}`); option.value = JSON.stringify([column.key, direction]); select.append(option);
      }));
      select.value = this._state.sort ? JSON.stringify([this._state.sort.key, this._state.sort.direction]) : '';
      select.addEventListener('change', () => { const [key, direction] = select.value ? JSON.parse(select.value) : ['', null]; this.setSort(key, direction); });
      label.append(select); toolbar.append(label); this._mobileSort = select;
    }
    this.append(toolbar);
    this._summary = node('div', 'qi-table__summary'); this._summary.setAttribute('role', 'status'); this._summary.setAttribute('aria-live', 'polite'); this.append(this._summary);
    this._body = node('div', 'qi-table__body'); this.append(this._body);
    this._footer = node('div', 'qi-table__footer'); this.append(this._footer); this.renderBody();
  }
  renderBody() {
    if (!this._body) return;
    const config = this._config;
    if (this._mobileSort) this._mobileSort.value = this._state.sort ? JSON.stringify([this._state.sort.key, this._state.sort.direction]) : '';
    const view = getTableView(config.rows, config.columns, { ...this._state, pageSize: config.pageSize });
    this._state.page = view.page; this._body.replaceChildren(); this._footer.replaceChildren(); this.setAttribute('aria-busy', String(config.loading));
    this._summary.textContent = config.loading ? '正在加载数据…' : `共 ${view.total} 条${config.selectable ? ` · 已选 ${this._selected.size} 条` : ''}`;
    if (config.loading || !view.total) {
      const empty = node('div', 'qi-table__empty', config.loading ? '正在加载数据…' : (this._state.search || Object.values(this._state.filters).some(Boolean) ? '没有符合条件的数据' : config.emptyText));
      empty.setAttribute('role', 'status'); this._body.append(empty);
      emit(this, 'viewchange', { ...view, state: this.state }); return;
    }
    const wrap = node('div', 'qi-table__scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `${config.caption}，可横向滚动`);
    const table = node('table', config.sticky ? 'qi-table__grid qi-table__grid--sticky' : 'qi-table__grid');
    table.append(node('caption', 'qi-sr-only', config.caption));
    const head = node('thead'); const headerRow = node('tr');
    if (config.selectable) {
      const th = node('th'); th.scope = 'col'; const check = node('input'); check.type = 'checkbox'; check.setAttribute('aria-label', '选择本页全部');
      const selectedCount = view.rows.filter((row) => this._selected.has(this.rowId(row))).length;
      check.checked = selectedCount === view.rows.length; check.indeterminate = selectedCount > 0 && selectedCount < view.rows.length;
      check.addEventListener('change', () => { view.rows.forEach((row) => check.checked ? this._selected.add(this.rowId(row)) : this._selected.delete(this.rowId(row))); this.selectionChanged('all'); });
      const hit = node('label','qi-table__select-hit'); hit.append(check); th.append(hit); headerRow.append(th);
    }
    config.columns.forEach((column) => {
      const th = node('th'); th.scope = 'col'; if (column.width) th.style.width = column.width;
      if (column.sortable) {
        const active = this._state.sort?.key === column.key ? this._state.sort.direction : null;
        th.setAttribute('aria-sort', active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none');
        const sortButton = button(`${column.label} ${active === 'asc' ? '↑' : active === 'desc' ? '↓' : '↕'}`, 'ghost'); sortButton.classList.add('qi-table__sort'); sortButton.dataset.sortKey = column.key;
        sortButton.dataset.size = 'sm';
        sortButton.setAttribute('aria-label', `${column.label}，${active === 'asc' ? '点击降序' : active === 'desc' ? '点击取消排序' : '点击升序'}`);
        sortButton.addEventListener('click', () => { this.setSort(column.key, active === 'asc' ? 'desc' : active === 'desc' ? null : 'asc'); this._body.querySelector(`[data-sort-key="${CSS.escape(column.key)}"]`)?.focus(); }); th.append(sortButton);
      } else th.textContent = column.label;
      headerRow.append(th);
    });
    head.append(headerRow); table.append(head); const body = node('tbody');
    const cards = node('div', 'qi-table__cards'); cards.setAttribute('role', 'region'); cards.setAttribute('aria-label', config.caption);
    view.rows.forEach((row) => {
      const tr = node('tr'); const rowId = this.rowId(row); const selected = this._selected.has(rowId);
      tr.classList.toggle('qi-table__row--selected', selected);
      const card = node('article', 'qi-table__card');
      if (config.selectable) {
        const makeCheck = (location) => {
          const check = node('input'); check.type = 'checkbox'; check.checked = selected; check.dataset.rowId = rowId; check.dataset.location = location;
          check.setAttribute('aria-label', `选择 ${textValue(row[config.columns[0]?.key]) || rowId}`);
          check.addEventListener('change', () => { check.checked ? this._selected.add(rowId) : this._selected.delete(rowId); this.selectionChanged(rowId, location); }); return check;
        };
        const cell = node('td'); const hit = node('label','qi-table__select-hit'); hit.append(makeCheck('table')); cell.append(hit); tr.append(cell);
        const label = node('label', 'qi-table__card-select'); label.append(makeCheck('card'), node('span', '', '选择此项')); card.append(label);
      }
      const details = node('dl', 'qi-table__card-details');
      config.columns.forEach((column) => {
        const cell = node('td'); const dd = node('dd');
        setContent(cell, column.render ? column.render(row[column.key], row) : row[column.key]);
        setContent(dd, column.render ? column.render(row[column.key], row) : row[column.key]);
        tr.append(cell); const pair = node('div'); pair.append(node('dt', '', column.label), dd); details.append(pair);
      });
      card.append(details); cards.append(card); body.append(tr);
    });
    table.append(body); wrap.append(table); this._body.append(wrap, cards);
    const pageInfo = node('span', 'qi-muted', `第 ${view.page} / ${view.pageCount} 页`);
    const controls = node('div', 'qi-row');
    const previous = button('上一页'); const next = button('下一页'); previous.disabled = view.page <= 1; next.disabled = view.page >= view.pageCount;
    previous.dataset.pageControl = 'previous'; next.dataset.pageControl = 'next';
    const changePage = (target, direction) => { this.setPage(target); (this._footer.querySelector(`[data-page-control="${direction}"]:not(:disabled)`) || this._footer.querySelector('button:not(:disabled)') || this._body).focus(); };
    previous.addEventListener('click', () => changePage(view.page - 1, 'previous')); next.addEventListener('click', () => changePage(view.page + 1, 'next'));
    controls.append(previous, next); this._footer.append(pageInfo, controls);
    emit(this, 'viewchange', { ...view, state: this.state });
  }
  selectionChanged(rowId, location) {
    this.renderBody();
    const target = rowId === 'all' ? this._body.querySelector('thead input') : [...this._body.querySelectorAll('input[data-row-id]')].find((item) => item.dataset.rowId === rowId && item.dataset.location === location);
    target?.focus(); emit(this, 'selectionchange', { value: this.selected, rows: this._config.rows.filter((row) => this._selected.has(this.rowId(row))) });
  }
}

export class QiMultiselect extends QiElement {
  static get observedAttributes() { return ['mode', 'disabled', 'label', 'placeholder', 'searchable']; }
  attributeChangedCallback() { if (this.isConnected && this._events) this.render(); }
  constructor() { super(); this._options = []; this._value = []; this._query = ''; }
  mount() { this.classList.add('qi-multiselect'); this.render(); }
  get options() { return this._options; } set options(value) { this._options = Array.isArray(value) ? value : []; if (this.isConnected) this.render(); }
  get value() { return [...this._value]; } set value(value) { this._value = [...new Set(value || [])]; if (this.isConnected) this.render(); }
  render() {
    this._choiceResize?.disconnect();
    if (this.getAttribute('mode') === 'dropdown') { this.renderDropdown(); return; }
    this.replaceChildren();
    const fieldset = node('fieldset', 'qi-multiselect__fieldset'); fieldset.disabled = this.hasAttribute('disabled');
    fieldset.append(node('legend', 'qi-multiselect__legend', this.getAttribute('label') || this.getAttribute('aria-label') || '多项选择'));
    const selected = node('div', 'qi-multiselect__selected');
    this._value.forEach((value) => {
      const option = this._options.find((item) => sameValue(item.value, value)); if (!option) return;
      const tag = node('span', 'qi-tag'); tag.append(node('span', '', option.label));
      const remove = button('×', 'ghost'); remove.classList.add('qi-multiselect__remove'); remove.setAttribute('aria-label', `移除 ${option.label}`); remove.disabled = !!option.disabled; remove.dataset.removeValue = String(value);
      remove.addEventListener('click', () => this.update(value, false, 'remove')); tag.append(remove); selected.append(tag);
    });
    if (!selected.childElementCount) selected.append(node('span', 'qi-muted', this.getAttribute('placeholder') || '请选择，可多选'));
    fieldset.append(selected);
    const searchLabel = node('label', 'qi-multiselect__search'); searchLabel.append(node('span', 'qi-sr-only', '搜索可选项'));
    const search = node('input', 'qi-input'); search.type = 'search'; search.placeholder = '搜索选项…'; search.value = this._query;
    searchLabel.append(search); fieldset.append(searchLabel);
    const choices = node('div', 'qi-multiselect__options');
    this._count = node('p', 'qi-multiselect__count qi-muted'); this._count.setAttribute('role', 'status'); this._count.setAttribute('aria-live', 'polite');
    search.addEventListener('input', () => { this._query = search.value; this.renderChoices(choices); });
    search.addEventListener('change', (event) => event.stopPropagation());
    this.renderChoices(choices); fieldset.append(choices, this._count); this.append(fieldset);
  }
  renderChoices(choices) {
    choices.replaceChildren(); const query = fold(this._query).trim();
    const visibleOptions = this._options.filter((option) => !query || fold(option.label).includes(query));
    visibleOptions.forEach((option) => {
      const label = node('label', 'qi-multiselect__option'); const input = node('input'); input.type = 'checkbox'; input.disabled = !!option.disabled;
      input.checked = this._value.some((value) => sameValue(value, option.value)); input.dataset.optionValue = String(option.value);
      input.addEventListener('change', (event) => { event.stopPropagation(); this.update(option.value, input.checked, 'checkbox'); }); label.append(input, node('span', '', option.label)); choices.append(label);
    });
    this._count.textContent = !visibleOptions.length ? (query ? '没有匹配的选项' : '暂无选项') : `${visibleOptions.length} 个可选项 · 已选择 ${this._value.length} 项`;
  }
  update(value, checked, origin) {
    this._value = this._value.filter((item) => !sameValue(item, value)); if (checked) this._value.push(value);
    if (this.getAttribute('mode') === 'dropdown') {
      this.updateSummary(); emit(this, 'change', { value: this.value, origin }); return;
    }
    this.render(); const checkbox = [...this.querySelectorAll('[data-option-value]')].find((item) => sameValue(item.dataset.optionValue, value));
    (checkbox || this.querySelector('input[type="search"]'))?.focus(); emit(this, 'change', { value: this.value, origin });
  }
  renderDropdown() {
    const previousOpen = this._choicePopover?.open;
    const focusedValue = this.querySelector('input:focus')?.dataset.optionValue;
    this.replaceChildren();
    const label = this.getAttribute('label') || this.getAttribute('aria-label') || '多项选择';
    const popover = node('qi-popover'); popover.setAttribute('label', label);
    const trigger = button('', 'secondary'); trigger.className = 'qi-input qi-choice-trigger'; trigger.dataset.trigger = '';
    trigger.disabled = this.hasAttribute('disabled'); trigger.dataset.qiRole = 'form';
    const sizer = node('span', 'qi-choice-sizer'); sizer.setAttribute('aria-hidden', 'true');
    // All candidates reserve width; selecting another value never changes geometry.
    for (const text of [this.getAttribute('placeholder') || '请选择', `已选 ${this._options.length} 项`, ...this._options.map(o => o.label)]) sizer.append(node('span', '', text));
    this._summary = node('span', 'qi-choice-summary');
    const chevron = node('span', 'qi-choice-chevron', '⌄'); chevron.setAttribute('aria-hidden', 'true');
    trigger.append(sizer, this._summary, chevron);
    const content = node('div', 'qi-choice-panel'); content.dataset.content = '';
    const heading = node('div', 'qi-choice-heading', label);
    const choices = node('div', 'qi-multiselect__options');
    choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', label);
    content.append(heading);
    this._count = node('p', 'qi-multiselect__count qi-muted'); this._count.setAttribute('role', 'status');
    if (this.hasAttribute('searchable')) {
      const searchLabel = node('label', 'qi-multiselect__search'); searchLabel.append(node('span', 'qi-sr-only', '搜索可选项'));
      const search = node('input', 'qi-input'); search.type = 'search'; search.value = this._query;
      search.addEventListener('input', () => { this._query = search.value; this.renderChoices(choices); });
      search.addEventListener('change', e => e.stopPropagation()); searchLabel.append(search); content.append(searchLabel);
    } else this._query = '';
    this.renderChoices(choices);
    const done = button('完成', 'ghost'); done.dataset.close = '';
    const footer = node('div', 'qi-choice-footer'); footer.append(this._count, done);
    content.append(choices, footer);
    popover.append(trigger, content); this.append(popover); this._choicePopover = popover; this._choiceTrigger = trigger;
    this.updateSummary();
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); popover.show(); const items = focusable(content);
        (event.key === 'ArrowDown' ? items[0] : items.at(-1))?.focus();
      }
    });
    content.addEventListener('keydown', event => {
      const items = focusable(content), index = items.indexOf(document.activeElement);
      if (event.key === 'Tab' && event.shiftKey && index === 0) { event.preventDefault(); popover.hide(true); return; }
      if (event.key === 'Tab' && !event.shiftKey && index === items.length - 1) { popover.hide(true); return; }
      if (!document.activeElement?.matches('input[type="checkbox"]')) return;
      const inputs = [...choices.querySelectorAll('input:not(:disabled)')], current = inputs.indexOf(document.activeElement);
      let target;
      if (event.key === 'ArrowDown') target = inputs[(current + 1) % inputs.length];
      if (event.key === 'ArrowUp') target = inputs[(current - 1 + inputs.length) % inputs.length];
      if (event.key === 'Home') target = inputs[0];
      if (event.key === 'End') target = inputs.at(-1);
      if (target) { event.preventDefault(); target.focus(); }
    });
    if (typeof ResizeObserver !== 'undefined') {
      this._choiceResize = new ResizeObserver(() => {
        this.style.setProperty('--qi-choice-trigger-width', `${trigger.getBoundingClientRect().width / (trigger.currentCSSZoom || 1)}px`);
        if (popover.open) popover.position();
      });
      this._choiceResize.observe(trigger);
    }
    if (previousOpen && !trigger.disabled) {
      popover.show(); [...choices.querySelectorAll('input')].find(i => i.dataset.optionValue === focusedValue)?.focus();
    }
  }
  updateSummary() {
    const labels = this._value.map(v => this._options.find(o => sameValue(o.value, v))?.label ?? String(v));
    const summary = labels.length > 1 ? `已选 ${labels.length} 项` : labels[0] || this.getAttribute('placeholder') || '请选择';
    this._summary.textContent = summary;
    this._choiceTrigger.setAttribute('aria-label', `${this.getAttribute('label') || this.getAttribute('aria-label') || '多项选择'}：${summary}`);
    this._choiceTrigger.title = labels.join('、');
    const query = fold(this._query).trim();
    const visible = this._options.filter(o => !query || fold(o.label).includes(query)).length;
    this._count.textContent = !visible ? (query ? '没有匹配的选项' : '暂无选项') : `${visible} 个可选项 · 已选择 ${labels.length} 项`;
  }
  unmount() { this._choiceResize?.disconnect(); this._choicePopover?.hide(false); }
}

export class QiCascader extends QiElement {
  constructor() { super(); this._options = []; this._value = []; }
  mount() { this.classList.add('qi-cascader'); this.render(); }
  get options() { return this._options; } set options(value) { this._options = Array.isArray(value) ? value : []; this._value = normalizeCascadeValue(this._options, this._value); if (this.isConnected) this.render(); }
  get value() { return [...this._value]; } set value(value) { this._value = normalizeCascadeValue(this._options, value || []); if (this.isConnected) this.render(); }
  render() {
    this.replaceChildren(); const fieldset = node('fieldset', 'qi-cascader__fieldset'); fieldset.disabled = this.hasAttribute('disabled');
    fieldset.append(node('legend', 'qi-cascader__legend', this.getAttribute('label') || this.getAttribute('aria-label') || '级联选择'));
    const levels = node('div', 'qi-cascader__levels'); const options = getCascadeLevels(this._options, this._value);
    options.forEach((choices, index) => {
      const label = node('label', 'qi-cascader__level'); label.append(node('span', 'qi-sr-only', `第 ${index + 1} 级`));
      const select = node('select', 'qi-input'); select.dataset.level = index; const placeholder = node('option', '', `选择第 ${index + 1} 级`); placeholder.value = ''; select.append(placeholder);
      choices.forEach((choice, optionIndex) => { const option = node('option', '', choice.label); option.value = String(optionIndex); option.disabled = !!choice.disabled; select.append(option); });
      const selectedIndex = choices.findIndex((choice) => sameValue(choice.value, this._value[index])); select.value = selectedIndex < 0 ? '' : String(selectedIndex);
      select.addEventListener('change', (event) => {
        event.stopPropagation();
        this._value = this._value.slice(0, index); if (select.value !== '') this._value.push(choices[Number(select.value)].value);
        this.render(); this.querySelector(`[data-level="${index + 1}"]`)?.focus();
        if (!this.querySelector(`[data-level="${index + 1}"]`)) this.querySelector(`[data-level="${index}"]`)?.focus();
        const selected = this.selectedOptions(); emit(this, 'change', { value: this.value, options: selected, complete: !!selected.length && !selected.at(-1).children?.length });
      }); label.append(select); levels.append(label);
    });
    if (!options.length) levels.append(node('span', 'qi-muted', '暂无选项'));
    fieldset.append(levels);
    const selected = this.selectedOptions(); const path = node('p', 'qi-cascader__path qi-muted', selected.length ? selected.map((item) => item.label).join(' / ') : '尚未选择'); path.setAttribute('aria-live', 'polite'); fieldset.append(path); this.append(fieldset);
  }
  selectedOptions() {
    const result = []; let options = this._options;
    for (const part of this._value) { const selected = options.find((item) => sameValue(item.value, part)); if (!selected) break; result.push(selected); options = selected.children || []; }
    return result;
  }
}

export class QiUpload extends QiElement {
  constructor() { super(); this._files = []; this._rejections = []; }
  mount() {
    this.classList.add('qi-upload'); this.replaceChildren();
    const dropzone = node('div', 'qi-upload__dropzone');
    const label = node('label', 'qi-upload__label');
    label.append(node('span', 'qi-upload__title', this.getAttribute('label') || '选择文件，或拖放到这里'));
    const input = node('input', 'qi-upload__input'); input.type = 'file'; input.accept = this.getAttribute('accept') || ''; input.multiple = this.hasAttribute('multiple'); input.disabled = this.hasAttribute('disabled');
    label.append(input); dropzone.append(label);
    const max = Number(this.getAttribute('max-size')) || 0;
    dropzone.append(node('p', 'qi-muted', [input.accept ? `支持 ${input.accept}` : '支持任意文件类型', max ? `单个文件不超过 ${this.formatSize(max)}` : '', '文件仅保留在当前页面，尚未上传'].filter(Boolean).join(' · ')));
    this.listen(input, 'change', (event) => { event.stopPropagation(); this.addFiles([...input.files]); input.value = ''; });
    this.listen(dropzone, 'dragover', (event) => { event.preventDefault(); if (!input.disabled) dropzone.classList.add('qi-upload__dropzone--dragover'); });
    this.listen(dropzone, 'dragleave', () => dropzone.classList.remove('qi-upload__dropzone--dragover'));
    this.listen(dropzone, 'drop', (event) => { event.preventDefault(); dropzone.classList.remove('qi-upload__dropzone--dragover'); if (!input.disabled) this.addFiles([...event.dataTransfer.files]); });
    this.append(dropzone); this._list = node('ul', 'qi-upload__list'); this._feedback = node('div', 'qi-upload__feedback'); this._feedback.setAttribute('aria-live', 'polite'); this.append(this._list, this._feedback); this.renderFiles();
  }
  get files() { return [...this._files]; }
  addFiles(files) {
    if (this.hasAttribute('disabled')) return;
    const { accepted, rejected } = validateFiles(files, { accept: this.getAttribute('accept') || '', maxSize: Number(this.getAttribute('max-size')) || 0, multiple: this.hasAttribute('multiple') });
    if (accepted.length) {
      if (this.hasAttribute('multiple')) {
        accepted.forEach((file) => { if (!this._files.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) this._files.push(file); });
      } else this._files = accepted;
    }
    this._rejections = rejected; this.renderFiles(); emit(this, 'change', { files: this.files, rejected });
  }
  removeFile(index) { if (this.hasAttribute('disabled')) return; const removed = this._files.splice(index, 1); this.renderFiles(); this.querySelector('input[type="file"]')?.focus(); emit(this, 'change', { files: this.files, removed, rejected: [] }); }
  clear() { this._files = []; this._rejections = []; this.renderFiles(); emit(this, 'change', { files: [], rejected: [] }); }
  formatSize(size) { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
  renderFiles() {
    if (!this._list) return; this._list.replaceChildren();
    this._files.forEach((file, index) => {
      const item = node('li', 'qi-upload__file'); const info = node('span'); info.append(node('strong', '', file.name), node('small', 'qi-muted', `${this.formatSize(file.size)} · 待上传`));
      const remove = button('移除', 'ghost'); remove.disabled = this.hasAttribute('disabled'); remove.setAttribute('aria-label', `移除 ${file.name}`); remove.addEventListener('click', () => this.removeFile(index)); item.append(info, remove); this._list.append(item);
    });
    this._feedback.replaceChildren();
    this._rejections.forEach(({ file, reason }) => this._feedback.append(node('p', 'qi-upload__error', `${file.name}：${reason}`)));
    if (!this._rejections.length) this._feedback.textContent = this._files.length ? `已选择 ${this._files.length} 个文件，尚未上传` : '';
  }
}

export class QiCarousel extends QiElement {
  mount() {
    this.classList.add('qi-carousel'); this.setAttribute('role', 'region'); this.setAttribute('aria-roledescription', '轮播'); this.setAttribute('aria-label', this.getAttribute('label') || this.getAttribute('aria-label') || '内容轮播');
    this._slides = [...this.querySelectorAll('[data-slide]')]; this._index = clamp(this._index || 0, 0, Math.max(0, this._slides.length - 1));
    this._slides.forEach((slide, index) => { slide.classList.add('qi-carousel__slide'); slide.setAttribute('role', 'group'); slide.setAttribute('aria-roledescription', '幻灯片'); slide.setAttribute('aria-label', `${index + 1} / ${this._slides.length}`); });
    this.querySelector('.qi-carousel__controls')?.remove();
    const controls = node('div', 'qi-carousel__controls'); this._previous = button('← 上一张'); this._next = button('下一张 →'); this._status = node('span', 'qi-carousel__status'); this._status.setAttribute('aria-live', 'polite'); this._status.setAttribute('aria-atomic', 'true');
    this.listen(this._previous, 'click', () => this.goTo(this._index - 1)); this.listen(this._next, 'click', () => this.goTo(this._index + 1)); controls.append(this._previous, this._status, this._next); this.append(controls);
    this.listen(this, 'keydown', (event) => {
      if (event.target.matches('input,textarea,select,[contenteditable]')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.goTo(this._index + (event.key === 'ArrowLeft' ? -1 : 1)); }
    });
    this.listen(this, 'touchstart', (event) => { const touch = event.touches[0]; this._touch = touch && { x: touch.clientX, y: touch.clientY }; }, { passive: true });
    this.listen(this, 'touchend', (event) => {
      const touch = event.changedTouches[0]; if (!touch || !this._touch) return;
      const dx = touch.clientX - this._touch.x; const dy = touch.clientY - this._touch.y;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) this.goTo(this._index + (dx < 0 ? 1 : -1)); this._touch = null;
    }, { passive: true }); this.update();
  }
  get index() { return this._index || 0; } set index(value) { this.goTo(Number(value), false); }
  goTo(index, notify = true) {
    if (!this._slides) { this._index = Math.max(0, integer(index, 0)); return; }
    const next = clamp(integer(index, 0), 0, Math.max(0, this._slides.length - 1)); const changed = this._index !== next;
    this._index = next; this.update(); if (notify && changed) emit(this, 'change', { index: next });
  }
  update() {
    if (!this._slides) return;
    this._slides.forEach((slide, index) => { slide.hidden = index !== this._index; });
    this._previous.disabled = this._index <= 0; this._next.disabled = this._index >= this._slides.length - 1;
    this._status.textContent = this._slides.length ? `${this._index + 1} / ${this._slides.length}` : '暂无内容';
  }
}

export class QiContextMenu extends QiDropdown {
  mount() {
    let trigger = this.querySelector('[data-trigger]');
    if (!trigger) { trigger = button('打开操作菜单'); trigger.dataset.trigger = ''; this.append(trigger); }
    super.mount(); if (!this.content) return;
    this.classList.add('qi-context-menu'); this.target = this.querySelector('[data-context-target]') || this;
    if (!this.target.hasAttribute('tabindex')) this.target.tabIndex = 0;
    this.target.setAttribute('aria-haspopup', 'menu'); this.target.setAttribute('aria-controls', this.content.id);
    this.listen(this.target, 'contextmenu', (event) => { if (this.content.contains(event.target)) return; event.preventDefault(); this._contextOpener = document.activeElement; this.showAt(event.clientX, event.clientY); });
    this.listen(this.target, 'keydown', (event) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault(); event.stopPropagation(); const rect = this.target.getBoundingClientRect(); this._contextOpener = this.target; this.showAt(rect.left + 16, rect.top + 16);
      }
    });
    this.listen(this.trigger, 'click', () => { this._contextOpener = this.trigger; });
    this.listen(window, 'scroll', () => { if (this.open) this.hide(false); }, { capture: true });
  }
  showAt(x, y) {
    super.show(); this.content.classList.add('qi-context-menu__positioned');
    this.content.style.maxHeight = 'min(65dvh, 420px)';
    const rect = this.content.getBoundingClientRect(); this.content.style.left = `${clamp(x, 8, Math.max(8, window.innerWidth - rect.width - 8))}px`; this.content.style.top = `${clamp(y, 8, Math.max(8, window.innerHeight - rect.height - 8))}px`;
  }
  show() { this.content?.classList.remove('qi-context-menu__positioned'); if (this.content) { this.content.style.left = ''; this.content.style.top = ''; } super.show(); }
  hide(returnFocus = false) { super.hide(false); if (returnFocus) (this._contextOpener?.isConnected ? this._contextOpener : this.trigger)?.focus(); }
}

/** Persistent by default. Caller may opt into duration; hover/focus pauses dismissal. */
export function toast(message, { tone = 'info', duration = 0, title = '' } = {}) {
  if (typeof document === 'undefined') return { close() {} };
  let region = document.querySelector('[data-qi-toasts]');
  if (!region) { region = node('div', 'qi-toasts'); region.dataset.qiToasts = ''; region.setAttribute('role', 'region'); region.setAttribute('aria-label', '通知'); document.body.append(region); }
  const item = node('div', 'qi-toast'); item.dataset.tone = ['info', 'success', 'warning', 'error'].includes(tone) ? tone : 'info';
  const messageNode = node('div', 'qi-toast__message'); messageNode.setAttribute('role', tone === 'error' ? 'alert' : 'status'); messageNode.setAttribute('aria-atomic', 'true');
  const close = button('×', 'ghost'); close.classList.add('qi-toast__close'); close.setAttribute('aria-label', '关闭通知');
  const before = document.activeElement; let timer; let remaining = Math.max(0, Number(duration) || 0); let started = 0;
  const dismiss = () => { clearTimeout(timer); const hadFocus = item.contains(document.activeElement); item.remove(); if (hadFocus && before?.isConnected) before.focus(); if (!region.childElementCount) region.remove(); };
  const pause = () => { if (timer) { clearTimeout(timer); timer = null; remaining = Math.max(0, remaining - (Date.now() - started)); } };
  const resume = () => { if (remaining > 0 && !item.matches(':hover') && !item.contains(document.activeElement)) { started = Date.now(); timer = setTimeout(dismiss, remaining); } };
  close.addEventListener('click', dismiss); item.addEventListener('pointerenter', pause); item.addEventListener('pointerleave', resume); item.addEventListener('focusin', pause); item.addEventListener('focusout', () => queueMicrotask(resume));
  item.append(messageNode, close); region.append(item);
  // Populate after inserting the live region so assistive technologies announce it.
  queueMicrotask(() => { if (!item.isConnected) return; if (title) messageNode.append(node('strong', 'qi-toast__title', title)); messageNode.append(node('span', '', message)); resume(); });
  return { element: item, close: dismiss };
}

export function registerComponents(registry = globalThis.customElements) {
  if (!registry) return;
  const elements = { 'qi-tabs': QiTabs, 'qi-dialog': QiDialog, 'qi-drawer': QiDrawer, 'qi-dropdown': QiDropdown, 'qi-tooltip': QiTooltip, 'qi-popover': QiPopover, 'qi-table': QiTable, 'qi-multiselect': QiMultiselect, 'qi-cascader': QiCascader, 'qi-upload': QiUpload, 'qi-carousel': QiCarousel, 'qi-context-menu': QiContextMenu };
  Object.entries(elements).forEach(([name, component]) => { if (!registry.get(name)) registry.define(name, component); });
}
registerComponents();
