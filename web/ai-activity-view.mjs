import { beijingTime } from './ai-proactive-view.mjs';
import { icon } from './ai-icons.mjs';
import { contactName, contactSearch } from './ai-contact-name.mjs';
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
export function activityRows(state, filters, records, loading) {
  const entries = activityEntries(state, filters, records), page = Math.min(Number(filters.page) || 0, Math.max(0, Math.ceil(entries.length / 25) - 1));
  const failures = records.filter(r => r.unavailable);
  return `${failures.length ? `<div class="ai-record-error" role="alert">${failures.map(r => `<p>${esc(r.label)}：${esc(r.error || '记录读取失败，请重试')}</p>`).join('')}<button type="button" class="secondary" data-ai-retry-records>重新读取</button></div>` : ''}<div class="ap-table-scroll"><table class="ai-record-table ap-record-table"><thead><tr><th>联系人</th><th>最近执行时间</th><th>执行记录</th><th>操作</th></tr></thead><tbody>${entries.slice(page * 25, page * 25 + 25).map(p => {
    const source = records.find(r => r.id === p.id), messages = filters.code === 'help' ? [] : (source?.messages || []).filter(m => within(m.at, filters) && (filters.source === 'unknown' ? m.source === 'unknown' : !m.source || ['reply', 'atMe', 'atAll', 'realtime'].includes(m.source))).sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    // 运行记录展示所有已代发数据：正文暂不可读时保留行，由下方占位说明。
    const open = `<button class="quiet" type="button" data-ai-open-conversation="${esc(p.id)}">打开聊天</button>`;
    return `<tr class="ai-contact-record"><td><strong>${contactName(p)}</strong><small>${p.kind === 'group' ? '群聊' : '联系人'}</small></td><td>${esc(beijingTime(messages[0]?.at || p.at))}</td><td>${p.needsHelp ? `<p class="ai-help">${esc(p.reason)}</p>${p.queueFailed ? '<button class="quiet" type="button" data-ai-nav="proactive">查看主动聊天任务</button>' : `<button class="quiet" type="button" ${p.needsReview ? 'data-ai-review' : 'data-ai-resume-profile'}="${esc(p.id)}">${p.needsReview ? '核验发送结果' : '开启自动回复'}</button>`}` : ''}<details data-ai-record-expand="${esc(p.id)}" ${filters.expanded?.includes(p.id) ? 'open' : ''}><summary>${source?.pending ? '正在读取历史正文…' : source?.unavailable ? '正文暂不可读取' : `展开近期执行记录（${messages.length} 条）`}</summary>${messages.length ? `<ol>${messages.map(m => m.id && m.confirmed !== false ? `<li data-ai-record-menu="${esc(m.id)}" data-ai-record-menu-source="${esc(filters.source === 'unknown' ? 'unknown' : 'reply')}"><time>${esc(beijingTime(m.at))}</time><button type="button" class="ai-record-message" data-ai-locate-message="${esc(m.id)}" data-profile-id="${esc(p.id)}" title="定位到聊天位置">${esc(m.text)}</button></li>` : `<li><time>${esc(beijingTime(m.at))}</time><p>${esc(m.text)}</p><span>${filters.source === 'unknown' ? '来源未分类' : m.confirmed === false ? '待核对' : '已回复'}</span>${open}<button type="button" class="quiet danger-link" data-ai-delete-record="${esc(m.id)}" data-ai-delete-source="${esc(filters.source === 'unknown' ? 'unknown' : 'reply')}">删除记录</button></li>`).join('')}</ol>` : `<p class="ai-help">${loading ? '正在读取代发内容…' : source?.unavailable ? '暂时无法读取正文，可以直接打开聊天。' : '当前可读取范围内暂无正文，可以打开聊天查看。'}</p>`}</details></td><td>${open}</td></tr>`;
  }).join('') || `<tr><td colspan="4"><div class="ai-empty-state"><h4>${loading ? '正在读取记录…' : failures.length ? '部分记录读取失败' : '暂无符合条件的自动回复记录'}</h4><p>可以调整日期、对象或内容筛选后重试。</p></div></td></tr>`}</tbody></table></div>`;
}
export function proactiveRecordEntries(state, filters = {}) {
  return (state.proactiveRecords || []).filter(r => (!filters.taskId || r.taskId === filters.taskId) && within(r.at, filters) &&
    (!filters.query || `${contactSearch(r)} ${r.text || ''}`.normalize('NFKC').toLocaleLowerCase().includes(filters.query.normalize('NFKC').toLocaleLowerCase())) &&
    (!filters.kind || filters.kind === 'person') && (!filters.code || (filters.code === 'sent' ? ['sent', 'done'].includes(r.status) : ['failed', 'uncertain', 'not-sent'].includes(r.status))));
}
export function proactiveRecordRows(state, filters = {}, loading = false) {
  const records = proactiveRecordEntries(state, filters), labels = { sent: '已发送', done: '已发送', failed: '执行失败', uncertain: '待核验', reviewed: '已核对，不补发', 'not-sent': '未发送', pending: '待执行', generating: '正在生成', sending: '发送中', paused: '已暂停', skipped: '已跳过', cancelled: '已取消' };
  return `<div class="ap-table-scroll"><table class="ai-record-table ap-record-table"><thead><tr><th>任务</th><th>联系人</th><th>最近执行时间</th><th>本次执行内容</th><th>操作</th></tr></thead><tbody>${records.map(r => {
    const profileId = r.profileId || state.profiles?.find(p => p.contact === r.contact)?.id, profile = state.profiles?.find(p => p.id === profileId);
    return `<tr data-proactive-record="${esc(r.id)}"><td><strong>${esc(r.taskName || '历史任务')}</strong></td><td>${contactName(r) || esc(r.contact || '联系人')}</td><td>${esc(beijingTime(r.at))}</td><td><span class="ap-record-status ${esc(r.status)}">${esc(labels[r.status] || '状态待更新')}</span>${r.segmentsTotal ? `<small>已确认 ${r.segmentsSent || 0}/${r.segmentsTotal} 段</small>` : ''}${r.text ? `${r.messageId && profileId ? `<button type="button" class="ai-record-message" data-ai-locate-message="${esc(r.messageId)}" data-profile-id="${esc(profileId)}" title="定位到聊天位置">${esc(r.text)}</button><button type="button" class="quiet" data-ai-locate-message="${esc(r.messageId)}" data-profile-id="${esc(profileId)}">定位到聊天位置</button>` : `<p class="ap-record-text">${esc(r.text)}</p>`}` : `<p class="ai-help">${r.bodyUnavailable ? '正文暂时无法读取，请打开聊天核对。' : '无可展示正文'}</p>`}${r.reason ? `<p class="ai-help">${esc(r.reason)}</p>` : ''}${r.status === 'uncertain' ? '<p class="ai-help">发送结果待核对，不会自动重发本条。</p>' : ''}</td><td>${profile?.delivery?.status === 'uncertain' ? `<button type="button" class="quiet" data-ai-review="${esc(profileId)}">核验发送结果</button>` : ''}${profileId ? `${r.status === 'uncertain' ? `<button type="button" class="quiet" data-ai-review="${esc(profileId)}">核对结果</button>` : ''}<button type="button" class="quiet" data-ai-open-conversation="${esc(profileId)}">打开聊天</button>` : '<span class="ai-help">联系人暂不可定位</span>'}<button type="button" class="quiet danger-link" data-ai-delete-record="${esc(r.id)}" data-ai-delete-source="proactive">删除记录</button></td></tr>`;
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
    return `<tr><td>${esc(name)}</td><td>${esc(beijingTime(event.at))}</td><td>${esc(source)} · ${esc(reason)}</td><td>${event.messageId && profile ? `<button type="button" class="quiet" data-ai-locate-message="${esc(event.messageId)}" data-profile-id="${esc(profile.id)}">定位触发消息</button>` : '<span class="ai-help">无可定位的历史消息</span>'}</td></tr>`;
  }).join('');
  return `<div id="ai-skip-records"><div class="ap-table-scroll"><table class="ai-record-table ap-record-table"><thead><tr><th>联系人</th><th>时间</th><th>原因与来源</th><th>触发消息</th></tr></thead><tbody>${rows || '<tr><td colspan="4"><div class="ap-empty">暂无未回复记录</div></td></tr>'}</tbody></table></div></div>`;
}
export function activityPage(state, filters = {}, records = [], loading = false, proactiveLoading = false, errorLoading = false) {
  const option = (value, title, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(title)}</option>`;
  const entries = activityEntries(state, filters, records), pages = Math.max(1, Math.ceil(entries.length / 25)), page = Math.min(Number(filters.page) || 0, pages - 1);
  return `<section class="ai-activity-page"><div class="ai-page-heading"><div><h3>运行记录</h3></div></div><div class="ap-record-tabs" role="group" aria-label="记录来源">${[['reply', '自动回复'], ['proactive', '主动聊天']].map(([key, label]) => `<button type="button" data-ai-record-source="${key}" aria-pressed="${(filters.source || 'reply') === key}">${label}</button>`).join('')}</div><label class="ai-field ai-record-search">搜索联系人或内容<input id="ai-log-search" type="search" placeholder="输入联系人名称或记录内容…" value="${esc(filters.query)}"></label><form id="ai-log-filter" ${filters.open ? '' : 'hidden'}><label class="ai-field">开始日期<input name="from" type="date" value="${esc(filters.from)}"></label><label class="ai-field">结束日期<input name="to" type="date" value="${esc(filters.to)}"></label><label class="ai-field">类型<select name="kind">${option('', '全部', !filters.kind)}${option('person', '联系人', filters.kind === 'person')}${option('group', '群聊', filters.kind === 'group')}</select></label><label class="ai-field">状态<select name="code">${option('', '全部', !filters.code)}${option('sent', '已代发', filters.code === 'sent')}${option('help', '需要本人处理', filters.code === 'help')}</select></label><div class="ai-filter-actions"><button type="submit" class="primary">筛选并刷新</button></div></form>
  <div id="ai-live-box">${liveActivityBox(state)}</div>
  ${filters.source !== 'reply' ? `<section class="ap-record-block"><header><h4>主动聊天</h4><span>每次执行单独记录 · 删除任务后仍保留历史</span><button type="button" class="icon-button" data-ai-toggle-filters aria-expanded="${!!filters.open}" aria-controls="ai-log-filter" title="筛选" aria-label="筛选">${icon('filter')}</button></header><div id="ai-proactive-records">${proactiveRecordRows(state, filters, proactiveLoading)}</div></section>` : ''}
  ${filters.source === 'reply' ? `<section class="ap-record-block"><header><h4>自动回复</h4><span>按联系人查看近期执行内容，每页最多 25 位</span><button type="button" class="icon-button" data-ai-toggle-filters aria-expanded="${!!filters.open}" aria-controls="ai-log-filter" title="筛选" aria-label="筛选">${icon('filter')}</button></header><div id="ai-activity-entries">${activityRows(state, filters, records, loading)}</div><div class="ai-actions"><button class="quiet" type="button" data-ai-log-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page + 1} / ${pages}</span><button class="quiet" type="button" data-ai-log-page="${page + 1}" ${page + 1 >= pages ? 'disabled' : ''}>下一页</button></div></section><section class="ap-record-block"><header><h4>未回复记录</h4><span>保留最近 50 次判断，不进入核验流程</span></header>${skipRecordsView(state)}</section>` : ''}<div id="ai-recent-errors">${recentErrorsBox(state, filters.errorsOpen, errorLoading)}</div></section>`;
}
