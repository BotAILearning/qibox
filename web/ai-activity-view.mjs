import { beijingTime } from './ai-proactive-view.mjs';
import { errorRecordList } from './ai-error-view.mjs';
import { contactName, contactSearch } from './ai-contact-name.mjs';
import { contactPickerAvatar } from './ai-contact-picker.mjs';
import { replyRecordCards } from './ai-reply-records-view.mjs';
import { replyFlowMarkup } from './ai-reply-flow-view.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const within = (at, filters) => {
  if (!filters.from && !filters.to) return true;
  const day = at ? new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '';
  return !!day && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
};
export function activityEntries(state, filters = {}, records = []) {
  return ((filters.source === 'unknown' ? state.activityHistory : state.activity) || []).map(p => {
    const times = p.replySentTimes || p.sentTimes || (p.hasSent ? [p.at] : []);
    const hasSent = !!p.hasSent && (p.hasUndatedSent || times.some(at => within(at, filters)));
    const needsHelp = !!p.needsHelp && within(p.helpAt ?? p.at, filters);
    return { ...p, hasSent: filters.code === 'help' ? false : hasSent, needsHelp: filters.code === 'sent' ? false : needsHelp };
  }).filter(p => {
    return (p.hasSent || p.needsHelp) &&
      (!filters.query || `${contactSearch(p)} ${(records.find(record => record.id === p.id)?.messages || []).map(message => message.text || '').join(' ')}`.normalize('NFKC').toLocaleLowerCase().includes(filters.query.normalize('NFKC').toLocaleLowerCase())) &&
      (!filters.kind || p.kind === filters.kind) && (!filters.code || (filters.code === 'help' ? p.needsHelp : p.hasSent));
  });
}
export function activityRows(state, filters, records, loading, summaryResults) {
  return replyRecordCards(state, filters, records, loading, activityEntries, summaryResults);
}
export function skipRecordEntries(state) {
  const merged = new Map();
  for (const event of (state.skipRecords ?? (state.events || []).filter(row => row.code === 'skip'))) merged.set(event.id || `${event.target || ''}:${event.at}`, event);
  return [...merged.values()].sort((a, b) => b.at - a.at);
}
export function updateActivityCounts(root, state, filters = {}, records = []) {
  const reply = root.querySelector('[data-ai-record-count="reply"]');
  if (reply) reply.textContent = `自动回复（${activityEntries(state, filters, records).length}）`;
  const skip = root.querySelector('[data-ai-record-count="skip"]');
  if (skip) skip.textContent = `未回复（${skipRecordEntries(state).length}）`;
}
export function activityPagination(state, filters = {}, records = []) {
  const entries = activityEntries(state, filters, records), pages = Math.max(1, Math.ceil(entries.length / 25));
  const page = Math.min(Number(filters.page) || 0, pages - 1);
  return `<span>第 ${page + 1} / ${pages} 页 · 共 ${entries.length} 位</span><div class="ai-actions"><button class="secondary" type="button" data-ai-log-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><button class="secondary" type="button" data-ai-log-page="${page + 1}" ${page + 1 >= pages ? 'disabled' : ''}>下一页</button></div>`;
}
export function proactiveRecordEntries(state, filters = {}) {
  return (state.proactiveRecords || []).filter(r => (!filters.taskId || r.taskId === filters.taskId) && within(r.at, filters) &&
    (!filters.query || `${contactSearch(r)} ${r.text || ''}`.normalize('NFKC').toLocaleLowerCase().includes(filters.query.normalize('NFKC').toLocaleLowerCase())) &&
    (!filters.kind || filters.kind === 'person') && (!filters.code || (filters.code === 'sent' ? ['sent', 'done'].includes(r.status) : ['failed', 'uncertain', 'unknown', 'not-sent'].includes(r.status))));
}
export function proactiveRecordRows(state, filters = {}, loading = false) {
  const records = proactiveRecordEntries(state, filters), labels = { sent: '已发送', done: '已发送', failed: '执行失败', uncertain: '发送结果未知', unknown: '发送结果未知', reviewed: '已结束，不补发', 'not-sent': '未发送', pending: '待执行', generating: '正在生成', sending: '发送中', paused: '已暂停', skipped: '已跳过', cancelled: '已取消' };
  return `<div class="ai-review-record-list">${records.map((r, index) => {
    const profileId = r.profileId || state.profiles?.find(p => p.contact === r.contact)?.id, profile = state.profiles?.find(p => p.id === profileId);
    const contact = state.contacts?.find(c => c.id === r.contact || c.id === profile?.contact);
    const identity = `${contactPickerAvatar(contact, index, 'ai-reply-record-avatar')}<span class="ai-review-record-person-copy"><strong class="ai-record-contact-name">${contactName(r, contact) || esc(r.contact || '联系人')}</strong><small>联系人</small></span>`;
    const person = profileId ? `<button type="button" class="ai-record-contact-link" data-ai-open-conversation="${esc(profileId)}" aria-label="打开${esc(r.label || contact?.label || '联系人')}的微信聊天">${identity}</button>` : `<span class="ai-record-contact-link">${identity}</span>`;
    return `<article class="ai-review-record-card ai-proactive-record-card" data-proactive-record="${esc(r.id)}" data-ai-record-menu="${esc(r.id)}" data-ai-record-menu-source="proactive"><header class="ai-review-record-head"><div class="ai-review-record-identity"><p class="ai-review-record-task"><small>任务</small><strong>${esc(r.taskName || '历史任务')}</strong></p>${person}</div><div class="ai-reply-record-time"><small>最近执行时间</small><time>${esc(beijingTime(r.at))}</time></div></header><section class="ai-review-record-content ai-review-record-execution" aria-label="本次执行内容"><div class="ai-review-record-status"><span class="ap-record-status ${esc(r.status)}">${esc(labels[r.status] || '状态待更新')}</span>${r.segmentsTotal ? `<small>已确认 ${r.segmentsSent || 0}/${r.segmentsTotal} 段</small>` : ''}</div>${r.text ? `<p class="ap-record-text">${esc(r.text)}</p>` : `<p class="ai-help">${r.bodyUnavailable ? '正文暂时无法读取。' : '无可展示正文'}</p>`}${r.reason ? `<p class="ai-help">${esc(r.reason)}</p>` : ''}</section></article>`;
  }).join('') || `<div class="ap-empty">${loading ? '正在读取主动聊天记录…' : '已加载范围内暂无符合条件的主动聊天记录'}</div>`}</div><footer class="ap-record-footer"><span>已加载 ${state.proactiveRecords?.length || 0} 条，当前筛选显示 ${records.length} 条</span>${state.proactiveRecordsPage?.hasMore ? `<button class="secondary" type="button" data-proactive-record-more ${loading ? 'disabled' : ''}>${loading ? '正在读取…' : '加载更早记录'}</button>` : '<span>当前加载范围已到末尾</span>'}</footer>`;
}
export function liveActivityBox(state) {
  const live = (state.live || []).filter(row => ['waiting', 'summarizing', 'requesting', 'generating', 'sending', 'confirming', 'failed'].includes(row.phase));
  if (!live.length) return '';
  return `<details class="ap-record-live qbx-record-section" data-ai-optional="activity-live"><summary><h4>实时状态</h4></summary><div class="qbx-record-section-body"><ul>${live.map(x => {
    const profile = (state.profiles || []).find(profile => profile.id === x.id);
    const flow = replyFlowMarkup(profile, x, { allowSkip: !!(profile && state.settings?.enabled && state.settings?.reply && state.waiting !== true && !profile.paused) });
    return `<li><i class="ai-live-dot ${esc(x.phase)}"></i><div><strong>${contactName(x)}</strong>${flow || `：${esc(x.reason || '等待处理')}`}</div></li>`;
  }).join('')}</ul></div></details>`;
}
export function recentErrorsBox(state, open = false, loading = false, expanded = []) {
  // 异常全部保留、按页加载：标题是总数，列表是当前已加载的部分，翻页按钮拉更早的。
  const errors = state.recentErrors || [], page = state.errorsPage || {};
  // 总数取服务端给的与已加载条数的较大值：老版本服务端还没带 errorsPage 时也能正常显示。
  const total = Math.max(Number(page.total) || 0, errors.length);
  const hasMore = !!page.hasMore || errors.length < total;
  return `<details class="ap-record-errors qbx-record-section"${open ? ' open' : ''}><summary><h4>最近异常（${total}）</h4></summary><div class="qbx-record-section-body"><div class="qbx-record-section-tools"><span>查看操作异常、当时证据与处理结果</span><button type="button" class="secondary danger-link" data-ai-clear-errors>清空异常</button></div>${errorRecordList(errors, expanded)}<footer class="ap-record-footer"><span>已加载 ${errors.length} / ${total} 条</span>${hasMore ? `<button class="secondary" type="button" data-ai-error-more ${loading ? 'disabled' : ''}>${loading ? '正在读取…' : '加载更早异常'}</button>` : '<span>已全部加载</span>'}</footer></div></details>`;
}
export function skipRecordsView(state) {
  const profiles = new Map((state.profiles || []).map(profile => [profile.id, profile]));
  const expanded = new Set(state.skipMessageExpanded || []);
  const merged = new Map();
  for (const event of (state.skipRecords ?? (state.events || []).filter(row => row.code === 'skip'))) merged.set(event.id || `${event.target || ''}:${event.at}`, event);
  const reasonLabels = { 'group-trigger-missing': '来信未满足已开启的群聊回复条件', 'group-at-others': '消息仅 @ 其他成员，本轮不参与', 'group-mentions-unverified': '无法确认消息的 @ 对象，本轮未自动回复', 'group-at-me-disabled': '该群未开启 @我时回复', 'group-at-all-disabled': '该群未开启 @所有人时回复', 'group-realtime-disabled': '该群未开启实时回复', 'explicit-question-no-response': '明确提问重试后仍未生成文字回复；新来信仍可处理', 'unsupported-media': '当前内容无法安全处理', 'identity-rule-block': '回复内容未通过身份规则', 'unverified-execution': '回复声称执行了未核实的操作', 'model-no-reply': '模型判断本轮无需回复' };
  const rows = [...merged.values()].sort((a, b) => b.at - a.at).map((event, index) => {
    const profile = profiles.get(event.target), contact = (state.contacts || []).find(c => c.id === profile?.contact);
    const name = contactName(profile, contact) || '联系人';
    const source = `${({ 'model-skip': '模型判断', 'system-skip': '系统拦截' })[event.source] || '旧记录'}${event.trigger ? ` · ${{ reply: '私聊', atMe: '@我', atAll: '@所有人', realtime: '群聊实时', proactive: '主动聊天' }[event.trigger] || event.trigger}` : ''}`;
    const reason = reasonLabels[event.reasonCode] || (event.reasonCode ? '系统跳过本次回复' : '历史记录未保存具体原因');
    const marking = event.markingForReply === true, marked = event.markedForReply === true;
    const markText = marked ? '已标记' : marking ? '正在标记…' : '需回复';
    const markHint = marked ? '已暂存，将在下一次自动回复前总结；此操作不会立即发送消息。' : event.markReplyError || '';
    const incoming = Array.isArray(event.incomingMessages) ? event.incomingMessages : [];
    const senderOf = message => message.senderName || (profile?.kind === 'person' ? profile.label : '') || (message.senderId ? `群成员（${String(message.senderId).slice(0, 8)}）` : '发送者暂不可读取');
    const bodyOf = message => {
      const media = { image: '图片', voice: '语音', video: '视频', file: '文件', sticker: '表情', emoji: '表情', link: '链接', system: '系统消息' }[message.type];
      return message.text || (media ? `[${media}]` : '消息正文暂不可读取');
    };
    const messageList = incoming.map(message => {
      return `<div class="ai-skip-message"><strong class="ai-skip-sender">${esc(senderOf(message))}</strong>${message.timestamp ? `<time>${esc(beijingTime(message.timestamp * 1000))}</time>` : ''}<p class="ap-record-text">${esc(bodyOf(message))}</p>${message.truncated ? '<small>原消息较长，此处展示已保存的部分内容。</small>' : ''}</div>`;
    }).join('');
    const messages = `<div class="ai-skip-messages">${messageList}${event.truncated ? '<p class="ai-help">来信较多或内容较长，此处展示已保存的部分消息。</p>' : ''}</div>`;
    const latest = incoming.at(-1);
    const disclosureId = event.id || `${event.target || ''}:${event.at || ''}`;
    const content = incoming.length > 1
      ? `<details class="ai-skip-message-disclosure" data-ai-skip-messages="${esc(disclosureId)}" ${expanded.has(disclosureId) ? 'open' : ''}><summary><span class="ai-skip-message-count">${incoming.length} 条消息</span><span class="ai-skip-message-preview">${esc(senderOf(latest))}：${esc(bodyOf(latest))}</span><span class="ai-skip-message-toggle"><span class="when-closed">展开</span><span class="when-open">收起</span></span></summary>${messages}</details>`
      : incoming.length ? messages : `<p class="ai-help" role="status">${state.skipRecordsLoading ? '正在读取发送者与消息内容…' : esc(event.contentUnavailableMessage || '历史记录未保存原文，暂时无法读取消息内容。')}</p>`;
    const person = `<span class="ai-review-record-person-copy"><strong class="ai-record-contact-name">${name}</strong><small>${profile?.kind === 'group' ? '群聊' : '联系人'}</small></span>`;
    const contactLink = `${contactPickerAvatar(contact, index, 'ai-reply-record-avatar')}${person}`;
    return `<article class="ai-review-record-card ai-skip-record-card" data-ai-skip-record="${esc(event.id || '')}" ${event.id ? `data-ai-record-menu="${esc(event.id)}" data-ai-record-menu-source="skip"` : ''}>
      <header class="ai-review-record-head">${profile ? `<button type="button" class="ai-record-contact-link" data-ai-open-conversation="${esc(profile.id)}" aria-label="打开${esc(profile.label || '联系人')}的微信聊天">${contactLink}</button>` : `<span class="ai-record-contact-link">${contactLink}</span>`}<div class="ai-reply-record-time"><small>未回复时间</small><time>${esc(beijingTime(event.at))}</time></div></header>
      <div class="ai-review-record-body"><section class="ai-review-record-content" aria-label="发送者与消息内容">${content}</section><aside class="ai-review-record-context" aria-label="原因与来源"><span class="ai-skip-source">${esc(source)}</span><p class="ai-skip-reason">${esc(reason)}</p><div class="ai-review-record-actions"><button type="button" class="secondary ap-record-mark" data-ai-mark-reply="${esc(profile?.id || '')}" data-message-id="${esc(event.messageId || '')}" data-event-id="${esc(event.id || '')}" ${event.messageId && profile && !marked && !marking ? '' : 'disabled'}>${markText}</button>${markHint ? `<small class="ai-skip-mark-status${event.markReplyError ? ' error' : ''}" role="status">${esc(markHint)}</small>` : ''}</div></aside></div>
    </article>`;
  }).join('');
   const canRetry = [...merged.values()].sort((a, b) => b.at - a.at).some(event => event.messageId && !event.incomingMessages?.length);
   return `<div id="ai-skip-records"><div class="ai-review-record-list">${rows || '<div class="ap-empty">暂无未回复记录</div>'}</div>${canRetry ? `<div class="ai-actions"><button type="button" class="secondary" data-ai-retry-skips ${state.skipRecordsLoading ? 'disabled' : ''}>${state.skipRecordsLoading ? '正在读取消息…' : '重新读取消息'}</button></div>` : ''}<footer class="ap-record-footer"><span>已加载 ${merged.size} / ${state.skipRecordsPage?.total || merged.size} 条</span>${state.skipRecordsPage?.hasMore ? `<button type="button" class="secondary" data-ai-skip-more ${state.skipPageLoading ? 'disabled' : ''}>${state.skipPageLoading ? '正在读取…' : '加载更早记录'}</button>` : ''}</footer></div>`;
}
export function activityPage(state, filters = {}, records = [], loading = false, proactiveLoading = false, errorLoading = false, summaryResults) {
  filters = { ...filters, source: filters.source || 'reply' };
  const option = (value, title, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(title)}</option>`;
  return `<section class="ai-activity-page"><div class="ai-page-heading"><div><h3>执行记录</h3></div></div><div class="ap-record-tabs" role="group" aria-label="记录来源">${[['reply', '自动回复'], ['proactive', '主动聊天']].map(([key, label]) => `<button type="button" data-ai-record-source="${key}" aria-pressed="${(filters.source || 'reply') === key}">${label}</button>`).join('')}</div><label class="ai-field ai-record-search">搜索联系人或内容<input id="ai-log-search" type="search" placeholder="输入联系人名称或记录内容…" value="${esc(filters.query)}"></label><button type="button" class="ai-reference-filter-button secondary" data-ai-toggle-filters aria-label="筛选" aria-controls="ai-log-filter" aria-expanded="${!!filters.open}">筛选</button><form id="ai-log-filter" ${filters.open ? '' : 'hidden'}><label class="ai-field">开始日期<input name="from" type="date" value="${esc(filters.from)}"></label><label class="ai-field">结束日期<input name="to" type="date" value="${esc(filters.to)}"></label><label class="ai-field">类型<select name="kind">${option('', '全部', !filters.kind)}${option('person', '联系人', filters.kind === 'person')}${option('group', '群聊', filters.kind === 'group')}</select></label><label class="ai-field">状态<select name="code">${option('', '全部', !filters.code)}${option('sent', '已代发', filters.code === 'sent')}${option('help', '需要本人处理', filters.code === 'help')}</select></label><div class="ai-filter-actions"><button type="submit" class="primary">筛选并刷新</button></div></form>
  <div id="ai-live-box">${liveActivityBox(state)}</div>
  ${filters.source === 'reply' ? `<details class="ap-record-block qbx-record-section" open data-ai-optional="activity-reply"><summary><div class="qbx-record-section-copy"><h4 data-ai-record-count="reply">自动回复（${activityEntries(state, filters, records).length}）</h4></div></summary><div class="qbx-record-section-body"><div class="qbx-record-section-tools"><div class="ai-record-kind-tabs" role="group" aria-label="回复记录对象">${[['person','联系人'],['group','群聊'],['all','全部']].map(([kind,label]) => `<button type="button" data-ai-record-kind="${kind}" aria-pressed="${(filters.kind || 'all') === kind}">${label}</button>`).join('')}</div><button type="button" class="secondary danger-link" data-ai-clear-records="reply">删除全部</button></div><div id="ai-activity-entries">${activityRows(state, filters, records, loading, summaryResults)}</div><footer class="ap-record-footer" data-ai-log-pagination>${activityPagination(state, filters, records)}</footer></div></details><details class="ap-record-block qbx-record-section" open data-ai-optional="activity-skip"><summary><div class="qbx-record-section-copy"><h4 data-ai-record-count="skip">未回复（${skipRecordEntries(state).length}）</h4></div></summary><div class="qbx-record-section-body"><div class="qbx-record-section-tools"><span>已保存的未回复来信</span><button type="button" class="secondary danger-link" data-ai-clear-records="skip">删除全部</button></div>${skipRecordsView(state)}</div></details>` : ''}
  ${filters.source !== 'reply' ? `<details class="ap-record-block qbx-record-section" open data-ai-optional="activity-proactive"><summary><div class="qbx-record-section-copy"><h4>主动聊天</h4></div></summary><div class="qbx-record-section-body"><div class="qbx-record-section-tools"><span>主动聊天执行记录</span><button type="button" class="secondary danger-link" data-ai-clear-records="proactive">删除全部</button></div><div id="ai-proactive-records">${proactiveRecordRows(state, filters, proactiveLoading)}</div></div></details>` : ''}<div id="ai-recent-errors">${recentErrorsBox(state, filters.errorsOpen, errorLoading, filters.errorExpanded)}</div></section>`;
}
