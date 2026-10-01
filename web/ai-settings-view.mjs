import { icon } from './ai-icons.mjs';

const entries = [
  ['global-reply', 'sliders', '全局回复策略', '设置联系人与群聊的默认回复要求'],
  ['personal-info', 'user', '我的信息', '填写自己的长期记忆与群聊分享范围'],
  ['default-style', 'sparkle', '学习默认风格', '为没有专属风格的对象设置默认口吻'],
  ['provider', 'sliders', '模型设置', '管理模型并分配给聊天类、学习分析类'],
];

export function settingsPage(state) {
  const settings = state.settings || {};
  const rule = settings.takeover || { enabled: true, minutes: 5 };
  return `<div class="ai-reference-settings qbx-settings-page">
    <form id="ai-takeover-form" class="ai-card ai-reference-general qbx-surface qbx-settings-group">
      <h4>通用行为</h4>
      <div class="ai-switch-row qbx-setting-row"><span>AI 总开关<small>关闭后暂停当前账号的 AI 辅助功能。</small></span><input type="checkbox" name="master" role="switch" class="qbx-switch" aria-label="AI 总开关" ${settings.enabled ? 'checked' : ''}></div>
      <div class="ai-switch-row qbx-setting-row"><span>开启 AI 辅助等待<small>手动回复后，从对方下一条消息开始等待；同一轮后续消息不延长等待。</small></span><input type="checkbox" name="enabled" role="switch" class="qbx-switch" aria-label="开启 AI 辅助等待" ${rule.enabled ? 'checked' : ''}></div>
      <div data-takeover-minutes ${rule.enabled ? '' : 'hidden'}><label class="ai-field">等待时长（分钟）<input name="minutes" type="number" min="1" max="10080" required value="${Number(rule.minutes) || 5}" ${rule.enabled ? '' : 'disabled'}></label></div>
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
