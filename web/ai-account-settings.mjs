import { icon } from './ai-icons.mjs';
import { personalFieldDefinitions, retiredPersonalFields } from '../server/ai-personal-fields.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const back = title => `<div class="ai-page-heading"><button type="button" class="quiet" data-ai-nav="settings">${icon('arrow-l')}返回系统设置</button>${title ? `<h3>${title}</h3>` : ''}</div>`;

const fieldValue = (state, field) => {
  const rows = (state.personalInformation?.entries || []).filter(entry => entry.field === field);
  return { text: rows.map(entry => entry.text).join('\n'), allowGroup: rows.length > 0 && rows.every(entry => entry.allowGroup),
    scope: rows.some(entry => entry.allowGroup) ? rows.every(entry => entry.allowGroup) ? 'group' : 'mixed' : 'private' };
};
const fieldDirty = (value, previous) => value.text.trim() !== previous.text.trim() || value.allowGroup !== previous.allowGroup || value.shareChanged && previous.scope === 'mixed';
const scopeLabel = scope => scope === 'group' ? '群聊可用' : scope === 'mixed' ? '部分内容可用于群聊' : '仅用于私聊';

function personalCard(state, field, draft) {
  const previous = fieldValue(state, field.key), value = { ...previous, ...draft?.[field.key] };
  const dirty = fieldDirty(value, previous), status = value.open ? 'editing' : dirty ? 'pending' : value.text.trim() ? 'filled' : 'empty';
  const statusLabel = { editing: '编辑中', pending: '待保存', filled: '已填写', empty: '未补充' }[status];
  const labelId = `personal-label-${field.key}`, inputId = `personal-input-${field.key}`;
  // Old entries may contain multiple lines even for a short field: keep them
  // editable in full instead of letting a single-line input erase newlines.
  const multiline = field.input !== 'short' || value.text.includes('\n') || value.text.length > 160;
  const input = multiline
    ? `<textarea id="${inputId}" name="${field.key}" data-personal-input rows="${field.rows || 3}" maxlength="2000" placeholder="${esc(field.example)}">${esc(value.text)}</textarea>`
    : `<input id="${inputId}" name="${field.key}" data-personal-input type="text" maxlength="2000" value="${esc(value.text)}" placeholder="${esc(field.example)}">`;
  const scope = dirty ? value.allowGroup ? 'group' : 'private' : previous.scope;
  return `<details class="ai-personal-card${field.wide ? ' ai-personal-wide' : ''}" data-personal-field="${field.key}" data-ai-optional="personal:${field.key}" data-state="${status}" ${value.open ? 'open' : ''} ${value.shareChanged ? 'data-personal-share-changed="true"' : ''}>
    <summary aria-labelledby="${labelId} personal-status-${field.key}"><div class="ai-personal-card-head"><strong id="${labelId}">${esc(field.label)}</strong><span class="ai-personal-status" id="personal-status-${field.key}" data-personal-status>${statusLabel}</span><span class="ai-personal-edit-label" aria-hidden="true">${value.text.trim() ? '编辑' : '补充'}${icon('chev-r')}</span></div><p class="ai-personal-preview" data-personal-preview ${value.text.trim() ? '' : 'hidden'}>${esc(value.text.trim())}</p><span class="ai-personal-scope" data-personal-scope ${value.text.trim() ? '' : 'hidden'}>${scopeLabel(scope)}</span></summary>
    <div class="ai-personal-editor"><label class="ai-field" for="${inputId}"><span class="visually-hidden">${esc(field.label)}</span>${input}</label><div class="ai-personal-input-help"><span data-personal-count aria-hidden="true">${value.text.length}/2000</span></div><label class="ai-personal-share"><input type="checkbox" data-personal-share ${value.allowGroup ? 'checked' : ''}>允许这项信息用于群聊</label></div>
  </details>`;
}

export function personalInformationPage(state, draft = {}) {
  const entries = state.personalInformation?.entries || [];
  const commonOrder = ['addressing', 'status', 'plans', 'schedule', 'boundaries', 'city', 'occupation', 'preferences', 'interests'];
  const fields = [...personalFieldDefinitions].sort((a, b) => (commonOrder.indexOf(a.key) < 0 ? Infinity : commonOrder.indexOf(a.key)) - (commonOrder.indexOf(b.key) < 0 ? Infinity : commonOrder.indexOf(b.key)));
  const suggestions = (state.personalInformation?.suggestions || []).filter(row => !retiredPersonalFields.includes(row.field)), history = state.personalInformation?.history || [];
  const filled = fields.filter(field => entries.some(entry => entry.field === field.key && entry.text.trim())).length;
  const moreFilled = fields.filter(field => field.group === 'more' && entries.some(entry => entry.field === field.key && entry.text.trim())).length;
  const progress = filled ? `<span class="ai-personal-progress">已保存 ${filled} 项</span>` : '';
  const additions = `<div class="ai-personal-additions"><details class="ai-card" data-ai-optional="personal-suggestions" ${suggestions.length ? 'open' : ''}><summary>聊天中的待确认信息 <span>${suggestions.length ? `${suggestions.length} 项待确认` : '暂无建议'}</span></summary>${suggestions.map(row => `<article class="ai-personal-suggestion"><strong>${esc(fields.find(field => field.key === row.field)?.label || '其他信息')}</strong><p>${esc(row.text)}</p><details><summary>查看原话</summary><p>${esc(row.sourceText)}</p></details><button type="button" class="secondary" data-ai-personal-suggestion="${esc(row.id)}" data-command="accept">确认采用</button><button type="button" class="quiet" data-ai-personal-suggestion="${esc(row.id)}" data-command="reject">忽略</button></article>`).join('')}</details><details class="ai-card" data-ai-optional="personal-history"><summary>我的信息历史版本 <span>${history.length ? `${history.length} 个版本` : '暂无版本'}</span></summary>${history.slice().reverse().map(row => `<p><time>${esc(new Date(row.at).toLocaleString('zh-CN'))}</time> <button type="button" class="secondary" data-ai-personal-history="${row.at}">查看并恢复</button></p>`).join('')}</details></div>`;
  return `${back('')}<form id="ai-personal-information-form" data-personal-account="${esc(state.account || '')}" class="ai-card ai-account-form ai-personal-form"><header class="ai-personal-intro"><div><h4>让回复更了解你</h4></div>${progress}</header><div class="ai-personal-section-heading"><h4>常用信息</h4></div><div class="ai-personal-fields">${fields.filter(field => field.group === 'common').map(field => personalCard(state, field, draft)).join('')}</div><details id="ai-personal-more" class="ai-personal-more" data-ai-optional="personal-more" ${draft.moreOpen ? 'open' : ''}><summary><div><strong>更多信息</strong></div><span data-personal-more-status>${moreFilled ? `已填写 ${moreFilled} 项` : '按需补充'}</span>${icon('chev-r')}</summary><div class="ai-personal-fields">${fields.filter(field => field.group === 'more').map(field => personalCard(state, field, draft)).join('')}</div></details><footer class="ai-personal-save"><span data-personal-save-status role="status"></span><button type="submit" class="primary">保存我的信息</button></footer></form>${additions}`;
}
export function personalDraftFromForm(form) {
  return Object.fromEntries([['moreOpen', form.querySelector('#ai-personal-more')?.open === true], ...[...form.querySelectorAll('[data-personal-field]')].map(section => [section.dataset.personalField,
    { text: section.querySelector('[data-personal-input]').value, allowGroup: section.querySelector('[data-personal-share]').checked, open: section.open, shareChanged: section.dataset.personalShareChanged === 'true' }])]);
}
export function updatePersonalInformationForm(form, state) {
  if (!form) return;
  let changed = 0, moreChanged = 0;
  for (const section of form.querySelectorAll('[data-personal-field]')) {
    const field = personalFieldDefinitions.find(field => field.key === section.dataset.personalField);
    const input = section.querySelector('[data-personal-input]'), share = section.querySelector('[data-personal-share]'), previous = fieldValue(state, field.key);
    const value = { text: input.value, allowGroup: share.checked, shareChanged: section.dataset.personalShareChanged === 'true' }, dirty = fieldDirty(value, previous);
    if (dirty) { changed++; if (field.group === 'more') moreChanged++; }
    section.dataset.dirty = dirty ? 'true' : 'false';
    share.indeterminate = !dirty && previous.scope === 'mixed';
    const status = section.open ? 'editing' : dirty ? 'pending' : value.text.trim() ? 'filled' : 'empty';
    section.dataset.state = status;
    section.querySelector('[data-personal-status]').textContent = { editing: '编辑中', pending: '待保存', filled: '已填写', empty: '未补充' }[status];
    const preview = section.querySelector('[data-personal-preview]');
    preview.textContent = value.text.trim(); preview.hidden = !value.text.trim();
    section.querySelector('[data-personal-count]').textContent = `${value.text.length}/2000`;
    const scope = section.querySelector('[data-personal-scope]'); scope.hidden = !value.text.trim(); scope.textContent = scopeLabel(dirty ? value.allowGroup ? 'group' : 'private' : previous.scope);
    section.querySelector('.ai-personal-edit-label').firstChild.textContent = value.text.trim() ? '编辑' : '补充';
  }
  const moreStatus = form.querySelector('[data-personal-more-status]');
  const moreFilled = personalFieldDefinitions.filter(field => field.group === 'more' && fieldValue(state, field.key).text.trim()).length;
  if (moreStatus) moreStatus.textContent = moreChanged ? `待保存 ${moreChanged} 项` : moreFilled ? `已填写 ${moreFilled} 项` : '按需补充';
  const status = form.querySelector('[data-personal-save-status]');
  status.textContent = changed ? `有 ${changed} 项修改尚未保存` : '';
  form.dataset.dirty = changed ? 'true' : 'false';
  const save = form.querySelector('button[type="submit"]');
  if (save) save.disabled = changed === 0;
}
export function personalEntriesFromForm(form, state) {
  const entries = [...form.querySelectorAll('[data-personal-field]')].filter(section => !retiredPersonalFields.includes(section.dataset.personalField)).flatMap(section => {
    const field = section.dataset.personalField, text = section.querySelector('[data-personal-input]').value.trim();
    if (!text) return [];
    const rows = (state.personalInformation?.entries || []).filter(entry => entry.field === field), allowGroup = section.querySelector('[data-personal-share]').checked;
    if (!fieldDirty({ text, allowGroup, shareChanged: section.dataset.personalShareChanged === 'true' }, fieldValue(state, field)))
      return rows.map(({ expiresAt, ...row }) => row);
    return [{ id: rows[0]?.id, field, text, allowGroup }];
  });
  return entries.concat((state.personalInformation?.entries || []).filter(row => retiredPersonalFields.includes(row.field)).map(({ expiresAt, ...row }) => row));
}
export function globalReplyStrategyPage(state) {
  const strategy = state.replyStrategy || {};
  const field = (key, label, max = 1200) => `<label class="ai-field"><span>${label}</span><textarea name="${key}" maxlength="${max}" rows="4">${esc(strategy[key])}</textarea></label>`;
  return `${back('')}<form id="ai-global-reply-form" class="ai-card ai-account-form">
    <div class="ai-card-heading"><div><h4>默认回复要求</h4><p class="ai-help">选择“使用全局策略”的联系人与群聊会跟随更新；单独设置的对象继续使用自己的策略。</p></div></div>
    ${field('replyGoal', '回复要求')}${field('boundaries', '边界与注意事项')}
    <details class="ai-optional-fields" data-ai-optional="global-facts"><summary><span>可使用的已知信息 <small>选填</small></span><span class="ai-optional-status">${strategy.facts ? '已填写' : '按需补充'}</span></summary><div class="qbx-optional-body">${field('facts', '可使用的已知信息', 4000)}</div></details>
    <footer class="qbx-form-footer"><span>保存后用于当前账号的默认回复</span><button type="submit" class="primary">保存全局策略</button></footer>
  </form>`;
}
export function objectStyleTabs(state, profile = {}) {
  return [...(state.schema?.replyPresets || []).filter(preset => !profile.hiddenStyleIds?.includes(`preset:${preset.id}`)).map(preset => ({
    id: `preset:${preset.id}`, label: profile.styleNames?.[`preset:${preset.id}`] || preset.label,
    style: profile.presetSnapshots?.[preset.id] || preset.style,
  })), ...(profile.customStyles || [])];
}
