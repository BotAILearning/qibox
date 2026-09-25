import { beijingTime } from './ai-proactive-view.mjs';
import { contactName } from './ai-contact-name.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const within = (at, filters) => {
  if (!filters.from && !filters.to) return true;
  const day = at ? new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '';
  return !!day && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
};

export function replyRecordCards(state, filters, records, loading, activityEntries, summaryResults = new Map()) {
  const entries = activityEntries(state, filters, records);
  const page = Math.min(Number(filters.page) || 0, Math.max(0, Math.ceil(entries.length / 25) - 1));
  const failures = records.filter(row => row.unavailable);
  const notice = failures.length ? `<div class="ai-record-error" role="alert">${failures.map(row => `<p>${esc(row.label)}：${esc(row.error || '记录读取失败，请重试')}</p>`).join('')}<button type="button" class="secondary" data-ai-retry-records>重新读取</button></div>` : '';
  const cards = entries.slice(page * 25, page * 25 + 25).map((profile, index) => {
    const summary = summaryResults.get(profile.id);
    const source = records.find(row => row.id === profile.id);
    const messages = filters.code === 'help' ? [] : (source?.messages || [])
      .filter(message => within(message.at, filters) && (filters.source === 'unknown' ? message.source === 'unknown' : !message.source || ['reply', 'atMe', 'atAll', 'realtime'].includes(message.source)))
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    const name = contactName(profile);
    const openChat = `<button class="secondary ap-record-open" type="button" data-ai-open-conversation="${esc(profile.id)}">打开聊天</button>`;
    const history = messages.length ? `<ol class="ai-reply-history-list">${messages.map(message => {
      const confirmed = !!message.id && message.confirmed !== false;
      return `<li ${confirmed ? `data-ai-record-menu="${esc(message.id)}" data-ai-record-menu-source="${esc(filters.source === 'unknown' ? 'unknown' : 'reply')}"` : ''}><time>${esc(beijingTime(message.at))}</time><p class="ai-record-message">${esc(message.text)}</p><span>${filters.source === 'unknown' ? '来源未分类' : message.confirmed === false ? '发送结果未知' : '已回复'}</span>${confirmed ? `<button type="button" class="quiet danger-link" data-ai-delete-record="${esc(message.id)}" data-ai-delete-source="${esc(filters.source === 'unknown' ? 'unknown' : 'reply')}">删除记录</button>` : openChat}</li>`;
    }).join('')}</ol>` : `<p class="ai-help">${loading ? '正在读取代发内容…' : source?.unavailable ? '暂时无法读取正文，可以直接打开聊天。' : '当前可读取范围内暂无正文，可以打开聊天查看。'}</p>`;
    const preview = profile.needsHelp ? esc(profile.reason || '需要本人处理') : messages[0]?.text ? esc(messages[0].text) : source?.pending ? '正在读取历史正文…' : source?.unavailable ? '正文暂不可读取' : '查看近期执行记录';
    return `<article class="ai-reply-record-card" data-ai-reply-card="${esc(profile.id)}">
      <header class="ai-reply-record-head"><div class="ai-reply-record-person"><span class="ai-reply-record-avatar ai-avatar-${index % 6}" aria-hidden="true">${esc([...name][0] || '联')}</span><span><strong>${esc(name)}</strong><small>${profile.kind === 'group' ? '群聊' : '联系人'}</small></span></div><div class="ai-reply-record-time"><small>最近执行时间</small><time>${esc(beijingTime(messages[0]?.at || profile.at))}</time></div><p class="ai-reply-record-preview">${preview}</p><div class="ai-reply-record-actions">${openChat}</div></header>
      <details data-ai-record-expand="${esc(profile.id)}" ${filters.expanded?.includes(profile.id) || summary ? 'open' : ''}><summary>执行详情 <span>${messages.length} 条记录</span></summary><div class="ai-reply-record-detail">${profile.needsHelp ? `<div class="ai-reply-record-help"><span>${esc(profile.reason || '需要本人处理')}</span>${profile.queueFailed ? '<button class="quiet" type="button" data-ai-nav="proactive">查看主动聊天任务</button>' : `<button class="quiet" type="button" data-ai-resume-profile="${esc(profile.id)}">开启自动回复</button>`}</div>` : ''}<div class="ai-reply-summary-toolbar"><span>按时间范围生成聊天总结</span><div class="ai-summary-controls"><select data-ai-summary-range="${esc(profile.id)}" aria-label="${esc(name)}的总结时间范围">${[['takeover','本次接管'],['all','全部'],['day','近一天'],['week','近一周'],['month','近一月']].map(([value, label]) => `<option value="${value}" ${summary?.range === value ? 'selected' : ''}>${label}</option>`).join('')}</select><button type="button" class="primary" data-ai-summary-profile="${esc(profile.id)}" ${summary?.pending ? 'disabled' : ''}>总结</button></div></div><p class="ai-summary-result" data-ai-summary-result="${esc(profile.id)}" role="status" ${summary ? '' : 'hidden'}>${summary ? esc(summary.text) : ''}</p><section class="ai-reply-history"><header><h4>执行记录</h4><span>${messages.length} 条</span></header>${history}</section></div></details>
    </article>`;
  }).join('');
  return notice + `<div class="ai-reply-record-list">${cards || `<div class="ai-empty-state"><h4>${loading ? '正在读取记录…' : failures.length ? '部分记录读取失败' : '暂无符合条件的自动回复记录'}</h4><p>可以调整日期、对象或内容筛选后重试。</p></div>`}</div>`;
}
