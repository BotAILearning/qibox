import { beijingTime } from './ai-proactive-view.mjs';
import { icon } from './ai-icons.mjs';
import { contactName, contactSearch } from './ai-contact-name.mjs';
import { replyRecordCards } from './ai-reply-records-view.mjs';
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
export function proactiveRecordEntries(state, filters = {}) {
  return (state.proactiveRecords || []).filter(r => (!filters.taskId || r.taskId === filters.taskId) && within(r.at, filters) &&
    (!filters.query || `${contactSearch(r)} ${r.text || ''}`.normalize('NFKC').toLocaleLowerCase().includes(filters.query.normalize('NFKC').toLocaleLowerCase())) &&
    (!filters.kind || filters.kind === 'person') && (!filters.code || (filters.code === 'sent' ? ['sent', 'done'].includes(r.status) : ['failed', 'uncertain', 'unknown', 'not-sent'].includes(r.status))));
}
export function proactiveRecordRows(state, filters = {}, loading = false) {
  const records = proactiveRecordEntries(state, filters), labels = { sent: '已发送', done: '已发送', failed: '执行失败', uncertain: '发送结果未知', unknown: '发送结果未知', reviewed: '已结束，不补发', 'not-sent': '未发送', pending: '待执行', generating: '正在生成', sending: '发送中', paused: '已暂停', skipped: '已跳过', cancelled: '已取消' };
  return `<div class="ap-table-scroll"><table class="ai-record-table ap-record-table ap-proactive-record-table"><thead><tr><th>任务</th><th>联系人</th><th>最近执行时间</th><th>本次执行内容</th><th>操作</th></tr></thead><tbody>${records.map(r => {
    const profileId = r.profileId || state.profiles?.find(p => p.contact === r.contact)?.id, profile = state.profiles?.find(p => p.id === profileId);
     return `<tr data-proactive-record="${esc(r.id)}"><td data-label="任务"><strong>${esc(r.taskName || '历史任务')}</strong></td><td data-label="联系人">${contactName(r) || esc(r.contact || '联系人')}</td><td data-label="最近执行时间">${esc(beijingTime(r.at))}</td><td data-label="本次执行内容"><span class="ap-record-status ${esc(r.status)}">${esc(labels[r.status] || '状态待更新')}</span>${r.segmentsTotal ? `<small>已确认 ${r.segmentsSent || 0}/${r.segmentsTotal} 段</small>` : ''}${r.text ? `<p class="ap-record-text">${esc(r.text)}</p>` : `<p class="ai-help">${r.bodyUnavailable ? '正文暂时无法读取。' : '无可展示正文'}</p>`}${r.reason ? `<p class="ai-help">${esc(r.reason)}</p>` : ''}</td><td data-label="操作">${profileId ? `<button type="button" class="quiet" data-ai-open-conversation="${esc(profileId)}">打开聊天</button>` : '<span class="ai-help">联系人信息不可用</span>'}<button type="button" class="quiet danger-link" data-ai-delete-record="${esc(r.id)}" data-ai-delete-source="proactive">删除记录</button></td></tr>`;
  }).join('') || `<tr><td colspan="5"><div class="ap-empty">${loading ? '正在读取主动聊天记录…' : '已加载范围内暂无符合条件的主动聊天记录'}</div></td></tr>`}</tbody></table></div><footer class="ap-record-footer"><span>已加载 ${state.proactiveRecords?.length || 0} 条，当前筛选显示 ${records.length} 条</span>${state.proactiveRecordsPage?.hasMore ? `<button class="secondary" type="button" data-proactive-record-more ${loading ? 'disabled' : ''}>${loading ? '正在读取…' : '加载更早记录'}</button>` : '<span>当前加载范围已到末尾</span>'}</footer>`;
}
export function liveActivityBox(state) {
  const live = state.live || [];
  if (!live.length) return '';
  return `<section class="ap-record-live"><header><h4>实时状态</h4></header><ul>${live.map(x => {
    const remaining = x.phase === 'generating' || !Number.isFinite(x.dueAt) ? '' : ` · 约 ${Math.max(1, Math.ceil((x.dueAt - Date.now()) / 1000))} 秒后发送`;
    return `<li><i class="ai-live-dot ${esc(x.phase)}"></i><strong>${contactName(x)}</strong>${x.phase === 'generating' ? '：模型生成中…' : `：${esc(x.reason || '等待发送')}${remaining}`}</li>`;
  }).join('')}</ul></section>`;
}
export function recentErrorsBox(state, open = false, loading = false) {
  // 异常全部保留、按页加载：标题是总数，列表是当前已加载的部分，翻页按钮拉更早的。
  const errors = state.recentErrors || [], page = state.errorsPage || {};
  // 总数取服务端给的与已加载条数的较大值：老版本服务端还没带 errorsPage 时也能正常显示。
  const total = Math.max(Number(page.total) || 0, errors.length);
  const hasMore = !!page.hasMore || errors.length < total;
  if (!total) return '';
  return `<details class="ap-record-errors"${open ? ' open' : ''}><summary><h4>最近异常（${total}）</h4><button type="button" class="quiet danger-link" data-ai-clear-errors>清空</button></summary><ul>${errors.map(e => `<li><time>${esc(beijingTime(e.at))}</time><span>${esc(e.message || 'AI 操作未完成')}</span></li>`).join('')}</ul><footer class="ap-record-footer"><span>已加载 ${errors.length} / ${total} 条</span>${hasMore ? `<button class="secondary" type="button" data-ai-error-more ${loading ? 'disabled' : ''}>${loading ? '正在读取…' : '加载更早异常'}</button>` : '<span>已全部加载</span>'}</footer></details>`;
}
export function skipRecordsView(state) {
  const profiles = new Map((state.profiles || []).map(profile => [profile.id, profile]));
  const merged = new Map();
  for (const event of [...(state.events || []).filter(event => event.code === 'skip'), ...(state.skipRecords || [])]) merged.set(event.id || `${event.target || ''}:${event.at}`, event);
  const reasonLabels = { 'group-trigger-missing': '群聊未配置触发方式', 'explicit-question-no-response': '明确提问重试后仍未生成文字回复；新来信仍可处理', 'unsupported-media': '当前内容无法安全处理', 'identity-rule-block': '回复内容未通过身份规则', 'model-no-reply': '模型判断本轮无需回复' };
  const rows = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, 50).map(event => {
    const profile = profiles.get(event.target), name = contactName(profile, (state.contacts || []).find(c => c.id === profile?.contact)) || '联系人';
    const source = `${({ 'model-skip': '模型判断', 'system-skip': '系统拦截' })[event.source] || '旧记录'}${event.trigger ? ` · ${{ reply: '私聊', atMe: '@我', atAll: '@所有人', realtime: '群聊实时', proactive: '主动聊天' }[event.trigger] || event.trigger}` : ''}`;
    const reason = reasonLabels[event.reasonCode] || (event.reasonCode ? '系统跳过本次回复' : '历史记录未保存具体原因');
     return `<tr><td data-label="联系人">${name}</td><td data-label="时间">${esc(beijingTime(event.at))}</td><td data-label="原因与来源">${esc(source)} · ${esc(reason)}</td><td data-label="操作">${profile ? `<button type="button" class="secondary ap-record-open" data-ai-open-conversation="${esc(profile.id)}">打开聊天</button>` : '<span class="ai-help">联系人信息不可用</span>'}<button type="button" class="secondary ap-record-mark" data-ai-mark-reply="${esc(profile?.id || '')}" data-message-id="${esc(event.messageId || '')}" data-event-id="${esc(event.id || '')}" ${event.messageId ? '' : 'disabled'}>标记为需回复</button><button type="button" class="quiet danger-link" data-ai-delete-record="${esc(event.id || '')}" data-ai-delete-source="skip">删除记录</button></td></tr>`;
  }).join('');
   return `<div id="ai-skip-records"><div class="ap-table-scroll"><table class="ai-record-table ap-record-table ap-skip-record-table"><thead><tr><th>联系人</th><th>时间</th><th>原因与来源</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="4"><div class="ap-empty">暂无未回复记录</div></td></tr>'}</tbody></table></div></div>`;
}
export function activityPage(state, filters = {}, records = [], loading = false, proactiveLoading = false, errorLoading = false, summaryResults) {
  const option = (value, title, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(title)}</option>`;
  const entries = activityEntries(state, filters, records), pages = Math.max(1, Math.ceil(entries.length / 25)), page = Math.min(Number(filters.page) || 0, pages - 1);
  return `<section class="ai-activity-page"><div class="ai-page-heading"><div><h3>执行记录</h3></div></div><div class="ap-record-tabs" role="group" aria-label="记录来源">${[['reply', '自动回复'], ['proactive', '主动聊天']].map(([key, label]) => `<button type="button" data-ai-record-source="${key}" aria-pressed="${(filters.source || 'reply') === key}">${label}</button>`).join('')}</div><label class="ai-field ai-record-search">搜索联系人或内容<input id="ai-log-search" type="search" placeholder="输入联系人名称或记录内容…" value="${esc(filters.query)}"></label><button type="button" class="ai-reference-filter-button secondary" data-ai-toggle-filters aria-label="筛选" aria-controls="ai-log-filter" aria-expanded="${!!filters.open}">筛选</button><form id="ai-log-filter" ${filters.open ? '' : 'hidden'}><label class="ai-field">开始日期<input name="from" type="date" value="${esc(filters.from)}"></label><label class="ai-field">结束日期<input name="to" type="date" value="${esc(filters.to)}"></label><label class="ai-field">类型<select name="kind">${option('', '全部', !filters.kind)}${option('person', '联系人', filters.kind === 'person')}${option('group', '群聊', filters.kind === 'group')}</select></label><label class="ai-field">状态<select name="code">${option('', '全部', !filters.code)}${option('sent', '已代发', filters.code === 'sent')}${option('help', '需要本人处理', filters.code === 'help')}</select></label><div class="ai-filter-actions"><button type="submit" class="primary">筛选并刷新</button></div></form>
  <div id="ai-live-box">${liveActivityBox(state)}</div>
  ${filters.source !== 'reply' ? `<section class="ap-record-block"><header><h4>主动聊天</h4><span>每次执行单独记录 · 删除任务后仍保留历史</span><button type="button" class="icon-button" data-ai-toggle-filters aria-expanded="${!!filters.open}" aria-controls="ai-log-filter" title="筛选" aria-label="筛选">${icon('filter')}</button></header><div id="ai-proactive-records">${proactiveRecordRows(state, filters, proactiveLoading)}</div></section>` : ''}
  ${filters.source === 'reply' ? `<section class="ap-record-block"><header><h4>自动回复</h4><span>按联系人查看近期执行内容，每页最多 25 位</span><button type="button" class="icon-button" data-ai-toggle-filters aria-expanded="${!!filters.open}" aria-controls="ai-log-filter" title="筛选" aria-label="筛选">${icon('filter')}</button></header><div id="ai-activity-entries">${activityRows(state, filters, records, loading, summaryResults)}</div><div class="ai-actions"><button class="quiet" type="button" data-ai-log-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page + 1} / ${pages}</span><button class="quiet" type="button" data-ai-log-page="${page + 1}" ${page + 1 >= pages ? 'disabled' : ''}>下一页</button></div></section><section class="ap-record-block"><header><h4>未回复记录</h4><span>保留最近 50 次判断，不进入核验流程</span></header>${skipRecordsView(state)}</section>` : ''}<div id="ai-recent-errors">${recentErrorsBox(state, filters.errorsOpen, errorLoading)}</div></section>`;
}
