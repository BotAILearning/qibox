import { icon } from './ai-icons.mjs';
import { keyIcon } from './ai-key-icon.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
const features = [
  { key: 'chat', label: '聊天类', hint: '自动回复和主动聊天' },
  { key: 'learningAnalysis', label: '学习分析类', hint: '学习风格和记忆、分析报告' },
];
function modelsFor(state, draft) {
  if (draft?.models) return draft.models;
  if (state.models?.length) return state.models;
  if (state.provider) return [{ id: 'legacy', label: state.provider.model, baseUrl: state.provider.baseUrl, model: state.provider.model, protocol: state.provider.protocol || 'openai', timeout: state.provider.timeout, consent: state.provider.consent, hasKey: state.provider.hasKey, tested: state.provider.tested, usedBy: features.map(f => f.key) }];
  return [];
}
function assignmentsFor(state, draft) {
  if (draft?.assignments) return draft.assignments;
  if (state.assignments && Object.values(state.assignments).some(Boolean)) return state.assignments;
  const first = modelsFor(state, null)[0]?.id || null;
  return { chat: first, learningAnalysis: first };
}
function assignedModel(models, assignments, key) {
  return models.find(m => m.id === assignments[key]) || null;
}
function modelItem(m, assignments, selected) {
  const used = features.filter(f => assignments[f.key] === m.id);
  return `<article class="ai-model-item${selected ? ' selected' : ''}">
    <div class="ai-model-item-main">
      <div class="ai-model-item-title"><strong>${esc(m.model)}</strong><span class="ai-badge ${m.tested ? 'blue' : 'muted'}">${m.tested ? '已验证' : '未测试'}</span></div>
      <small title="${esc(m.baseUrl)}">${esc(m.model)} · ${esc(m.baseUrl)}</small>
      ${used.length ? `<small class="ai-model-usedby">用于：${used.map(f => f.label).join('、')}</small>` : '<small class="ai-model-usedby">未分配功能</small>'}
    </div>
    <div class="ai-model-item-actions">
      <button type="button" class="icon-button" data-ai-model-edit="${esc(m.id)}" title="编辑" aria-label="编辑${esc(m.model)}">${icon('edit')}</button>
      <button type="button" class="icon-button" data-ai-model-test="${esc(m.id)}" title="测试连接" aria-label="测试连接${esc(m.model)}">${icon('link')}</button>
      <button type="button" class="icon-button" data-ai-model-apply="${esc(m.id)}" title="应用于所有功能" aria-label="将${esc(m.model)}应用于所有功能">${icon('layers')}</button>
      <button type="button" class="icon-button danger" data-ai-model-delete="${esc(m.id)}" title="删除" aria-label="删除${esc(m.model)}">${icon('trash')}</button>
    </div>
  </article>`;
}
function editorCard(state, draft, presets) {
  const f = draft.form || {};
  const preset = presets.find(x => x.id === f.preset) || (f.baseUrl && presets.find(x => x.baseUrl === f.baseUrl && x.protocol === (f.protocol || 'openai')));
  const keyStored = !!f.keyStored;
  return `<form id="ai-model-form" class="ai-card ai-model-editor" data-model-id="${esc(draft.editing)}">
  <div class="ai-card-heading"><h4>${draft.editing === 'new' ? '添加模型' : '编辑模型'}</h4><button type="button" class="quiet" data-ai-action="model-cancel">${icon('arrow-l')}返回模型列表</button></div>
  <div class="ai-form-grid"><label class="ai-field">模型服务<select id="ai-model-preset">${presets.map(x => option(x.id, x.label, x.id === f.preset)).join('')}${option('custom', '自定义服务', !f.preset)}</select></label><label class="ai-field">接口类型<select name="protocol">${option('openai', 'OpenAI 兼容', (f.protocol || 'openai') !== 'anthropic')}${option('anthropic', 'Anthropic Messages', f.protocol === 'anthropic')}</select></label></div>
  <label class="ai-field">服务地址<input name="baseUrl" type="url" required value="${esc(f.baseUrl || '')}" placeholder="https://你的服务地址/v1" autocomplete="off"></label>
  <div class="ai-field"><label for="ai-api-key">API Key</label><div class="ai-key-field"><input id="ai-api-key" name="apiKey" type="password" maxlength="2048" value="${keyStored ? '********' : esc(f.apiKey || '')}" data-key-stored="${keyStored}" placeholder="输入服务商提供的密钥" autocomplete="new-password" autocapitalize="none" spellcheck="false"><button type="button" class="ai-key-eye" data-ai-action="toggle-key" aria-label="展示 API Key" aria-controls="ai-api-key" aria-pressed="false">${keyIcon(false)}</button></div></div>
  <div class="ai-field"><label for="ai-model-choice">选择模型</label><div class="ai-model-picker"><select id="ai-model-choice">${option('', '手动填写模型名称', !f.model)}${[...new Set([f.model, ...(preset?.models || [])].filter(Boolean))].map(x => option(x, x, x === f.model)).join('')}</select><button type="button" class="secondary" data-ai-action="models">${icon('refresh')}拉取支持的模型</button></div><p id="ai-model-status" class="ai-help" role="status"></p></div>
  <div class="ai-form-grid ai-model-fields"><label class="ai-field">模型名称<input name="model" required maxlength="160" value="${esc(f.model || '')}" placeholder="填写服务商提供的完整模型名称"></label><label class="ai-field">响应超时（秒）<input name="timeout" type="number" min="10" max="120" value="${f.timeout || 60}"></label></div>
  <label class="ai-check"><input name="consent" type="checkbox" required ${f.consent ? 'checked' : ''}><span>同意将选定聊天发送至此模型服务，用于学习风格、生成回复和分析报告。</span></label>
  <div class="ai-provider-footer"><p id="ai-provider-status" class="ai-help">${esc(draft.status || '填写完成后可测试连接；保存模型后到功能分配中点击“保存”生效')}</p><button type="button" class="secondary" data-ai-action="test">${icon('link')}测试连接</button><button class="primary" type="submit">${icon('check')}保存模型</button></div></form>`;
}
function assignmentCard(state, draft, models, assignments) {
  return `<section class="ai-card ai-assignment-card">
  <div class="ai-card-heading"><h4>功能分配</h4><span class="ai-help">按功能选择使用的模型，保存后生效</span></div>
  <div class="ai-assignment-rows">${features.map(f => {
    const m = assignedModel(models, assignments, f.key);
    return `<div class="ai-assignment-row">
      <div class="ai-assignment-label"><strong>${f.label}</strong><small>${f.hint}</small></div>
      <select data-ai-assignment="${f.key}" aria-label="${f.label}使用的模型">${models.map(x => option(x.id, x.model, x.id === assignments[f.key])).join('')}</select>
      <span class="ai-badge ${m?.tested ? 'blue' : 'muted'}">${m ? (m.tested ? '已验证' : '未测试') : '未分配'}</span>
    </div>`;
  }).join('')}</div>
  <div class="ai-model-save"><p class="ai-help">${esc(draft?.status || '更改模型或分配后需点击“保存”才生效；修改模型配置后需重新测试连接。')}</p><button type="button" class="primary" data-ai-action="models-save">${icon('check')}保存</button></div></section>`;
}
export function providerPage(state, draft, { back = '' } = {}) {
  const models = modelsFor(state, draft);
  const assignments = assignmentsFor(state, draft);
  const savedAssignments = assignmentsFor(state, null);
  const presets = state.schema?.providerPresets || [];
  const editing = draft?.editing;
  const badge = models.length ? `<span class="ai-badge ${models.some(m => m.tested) ? 'blue' : 'muted'}">${models.length} 个模型${models.some(m => m.tested) ? ' · 已配置' : ' · 待测试'}</span>` : '<span class="ai-badge muted">尚未配置</span>';
  return `<div class="ai-page-heading ai-provider-page-heading"><div>${back}<h3>模型设置</h3><p>为聊天类和学习分析类分别选择模型；第一个添加的模型默认应用于全部功能。</p></div>${badge}</div>
  <div class="ai-model-workspace">
    <aside class="ai-model-sidebar${editing ? ' ai-model-editing' : ''}">${editing ? editorCard(state, draft, presets) : `<button type="button" class="secondary ai-model-add" data-ai-action="model-add">${icon('plus')}添加模型</button>
      <div class="ai-model-list" role="list" aria-label="已配置模型">${models.length ? models.map(m => modelItem(m, savedAssignments, draft?.editing === m.id)).join('') : '<p class="ai-help ai-model-empty">还没有模型，点击“添加模型”创建第一个。</p>'}</div>
      <p class="ai-help">API Key 加密保存；删除模型不影响其他已保存的模型。</p>`}</aside>
    ${assignmentCard(state, draft, models, assignments)}
  </div>`;
}
