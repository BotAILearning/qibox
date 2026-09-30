import { icon } from './ai-icons.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const back = title => `<div class="ai-page-heading"><button type="button" class="quiet" data-ai-nav="settings">${icon('arrow-l')}返回系统设置</button><h3>${title}</h3></div>`;

export function personalInformationPage(state) {
  const entries = state.personalInformation?.entries || [];
  const fields = state.personalFields || [];
  const suggestions = state.personalInformation?.suggestions || [], history = state.personalInformation?.history || [];
  const additions = `<section class="ai-card"><h4>聊天中的待确认信息</h4><p class="ai-help">来自你自己写出的聊天消息，确认后才会使用；已有信息需由你确认替换。</p>${suggestions.map(row => `<article class="ai-personal-suggestion"><strong>${esc(fields.find(([key]) => key === row.field)?.[1] || '其他信息')}</strong><p>${esc(row.text)}</p><details><summary>查看原话</summary><p>${esc(row.sourceText)}</p></details><button type="button" class="secondary" data-ai-personal-suggestion="${esc(row.id)}" data-command="accept">确认采用</button><button type="button" class="quiet" data-ai-personal-suggestion="${esc(row.id)}" data-command="reject">忽略</button></article>`).join('') || '<p class="ai-help">暂无待确认建议</p>'}</section><details class="ai-card"><summary>我的信息历史版本</summary>${history.slice().reverse().map(row => `<p><time>${esc(new Date(row.at).toLocaleString('zh-CN'))}</time> <button type="button" class="secondary" data-ai-personal-history="${row.at}">查看并恢复</button></p>`).join('') || '<p>暂无历史版本</p>'}</details>`;
  return `${back('我的信息')}<form id="ai-personal-information-form" class="ai-card ai-account-form"><p class="ai-help">这里记录你自己的信息，回复时作为长期记忆使用。你填写的内容优先；未填写的经历、日程和状态不会由 AI 补造。群聊只使用你勾选允许分享的内容。</p><div class="ai-personal-fields">${fields.map(([field, label]) => {
    const rows = entries.filter(entry => entry.field === field), row = rows[0];
    return `<section data-personal-field="${field}"><label class="ai-field"><span>${esc(label)}</span><textarea name="${field}" maxlength="2000" rows="2" placeholder="选填">${esc(rows.map(entry => entry.text).join('\n'))}</textarea></label><div class="ai-personal-field-options"><label><input type="checkbox" data-personal-share ${rows.some(entry => entry.allowGroup) ? 'checked' : ''}>允许在群聊中使用</label><label>有效至 <input type="date" data-personal-expiry value="${row?.expiresAt ? new Date(row.expiresAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : ''}"></label></div></section>`;
  }).join('')}</div><footer class="ai-actions"><span>保存后应用于当前账号的聊天回复</span><button type="submit" class="primary">保存我的信息</button></footer></form>${additions}`;
}
export function personalEntriesFromForm(form, state) {
  return [...form.querySelectorAll('[data-personal-field]')].flatMap(section => {
    const field = section.dataset.personalField, text = section.querySelector('textarea').value.trim();
    if (!text) return [];
    const date = section.querySelector('[data-personal-expiry]').value;
    return [{ id: state.personalInformation?.entries?.find(entry => entry.field === field)?.id, field, text,
      allowGroup: section.querySelector('[data-personal-share]').checked,
      expiresAt: date ? Date.parse(`${date}T23:59:59+08:00`) : null }];
  });
}
export function globalReplyStrategyPage(state) {
  const strategy = state.replyStrategy || {};
  return `${back('全局回复策略')}<form id="ai-global-reply-form" class="ai-card ai-account-form"><p class="ai-help">作为当前账号的默认回复策略。选择“使用全局策略”的联系人与群聊会跟随更新；单独设置的对象继续使用自己的策略。</p>${[['replyGoal','回复要求',1200],['facts','可使用的已知信息',4000],['boundaries','边界与注意事项',1200]].map(([field,label,max]) => `<label class="ai-field"><span>${label}</span><textarea name="${field}" maxlength="${max}" rows="4">${esc(strategy[field])}</textarea></label>`).join('')}<footer class="ai-actions"><button type="submit" class="primary">保存全局策略</button></footer></form>`;
}
export function objectStyleTabs(state, profile = {}) {
  return [...(state.schema?.replyPresets || []).filter(preset => !profile.hiddenStyleIds?.includes(`preset:${preset.id}`)).map(preset => ({
    id: `preset:${preset.id}`, label: profile.styleNames?.[`preset:${preset.id}`] || preset.label,
    style: profile.presetSnapshots?.[preset.id] || preset.style,
  })), ...(profile.customStyles || [])];
}
