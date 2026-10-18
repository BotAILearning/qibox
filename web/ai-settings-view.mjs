import { timingDefaults } from '../server/ai-timing-fields.mjs';
import { icon } from './ai-icons.mjs';

const entries = [
  ['global-reply', 'sliders', '全局回复策略', '设置联系人与群聊的默认回复要求'],
  ['personal-info', 'user', '我的信息', '填写自己的长期记忆与群聊分享范围'],
  ['default-style', 'sparkle', '学习默认风格', '为没有专属风格的对象设置默认口吻'],
  ['provider', 'sliders', '模型设置', '管理模型并分配给聊天类、学习分析类'],
];

const timingGroups = [
  { title: '消息合并', help: '从最后一条消息重新等待；到达整轮上限后执行。', fields: [['replyDelay', '最后一条消息后'], ['replyMaxWait', '整轮最长']] },
  { title: '分段发送间隔', help: '分段之间按最短至最长间隔发送。', fields: [['segmentDelayMin', '最短间隔'], ['segmentDelayMax', '最长间隔']] },
  { title: '延迟续聊等待', help: '续聊按最短至最长等待区间执行。', fields: [['followUpDelayMin', '最短等待'], ['followUpDelayMax', '最长等待']] },
];

const effectiveTimingSummary = timing => `消息合并：最后消息后 ${timing.replyDelay} 秒、整轮最长 ${timing.replyMaxWait} 秒；分段发送：${timing.segmentDelayMin}–${timing.segmentDelayMax} 秒；延迟续聊：${timing.followUpDelayMin}–${timing.followUpDelayMax} 秒。`;

export function timingFields(settings) {
  return timingGroups.map(group => `<fieldset class="ai-time-range qi-settings-group"><legend>${group.title}</legend><div class="ai-time-range-fields qi-setting-controls">${group.fields.map(([key, label]) => `<label class="ai-field"><span>${label}</span><span class="ai-number-unit qi-number-unit"><input name="${key}" type="number" min="0" max="86400" required value="${settings[key] ?? timingDefaults[key]}"><span>秒</span></span></label>`).join('')}</div><p class="ai-help">${group.help}</p></fieldset>`).join('');
}

export function timingEffectiveSummary(timing) {
  const effective = { ...timingDefaults, ...(timing || {}) };
  return effectiveTimingSummary(effective);
}

export function settingsPage(state) {
  const settings = state.settings || {};
  const appearance = globalThis.document?.documentElement?.dataset.qiTheme || 'system';
  const rule = settings.takeover || { enabled: true, minutes: 5 };
  return `<div class="ai-reference-settings qbx-settings-page">
    <form id="ai-takeover-form" class="ai-card ai-reference-general qbx-surface qbx-settings-group qi-settings-form">
      <h4>通用行为</h4>
      <label class="ai-field">外观<select name="appearance">${[['system','跟随系统'],['light','浅色'],['dark','暗色']].map(([value,label])=>`<option value="${value}" ${appearance === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="ai-switch-row qbx-setting-row"><span>AI 总开关<small>关闭后暂停回复与主动聊天，自动学习由下方独立开关控制。</small></span><input type="checkbox" name="master" role="switch" class="qbx-switch" aria-label="AI 总开关" ${settings.enabled ? 'checked' : ''}></div>
      <div class="ai-switch-row qbx-setting-row"><span>自动学习<small>从聊天中自动更新我的信息、聊天风格和聊天记忆。关闭后停止学习，已保存内容仍可用于回复。</small></span><input type="checkbox" name="autoLearning" role="switch" class="qbx-switch" aria-label="自动学习" ${settings.autoLearning ? 'checked' : ''}></div>
      <div class="ai-setting-group qi-settings-group"><h5>回复快慢</h5><div class="ai-timing-fields qi-setting-controls">${timingFields(settings)}</div><p class="ai-effective-note qi-setting-effective" data-effective-timing>当前执行值：${effectiveTimingSummary(settings)}</p></div>
      <section class="ai-takeover-settings qi-setting-dependent"><div class="ai-switch-row qbx-setting-row qi-setting-row ai-takeover-switch"><span class="qi-setting-copy">人工接管后自动恢复<small>手动回复后，从对方下一条新消息开始独立计时。</small></span><input type="checkbox" name="enabled" role="switch" class="qbx-switch" aria-label="人工接管后自动恢复" ${rule.enabled ? 'checked' : ''}></div><div data-takeover-minutes ${rule.enabled ? '' : 'hidden'}><label class="ai-field">恢复等待时长<span class="ai-number-unit qi-number-unit"><input name="minutes" type="number" min="1" max="10080" required value="${Number(rule.minutes) || 5}" ${rule.enabled ? '' : 'disabled'}><span>分钟</span></span></label></div><p class="ai-effective-note" data-effective-takeover>当前执行值：${rule.enabled ? `开启，${Number(rule.minutes) || 5} 分钟` : '关闭'}。</p><p class="ai-help">你手动回复后，从对方下一条新消息开始独立计时；同轮后续来信不延长等待，不受消息合并和发送间隔影响。</p></section>
      <p class="ai-help">关闭等待后，手动回复会关闭对应联系人的自动回复开关；群聊会关闭该群的自动回复触发开关。其他联系人不受影响。</p>
      <div class="ai-switch-row qbx-setting-row"><span>被问及身份时承认 AI<small>开启后，仅被询问时说明由 AI 回复。</small></span><input type="checkbox" name="acknowledgeAI" role="switch" class="qbx-switch" aria-label="被问及身份时承认 AI" ${settings.acknowledgeAI ? 'checked' : ''}></div>
      <footer><span>修改后点击保存生效</span><button class="primary" type="submit">保存设置</button></footer>
    </form>
    <section class="ai-card qbx-settings-config qi-settings-group" aria-labelledby="ai-settings-config-title">
      <div class="ai-card-heading"><div><h4 id="ai-settings-config-title">回复配置</h4><p class="ai-help">按需调整账号资料、默认策略与模型</p></div></div>
      <div class="ai-reference-settings-entries qbx-settings-links">${entries.map(([page, glyph, title, hint]) => `<button type="button" class="ai-settings-entry" data-ai-nav="${page}"><span class="ai-settings-entry-icon">${icon(glyph)}</span><span class="ai-settings-entry-text"><strong>${title}</strong><small>${hint}</small></span><span class="ai-settings-entry-arrow">${icon('chev-r')}</span></button>`).join('')}</div>
    </section>
  </div>`;
}
