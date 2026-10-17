import { timingDefaults, timingLabels } from '../server/ai-timing-fields.mjs';
import { icon } from './ai-icons.mjs';

const entries = [
  ['global-reply', 'sliders', '全局回复策略', '设置联系人与群聊的默认回复要求'],
  ['personal-info', 'user', '我的信息', '填写自己的长期记忆与群聊分享范围'],
  ['default-style', 'sparkle', '学习默认风格', '为没有专属风格的对象设置默认口吻'],
  ['provider', 'sliders', '模型设置', '管理模型并分配给聊天类、学习分析类'],
];

export function settingsPage(state) {
  const settings = state.settings || {};
  const appearance = globalThis.document?.documentElement?.dataset.qiTheme || 'system';
  const rule = settings.takeover || { enabled: true, minutes: 5 };
  return `<div class="ai-reference-settings qbx-settings-page">
    <form id="ai-takeover-form" class="ai-card ai-reference-general qbx-surface qbx-settings-group">
      <h4>通用行为</h4>
      <label class="ai-field">外观<select name="appearance">${[['system','跟随系统'],['light','浅色'],['dark','暗色']].map(([value,label])=>`<option value="${value}" ${appearance === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="ai-switch-row qbx-setting-row"><span>AI 总开关<small>关闭后暂停回复与主动聊天，自动学习由下方独立开关控制。</small></span><input type="checkbox" name="master" role="switch" class="qbx-switch" aria-label="AI 总开关" ${settings.enabled ? 'checked' : ''}></div>
      <div class="ai-switch-row qbx-setting-row"><span>自动学习<small>从聊天中自动更新我的信息、聊天风格和聊天记忆。关闭后停止学习，已保存内容仍可用于回复。</small></span><input type="checkbox" name="autoLearning" role="switch" class="qbx-switch" aria-label="自动学习" ${settings.autoLearning ? 'checked' : ''}></div>
      <div class="ai-switch-row qbx-setting-row"><span>人工接管后自动恢复<small>手动回复后，从对方下一条消息开始等待；同一轮后续消息不延长等待。</small></span><input type="checkbox" name="enabled" role="switch" class="qbx-switch" aria-label="人工接管后自动恢复" ${rule.enabled ? 'checked' : ''}></div>
      <div class="ai-timing-fields">${Object.entries(timingLabels).map(([key, label]) => `<label class="ai-field">${label}<input name="${key}" type="number" min="0" max="86400" required value="${settings[key] ?? timingDefaults[key]}"></label>`).join('')}</div><p class="ai-help">消息合并按最后一条消息计时，达到整轮最长等待即处理；人工接管独立计时。群聊实时参与与回复快慢分别设置。</p><div data-takeover-minutes ${rule.enabled ? '' : 'hidden'}><label class="ai-field">等待时长（分钟）<input name="minutes" type="number" min="1" max="10080" required value="${Number(rule.minutes) || 5}" ${rule.enabled ? '' : 'disabled'}></label></div>
      <p class="ai-help">关闭等待后，手动回复会关闭对应联系人的自动回复开关；群聊会关闭该群的自动回复触发开关。其他联系人不受影响。</p>
      <div class="ai-switch-row qbx-setting-row"><span>被问及身份时承认 AI<small>开启后，仅被询问时说明由 AI 回复。</small></span><input type="checkbox" name="acknowledgeAI" role="switch" class="qbx-switch" aria-label="被问及身份时承认 AI" ${settings.acknowledgeAI ? 'checked' : ''}></div>
      <footer><span>修改后点击保存生效</span><button class="primary" type="submit">保存设置</button></footer>
    </form>
    <section class="ai-card qbx-settings-config" aria-labelledby="ai-settings-config-title">
      <div class="ai-card-heading"><div><h4 id="ai-settings-config-title">回复配置</h4><p class="ai-help">按需调整账号资料、默认策略与模型</p></div></div>
      <div class="ai-reference-settings-entries qbx-settings-links">${entries.map(([page, glyph, title, hint]) => `<button type="button" class="ai-settings-entry" data-ai-nav="${page}"><span class="ai-settings-entry-icon">${icon(glyph)}</span><span class="ai-settings-entry-text"><strong>${title}</strong><small>${hint}</small></span><span class="ai-settings-entry-arrow">${icon('chev-r')}</span></button>`).join('')}</div>
    </section>
  </div>`;
}
