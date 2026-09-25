import { dateRangeField, chooseDateRange } from './ai-date-range.mjs';
import { providerPage } from './ai-provider-view.mjs';
import { icon, iconSprite, logoIcon } from './ai-icons.mjs';
import { keyIcon } from './ai-key-icon.mjs';
import { memoryFields, pendingMemoryFields, wikiEntryMarkup, sameWikiEntries } from './ai-memory-view.mjs';
import { objectPage, objectList } from './ai-object-view.mjs';
import { styleChoice, styleSummary as styleSummaryText } from './ai-style-view.mjs';
import { learnedObjectDraft } from './ai-learning-draft.mjs';
import { analysisPage, analysisContactList, copyReport, presetRequest, analysisRequestState, presetChips } from './ai-analysis-view.mjs';
import { activityPage, activityEntries, activityRows, proactiveRecordRows, liveActivityBox, recentErrorsBox, skipRecordsView } from './ai-activity-view.mjs';
import { createProactiveUI } from './ai-proactive-view.mjs';
import { RecordCache, mergeRecordResults } from './ai-record-cache.mjs';
import { contactName, contactSearch as searchableContact } from './ai-contact-name.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eventLabels = { contacted: '已主动联系', replied: '已自动回复', manual: '已交由你回复', limit: '已达到回复上限', skip: '本轮无需回复', stop: '已收到停止联系要求', uncertain: '发送结果未知，本次不重发', error: '任务已暂停', failed: '对象不可读取，本次未发送' };
const names = { formality: '正式程度', warmth: '亲切程度', length: '回复长度', directness: '表达方式', emoji: '表情使用', humor: '幽默程度' };
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
const field = (name, label, value, max = 1200, placeholder = '') => `<label class="ai-field">${label}<textarea name="${name}" maxlength="${max}" rows="${name === 'summary' ? 6 : 2}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
const switchRow = (key, label, hint = '') => `<label class="ai-switch-row"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" role="switch" data-ai-setting="${key}" aria-label="${label}"></label>`;
const KEY_MASK = '********';
const LEARN_TARGETS = [
  { id: 'both', label: '风格 + 记忆', hint: '一次同时学习表达风格与聊天记忆，速度快，素材为最近的聊天记录。' },
  { id: 'style', label: '仅学习风格', hint: '只更新聊天风格，不改动已保存的聊天记忆。' },
  { id: 'memory', label: '仅学习记忆', hint: '读取聊天记录整理成一份记忆，学习后在对象页选择替换或与原有记忆合并。' },
];
const serviceIdentity = value => `${String(value?.protocol || 'openai')}|${String(value?.baseUrl || '').trim().replace(/\/+$/, '')}`;

export function aiAssistant({ api, onClose, onOpenChat, guard, ensure }) {
  const rail = document.querySelector('#ai-rail'), panel = document.querySelector('#ai-panel');
  // guard：入口常驻后，操作开关 / 打开面板前由外层判断可用性，不满足时弹窗提醒并返回 false。
  const pass = () => guard ? guard() !== false : true;
  // ensure：入口常驻后入口可能先于实例挂载出现，操作前补一次挂载，避免用空实例 id 发请求。
  async function ensureInstance() {
    if (id) return true;
    if (!ensure) return false;
    await ensure();
    return !!id;
  }
  let id, state, tab = 'overview', timer, generation = 0, requestEpoch = 0, workToken = 0, analysisQueueToken = 0, analysisQueueAccount = null, polling = false, busy = false;
  // Profiles carry a snapshot label; the WeChat nickname still lives in the
  // address book, so rows derived from a profile borrow it from there.
  // These must stay inside the closure: `state` is declared here, and a
  // module-level arrow would throw "ReferenceError: state is not defined".
  const profileContact = profile => (state.contacts || []).find(c => c.id === profile?.contact);
  const profileName = profile => contactName(profile, profileContact(profile));
  let lastActivity = 0;
  let replyDraft = null, editingProfile = null, profileReturn = 'results';
  let contactsLoaded = false, contactsLoading = false, resultProfileIds = null;
  let lastAutoScanAt = 0;
  let editingReplyContact = null, replyContactSearch = '', contactSearch = '';
  let modelDraft = null, providerRevision = 0, revealRevision = 0, learningDraft = null, renderedView = '';
  const profileDrafts = new Map();
  const manualReplyDrafts = new Map();
  const objectDrafts = new Map();
  let learnRange = { from: '', to: '' }, learnScope = 'range', learnTarget = 'both', memoryPendingSignature = '';
  let defaultStylePerspective = 'self';
  let defaultStyleReturn = 'settings';
  let analysisDraft = { request: '', from: '', to: '', contacts: [] }, analysisResult = null, analysisSearch = '', analysisHistoryReport = null, analysisHistoryEpoch = 0;
  let objectKind = 'person', selectedObject = '', objectSearch = '', logFilters = { source: 'reply' };
  const objectView = () => ({ kind: objectKind, selected: selectedObject, search: objectSearch, draft: objectDrafts.get(selectedObject) });
  function objects() { return objectPage(state, objectView()); }
  let logRecords = [], logLoading = false, logEpoch = 0, logSignature = '';
  let proactiveHistory = [], proactiveHistoryPage = null, proactiveRecordLoading = false, proactiveRecordEpoch = 0;
  let errorHistory = [], errorPage = null, errorLoading = false, errorEpoch = 0;
  const recordCache = new RecordCache();
  let logRequestScope = '';
  const rememberRecords = () => recordCache.save(id, state?.account, { logRecords, proactiveHistory, proactiveHistoryPage, errorHistory, errorPage, logFilters });
  function restoreRecords() {
    const saved = recordCache.take(id, state?.account);
    if (saved) ({ logRecords, proactiveHistory, proactiveHistoryPage, errorHistory, errorPage, logFilters } = saved, logFilters.source = 'reply', delete logFilters.taskId);
  }
  function drawRecords() {
    if (state && tab === 'activity' && $('#ai-activity-entries')) $('#ai-activity-entries').innerHTML = activityRows(state, logFilters, logRecords, logLoading);
  }
  function drawErrors() {
    if (state && tab === 'activity') { const box = $('#ai-recent-errors'); if (box) box.innerHTML = recentErrorsBox(activityState(), logFilters.errorsOpen, errorLoading); }
  }
  const activityState = () => {
    const rows = new Map(proactiveHistory.map(r => [r.id, r]));
    const newest = proactiveHistory.length ? Math.max(...proactiveHistory.map(r => new Date(r.at).getTime())) : Infinity;
    for (const r of state?.proactiveRecords || []) if ((!logFilters.taskId || r.taskId === logFilters.taskId) && (!proactiveHistoryPage || rows.has(r.id) || new Date(r.at).getTime() >= newest)) rows.set(r.id, r);
    // 异常同主动聊天记录：state 只带第一页，翻出来的更早部分留在本地一起显示。
    const errors = new Map(errorHistory.map(e => [e.id, e]));
    for (const e of state?.recentErrors || []) errors.set(e.id, e);
    // 翻页游标取已翻出来的那一页，总数取两边的大值：新异常出现时标题不会往回缩。
    const serverPage = state?.errorsPage || {}, total = Math.max(Number(serverPage.total) || 0, Number(errorPage?.total) || 0);
    return { ...state, proactiveRecords: [...rows.values()].sort((a, b) => new Date(b.at) - new Date(a.at)), proactiveRecordsPage: proactiveHistoryPage || (logFilters.taskId ? { hasMore: true } : state?.proactiveRecordsPage),
      recentErrors: [...errors.values()].sort((a, b) => new Date(b.at) - new Date(a.at)), errorsPage: { ...serverPage, ...(errorPage || {}), total } };
  };
  function activity() { return activityPage(activityState(), logFilters, logRecords, logLoading, proactiveRecordLoading, errorLoading); }
  async function loadProactiveRecords(more = false) {
    if (proactiveRecordLoading) return;
    const current = generation, target = id, epoch = ++proactiveRecordEpoch, taskId = logFilters.taskId || '';
    const page = proactiveHistoryPage || (!taskId ? state?.proactiveRecordsPage : null);
    if (more && !page?.hasMore) return;
    proactiveRecordLoading = true;
    if ($('#ai-proactive-records')) $('#ai-proactive-records').innerHTML = proactiveRecordRows(activityState(), logFilters, true);
    try {
      const result = await api(`/instances/${target}/ai`, { action: 'proactive-records', value: { ...(taskId ? { taskId } : {}), limit: 50, ...(more && page?.nextBefore ? { before: page.nextBefore } : {}) } }, 130000);
      if (current !== generation || target !== id || epoch !== proactiveRecordEpoch) return;
      if (more) {
        const rows = new Map(activityState().proactiveRecords.map(r => [r.id, r]));
        for (const r of result.records || []) rows.set(r.id, r);
        proactiveHistory = [...rows.values()];
      } else proactiveHistory = result.records || [];
      proactiveHistoryPage = result.page || { hasMore: false };
      rememberRecords();
    } catch (e) { if (current === generation && epoch === proactiveRecordEpoch) message(e.message, true); }
    finally {
      if (current === generation && epoch === proactiveRecordEpoch) {
        proactiveRecordLoading = false;
        if ($('#ai-proactive-records')) $('#ai-proactive-records').innerHTML = proactiveRecordRows(activityState(), logFilters, false);
      }
    }
  }
  async function loadErrorRecords(more = false) {
    if (errorLoading) return;
    const page = errorPage || state?.errorsPage;
    const before = more ? (page?.nextBefore || activityState().recentErrors.at(-1)?.id || null) : null;
    if (more && !before) return;
    const current = generation, target = id, epoch = ++errorEpoch;
    errorLoading = true;
    drawErrors();
    try {
      const result = await api(`/instances/${target}/ai`, { action: 'error-records', value: { limit: 50, ...(before ? { before } : {}) } }, 30000);
      if (current !== generation || target !== id || epoch !== errorEpoch) return;
      if (more) {
        const rows = new Map(activityState().recentErrors.map(e => [e.id, e]));
        for (const e of result.records || []) rows.set(e.id, e);
        errorHistory = [...rows.values()];
      } else errorHistory = result.records || [];
      errorPage = result.page || { hasMore: false };
      rememberRecords();
    } catch (e) { if (current === generation && target === id && epoch === errorEpoch) message(e.message, true); }
    finally { if (current === generation && target === id && epoch === errorEpoch) { errorLoading = false; drawErrors(); } }
  }
  async function loadActivity() {
    if (logFilters.source === 'proactive') return;
    const entries = activityEntries(state, logFilters), pages = Math.max(1, Math.ceil(entries.length / 25));
    logFilters.page = Math.min(Number(logFilters.page) || 0, pages - 1);
    const ids = entries.slice(logFilters.page * 25, logFilters.page * 25 + 25).map(x => x.id);
    const filters = { from: logFilters.from || '', to: logFilters.to || '', source: logFilters.source === 'unknown' ? 'unknown' : 'reply' };
    const scope = JSON.stringify([id, state.account, ids, filters]);
    if (logLoading && logRequestScope === scope) return;
    const current = generation, target = id, epoch = ++logEpoch, account = state.account;
    const valid = () => current === generation && target === id && epoch === logEpoch && account === state?.account;
    logRequestScope = scope;
    logLoading = true; logSignature = JSON.stringify([state.activity || [], state.activityHistory || []]);
    drawRecords();
    try {
      const result = await api(`/instances/${target}/ai`, { action: 'activity-records', ids, filters: { ...filters, hydrate: false } }, 15000);
      if (!valid()) return;
      logRecords = mergeRecordResults(logRecords, result.records); drawRecords(); rememberRecords();
      // Show saved records immediately; hydrate older bodies one contact at a
      // time so one slow history cannot hold back the entire page.
      for (const row of result.records.filter(r => r.pending)) {
        if (!valid()) return;
        let rows;
        try { rows = (await api(`/instances/${target}/ai`, { action: 'activity-records', ids: [row.id], filters }, 130000)).records; }
        catch (error) { rows = [{ ...row, pending: false, unavailable: true, error: error.message }]; }
        if (!valid()) return;
        const merged = mergeRecordResults(logRecords, rows);
        logRecords = logRecords.map(r => merged.find(next => next.id === r.id) || r);
        drawRecords(); rememberRecords();
      }
    } catch (error) {
      if (valid()) {
        logRecords = mergeRecordResults(logRecords, entries.filter(p => ids.includes(p.id)).map(p => ({ ...p, messages: [], unavailable: true, error: error.message })));
        message(error.message, true);
      }
    } finally {
      if (valid()) { logLoading = false; drawRecords(); rememberRecords(); }
    }
  }
  async function openConversation(profileId) {
    const current = generation, target = id;
    let result;
    try { result = await api(`/instances/${target}/ai`, { action: 'open-conversation', id: profileId }, 30000); }
    catch (error) { if (current !== generation || target !== id) return; throw error; }
    if (current !== generation || target !== id) return;
    if (!result.opened) throw new Error('尚未确认打开目标聊天');
    panel.hidden = true;
    await onOpenChat?.(target);
  }
  function confirmRealtime() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'ai-confirm-dialog';
      dialog.innerHTML = '<h3>开启 AI 实时回复？</h3><p>开启后，AI 将持续分析群聊消息，并根据聊天内容自动回复。群聊消息较多时，会消耗大量 Token，增加模型调用费用。</p><p>自动发言过于频繁存在账号被限制或封禁的风险，请谨慎开启。</p><form method="dialog" class="ai-actions"><button class="secondary" value="cancel">取消</button><button class="primary" value="confirm">确认开启</button></form>';
      dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  // A very long range would mean hundreds of model calls. Measure first, then
  // tell the user: the run keeps only the newest part, so shortening the dates
  // is the only way to cover the whole range.
  function confirmTruncatedAnalysis(result) {
    return new Promise(resolve => {
      const items = Array.isArray(result.contacts) ? result.contacts : [];
      const sum = key => items.reduce((total, item) => total + (Number.isFinite(item[key]) ? item[key] : 0), 0);
      const rows = items.map(item => `<li>${esc(item.label || '联系人')}：${item.status === 'error' ? esc(item.error) : `${item.count} 条${item.span?.from ? ` · ${esc(item.span.from)} 至 ${esc(item.span.to)}` : ''}`}</li>`).join('');
      const dialog = document.createElement('dialog'); dialog.className = 'ai-confirm-dialog ai-analysis-length-dialog';
      dialog.innerHTML = `<h3>聊天内容过长</h3><p>所选范围内共有 ${sum('count')} 条聊天记录，超出单次分析的上限。</p><p>继续分析只会覆盖最近约 ${sum('directCount')} 条，较早的记录不会出现在报告里。想看完整范围，可以取消后自行筛选日期、缩小时间范围再分析。</p>${rows ? `<ul class="ai-analysis-length-list">${rows}</ul>` : ''}<form method="dialog" class="ai-actions"><button class="secondary" value="cancel">取消</button><button class="primary" value="truncate">继续分析</button></form>`;
      dialog.addEventListener('close', () => { const choice = dialog.returnValue; dialog.remove(); resolve(choice === 'truncate' ? choice : null); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  function showLogDetail(key) {
    const entry = state.events.find(e => String(e.id || e.at) === key); if (!entry) return;
    const profile = state.profiles.find(p => p.id === entry.target), dialog = document.createElement('dialog');
    dialog.className = 'ai-confirm-dialog';
    dialog.innerHTML = `<h3>运行记录详情</h3><p>对象：${profile ? profileName(profile) : '系统'}</p><p>时间：${esc(new Date(entry.at).toLocaleString('zh-CN', { hour12: false }))}</p><p>结果：${esc(profile?.kind === 'group' && entry.code === 'uncertain' ? '发送结果未确认，本轮不会重发，后续群消息仍会处理' : eventLabels[entry.code] || ({ wait: '等待', pause: '暂停', resumed: '已恢复', 'not-sent': '未发送' })[entry.code] || entry.code)}</p><p>触发方式：${esc(({ reply: '个人自动回复', proactive: '主动聊天', atMe: '@我', atAll: '@所有人', realtime: '群聊实时回复' })[entry.source] || '状态更新')}</p><p>该条记录不保存聊天正文。可查看当前聊天及自动回复状态。</p><form method="dialog"><button class="primary">关闭</button></form>`;
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
  const replyProfiles = new Set();
  const learnedProfiles = () => selectProfiles().filter(p => p.learnedAt && p.learnedStyle);
  // 学习默认风格面向单个联系人，不提供群聊；批量学习风格则两者都可选。
  const pickerKinds = () => tab === 'default-style' ? ['person'] : ['person', 'group'];
  const modeTargets = mode => state[`${mode}Targets`] || state.targets;
  const replyStrategy = () => state.replyStrategy || state.strategy;
  const needsContacts = () => !state.contacts?.length;
  const operationText = operation => operation?.phase?.startsWith('analysis-') ? `正在${operation.phase === 'analysis-model' ? '分析' : '读取'}聊天记录 ${operation.completed}/${operation.total}` : operation ? operation.phase === 'contacts' ? operation.total ? `正在获取联系人 ${operation.completed}/${operation.total}` : '正在读取通讯录…' : operation.phase === 'memory' ? `正在学习聊天记忆 ${operation.completed}/${operation.total} 批，请勿关闭页面` : operation.phase === 'model' ? `正在分析 ${operation.total} 位联系人的聊天风格…` : `正在读取聊天 ${operation.completed}/${operation.total}` : '';
  const back = title => `<div class="ai-page-heading"><button type="button" class="quiet" data-ai-nav="overview">${icon('arrow-l')}返回自动回复</button><h3>${title}</h3></div>`;
  const steps = (labels, current) => `<ol class="ai-steps" aria-label="配置进度">${labels.map((label, i) => `<li ${i === current ? 'aria-current="step"' : ''} class="${i < current ? 'complete' : ''}"><span>${i + 1}</span>${label}</li>`).join('')}</ol>`;
  const noteActivity = () => {
    if (!id || !state?.settings.enabled || Date.now() - lastActivity < 1000) return;
    lastActivity = Date.now();
    void api(`/instances/${id}/ai`, { action: 'activity' }, 5000).catch(() => {});
  };
  for (const event of ['pointerdown', 'keydown', 'paste', 'wheel']) document.querySelector('#desktop-screen').addEventListener(event, noteActivity, true);
  const selectedContacts = new Set();
  const $ = selector => panel.querySelector(selector);
  const proactiveUI = createProactiveUI({
    panel, getState: () => state, context: () => generation, isBusy: () => busy,
    mutate: (value, saved, success) => workflow(async step => { await step('proactive-task', { value }); saved(); }, success),
    // 主动聊天只负责发起：没开自动回复的联系人，对方此后的回复不会被处理。
    // 这里只提供发起时的快捷开启，不做后端兜底接管。
    enableReply: contacts => workflow(async step => {
      for (const contact of contacts) await step('reply-options', { value: { contact, enabled: true } });
    }, contacts.length > 1 ? `已为 ${contacts.length} 位联系人开启自动回复` : '已开启自动回复'),
    render,
    refreshContacts: () => refreshContacts({ manual: true }),
    showRecords: async taskId => {
      logFilters = { ...logFilters, taskId, source: 'proactive', page: 0 };
      proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordLoading = false; proactiveRecordEpoch++;
      await navigate('activity');
    },
  });
  const reviewAlert = document.createElement('a'); reviewAlert.href = '#ai-review'; reviewAlert.className = 'ai-review-alert'; reviewAlert.hidden = true; rail.append(reviewAlert);
  reviewAlert.addEventListener('click', event => { event.preventDefault(); show(); void navigate('activity').catch(e => message(e.message, true)); });
  panel.addEventListener('click', event => {
    const resume = event.target.closest('[data-ai-resume-profile]');
    if (resume) {
      event.preventDefault(); const p = state.profiles.find(p => p.id === resume.dataset.aiResumeProfile);
      if (p) void execute('profile', { id: p.id, value: { style: p.style, paused: false } }, '已开启，将处理后续新消息').catch(error => message(error.message, true));
      return;
    }
    const open = event.target.closest('[data-ai-open-conversation]');
    if (open) { event.preventDefault(); void openConversation(open.dataset.aiOpenConversation).catch(error => message(error.message, true)); return; }
  });
  const message = (text, error = false) => { const node = $('#ai-feedback'); node.textContent = text; node.classList.toggle('error', error); node.hidden = !text; };
  function confirmAnalysisDelete() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'ai-confirm-dialog';
      let confirmed = false;
      dialog.innerHTML = '<h3>删除分析报告？</h3><p>仅删除这份分析报告，不会删除微信聊天记录。</p><div class="ai-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="danger" data-confirm>删除报告</button></div>';
      const finish = () => { dialog.remove(); resolve(confirmed); };
      dialog.addEventListener('close', finish, { once: true });
      dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); }, { once: true });
      dialog.addEventListener('click', event => { const button = event.target.closest('button'); if (!button) return; if (button.hasAttribute('data-confirm')) confirmed = true; dialog.close(); });
      document.body.append(dialog); dialog.showModal();
    });
  }
  async function deleteAnalysisReport(reportId) {
    const current = generation, target = id, account = state?.account, epoch = analysisHistoryEpoch;
    if (!await confirmAnalysisDelete()) return false;
    if (current !== generation || target !== id || account !== state?.account || epoch !== analysisHistoryEpoch) { message('账号或页面已变化，请重新打开历史报告', true); return false; }
    const result = await api(`/instances/${target}/ai`, { action: 'analysis-report-delete', id: reportId }, 30000);
    if (current !== generation || target !== id || account !== state?.account || epoch !== analysisHistoryEpoch) return false;
    state.analysis = { ...(state.analysis || {}), history: result.history || [] };
    if (analysisResult?.reports?.some(report => report.historyId === reportId)) analysisResult = null;
    if (analysisHistoryReport?.id === reportId) analysisHistoryReport = null;
    render(); message('分析报告已删除'); return true;
  }
  async function call(action, extras = {}) {
    const current = generation, target = id, epoch = action ? ++requestEpoch : requestEpoch;
    // 未挂载实例时不要用空 id 发请求（会落到不存在的路由上），先补挂载或明确提示。
    if (!target) throw new Error('AI 辅助尚未就绪，请重新打开微信后再试');
    let result;
    try { result = await api(`/instances/${target}/ai`, action ? { action, ...extras } : undefined, ['learn', 'scan'].includes(action) ? 30 * 60 * 1000 : 130000); }
    catch (error) { if (current !== generation || target !== id || epoch !== requestEpoch) return null; throw error; }
    if (current !== generation || target !== id || epoch !== requestEpoch) return null;
    if (state && state.account !== result.account) {
      analysisHistoryEpoch++; analysisHistoryReport = null; analysisResult = null;
      recordCache.delete(id); logEpoch++; proactiveRecordEpoch++; errorEpoch++;
      logRecords = []; proactiveHistory = []; proactiveHistoryPage = null; errorHistory = []; errorPage = null; errorLoading = false; logLoading = false; proactiveRecordLoading = false; logSignature = '';
    }
    state = result; return result;
  }
  function selectProfiles(includePaste = true) { return (state?.profiles || []).filter(p => includePaste || p.contact && state.contacts.some(c => c.id === p.contact)); }
  function scopeOptions(selected = '') { return option('', '通用策略', !selected) + selectProfiles().map(p => option(p.id, p.label, p.id === selected)).join(''); }
  function controls() {
    if (!state) return;
    // 记忆合并在后台跑，轮询拿到新状态时重画对象页，让合并结果立刻可确认。
    const memoryPending = JSON.stringify((state.profiles || []).map(p => [p.id, p.pendingMemoryAt || 0, p.pendingMemorySource || '', p.memoryMerge?.status || '']));
    if (memoryPending !== memoryPendingSignature) {
      memoryPendingSignature = memoryPending;
      if (['overview', 'profile'].includes(tab)) { render(); return; }
    }
    for (const input of document.querySelectorAll('[data-ai-setting]')) input.checked = !!state.settings[input.dataset.aiSetting];
    const panelMaster = panel.querySelector('[data-ai-panel-master]'); if (panelMaster) panelMaster.checked = state.settings.enabled;
    const masterLabel = panel.querySelector('#ai-panel-master-label'); if (masterLabel) masterLabel.textContent = state.settings.enabled ? 'AI 已开启' : 'AI 已关闭';
    const pending = (state.activity || []).filter(p => p.needsHelp); reviewAlert.hidden = !pending.length; reviewAlert.textContent = `需处理 ${pending.length}`;
    $('#ai-operation').hidden = !state.operation && !contactsLoading;
    $('#ai-operation-text').textContent = operationText(state.operation) || (contactsLoading ? '正在获取联系人…' : '');
    const readiness = $('#ai-readiness');
    if (readiness) {
      const needs = [...new Set([state.requirements.proactive, state.requirements.reply].filter(Boolean))];
      readiness.textContent = needs.length ? needs.join('；') : '已完成准备，可以选择需要运行的功能';
    }
    proactiveUI.refresh();
    if (tab === 'activity') {
      const liveBox = $('#ai-live-box'); if (liveBox) liveBox.innerHTML = liveActivityBox(state);
      const errBox = $('#ai-recent-errors'); if (errBox) errBox.innerHTML = recentErrorsBox(activityState(), logFilters.errorsOpen, errorLoading);
      const proactiveRecords = $('#ai-proactive-records'); if (proactiveRecords) proactiveRecords.innerHTML = proactiveRecordRows(activityState(), logFilters, proactiveRecordLoading);
      const skipRecords = $('#ai-skip-records'); if (skipRecords) skipRecords.outerHTML = skipRecordsView(state);
    }
    if (state.notice) { const note = $('#ai-state-notice'); if (note) note.textContent = state.notice; }
  }
  function replyContactList() {
    const query = replyContactSearch.trim().normalize('NFKC').toLocaleLowerCase();
    const contacts = (state.contacts || []).filter(c => c.kind === 'person' && (!query || searchableContact(c).includes(query)));
    return contacts.map(contact => {
      const profile = selectProfiles().find(p => p.contact === contact.id), applied = profile && (state.settings.replyScope === 'all' || modeTargets('reply').includes(profile.id));
      const strategy = profile && { ...replyStrategy(), ...(profile.strategy || {}), ...(profile.replyStrategy || {}) };
      return `<article class="ai-reply-contact" data-ai-reply-contact="${esc(contact.id)}"><strong>${contactName(contact)}</strong><div class="ai-contact-strategy" data-ai-contact-strategy aria-label="${esc(contact.label)}的回复策略">${applied ? `${styleSummary(profile)}<p class="ai-help">回复目的：${esc(strategy.replyGoal)}</p>` : ''}</div><div class="ai-actions"><button type="button" class="secondary" data-ai-manual-contact="${esc(contact.id)}">${applied ? '调整回复风格' : '选择回复风格'}</button><button type="button" class="quiet" data-ai-learn-contact="${esc(contact.id)}" title="学习风格或记忆，可选择学习目标">学习</button>${profile?.learnedAt ? `<button type="button" class="quiet" data-ai-profile="${esc(profile.id)}">查看学习结果</button>${!applied ? `<button type="button" class="quiet" data-ai-apply-contact="${esc(contact.id)}">应用聊天风格</button>` : ''}` : ''}</div></article>`;
    }).join('') || `<p class="ai-help">${query && state.contacts?.length ? '没有找到匹配的联系人' : contactsLoading ? '正在获取联系人…' : contactsLoaded ? '暂未获取到联系人，请确认微信已登录后刷新。' : '打开后会获取联系人，也可以点击刷新联系人。'}</p>`;
  }
  function provider() { return providerPage(state, modelDraft, { back: `<button type="button" class="quiet ai-learning-back" data-ai-nav="settings">${icon('arrow-l')}返回系统设置</button>` }); }
  function providerDraft() {
    const form = $('#ai-model-form'), data = new FormData(form);
    const value = { ...Object.fromEntries(data), timeout: Number(data.get('timeout')), consent: data.has('consent'), keyStored: form.elements.apiKey.dataset.keyStored === 'true' };
    if (value.keyStored) delete value.apiKey;
    return value;
  }
  function rememberProvider() {
    const form = $('#ai-model-form');
    if (!form || !modelDraft?.editing) return;
    const value = providerDraft();
    modelDraft.form = { ...modelDraft.form, ...value, preset: $('#ai-model-preset')?.value || '', status: modelDraft.status };
    const id = modelDraft.editing;
    modelDraft.models = modelDraft.models.map(m => m.id === id ? { ...m, label: value.label || value.model, baseUrl: value.baseUrl, model: value.model, protocol: value.protocol, timeout: value.timeout, consent: value.consent, apiKey: value.keyStored ? m.apiKey : (value.apiKey || ''), hasKey: value.keyStored || !!value.apiKey, tested: m.tested && value.keyStored && m.baseUrl === value.baseUrl && m.model === value.model && m.protocol === value.protocol && m.timeout === value.timeout && m.consent === value.consent ? m.tested : false } : m);
  }
  function concealKey(clearTyped = false) {
    revealRevision++;
    const form = $('#ai-model-form');
    if (!form) return;
    const input = form.elements.apiKey;
    if (clearTyped) {
      const stored = !!modelDraft?.editing && modelDraft.editing !== 'new' && !!modelDraft.models.find(m => m.id === modelDraft.editing)?.hasKey;
      input.dataset.keyStored = String(stored);
      input.value = stored ? KEY_MASK : '';
    } else if (input.dataset.keyStored === 'true') input.value = KEY_MASK;
    input.type = 'password';
    const button = $('[data-ai-action=toggle-key]');
    button.dataset.revealing = ''; button.innerHTML = keyIcon(false); button.setAttribute('aria-label', '展示 API Key'); button.setAttribute('aria-pressed', 'false');
    rememberProvider();
  }
  async function toggleKey() {
    const form = $('#ai-model-form'), input = form.elements.apiKey, button = $('[data-ai-action=toggle-key]');
    if (input.type === 'text' || button.dataset.revealing === 'true') { concealKey(); return; }
    if (input.dataset.keyStored !== 'true') {
      input.type = 'text'; button.innerHTML = keyIcon(true); button.setAttribute('aria-label', '隐藏 API Key'); button.setAttribute('aria-pressed', 'true'); return;
    }
    const target = id, current = generation, revision = providerRevision, token = ++revealRevision, modelId = modelDraft?.editing, service = serviceIdentity(providerDraft());
    const active = () => target === id && current === generation && token === revealRevision && revision === providerRevision && !panel.hidden && $('#ai-model-form') === form && modelDraft?.editing === modelId && serviceIdentity(providerDraft()) === service && input.dataset.keyStored === 'true';
    button.dataset.revealing = 'true'; button.innerHTML = keyIcon(true);
    try {
      const result = await api(`/instances/${target}/ai`, { action: 'reveal-key', ...(modelId && modelId !== 'new' && modelId !== 'legacy' ? { modelId } : { scope: 'chat' }) }, 130000);
      if (!active()) return;
      if (serviceIdentity(result) !== service || typeof result.apiKey !== 'string' || !result.apiKey) throw new Error('模型配置已变化，请重新打开模型设置');
      input.value = result.apiKey; input.type = 'text'; button.innerHTML = keyIcon(true); button.setAttribute('aria-label', '隐藏 API Key'); button.setAttribute('aria-pressed', 'true');
    } catch (error) { if (active()) { concealKey(); message(error.message, true); } }
    finally { if (active()) button.dataset.revealing = ''; }
  }
  function validateProvider(action) {
    const form = $('#ai-model-form');
    if (action !== 'models') return form.reportValidity();
    return ['baseUrl', 'apiKey', 'timeout'].every(key => form.elements[key].reportValidity());
  }
  function stageModel() {
    const form = $('#ai-model-form');
    if (!form || !modelDraft?.editing) return;
    if (!validateProvider('configure')) return;
    const value = providerDraft(), editing = modelDraft.editing;
    const id = editing !== 'new' ? editing : (modelDraft.draftId || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const list = modelDraft.models.filter(m => m.id !== id);
    const first = editing === 'new' && !list.length;
    list.push({ id, label: value.label || value.model, baseUrl: value.baseUrl, model: value.model, protocol: value.protocol || 'openai', timeout: value.timeout, consent: value.consent, hasKey: value.keyStored || !!value.apiKey, apiKey: value.keyStored ? undefined : (value.apiKey || ''), tested: false, usedBy: [] });
    const assignments = { ...modelDraft.assignments };
    for (const key of Object.keys(assignments)) if (first || assignments[key] === editing) assignments[key] = id;
    modelDraft = { models: list, assignments, editing: null, draftId: undefined, form: null, status: '模型已加入列表，点击“保存”后生效' };
    render(); message('已添加模型，请在功能分配中确认后点击“保存”');
  }
  async function saveModelsAction() {
    const current = generation, target = id;
    const list = modelDraft?.models || state.models || [];
    const models = list.map(({ id, label, baseUrl, model, protocol, timeout, consent, apiKey }) => ({ id, label, baseUrl, model, protocol, timeout, consent, ...(apiKey ? { apiKey } : {}) }));
    const assignments = modelDraft?.assignments || state.assignments || {};
    const result = await execute('models-save', { value: { models, assignments } }, '模型设置已保存并生效');
    if (!result || current !== generation || target !== id) return;
    modelDraft = null;
    render();
  }
  async function probeProvider(action) {
    if (busy) throw new Error('请等待当前操作完成');
    const form = $('#ai-model-form'), value = providerDraft(), modelId = modelDraft?.editing;
    if (!validateProvider(action)) return;
    if (action !== 'models' && !value.consent) throw new Error('请确认将选定聊天发送至此模型服务');
    const current = generation, target = id, signature = JSON.stringify(value), revision = providerRevision;
    busy = true; panel.setAttribute('aria-busy', 'true'); message(action === 'models' ? '正在拉取模型…' : '正在测试连接…');
    if (action === 'models') $('#ai-model-status').textContent = '正在拉取模型…';
    try {
      if (action === 'test') {
        const result = await api(`/instances/${target}/ai`, { action: 'model-test', value: { ...value, modelId: modelId && modelId !== 'new' ? modelId : (modelDraft?.draftId || undefined) } }, 130000);
        if (!result || current !== generation || target !== id) return;
        if ($('#ai-model-form') === form && providerRevision === revision && modelDraft?.editing === modelId && JSON.stringify(providerDraft()) === signature) {
          modelDraft = { ...modelDraft, status: '连接测试通过' };
          rememberProvider(); render(); message('模型连接成功');
        } else message('已测试提交的配置，当前改动仍需保存并测试');
      } else {
        const result = await api(`/instances/${target}/ai`, { action: 'models', value: { ...value, modelId: modelId && modelId !== 'new' ? modelId : (modelDraft?.draftId || undefined) }, scope: 'chat' }, 130000);
        if (current !== generation || target !== id || $('#ai-model-form') !== form) return;
        if (JSON.stringify(providerDraft()) !== signature) { message('配置已修改，请重新拉取模型'); return; }
        $('#ai-model-choice').innerHTML = option('', '请选择对话模型', true) + result.models.map(x => option(x, x, false)).join('');
        $('#ai-model-status').textContent = `已拉取 ${result.models.length} 个模型，请选择或手动填写。`;
        message(`已拉取 ${result.models.length} 个候选模型，请选择对话模型并测试连接`);
      }
    } catch (error) { if (current === generation) { message(error.message, true); if (action === 'models' && $('#ai-model-status')) $('#ai-model-status').textContent = error.message; } }
    finally { if (current === generation) { busy = false; panel.setAttribute('aria-busy', 'false'); } }
  }
  function openModelEditor(id) {
    const presets = state.schema?.providerPresets || [];
    const list = (modelDraft?.models || state.models || []).map(m => ({ ...m }));
    const base = id === 'new' ? null : list.find(m => m.id === id);
    const preset = base ? (presets.find(x => x.baseUrl === base.baseUrl && x.protocol === (base.protocol || 'openai'))?.id || 'custom') : (presets[0]?.id || 'custom');
    const starter = base || presets[0] || { protocol: 'openai', baseUrl: '', model: '', timeout: 60 };
    modelDraft = {
      models: list, assignments: { ...(modelDraft?.assignments || state.assignments || {}) }, editing: id, draftId: id === 'new' ? `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined,
      form: { label: base?.label || '', preset, protocol: starter.protocol || 'openai', baseUrl: base?.baseUrl || starter.baseUrl || '', apiKey: '', keyStored: !!base?.hasKey, model: base?.model || starter.model || '', timeout: base?.timeout || starter.timeout || 60, consent: !!base?.consent },
      status: '',
    };
    render();
  }
  function deleteModel(id) {
    const models = (modelDraft?.models || state.models || []).filter(m => m.id !== id);
    const assignments = { ...(modelDraft?.assignments || state.assignments || {}) };
    const fallback = models[0]?.id || null;
    for (const key of Object.keys(assignments)) if (assignments[key] === id) assignments[key] = fallback;
    modelDraft = { models, assignments, editing: null, form: null, status: '已删除模型，点击“保存”后生效' };
    render();
  }
  function applyModelToAll(id) {
    const current = modelDraft?.models || state.models || [];
    modelDraft = { ...(modelDraft || { models: current, assignments: { ...(state.assignments || {}) }, editing: null, form: null, status: '' }), assignments: { chat: id, learningAnalysis: id }, status: `已将“${current.find(m => m.id === id)?.label || '该模型'}”应用于全部功能，点击“保存”后生效` };
    render();
  }
  async function testListModel(modelId) {
    if (busy) throw new Error('请等待当前操作完成');
    const list = modelDraft?.models || state.models || [];
    const m = list.find(x => x.id === modelId);
    if (!m) throw new Error('模型已变化，请重新打开模型设置');
    const current = generation, target = id, token = ++revealRevision;
    busy = true; panel.setAttribute('aria-busy', 'true'); message('正在测试连接…');
    try {
      const result = await api(`/instances/${target}/ai`, { action: 'model-test', value: { id: m.id, label: m.label, baseUrl: m.baseUrl, model: m.model, protocol: m.protocol, timeout: m.timeout, consent: m.consent, modelId: m.id, ...(m.apiKey ? { apiKey: m.apiKey } : {}) } }, 130000);
      if (!result || current !== generation || target !== id || token !== revealRevision) return;
      if (modelDraft) { modelDraft = { ...modelDraft, models: modelDraft.models.map(x => x.id === modelId ? { ...x, tested: true } : x), status: '模型连接成功' }; render(); }
      else message('模型连接成功');
    } catch (error) { if (current === generation) message(error.message, true); }
    finally { if (current === generation) { busy = false; panel.setAttribute('aria-busy', 'false'); } }
  }
  const summaryText = styleSummaryText;
  function styleSummary(p) {
    return '<div class="ai-style-summary ai-style-text">' + esc(summaryText(p.style)) + (p.style.customAvoid ? '<p>注意：' + esc(p.style.customAvoid) + '</p>' : '') + '</div>';
  }
  function resizeWikiTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, 42)}px`;
  }
  function wikiEntries(form) {
    const list = form?.querySelector('[data-ai-wiki-entities]'); if (!list) return [];
    return [...list.querySelectorAll('.ai-wiki-bubble')].map(row => {
      const field=row.querySelector('select[aria-label="信息类型"]').value, temporal=['residence','workplace','employer','shipping'].includes(field), calendar=['birthday','date'].includes(field), rawRecorded=row.querySelector('[data-ai-wiki-recorded]')?.value, recordedAt=rawRecorded ? Number(rawRecorded) : undefined;
      return { ...(row.querySelector('[data-ai-wiki-id]')?.value ? { id: row.querySelector('[data-ai-wiki-id]').value } : {}), field, text: row.querySelector('[aria-label="信息内容"]').value.trim(), ...(field==='school' && row.querySelector('[aria-label="学历"]')?.value ? { degree: row.querySelector('[aria-label="学历"]').value } : {}), ...(calendar && row.querySelector('select[aria-label="生日历法"]')?.value ? { calendar: row.querySelector('select[aria-label="生日历法"]').value } : {}), ...(temporal && Number.isSafeInteger(recordedAt) && recordedAt > 0 ? { recordedAt } : {}) };
    }).filter(x => x.text);
  }
  function styleResults(profiles, editable = true) {
    if (!profiles.length) return '';
    const edit = p => `<button type="button" class="quiet" data-ai-profile="${esc(p.id)}">${profileName(p)} · ${editable ? '调整' : '查看'}${p.paused ? ' · 待你处理' : ''}</button>`;
    return profiles.map(p => `<details class="ai-style-group" data-ai-result-profile="${esc(p.id)}" open><summary>${profileName(p)}</summary><h4>风格</h4>${styleSummary(p)}<h4>记忆</h4><p class="ai-result-memory">${esc(p.memory?.summary || '暂无明确记忆')}</p>${(p.replyStrategy?.replyGoal || p.strategy?.replyGoal) ? `<p class="ai-help">专属回复目的：${esc(p.replyStrategy?.replyGoal || p.strategy.replyGoal)}</p>` : ''}${edit(p)}</details>`).join('');
  }
  function contactPickerRows(contacts, query) {
    const q = (query || '').trim().normalize('NFKC').toLocaleLowerCase();
    const rows = contacts.filter(c => !q || searchableContact(c).includes(q)).map(c => `<label class="ai-check"><input type="checkbox" data-ai-contact="${esc(c.id)}" ${selectedContacts.has(c.id) ? 'checked' : ''} ${!['person', 'group'].includes(c.kind) ? 'disabled' : ''}><span>${contactName(c)}${learnedProfiles().some(p => p.contact === c.id) ? '<small class="ai-badge blue">已学习</small>' : ''}${c.kind === 'group' ? '<small>群聊</small>' : ''}</span></label>`).join('');
    if (rows) return rows;
    if (q) return '<p class="ai-help">未找到匹配的联系人。</p>';
    return `<p class="ai-help">${contactsLoading ? '正在获取联系人…' : '暂未获取到联系人，请确认微信已登录后刷新。'}</p>`;
  }
  function contactPicker(headingSide = '', note = '', kinds = null) {
    const contacts = (state.contacts || []).filter(c => (kinds || ['person', 'group']).includes(c.kind));
    const search = contacts.length ? `<label class="ai-analysis-search ai-contact-search">${icon('search')}<span class="sr-only">搜索联系人</span><input id="ai-contact-search" type="search" placeholder="搜索联系人…" value="${esc(contactSearch)}"></label>` : '';
    return `<section class="ai-card ai-learning-contacts"><div class="ai-card-heading"><div><h4>选择联系人</h4><p>${note || '勾选要学习聊天风格的联系人或群聊。每位联系人单独学习并保存。'}</p></div>${headingSide}</div><div class="ai-actions ai-learning-contact-actions"><button type="button" class="secondary" data-ai-action="scan">${icon('refresh')}刷新联系人</button><button type="button" class="quiet" data-ai-action="select-contacts">选择未学习的联系人</button><button type="button" class="quiet" data-ai-action="clear-contacts">取消选择</button></div>${search}<div class="ai-contact-list" aria-label="选择联系人">${contactPickerRows(contacts, contactSearch)}</div><p id="ai-contact-count" class="ai-help ai-learning-count" aria-live="polite">已选择 ${selectedContacts.size} 位联系人</p></section>`;
  }
  function learnTargetCards() {
    return `<div class="ai-learn-targets" role="radiogroup" aria-label="学习目标">${LEARN_TARGETS.map(t => `<label class="ai-learn-target${learnTarget === t.id ? ' selected' : ''}"><input type="radio" name="learnTarget" value="${esc(t.id)}" ${learnTarget === t.id ? 'checked' : ''}><span class="ai-learn-target-mark" aria-hidden="true"></span><span class="ai-learn-target-text"><strong>${esc(t.label)}</strong><small>${esc(t.hint)}</small></span></label>`).join('')}</div>`;
  }
  function learning() {
    const target = LEARN_TARGETS.find(t => t.id === learnTarget) || LEARN_TARGETS[0];
    return `<div class="ai-learning-page"><div class="ai-page-heading ai-learning-page-heading"><div><button type="button" class="quiet ai-learning-back" data-ai-nav="overview">${icon('arrow-l')}返回自动回复</button><h3>批量学习风格与记忆</h3><p>每位联系人单独读取、学习和保存；粘贴聊天学习已移至系统设置中的“学习默认风格”。</p></div></div><section class="ai-card ai-learning-hero"><div class="ai-learning-hero-lead"><span class="ai-learning-hero-icon">${icon('sparkle')}</span><div><h4>从聊天中学习风格与记忆</h4><p>可同时选择多位联系人或群聊，每位单独处理。</p></div></div><div class="ai-learning-hero-side"><div class="ai-learning-targets-card"><h4>学习目标</h4>${learnTargetCards()}${learnTarget === 'memory' ? '<p class="ai-help">每位联系人的记忆独立学习后放入待确认区，可逐位替换或与原有记忆合并。</p>' : ''}</div><div class="ai-learning-run"><button type="button" class="primary" data-ai-action="learn-selected" ${selectedContacts.size ? '' : 'disabled'}>${icon('sparkle')}开始${esc(target.label === '风格 + 记忆' ? '学习' : target.label)}</button>${learnedProfiles().length ? '<button type="button" class="secondary" data-ai-nav="results">查看学习结果</button>' : ''}</div></div></section>${contactPicker('', learnTarget === 'memory' ? '选择要单独学习聊天记忆的联系人或群聊。' : learnTarget === 'style' ? '选择要单独更新聊天风格的联系人或群聊；已保存的聊天记忆不会被修改。' : '选择要单独学习风格与记忆的联系人或群聊。')}<section class="ai-card ai-learning-range"><div class="ai-card-heading"><div><h4>学习时间范围</h4><p>${learnTarget === 'memory' ? '默认使用全部聊天记录；也可先按时间范围筛选后再学习记忆。' : '只使用该时间范围内的聊天记录进行学习，默认使用全部记录。'}</p></div></div>${dateRangeField('learning',learnRange)}</section></div>`;
  }
  function chooseLearnTarget(title) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ai-calendar-dialog ai-learn-target-dialog';
      let confirmed = null;
      dialog.innerHTML = `<h3>选择学习目标</h3><p class="ai-help">${esc(title)}</p>${learnTargetCards()}<footer class="ai-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="primary" data-apply>开始学习</button></footer>`;
      dialog.addEventListener('close', () => { dialog.remove(); resolve(confirmed); }, { once: true });
      dialog.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button) return;
        if (button.hasAttribute('data-cancel')) dialog.close();
        if (button.hasAttribute('data-apply')) { confirmed = dialog.querySelector('input[name=learnTarget]:checked')?.value || 'both'; learnTarget = confirmed; dialog.close(); }
      });
      document.body.append(dialog); dialog.showModal();
    });
  }
  function pasteModule() {
    return `<details class="ai-paste"><summary>${icon('plus')}粘贴聊天学习</summary><form id="ai-paste-form"><label class="ai-field">聊天内容<textarea name="text" required maxlength="90000" rows="7" placeholder="我：……&#10;对方：……"></textarea></label><p class="ai-help">学习结果将更新默认风格，用于没有单独风格的联系人自动回复。</p><button type="submit" class="primary">学习这段聊天</button></form></details>`;
  }
  function defaultStyleLearning() {
    const ds = state.learnedDefaultStyle || null;
    const perspective = defaultStylePerspective;
    const perspectiveLabel = p => p === 'other' ? '对方的风格' : '自己与对方聊天的风格';
    const meta = ds ? `${perspectiveLabel(ds.perspective)}${ds.source === 'paste' ? ' · 来自粘贴的聊天' : ` · 基于 ${ds.labels?.length || ds.contacts?.length || 0} 位联系人的聊天`}${ds.learnedAt ? ` · ${new Date(ds.learnedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}` : '';
    const current = ds ? `<section class="ai-card"><div class="ai-card-heading"><div><h4>当前默认风格</h4><p>${esc(meta)}，将应用于没有单独风格的联系人自动回复。</p></div></div><form id="ai-default-style-form"><label class="ai-field">风格总结（可修改）<textarea name="summary" maxlength="6000" rows="6" placeholder="用自然语言描述默认的口吻与表达习惯">${esc(ds.style?.summary || summaryText(ds.style))}</textarea></label><div class="ai-actions"><button type="submit" class="primary">保存</button><button type="button" class="secondary" data-ai-action="cancel-default-style">取消</button></div><p class="ai-help">保存：保存这份默认风格并同步给所有联系人与群聊，选择「默认风格」的对象会换成最新内容并继续跟随账号默认风格的更新；只有改动过说明文字才会变成该对象自己的【自定义】风格。取消：撤销本次学习的内容，默认风格恢复到学习前那一份；学习前没有默认风格（或本次学习已经保存过）时，取消即清除默认风格。</p></form></section>` : '';
    const backLabel = ({ overview: '自动回复', settings: '系统设置', results: '学习结果', learning: '学习聊天风格', profile: '学习结果', 'manual-reply': '自动回复' })[defaultStyleReturn] || '系统设置';
    return `<div class="ai-default-style-page"><div class="ai-page-heading ai-learning-page-heading"><div><button type="button" class="quiet ai-learning-back" data-ai-nav="${esc(defaultStyleReturn)}">${icon('arrow-l')}返回${esc(backLabel)}</button><h3>学习默认风格</h3><p>从联系人聊天中按语言、节奏、互动和情感表达学习，再汇总成一份默认风格。</p></div></div>${current}${contactPicker(`<div class="ai-learning-heading-tools"><button type="button" class="primary" data-ai-action="learn-default" ${selectedContacts.size ? '' : 'disabled'}>${icon('sparkle')}学习默认风格</button>${dateRangeField('learning',learnRange,{compact:true,label:'时间筛选'})}</div>`, '勾选联系人；每位联系人单独学习后，再汇总成一份默认风格。', ['person'])}<section class="ai-card">${pasteModule()}</section></div>`;
  }
  function results() {
    const profiles = learnedProfiles().filter(p => !resultProfileIds || resultProfileIds.has(p.id));
    return back('学习结果') + (profiles.length ? profiles.map(p => styleResults([{...p,style:p.pendingStyle || p.style}]) + '<div class="ai-actions ai-result-footer"><button type="button" class="secondary" data-ai-nav="overview">取消</button>' + (p.contact && state.contacts.some(c => c.id === p.contact) ? '<button type="button" class="primary" data-ai-apply-result="' + esc(p.id) + '">应用到 ' + profileName(p) + ' 聊天</button>' : '') + '</div>').join('') : '<p class="ai-empty">还没有学习结果</p>');
  }
  function advancedSettings() {
    const rule = state.settings.takeover || {enabled:true,minutes:5};
    return '<div class="ai-page-heading"><div><h3>系统设置</h3><p>管理模型配置与 AI 回复的通用行为。</p></div></div><section class="ai-card ai-settings-group"><button type="button" class="ai-settings-entry" data-ai-nav="provider"><span class="ai-settings-entry-icon">' + icon('sliders') + '</span><span class="ai-settings-entry-text"><strong>模型设置</strong><small>为聊天回复、主动聊天、风格学习、聊天分析分别选择模型</small></span><span class="ai-settings-entry-arrow">' + icon('chev-r') + '</span></button><button type="button" class="ai-settings-entry" data-ai-nav="default-style"><span class="ai-settings-entry-icon">' + icon('sparkle') + '</span><span class="ai-settings-entry-text"><strong>学习默认风格</strong><small>选择联系人的聊天记录学习，作为没有单独风格时的默认口吻</small></span><span class="ai-settings-entry-arrow">' + icon('chev-r') + '</span></button></section><section class="ai-card">' + switchRow('acknowledgeAI','被问及身份时承认 AI','开启后，仅被询问时说明由 AI 回复；关闭后按本人身份回答。') + '</section><form id="ai-takeover-form" class="ai-card"><h4>AI 辅助等待</h4><label class="ai-switch-row"><span>开启 AI 辅助等待<small>开启后，每次手动回复后，从对方第一条新消息开始等待设定时长；同一轮后续消息不会延长等待。首次自动回复成功后恢复正常回复节奏；再次手动回复会重新开始等待。</small></span><input type="checkbox" name="enabled" role="switch" aria-label="开启 AI 辅助等待" '+(rule.enabled?'checked':'')+'></label><div data-takeover-minutes '+(rule.enabled?'':'hidden')+'><label class="ai-field">等待时长（分钟）<input name="minutes" type="number" min="1" max="10080" required value="'+rule.minutes+'" '+(rule.enabled?'':'disabled')+'></label></div><p class="ai-help">关闭后，手动回复会关闭对应联系人的自动回复开关；群聊会关闭该群的自动回复触发开关。其他联系人的设置不受影响。</p><button class="primary" type="submit">保存设置</button></form>';
  }
  function proactive() { return proactiveUI.page(); }
  function profileEditor(profile) {
    if (profile.pendingStyle) profile={...profile,style:profile.pendingStyle};
    const draft = profileDrafts.get(profile.id), v = { ...profile.style, summary: summaryText(profile.style), ...draft }, reply = { ...replyStrategy(), ...profile.replyStrategy, ...draft };
    return `<form id="ai-profile-form" data-id="${profile.id}"><button type="button" class="quiet" data-ai-action="back-learning">${icon('arrow-l')}返回学习结果</button><h3>${profileName(profile)}的聊天风格</h3>${field('summary', '风格总结（可修改）', v.summary, 6000, '例如：表达简洁，语气自然，不添加没有依据的称呼。')}${field('customAvoid', '注意事项（可选）', v.customAvoid, 1200)}${memoryFields({ ...profile, capabilities: state.capabilities }, draft?.memorySummary)}<details class="ai-paste"><summary>回复策略（可选）</summary>${field('replyGoal', '回复目的与立场', reply.replyGoal)}${field('facts', '允许使用的信息', reply.facts, 4000)}${field('boundaries', '注意事项', reply.boundaries)}<label class="ai-field">连续自动回复上限<input name="maxRounds" type="number" min="1" max="2000" value="${reply.maxRounds ?? 50}"></label></details><div class="ai-actions"><button type="submit" class="primary">保存风格</button><button type="button" class="quiet danger-link" data-ai-action="delete-profile">删除风格</button></div></form>`;
  }
  function manualReplyEditor() {
    const contact = state.contacts.find(c => c.id === editingReplyContact && c.kind === 'person');
    if (!contact) return back('回复风格') + '<p class="ai-help">请刷新联系人后重试。</p>';
    const v = manualReplyDrafts.get(contact.id), presets = state.schema.replyPresets || [], profile = selectProfiles().find(p => p.contact === contact.id);
    return `<form id="ai-manual-reply-form" data-contact="${esc(contact.id)}"><div class="ai-page-heading"><button type="button" class="quiet" data-ai-action="back-reply-contacts">${icon('arrow-l')}返回联系人列表</button><h3>${contactName(contact)}的回复风格</h3></div><label class="ai-field">选择风格<select id="ai-reply-preset" name="replyPreset">${presets.map(p => option(p.id, p.label, v.replyPreset === p.id)).join('')}${option('custom', '自定义', v.replyPreset === 'custom')}${learnedProfiles().length ? '<optgroup label="已学习的风格">' + learnedProfiles().map(p => option('learned:' + p.id, p.label, v.replyPreset === 'learned:' + p.id)).join('') + '</optgroup>' : ''}</select></label>${field('summary', '风格说明（可修改）', v.summary || summaryText(v), 6000)}<details class="ai-paste"><summary>注意事项与策略（可选）</summary>${field('customAvoid', '注意事项', v.customAvoid, 1200)}${field('replyGoal', '回复目的与立场', v.replyGoal)}${field('facts', '允许使用的信息', v.facts, 4000)}${field('boundaries', '不能擅自决定的事项', v.boundaries)}<label class="ai-field">连续自动回复上限<input name="maxRounds" type="number" min="1" max="2000" value="${v.maxRounds ?? 50}"></label></details><button type="submit" class="primary ai-wide">保存回复风格</button></form>`;
  }
  function rememberDraft() {
    const analysis = $('#ai-analysis-form');
    if (analysis) { const data = new FormData(analysis); analysisDraft = { request: data.get('request'), from: data.get('from'), to: data.get('to'), contacts: data.getAll('contacts') }; }
    const object = $('#ai-object-form');
    if (object) {
      const draft = { ...Object.fromEntries(new FormData(object)), folds: [...object.querySelectorAll("details[data-ai-fold][open]")].map(x => x.dataset.aiFold) };
      if (object.querySelector('[data-ai-wiki-entities]')) draft.memorySummary = JSON.stringify(wikiEntries(object));
      for (const input of object.querySelectorAll('[data-object-option]')) draft[input.dataset.objectOption] = input.checked;
      objectDrafts.set(selectedObject, draft);
    }
    rememberProvider();
    proactiveUI.remember();
    const profile = $('#ai-profile-form');
    if (profile) { const data = new FormData(profile); profileDrafts.set(profile.dataset.id, { ...profileDrafts.get(profile.dataset.id), ...Object.fromEntries(data), ...(profile.querySelector('[data-ai-wiki-entities]') ? { memorySummary: JSON.stringify(wikiEntries(profile)) } : {}) }); }
    const manual = $('#ai-manual-reply-form');
    if (manual) { const data = new FormData(manual); manualReplyDrafts.set(manual.dataset.contact, { ...manualReplyDrafts.get(manual.dataset.contact), ...Object.fromEntries(data) }); }
    const paste = $('#ai-paste-form');
    if (paste) learningDraft = Object.fromEntries(new FormData(paste));
  }
  async function navigate(next) {
    rememberDraft();
    if (tab === 'provider') concealKey(true);
    if (next === 'results') resultProfileIds = null;
    // 记录进入「学习默认风格」前的页面，返回时回到来源页（对象设置页或系统设置）。
    if (next === 'default-style' && tab !== 'default-style') defaultStyleReturn = tab;
    // 学习默认风格不提供群聊，进入时清掉批量学习页残留的群聊勾选。
    if (next === 'default-style') for (const id of [...selectedContacts]) if (state.contacts?.find(c => c.id === id)?.kind === 'group') selectedContacts.delete(id);
    if (next === 'activity') { logLoading = logFilters.source === 'reply'; logRequestScope = ''; }
    if (next !== 'analysis') { analysisHistoryReport = null; analysisHistoryEpoch++; }
    tab = next; editingProfile = null; editingReplyContact = null; message(''); render(); $('#ai-content').scrollTop = 0;
    if (next === 'activity') await Promise.all([loadActivity(), loadProactiveRecords()]);
    if ((next === 'analysis' || next === 'learning' || next === 'default-style' || next === 'proactive' || next === 'overview' && state.settings.reply) && needsContacts()) await refreshContacts();
  }
  function render() {
    if (!state) return;
    revealRevision++;
    const view = `${tab}:${editingProfile || editingReplyContact || (tab === 'overview' ? selectedObject : '')}:${tab === 'proactive' ? !!$('#ai-proactive-form') : ''}`;
    const objectScroll = $('#ai-object-list')?.scrollTop || 0;
    const disclosureStates = view === renderedView ? [...panel.querySelectorAll('#ai-content details')].filter(node => !node.hasAttribute('data-ai-record-expand')).map(node => ({ label: node.querySelector('summary')?.textContent, open: node.open })) : [];
    renderedView = view; panel.dataset.page = tab;
    $('#ai-title').textContent = ({ overview: '自动回复', proactive: '主动聊天', activity: '运行记录', provider: '模型设置', settings: '系统设置', analysis: '聊天数据分析', learning: '学习聊天风格', 'default-style': '学习默认风格', results: '学习结果', profile: '编辑学习结果' })[tab] || 'AI 辅助';
    const content = tab === 'profile' && editingProfile ? profileEditor(state.profiles.find(p => p.id === editingProfile)) : ({ overview: objects, analysis: () => analysisPage(state, analysisDraft, analysisResult, analysisSearch, analysisHistoryReport), activity, provider, settings: advancedSettings, learning, 'default-style': defaultStyleLearning, results, proactive, 'manual-reply': manualReplyEditor }[tab] || objects)();
    const nav = `<nav class="ai-main-tabs" aria-label="AI 页面"><div class="ai-nav-brand"><span>${logoIcon}</span><div>AI 辅助<small>栖盒 · QIBOX</small></div></div><p class="ai-nav-caption">工作台</p>${[['overview', '自动回复', 'chat'], ['proactive', '主动聊天', 'send'], ['analysis', '聊天分析', 'file'], ['activity', '运行记录', 'clock'], ['settings', '系统设置', 'sliders']].map(([key, name, symbol]) => `<button type="button" data-ai-nav="${key}" title="${name}" aria-label="${name}" aria-current="${tab === key || key === 'overview' && ['learning','results','profile','manual-reply'].includes(tab) || key === 'settings' && tab === 'default-style' ? 'page' : 'false'}">${icon(symbol)}<span>${name}</span></button>`).join('')}<div class="ai-nav-footer">${icon('shield')}<span>设置按当前微信独立保存</span></div></nav>`;
    $('#ai-content').innerHTML = iconSprite + nav + (tab === 'overview' ? content : `<div class="ai-page-body">${content}</div>`);
    for (const textarea of $('#ai-content').querySelectorAll('.ai-wiki-bubble textarea[aria-label="信息内容"]')) resizeWikiTextarea(textarea);
    if ($('#ai-object-list')) $('#ai-object-list').scrollTop = objectScroll;
    panel.classList.toggle('object-selected', !!selectedObject && tab === 'overview');
    for (const node of panel.querySelectorAll('#ai-content details')) {
      if (node.hasAttribute('data-ai-record-expand')) continue;
      const previous = disclosureStates.find(item => item.label === node.querySelector('summary')?.textContent);
      if (previous) node.open = previous.open;
    }
    const paste = $('#ai-paste-form'); if (paste && learningDraft) for (const [key, value] of Object.entries(learningDraft)) if (paste.elements[key]) paste.elements[key].value = value;
    controls();
  }
  async function workflow(work, success = '') {
    if (busy) throw new Error('请等待当前操作完成，或先取消');
    rememberDraft();
    const current = generation, token = ++workToken; busy = true; panel.setAttribute('aria-busy', 'true'); message('');
    const step = async (action, extras) => { const result = await call(action, extras); if (!result) throw new Error('obsolete-context'); return result; };
    try { await work(step); if (current !== generation || token !== workToken) return; render(); if (success) message(success); }
    catch (e) { if (current === generation && e.message !== 'obsolete-context') throw e; }
    finally { if (current === generation && token === workToken) { busy = false; panel.setAttribute('aria-busy', 'false'); } }
  }
  async function execute(action, extras = {}, success = '') {
    if (busy && ['cancel'].includes(action)) {
      const current = generation, token = ++workToken;
      try { const result = await call(action, extras); if (result) { render(); message(success); } return result; }
      finally { if (current === generation && token === workToken) { busy = false; panel.setAttribute('aria-busy', 'false'); } }
    }
    let result;
    await workflow(async step => { result = await step(action, extras); }, success);
    return result;
  }
  async function refreshContacts({ manual = false } = {}) {
    if (contactsLoading) return;
    if (!manual && Date.now() - lastAutoScanAt < 30000) return;
    if (!manual) lastAutoScanAt = Date.now();
    const current = generation, target = id;
    contactsLoading = true; $('#ai-operation').hidden = false; $('#ai-operation-text').textContent = '正在获取联系人…';
    try {
      const result = await execute('scan');
      if (!result || current !== generation || target !== id) return;
      contactsLoaded = true; state.operation = null; lastAutoScanAt = 0;
      for (const selected of [selectedContacts]) for (const key of selected) if (!state.contacts.some(c => c.id === key && ['person', 'group'].includes(c.kind))) selected.delete(key);
      contactsLoading = false; render(); message(state.notice || (state.contacts.length ? '联系人已更新' : '暂未获取到联系人，请确认微信已登录后重试'));
    } finally { if (current === generation && target === id) { contactsLoading = false; controls(); } }
  }
  function chooseDefaultPerspective() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ai-calendar-dialog ai-perspective-dialog';
      const option = (value, title, desc) => `<label class="ai-perspective"><input type="radio" name="default-perspective" value="${value}" ${defaultStylePerspective === value ? 'checked' : ''}><strong>${title}</strong><small>${desc}</small></label>`;
      let confirmed = null;
      dialog.innerHTML = `<h3>选择学习方向</h3><p class="ai-perspective-help">将把所选 ${selectedContacts.size} 位联系人的聊天记录合并读取，综合出一份通用默认风格。</p><div class="ai-perspective-options">${option('self', '自己与对方聊天的风格', '学习你与这些联系人聊天时的表达习惯，AI 以你的口吻回复')}${option('other', '对方的风格', '学习这些联系人在聊天中的表达习惯，AI 借鉴对方的口吻')}</div><footer class="ai-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="primary" data-apply>开始学习</button></footer>`;
      dialog.addEventListener('close', () => { dialog.remove(); resolve(confirmed); }, { once: true });
      dialog.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button) return;
        if (button.hasAttribute('data-cancel')) dialog.close();
        if (button.hasAttribute('data-apply')) { confirmed = dialog.querySelector('input[name=default-perspective]:checked')?.value || 'self'; defaultStylePerspective = confirmed; dialog.close(); }
      });
      document.body.append(dialog); dialog.showModal();
    });
  }
  async function learn(value) {
    // 学习目标：默认「风格 + 记忆」（沿用原有行为）；仅风格不动记忆；仅记忆读取全量聊天并增量合并。
    const target = value.asDefault ? 'style' : ['style', 'memory'].includes(value.target) ? value.target : 'both';
    if (value.asDefault) {
      if (value.contacts && !value.contacts.length) throw new Error('请选择至少一位联系人');
      if (value.contacts?.some(key => !state.contacts.some(c => c.id === key && ['person', 'group'].includes(c.kind)))) throw new Error('联系人已变化，请刷新后重新选择');
      rememberDraft();
      await workflow(async step => {
        $('#ai-operation').hidden = false; $('#ai-operation-text').textContent = '正在读取聊天并学习默认风格…';
        await step('learn', { value: { ...value, previewOnly: false } });
        state.operation = null;
        tab = 'default-style';
      });
      message(state.notice || '默认风格已更新，可在此调整后保存，或取消本次学习', /失败/.test(state.notice || ''));
      return;
    }
    if (value.contacts && !value.contacts.length) throw new Error('请选择至少一位联系人');
    if (value.contacts?.some(key => !state.contacts.some(c => c.id === key && ['person', 'group'].includes(c.kind)))) throw new Error('联系人已变化，请刷新后重新选择');
    rememberDraft();
    const beforeDrafts = new Map(structuredClone([...objectDrafts])), beforeProfiles = structuredClone(state.profiles);
    const previous = new Set(state.profiles.map(p => p.id));
    const expectedWorkToken = workToken + 1;
    await workflow(async step => {
      $('#ai-operation').hidden = false; $('#ai-operation-text').textContent = target === 'memory' ? '正在读取全部聊天记录…' : '正在读取聊天并学习风格…';
      await step('learn', { value: { ...value, target, previewOnly: target === 'both' } });
      state.operation = null;
      if (target === 'memory') {
        const keys = value.contacts || (value.contact ? [value.contact] : []);
        const updated = selectProfiles().filter(p => keys.includes(p.contact));
        rememberDraft();
        // 学到的记忆先放在对象页的待确认区，跳过去让用户马上能替换或合并。
        const first = updated.find(p => state.contacts.some(c => c.id === p.contact));
        if (first) { objectDrafts.delete(first.contact); selectedObject = first.contact; objectKind = first.kind === 'group' ? 'group' : 'person'; tab = 'overview'; }
        return;
      }
      const learned = learnedProfiles().filter(p => value.contacts?.includes(p.contact) || (value.contact && p.contact === value.contact) || (!value.contacts && !value.contact && !previous.has(p.id)));
      resultProfileIds = new Set(learned.map(p => p.id));
      rememberDraft();
      learned.forEach(p => { replyProfiles.add(p.id); if (objectDrafts.has(p.contact)) objectDrafts.set(p.contact, learnedObjectDraft(objectDrafts.get(p.contact), beforeDrafts.get(p.contact), beforeProfiles.find(x => x.contact === p.contact), p)); });
      replyDraft = null; tab = 'results';
    });
    if (workToken !== expectedWorkToken) return;
    message(state.notice || (target === 'memory' ? '聊天记忆学习完成，请在下方「聊天记忆」中确认后应用' : target === 'style' ? '聊天风格已更新' : '风格学习完成'), /失败/.test(state.notice || ''));
  }
  function show() {
    panel.hidden = false; rail.querySelector('#ai-open').setAttribute('aria-expanded', 'true'); if (state) render(); $('#ai-close').focus();
    if (!state) {
      // 入口常驻后，面板可能在挂载尚未完成（或曾失败）时被打开：这里补一次读取，避免空白面板。
      $('#ai-content').innerHTML = '<p class="ai-help">正在读取设置…</p>';
      if (id) { const current = generation; void call().then(result => { if (result && current === generation && !panel.hidden) render(); }).catch(error => { if (current === generation) message(error.message, true); }); }
      return;
    }
    if (state.settings.reply && tab === 'overview' && needsContacts() && !busy) {
      const current = generation;
      void refreshContacts().catch(error => { if (current === generation) message(error.message, true); });
    }
  }
  function hide() { rememberDraft(); rememberRecords(); concealKey(true); proactiveUI.closeOverlay(); if (learningDraft) learningDraft.text = ''; panel.hidden = true; rail.querySelector('#ai-open').setAttribute('aria-expanded', 'false'); panel.querySelectorAll('[name=text], [name=styleText]').forEach(input => { input.value = ''; }); rail.querySelector('#ai-open').focus(); onClose?.(); }
  rail.querySelector('#ai-open').onclick = async () => {
    if (panel.hidden && !pass()) return;
    if (panel.hidden && !id && !(await ensureInstance())) { message('AI 辅助尚未就绪，请重新打开微信后再试', true); return; }
    panel.hidden ? show() : hide();
  };
  $('#ai-close').onclick = hide;
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); if (!proactiveUI.closeOverlay()) hide(); } });
  const changeMaster = async event => {
    if (!pass()) { event.target.checked = !event.target.checked; return; }
    if (!id && !(await ensureInstance())) { event.target.checked = !event.target.checked; message('AI 辅助尚未就绪，请重新打开微信后再试', true); return; }
    try { await execute('settings', { value: { enabled: event.target.checked } }); }
    catch (e) { show(); controls(); message(e.message, true); }
  };
  rail.addEventListener('change', changeMaster);
  panel.addEventListener('change', async event => {
    try {
      const input = event.target;
      const wikiRow = input.closest('.ai-wiki-bubble');
      if (wikiRow && input.matches('select[aria-label="信息类型"]')) {
        const calendar = ['birthday', 'date'].includes(input.value);
        const school = input.value === 'school';
        const temporal = ['residence', 'workplace', 'employer', 'shipping'].includes(input.value);
        let dateType = wikiRow.querySelector('.ai-wiki-date-type');
        if (calendar && !dateType) { dateType = document.createElement('label'); dateType.className = 'ai-wiki-date-type'; dateType.innerHTML = '历法<select aria-label="生日历法"><option value="">未确定</option><option value="solar">公历</option><option value="lunar">农历</option></select>'; wikiRow.insertBefore(dateType, wikiRow.querySelector('[data-ai-wiki-remove]')); }
        if (dateType) dateType.hidden = !calendar;
        let degree = wikiRow.querySelector('[aria-label="学历"]');
        if (school && !degree) { degree = document.createElement('input'); degree.className = 'ai-wiki-degree'; degree.setAttribute('aria-label', '学历'); degree.maxLength = 120; degree.placeholder = '学历'; wikiRow.insertBefore(degree, wikiRow.querySelector('[data-ai-wiki-remove]')); }
        if (degree) degree.hidden = !school;
        let schoolName = wikiRow.querySelector('.ai-wiki-school-name');
        if (school && !schoolName) { schoolName = document.createElement('small'); schoolName.className = 'ai-wiki-school-name'; wikiRow.insertBefore(schoolName, wikiRow.querySelector('[aria-label="信息内容"]')); }
        if (schoolName) schoolName.hidden = !school;
        if (school && !wikiRow.querySelector('[aria-label="信息内容"]').value) wikiRow.querySelector('[aria-label="信息内容"]').placeholder = '具体学校';
        let recorded = wikiRow.querySelector('.ai-wiki-recorded');
        if (temporal && !recorded) { recorded = document.createElement('small'); recorded.className = 'ai-wiki-recorded'; wikiRow.insertBefore(recorded, wikiRow.querySelector('[data-ai-wiki-remove]')); }
        if (recorded) { const rawTime = wikiRow.querySelector('[data-ai-wiki-recorded]')?.value, stamp = Number(rawTime); recorded.hidden = !temporal; if (temporal) recorded.textContent = `时间：${Number.isSafeInteger(stamp) && stamp ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(stamp) : '未知'}`; }
        const remarkAction = wikiRow.querySelector('[data-ai-wiki-remark]');
        if (remarkAction) remarkAction.hidden = !state.capabilities?.writeContactRemark || !['name'].includes(input.value);
        const content = wikiRow.querySelector('[aria-label="信息内容"]'), isOther = input.value === 'other';
        if (content && (content.tagName === 'TEXTAREA') !== isOther) {
          const replacement = document.createElement(isOther ? 'textarea' : 'input');
          replacement.setAttribute('aria-label', '信息内容'); replacement.maxLength = 2000; replacement.value = content.value;
          replacement.placeholder = isOther ? '兴趣爱好、偏好或其他聊天记忆' : '填写已确认的信息';
          if (isOther) { replacement.rows = 1; resizeWikiTextarea(replacement); }
          content.replaceWith(replacement);
        }
        const targetField = ['workplace', 'employer'].includes(input.value) ? 'work' : input.value;
        const target = wikiRow.closest('[data-ai-wiki-entities]')?.querySelector(`[data-ai-wiki-field="${targetField}"] .ai-wiki-field-values`);
        if (target && wikiRow.parentElement !== target) target.append(wikiRow);
        return;
      }
      if (input.closest('#ai-takeover-form') && input.name === 'enabled') {
        const minutes = input.closest('#ai-takeover-form').querySelector('[data-takeover-minutes]');
        minutes.hidden = !input.checked;
        minutes.querySelector('[name="minutes"]').disabled = !input.checked;
      }
      if (proactiveUI.change(input)) return;
      if (input.name === 'default-perspective') { defaultStylePerspective = input.value; rememberDraft(); render(); return; }
      if (input.id === 'ai-learning-scope') { rememberDraft(); learnScope = input.value; render(); return; }
      if (input.name === 'learnTarget') { rememberDraft(); learnTarget = LEARN_TARGETS.some(t => t.id === input.value) ? input.value : 'both'; render(); return; }
      if ('aiPanelMaster' in input.dataset) { await changeMaster(event); return; }
      if (input.closest('#ai-analysis-form') && input.name === 'contacts') {
        const checked = [...panel.querySelectorAll('#ai-analysis-form [name=contacts]:checked')];
        $('#ai-analysis-count').textContent = String(checked.length);
      }
      if (input.dataset.objectOption) {
        // 开关修改只作为草稿，点击【保存设置】后统一生效。
        rememberDraft(); render(); if ($('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false; return;
      }
      if (input.closest('#ai-object-form') && input.name === 'styleId') {
        const profile = state.profiles.find(p => p.contact === selectedObject), preset = state.schema.replyPresets.find(p => 'preset:' + p.id === input.value);
        const style = input.value === 'learned' ? profile?.learnedStyle : preset?.style;
        // 【默认风格】只有一套（账号级）：填入学习到的默认风格内容，并跟随其更新。
        if (input.value === '') $('#ai-object-form').elements.summary.value = summaryText(state.learnedDefaultStyle?.style || {});
        else if (style) $('#ai-object-form').elements.summary.value = summaryText(style);
        
        rememberDraft(); render(); return;
      }
      if (input.dataset.aiAssignment) {
        const base = modelDraft || { models: state.models || [], assignments: { ...(state.assignments || {}) }, editing: null, form: null, status: '' };
        modelDraft = { ...base, assignments: { ...base.assignments, [input.dataset.aiAssignment]: input.value }, status: '分配已修改，点击“保存”后生效' };
        render(); return;
      }
      if (input.id === 'ai-model-preset') {
        const p = state.schema.providerPresets.find(x => x.id === input.value), form = $('#ai-model-form');
        form.elements.baseUrl.value = p?.baseUrl || ''; form.elements.protocol.value = p?.protocol || 'openai';
        form.elements.model.value = p?.models[0] || '';
        $('#ai-model-choice').innerHTML = option('', '手动填写模型名称', !p) + (p?.models || []).map((x, i) => option(x, x, i === 0)).join('');
        $('#ai-provider-status').textContent = '配置已修改，请测试连接';
      }
      if (input.id === 'ai-model-choice') $('#ai-model-form').elements.model.value = input.value;
      if (input.closest('#ai-model-form')) { providerRevision++; rememberProvider(); }
      if (input.id === 'ai-reply-preset') {
        rememberDraft();
        const draft = manualReplyDrafts.get(editingReplyContact), preset = state.schema.replyPresets?.find(p => p.id === input.value);
        const learned = input.value.startsWith('learned:') ? learnedProfiles().find(p => p.id === input.value.slice(8)) : null;
        if (preset) manualReplyDrafts.set(editingReplyContact, { ...draft, ...preset.style, summary: summaryText(preset.style), replyPreset: input.value });
        if (learned?.learnedStyle) manualReplyDrafts.set(editingReplyContact, { ...draft, ...learned.learnedStyle, summary: summaryText(learned.learnedStyle), replyPreset: input.value });
        render();
      }
      if (input.dataset.aiSetting) {
        rememberDraft(); const value = { [input.dataset.aiSetting]: input.checked };
        // A mode can be opened for configuration before it is ready to run.
        // Opening configuration does not disable the master switch.
        // Master stays as explicitly chosen by the user.
        const updated = await execute('settings', { value });
        if (updated && input.checked && input.dataset.aiSetting === 'reply' && needsContacts()) await refreshContacts();
      }
      const contact = input.dataset.aiContact;
      if (contact) {
        const set = selectedContacts;
        if (input.checked && !state.contacts.some(c => c.id === contact && ['person', 'group'].includes(c.kind))) { input.checked = false; throw new Error('请选择列表中的联系人'); }
        if (input.checked) set.add(contact); else set.delete(contact);
        const learnButton = $('[data-ai-action=learn-selected]'); if (learnButton) learnButton.disabled = !selectedContacts.size;
        const defaultButton = $('[data-ai-action=learn-default]'); if (defaultButton) defaultButton.disabled = !selectedContacts.size;
        const count = $('#ai-contact-count'); if (count) count.textContent = `已选择 ${set.size} 位联系人`;
        message('');
      }
      if (input.id === 'ai-reply-scope') await execute('settings', { value: { replyScope: input.value } });
      if (input.name === 'sendMode') { rememberDraft(); render(); }
      if (input.name === 'replyProfiles') { if (input.checked) replyProfiles.add(input.value); else replyProfiles.delete(input.value); }
      rememberDraft();
    } catch (e) { controls(); message(e.message, true); }
  });
  panel.addEventListener('input', event => {
    if (event.target?.matches?.('.ai-wiki-bubble textarea[aria-label="信息内容"]')) resizeWikiTextarea(event.target);
    const wikiRow = event.target?.closest?.('.ai-wiki-bubble');
    if (wikiRow && (event.target.matches('[aria-label="信息内容"]') || event.target.matches('[aria-label="学历"]'))) {
      const label = wikiRow.querySelector('.ai-wiki-school-name');
      if (label) label.textContent = `${wikiRow.querySelector('[aria-label="学历"]')?.value.trim() || '学历未注明'}：${wikiRow.querySelector('[aria-label="信息内容"]')?.value.trim() || '具体学校'}`;
    }
    if (event.target.closest('#ai-object-form') && event.target.name === 'summary') {
      const form = event.target.form;
      form.elements.styleId.value = 'custom';
      form.querySelectorAll('[data-ai-style]').forEach(button => {
        const selected = button.dataset.aiStyle === 'custom';
        button.setAttribute('aria-pressed', String(selected));
      });
      const dirty = form.querySelector('[data-ai-dirty]'); if (dirty) dirty.hidden = false;
      rememberDraft();
      const list = $('#ai-object-list'); if (list) list.innerHTML = objectList(state, objectView());
      return;
    }
    if (event.target.name === 'request' && event.target.closest('#ai-analysis-form')) {
      $('.ai-analysis-presets').innerHTML = presetChips(event.target.value);
    }
    if (event.target.id === 'ai-object-search') { objectSearch = event.target.value; $('#ai-object-list').innerHTML = objectList(state, objectView()); return; }
    if (event.target.id === 'ai-log-search') {
      logFilters.query = event.target.value; logFilters.page = 0; rememberRecords();
      const activityRowsNode = $('#ai-activity-entries'); if (activityRowsNode) activityRowsNode.innerHTML = activityRows(activityState(), logFilters, logRecords, logLoading);
      const proactiveRowsNode = $('#ai-proactive-records'); if (proactiveRowsNode) proactiveRowsNode.innerHTML = proactiveRecordRows(activityState(), logFilters, proactiveRecordLoading);
      return;
    }
    if (event.target.id === 'ai-analysis-search') {
      analysisSearch = event.target.value;
      const checked = new Set([...panel.querySelectorAll('#ai-analysis-form [name=contacts]:checked')].map(x => x.value));
      $('#ai-analysis-contacts').innerHTML = analysisContactList(state, checked, analysisSearch);
      return;
    }
    if (event.target.id === 'ai-reply-contact-search') {
      replyContactSearch = event.target.value;
      $('#ai-reply-contacts').innerHTML = replyContactList();
      return;
    }
    if (event.target.id === 'ai-contact-search') {
      contactSearch = event.target.value;
      const list = $('.ai-contact-list');
      if (list) list.innerHTML = contactPickerRows((state.contacts || []).filter(c => pickerKinds().includes(c.kind)), contactSearch);
      return;
    }
    if (event.target.closest('#ai-model-form')) {
      providerRevision++; revealRevision++;
      if (event.target.name === 'apiKey') event.target.dataset.keyStored = 'false';
      $('#ai-provider-status').textContent = '配置已修改，请测试连接';
      if (event.target.name === 'baseUrl' || event.target.name === 'protocol') { $('#ai-model-preset').value = 'custom'; $('#ai-model-choice').innerHTML = option('', '请重新拉取模型或手动填写', true); }
      else if ($('[data-ai-action=toggle-key]').dataset.revealing === 'true') concealKey();
    }
    rememberDraft();
    if (event.target.closest('#ai-object-form') && $('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false;
  });
  panel.addEventListener('toggle', event => {
    const key = event.target.dataset?.aiRecordExpand;
    if (!key || !event.target.isConnected) return;
    const expanded = new Set(logFilters.expanded || []);
    if (event.target.open) expanded.add(key); else expanded.delete(key);
    logFilters.expanded = [...expanded];
  }, true);
  panel.addEventListener('click', event => { if (!event.target.closest('[data-proactive-menu], .ap-action-menu')) proactiveUI.closeMenu(); });
  panel.addEventListener('focusin', event => { if (event.target.name === 'apiKey' && event.target.dataset.keyStored === 'true') event.target.select(); });
  panel.addEventListener('beforeinput', event => { if (event.target.name === 'apiKey' && event.target.dataset.keyStored === 'true' && event.target.value === KEY_MASK) event.target.select(); });
  panel.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target;
    const data = new FormData(form);
    try {
      const wiki = form.querySelector('[data-ai-wiki-entities]');
      if (wiki) {
        const entries = wikiEntries(form);
        form.querySelector('[name=memorySummary]').value = JSON.stringify(entries);
        data.set('memorySummary', JSON.stringify(entries));
      }
      if (form.id === 'ai-log-filter') { if (data.get('from') && data.get('to') && data.get('from') > data.get('to')) throw new Error('开始日期不能晚于结束日期'); logFilters = { ...logFilters, ...Object.fromEntries(data), page: 0 }; const refreshed = await call(); if (refreshed) { logLoading = logFilters.source === 'reply'; logRequestScope = ''; proactiveHistoryPage = null; proactiveRecordEpoch++; proactiveRecordLoading = false; render(); await Promise.all([loadActivity(), loadProactiveRecords()]); } return; }
            if (form.id === 'ai-takeover-form') { await execute('settings', {value:{takeover:{enabled:data.get('enabled')==='on',minutes:Number(data.get('minutes') ?? form.elements.minutes.value ?? 5)}}}, 'AI 辅助等待设置已保存'); return; }
      if (form.id === 'ai-analysis-form') {
        rememberDraft();
        if (!analysisDraft.contacts.length) throw new Error('请至少选择一位联系人');
        if (analysisDraft.from > analysisDraft.to) throw new Error('开始日期不能晚于结束日期');
        const current = generation, target = id, account = state?.account; analysisHistoryEpoch++;
        await workflow(async () => {
          const value = structuredClone(analysisDraft);
          const chosen = [...value.contacts];
          const queueToken = ++analysisQueueToken; analysisQueueAccount = account;
          const labels = new Map(state.contacts.map(contact => [contact.id, contact.label || contact.nickname || '联系人']));
          analysisResult = { from: value.from || '', to: value.to || '', reports: chosen.map(contact => ({ contact, label: labels.get(contact) || '联系人', status: 'waiting' })) };
          render();
          const contextValid = () => current === generation && id === target && account === state?.account;
          const valid = () => queueToken === analysisQueueToken && contextValid();
          for (let index = 0; index < chosen.length; index++) {
            if (!valid()) return;
            const contact = chosen[index], row = analysisResult.reports[index];
            row.status = 'analyzing'; render();
            try {
              const result = await api(`/instances/${target}/ai`, { action: 'analyze', value: { ...value, contacts: [contact], mode: 'auto' } }, 30 * 60 * 1000);
              if (!contextValid()) return;
              const completed = result?.reports?.[0];
              if (!completed || completed.contact !== contact || !['complete', 'empty', 'error'].includes(completed.status)) throw new Error('分析服务没有返回该联系人的有效结果');
              analysisResult.reports[index] = completed;
            } catch (error) {
              if (!contextValid()) return;
              if (queueToken !== analysisQueueToken) { row.status = 'cancelled'; row.error = ''; }
              else { row.status = 'error'; row.error = error instanceof Error ? error.message : '分析失败，请稍后重试'; }
            }
            render();
            if (!valid()) return;
          }
          // The analyze POST returns reports, while publicState carries only
          // history summaries. Refresh that read-only state immediately so a
          // newly saved snapshot appears without waiting for navigation.
          try {
            const refreshed = await api(`/instances/${target}/ai`, undefined, 30000);
            if (current === generation && id === target && account === refreshed.account) state = refreshed;
          } catch { /* the generated report remains visible; polling can retry */ }
          const incomplete = analysisResult.reports.some(report => report.status === 'error' || report.truncated);
          message(incomplete ? '分析队列已结束：请查看各联系人的状态和范围提示' : '分析结束，请查看每位联系人的报告');
          if (queueToken === analysisQueueToken) analysisQueueAccount = null;
        }); return;
      }
      if (form.id === 'ai-object-form') {
        const contact = form.dataset.contact, profile = state.profiles.find(p => p.contact === contact);
        const summary = String(data.get('summary') || '').trim();
        const styleId = data.get('styleId') || '';
        const strategy = { ...profile?.replyStrategy, replyGoal: data.get('replyGoal') || '', facts: data.get('facts') || '', boundaries: data.get('boundaries') || '', maxRounds: Number(data.get('maxRounds') || 50) };
        // 以页面当前 styleId 对应的完整风格为基础，仅覆盖页面编辑的说明，避免丢失预设/学习风格的其余字段。
        const base = styleId === 'learned' ? (profile?.learnedStyle || profile?.style || state.schema.defaultStyle)
          : styleId.startsWith('preset:') ? (state.schema.replyPresets.find(p => 'preset:' + p.id === styleId)?.style || state.schema.defaultStyle)
          : (profile?.style || state.schema.defaultStyle);
        const style = summary ? { ...base, summary } : { ...state.schema.defaultStyle };
        // 群聊开启实时回复需要先确认 Token 消耗与账号风险；取消则回滚草稿，不视为已保存。
        let realtimeConfirmed = true;
        if (profile?.kind === 'group' && data.has('realtime') && !profile?.groupOptions?.realtime) {
          realtimeConfirmed = await confirmRealtime();
          if (!realtimeConfirmed) { objectDrafts.set(contact, { ...(objectDrafts.get(contact) || {}), realtime: false }); render(); return; }
        }
        const kind = profile?.kind || state.contacts.find(item => item.id === contact)?.kind;
        const replyDefaults = {
          enabled: profile?.replyOptions?.enabled ?? (kind === 'person' && (state.settings.replyScope === 'all' || (state.replyTargets || []).includes(profile?.id))),
          multiTurn: profile?.replyOptions?.multiTurn ?? state.settings.multiTurn,
          judgeReply: profile?.replyOptions?.judgeReply ?? state.settings.judgeReply,
          atMe: profile?.groupOptions?.atMe ?? false, atAll: profile?.groupOptions?.atAll ?? false, realtime: profile?.groupOptions?.realtime ?? false,
        };
        const optionChecked = key => !!form.elements.namedItem(key)?.checked;
        const switchKeys = kind === 'group' ? ['atMe','atAll','realtime'] : ['enabled','multiTurn','judgeReply'];
        const changedSwitch = switchKeys.some(key => optionChecked(key) !== (replyDefaults[key] === true));
        const currentStyle = styleChoice(profile);
        const baselineStyleId = currentStyle.styleId || '';
        const baselineSummary = currentStyle.styleId ? (currentStyle.summary || '') : styleSummaryText(state.learnedDefaultStyle?.style);
        const changedStyle = String(data.get('styleId') || '') !== baselineStyleId || String(data.get('summary') || '') !== baselineSummary;
        const hasReplySettings = !!profile?.replyStrategy || ['replyGoal','facts','boundaries'].some(key => String(data.get(key) || '').trim()) || changedSwitch || changedStyle || Number(data.get('maxRounds')) !== Number(profile?.replyStrategy?.maxRounds ?? state.replyRoundLimits?.[kind] ?? state.replyStrategy?.maxRounds ?? 50);
        await workflow(async step => {
          const memoryEntries = JSON.parse(String(data.get('memorySummary') || '[]'));
          if (!sameWikiEntries(memoryEntries, profile?.memory?.entries || []) && !profile?.memory?.unavailable) await step('contact-memory', { value: { contact, entries: memoryEntries } });
          if (!hasReplySettings) { objectDrafts.delete(contact); return; }
          if (kind === 'group') {
            await step('group-options', { value: { contact, atMe: data.has('atMe'), atAll: data.has('atAll'), realtime: data.has('realtime'), ...(realtimeConfirmed ? { confirmRealtime: true } : {}) } });
            await step('reply-profile', { value: { contact, preserveSwitches: true, styleSet: !!summary, styleId, style, strategy } });
          } else {
            await step('reply-profile', { value: { contact, preserveSwitches: true, styleSet: !!summary, styleId, style, strategy, replyEnabled: data.has('enabled') } });
            await step('reply-options', { value: { contact, multiTurn: data.has('multiTurn'), judgeReply: data.has('judgeReply') } });
          }
          objectDrafts.delete(contact);
        }, hasReplySettings ? '设置已保存' : '个人信息 Wiki 已保存'); return;
      }
      if (form.id === 'ai-model-form') await stageModel();
      if (form.id === 'ai-manual-reply-form') {
        const contact = form.dataset.contact;
        if (!state.contacts.some(c => c.id === contact && ['person', 'group'].includes(c.kind))) throw new Error('联系人已变化，请刷新后重新选择');
        const strategy = { replyGoal: data.get('replyGoal') || '', facts: data.get('facts') || '', boundaries: data.get('boundaries') || '', maxRounds: Number(data.get('maxRounds')) };
        
        if (!Number.isInteger(strategy.maxRounds) || strategy.maxRounds < 1 || strategy.maxRounds > 2000) throw new Error('连续自动回复上限须为 1–2000 的整数');
        const style = { summary: data.get('summary'), customAvoid: data.get('customAvoid') || '' };
        await workflow(async step => {
          await step('reply-profile', { value: { contact, style, strategy } });
          manualReplyDrafts.delete(contact); editingReplyContact = null; tab = 'overview';
        }, '回复风格已保存');
      }
      if (form.id === 'ai-default-style-form') {
        const summary = String(data.get('summary') || '').trim();
        if (!summary) throw new Error('请填写风格总结');
        const current = generation;
        const saved = await execute('commit-default-style', { value: { summary } });
        if (!saved || current !== generation) return;
        message(saved.appliedDefaultStyle ? `默认风格已保存，并同步给 ${saved.appliedDefaultStyle} 个使用默认风格的对象` : '默认风格已保存，当前没有使用默认风格的对象');
        return;
      }
      if (form.id === 'ai-paste-form') { const value = Object.fromEntries(data); form.querySelector('[name=text]').value = ''; if (learningDraft) learningDraft.text = ''; await learn({ ...value, perspective: defaultStylePerspective, asDefault: true }); }
      if (form.id === 'ai-proactive-form') { await proactiveUI.submit(); return; }
      if (form.id === 'ai-profile-form') {
        const key = form.dataset.id, original = state.profiles.find(p => p.id === key), base = { ...(original.strategy || replyStrategy()), ...original.replyStrategy };
        const reply = { replyGoal: data.get('replyGoal') || '', facts: data.get('facts') || '', boundaries: data.get('boundaries') || '', maxRounds: Number(data.get('maxRounds') || 50) };
        await workflow(async step => {
          const existing = state.profiles.find(p => p.id === key);
          const memoryEntries = JSON.parse(String(data.get('memorySummary') || '[]'));
          if (!existing.memory?.unavailable && !sameWikiEntries(memoryEntries, existing.memory?.entries || [])) await step('memory', { id: key, value: { entries: memoryEntries } });
          await step('profile', { id: key, value: { style: { summary: data.get('summary'), customAvoid: data.get('customAvoid') || '' } } });
          if (Object.keys(reply).some(k => reply[k] !== (base[k] ?? ''))) await step('strategy', { id: key, mode: 'reply', value: { ...base, ...reply } });
          profileDrafts.delete(key); editingProfile = null; tab = profileReturn;
        }, '风格已保存');
      }
    } catch (e) { message(e.message, true); }
  });
  // 运行记录：右键执行记录文本浮现「删除记录」菜单，点击后仍弹确认框二次确认。
  let recordMenu = null;
  const hideRecordMenu = () => recordMenu?.classList.remove('open');
  panel.addEventListener('contextmenu', event => {
    const li = event.target.closest('[data-ai-record-menu]');
    if (!li) { hideRecordMenu(); return; }
    event.preventDefault();
    if (!recordMenu) {
      recordMenu = document.createElement('div');
      recordMenu.className = 'ai-record-context-menu';
      recordMenu.innerHTML = '<button type="button">删除记录</button>';
      panel.appendChild(recordMenu);
    }
    const action = recordMenu.querySelector('button');
    action.dataset.aiDeleteRecord = li.dataset.aiRecordMenu;
    action.dataset.aiDeleteSource = li.dataset.aiRecordMenuSource;
    recordMenu.classList.add('open');
    const rect = recordMenu.getBoundingClientRect();
    recordMenu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
    recordMenu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
  });
  panel.addEventListener('click', () => hideRecordMenu(), true);
  // 「最近异常」的展开状态记在本地筛选状态里，轮询刷新列表时不会被重新合上。
  panel.addEventListener('toggle', event => { if (event.target?.classList?.contains('ap-record-errors')) { logFilters.errorsOpen = event.target.open; rememberRecords(); } }, true);
  window.addEventListener('scroll', () => hideRecordMenu(), true);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') hideRecordMenu(); });
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.hasAttribute('data-ai-apply-limit-kind')) {
        const form = button.closest('form'), value = Number(form.elements.maxRounds.value), kind = button.dataset.aiApplyLimitKind;
        if (!Number.isInteger(value) || value < 1 || value > 2000) throw new Error('连续自动回复上限须为 1–2000 的整数');
        const result = await execute('apply-reply-limit', { value: { kind, maxRounds: value } }, `已应用到全部${kind === 'group' ? '群聊' : '联系人'}`);
        if (result?.appliedReplyLimit) message(`已更新 ${result.appliedReplyLimit.count} 个${kind === 'group' ? '群聊' : '联系人'}的连续回复上限`);
        return;
      }
      if (button.hasAttribute('data-ai-wiki-remark')) {
        const form = button.closest('form'), row = button.closest('.ai-wiki-bubble');
        const field = row?.querySelector('select[aria-label="信息类型"]')?.value;
        const remark = row?.querySelector('input[aria-label="信息内容"]')?.value?.trim();
        if (!state.capabilities?.writeContactRemark || !form?.dataset.id || field !== 'name' || !remark) throw new Error('当前微信连接没有可用的备注写入能力或姓名信息');
        if (!window.confirm(`将“${remark}”写入当前联系人微信备注？`)) return;
        await execute('contact-remark', { id: form.dataset.id, value: { remark } }, '已写入并核验微信备注');
        return;
      }
      if (button.hasAttribute('data-ai-wiki-remove')) { button.closest('.ai-wiki-bubble')?.remove(); return; }
      if (button.hasAttribute('data-ai-wiki-add')) {
        const field = button.dataset.aiWikiAddField || 'other';
        const entities=button.closest('form')?.querySelector('[data-ai-wiki-entities]');
        const section=button.closest('[data-ai-wiki-field]') || entities?.querySelector(`[data-ai-wiki-field="${field}"]`);
        const list = section?.querySelector('.ai-wiki-field-values');
        if (!list) return;
        list.insertAdjacentHTML('beforeend', wikiEntryMarkup({ field, text: '', ...(field === 'school' ? { degree: '' } : {}) }, state.capabilities?.writeContactRemark === true));
        const added = list.lastElementChild; const content = added.querySelector('[aria-label="信息内容"]');
        if (content?.tagName === 'TEXTAREA') resizeWikiTextarea(content);
        content?.focus(); return;
      }
      const action = button.dataset.aiAction;
      if ('aiRetryRecords' in button.dataset) { await loadActivity(); return; }
      if ('aiMarkReply' in button.dataset) {
        await call('mark-reply-needed', { value: { profileId: button.dataset.aiMarkReply, eventId: button.dataset.eventId, messageId: button.dataset.messageId } });
        message('已暂存；下一次自动回复前会先总结这条消息'); render(); return;
      }
      if ('aiSummaryProfile' in button.dataset) {
        const profileId = button.dataset.aiSummaryProfile, row = button.closest('tr'), output = row?.querySelector(`[data-ai-summary-result="${CSS.escape(profileId)}"]`);
        const range = row?.querySelector(`[data-ai-summary-range="${CSS.escape(profileId)}"]`)?.value || 'takeover';
        if (!output) return;
        output.hidden = false; output.textContent = '正在整理聊天…'; button.disabled = true;
        try {
          const result = await api(`/instances/${id}/ai`, { action: 'activity-summary', id: profileId, value: { range } }, 130000);
          const start = beijingTime(result.from), end = beijingTime(result.to);
          output.textContent = `${result.summary}\n\n证据范围：${start} 至 ${end}；共读取 ${result.count}/${result.total} 条双方消息，其中 AI 代回复 ${result.aiReplyCount} 条${result.truncated ? '（内容较多，使用最近部分）' : ''}。`;
        } catch (error) { output.textContent = `总结失败：${error.message || '请重试'}`; }
        finally { button.disabled = false; }
        return;
      }
      if ('aiDeleteRecord' in button.dataset) {
        if (!window.confirm('确认删除这条运行记录？不会删除微信中的聊天消息。')) return;
        const recordId = button.dataset.aiDeleteRecord, source = button.dataset.aiDeleteSource;
        await call('delete-activity-record', { value: { source, id: recordId } });
        proactiveHistory = proactiveHistory.filter(record => !(source === 'proactive' && record.id === recordId));
        logRecords = logRecords.map(record => ({ ...record, messages: (record.messages || []).filter(message => !(message.id === recordId && (source === 'reply' || source === 'unknown'))) }));
        rememberRecords(); render(); return;
      }
      if ('aiClearErrors' in button.dataset) {
        // 折叠区标题里也放了「清空」，点按钮时不要连带展开 / 收起。
        event.preventDefault();
        if (!window.confirm('确认删除「最近异常」的全部记录？删除后无法恢复，不影响聊天内容和运行记录。')) return;
        logFilters.errorsOpen = false;
        errorHistory = []; errorPage = null; errorEpoch++;
        await call('clear-activity-errors');
        rememberRecords(); render(); return;
      }
      if (await proactiveUI.click(button)) return;
      if ('proactiveRecordMore' in button.dataset) { await loadProactiveRecords(true); return; }
      if ('aiErrorMore' in button.dataset) { await loadErrorRecords(true); return; }
      if ('aiToggleFilters' in button.dataset) {
        logFilters.open = !logFilters.open;
        const form = $('#ai-log-filter'); form.hidden = !logFilters.open;
        button.setAttribute('aria-expanded', String(logFilters.open)); return;
      }
      if ('aiRecordSource' in button.dataset) {
        logFilters.source = button.dataset.aiRecordSource;
        if (logFilters.source !== 'proactive' && logFilters.taskId) { logFilters.taskId = ''; proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordEpoch++; proactiveRecordLoading = false; }
        logEpoch++; logLoading = logFilters.source === 'reply'; logRequestScope = ''; logSignature = ''; render();
        await loadActivity(); return;
      }
      if ('aiCopyReport' in button.dataset) {
        const report = analysisResult?.reports[Number(button.dataset.aiCopyReport)];
        if (!report || !['complete', 'empty'].includes(report.status)) throw new Error('报告已变化，请重新打开');
        await copyReport(report.report); message('已复制这份报告的全文'); return;
      }
      if ('aiHistoryOpen' in button.dataset) {
        const current = generation, target = id, account = state?.account, epoch = ++analysisHistoryEpoch;
        const report = await api(`/instances/${target}/ai/reports/${button.dataset.aiHistoryOpen}`, undefined, 30000);
        if (current !== generation || target !== id || account !== state?.account || epoch !== analysisHistoryEpoch) return;
        analysisHistoryReport = report; render(); return;
      }
      if ('aiHistoryBack' in button.dataset) { analysisHistoryReport = null; analysisHistoryEpoch++; render(); return; }
      if ('aiHistoryCopy' in button.dataset) { if (!analysisHistoryReport) throw new Error('报告已变化，请重新打开'); await copyReport(analysisHistoryReport.report); message('已复制这份报告的全文'); return; }
      if ('aiHistoryDelete' in button.dataset) { await deleteAnalysisReport(button.dataset.aiHistoryDelete); return; }
      if ('aiAnalysisPreset' in button.dataset) {
        const field = $('#ai-analysis-form [name=request]'); if (!field) return;
        // Choosing a direction fills its default prompt; choosing the active one
        // again clears the field, and editing the text turns it into 自定义.
        field.value = analysisRequestState(field.value) === button.dataset.aiAnalysisPreset ? '' : presetRequest(button.dataset.aiAnalysisPreset);
        rememberDraft(); render(); return;
      }
      if (busy && !['cancel'].includes(action)) throw new Error('请等待当前操作完成，或先取消');
      if (action === 'analysis-use-chat') { await execute('analysis-use-chat', {}, '聊天分析已改用聊天模型'); return; }
      if (action === 'analysis-settings') { await navigate('provider'); return; }
      if ('aiStyle' in button.dataset) {
        const form = $('#ai-object-form'), styleId = button.dataset.aiStyle;
        const profile = state.profiles.find(p => p.contact === selectedObject), preset = state.schema.replyPresets.find(p => 'preset:' + p.id === styleId);
        const style = styleId === 'learned' ? profile?.learnedStyle : preset?.style;
        form.elements.styleId.value = styleId;
        // 【默认风格】只有一套（账号级）：填入学习到的默认风格内容，并跟随其更新。
        if (styleId === '') form.elements.summary.value = summaryText(state.learnedDefaultStyle?.style || {});
        else if (style) form.elements.summary.value = summaryText(style);
        rememberDraft();
        objectDrafts.set(selectedObject, { ...objectDrafts.get(selectedObject), styleId: form.elements.styleId.value, summary: form.elements.summary.value });
        render(); $('[data-ai-dirty]').hidden = false; return;
      }
      if (button.dataset.aiNav) { await navigate(button.dataset.aiNav); return; }
      if (button.dataset.aiKind) { rememberDraft(); objectKind = button.dataset.aiKind; selectedObject = ''; objectSearch = ''; render(); return; }
      if (button.dataset.aiObject) { rememberDraft(); selectedObject = button.dataset.aiObject; render(); return; }
      if ('aiObjectBack' in button.dataset) { rememberDraft(); selectedObject = ''; render(); return; }
      if ('aiLogPage' in button.dataset) { logFilters.page = Number(button.dataset.aiLogPage); logLoading = true; logRequestScope = ''; render(); await loadActivity(); return; }
      if (button.dataset.aiMemoryRestore) { const current=generation;const result=await execute('memory', {id:button.dataset.profile,value:{restoreId:button.dataset.aiMemoryRestore}}, '已恢复记忆'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); render(); return; }
      // 记忆学习的结果先放在待确认区，由用户决定替换、合并还是放弃。
      if (button.dataset.aiMemoryApply) { const current=generation;const result=await execute('memory-apply', {id:button.dataset.aiMemoryApply}, '已用本次学习的记忆替换'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); render(); return; }
      if (button.dataset.aiMemoryDiscard) { const current=generation;const result=await execute('memory-discard', {id:button.dataset.aiMemoryDiscard}, '已放弃本次学习到的记忆'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); render(); return; }
      if (button.dataset.aiMemoryMerge) { const current=generation;const result=await execute('memory-merge', {id:button.dataset.aiMemoryMerge}, '正在与原有记忆合并，完成后请再确认一次'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); render(); return; }
      if (button.dataset.aiAdoptMemory) {
        const profile = state.profiles.find(p => p.id === button.dataset.aiAdoptMemory);
        const form = button.closest('form'), entries = wikiEntries(form);
        if (!sameWikiEntries(entries, profile.memory?.entries || [])) throw new Error('请先保存正在编辑的记忆，再合并候选内容');
        for(const entry of profile.memorySuggestion?.entries || []) {
          const index=entries.findIndex(e=>e.id===entry.id);
          if(index>=0) entries[index]=entry;else if(!entries.some(e=>e.text===entry.text && e.field===entry.field)) entries.push(entry);
        }
        const entities=form.querySelector('[data-ai-wiki-entities]');
        for(const section of entities.querySelectorAll('[data-ai-wiki-field]')) {
          const field=section.dataset.aiWikiField;
          section.querySelector('.ai-wiki-field-values').innerHTML=entries.filter(entry=>(entry.field||'other')===field).map(entry=>wikiEntryMarkup({...entry,field},state.capabilities?.writeContactRemark===true)).join('');
        }
        rememberDraft();return;
      }
      if (button.dataset.aiLogDetail) { showLogDetail(button.dataset.aiLogDetail); return; }
      if (button.dataset.aiProfile) { rememberDraft(); profileReturn = tab === 'overview' ? 'overview' : 'results'; editingProfile = button.dataset.aiProfile; tab = 'profile'; render(); return; }
      if (button.dataset.aiManualContact) {
        const contact = state.contacts.find(c => c.id === button.dataset.aiManualContact && c.kind === 'person');
        if (!contact) throw new Error('联系人已变化，请刷新后重新选择');
        rememberDraft();
        if (!manualReplyDrafts.has(contact.id)) {
          const profile = selectProfiles().find(p => p.contact === contact.id), preset = state.schema.replyPresets?.[0];
          manualReplyDrafts.set(contact.id, { ...state.schema.defaultStyle, ...preset?.style, ...profile?.style, ...preset?.strategy, ...profile?.strategy, ...profile?.replyStrategy, replyPreset: profile ? 'custom' : preset?.id || 'custom' });
        }
        editingReplyContact = contact.id; editingProfile = null; tab = 'manual-reply'; render(); message(''); $('#ai-content').scrollTop = 0; return;
      }
      if (button.dataset.aiLearnContact) {
        const contactId = button.dataset.aiLearnContact, contact = state.contacts.find(c => c.id === contactId);
        if (!contact) throw new Error('联系人已变化，请刷新后重新选择');
        const chosen = await chooseLearnTarget(`将对 ${contact.label} 执行学习。仅学习记忆会读取全部聊天记录，分批整理后与原有记忆增量合并，耗时较长。`);
        if (!chosen) return;
        await learn({ contacts: [contactId], target: chosen });
        return;
      }
      if (button.dataset.aiApplyContact) {
        const profile = learnedProfiles().find(p => p.contact === button.dataset.aiApplyContact);
        if (!profile) throw new Error('请先学习该联系人的聊天风格');
        rememberDraft(); resultProfileIds = new Set([profile.id]); replyProfiles.add(profile.id); replyDraft = null; tab = 'results'; editingProfile = null; render(); return;
      }
      if (action === 'model-add') { rememberDraft(); openModelEditor('new'); return; }
      if (button.dataset.aiModelEdit) { rememberDraft(); openModelEditor(button.dataset.aiModelEdit); return; }
      if (button.dataset.aiModelDelete) { rememberDraft(); deleteModel(button.dataset.aiModelDelete); return; }
      if (button.dataset.aiModelApply) { rememberDraft(); applyModelToAll(button.dataset.aiModelApply); return; }
      if (button.dataset.aiModelTest) { await testListModel(button.dataset.aiModelTest); return; }
      if (action === 'model-cancel') { modelDraft = { ...(modelDraft || {}), editing: null, draftId: undefined, form: null, status: '' }; render(); return; }
      if (action === 'models-save') { await saveModelsAction(); return; }
      if (action === 'test' || action === 'models') await probeProvider(action);
      if (button.dataset.aiDateRange) {
        rememberDraft(); const scope = button.dataset.aiDateRange, contacts = scope === 'analysis' ? analysisDraft.contacts : [...selectedContacts];
        if (!contacts.length) throw new Error('请先选择联系人');
        const current = generation, target = id;
        const calendar = await api(`/instances/${target}/ai`, {action:'calendar',value:{contacts}}, 130000);
        if (current !== generation || target !== id) return;
        const result = await chooseDateRange(calendar.dates, scope === 'analysis' ? analysisDraft : learnRange);
        if (current !== generation || target !== id || !result) return;
        if (scope === 'analysis') Object.assign(analysisDraft,result); else learnRange=result;
        render(); return;
      }
      if (button.dataset.aiApplyResult) {
        const profile = state.profiles.find(p => p.id === button.dataset.aiApplyResult);
        if (!profile?.contact) throw new Error('联系人已变化，请刷新后重试');
        const current = generation;
        const applied = await execute('reply-profile', {value:{contact:profile.contact,preserveSwitches:true,styleSet:true,styleId:'learned',style:profile.pendingStyle || profile.learnedStyle || profile.style,strategy:profile.replyStrategy || replyStrategy()}}, '已应用到 '+profile.label+' 聊天');
        if (!applied || current !== generation) return;
        selectedObject=profile.contact; objectKind=profile.kind || 'person'; objectDrafts.delete(profile.contact); await navigate('overview');
        return;
      }
      if (action === 'toggle-key') await toggleKey();
      if (action === 'scan' || action === 'detect') await refreshContacts({ manual: true });
      if (action === 'learn-selected') await learn({ contacts: [...selectedContacts], target: learnTarget, ...(learnScope === 'range' ? {...learnRange, scope:'range'} : {}) });
      if (action === 'learn-default') {
        const picked = [...selectedContacts].filter(id => state.contacts.find(c => c.id === id)?.kind === 'person');
        if (!picked.length) throw new Error('请先选择至少一位联系人');
        const perspective = await chooseDefaultPerspective();
        if (!perspective) return;
        await learn({ contacts: picked, perspective, asDefault: true, ...(learnScope === 'range' ? {...learnRange, scope:'range'} : {}) });
      }
      if (action === 'cancel-default-style') {
        const undoable = !!state.defaultStyleUndoable;
        if (!window.confirm(undoable ? '取消本次学习？默认风格将恢复为学习前的内容，联系人与群聊的设置不受影响。' : '没有可撤销的本次学习，取消将清除默认风格：没有单独风格的联系人回到通用回复口吻。确定清除？')) return;
        const current = generation;
        const cancelled = await execute('cancel-default-style', {});
        if (!cancelled || current !== generation) return;
        message(cancelled.defaultStyleCancelled === 'reverted' ? '已取消本次学习，默认风格恢复为学习前的内容' : '默认风格已清除');
        return;
      }
      if (action === 'cancel') {
        contactsLoading = false;
        if (analysisQueueAccount !== null) {
          analysisQueueToken++; analysisQueueAccount = null;
          for (const report of analysisResult?.reports || []) if (report.status === 'waiting') { report.status = 'cancelled'; report.error = ''; }
          render();
        }
        await execute('cancel', {}, '已取消未完成的操作');
      }
      if (['select-contacts', 'clear-contacts'].includes(action)) {
        rememberDraft(); selectedContacts.clear();
        if (action === 'select-contacts') state.contacts.filter(c => pickerKinds().includes(c.kind) && !learnedProfiles().some(p => p.contact === c.id)).forEach(c => selectedContacts.add(c.id));
        render(); message('');
      }
      if (action === 'back-learning') { editingProfile = null; tab = profileReturn; render(); }
      if (action === 'back-reply-contacts') { rememberDraft(); editingReplyContact = null; tab = 'overview'; render(); message(''); }
      if (action === 'resume-manual-reply') {
        const profile = selectProfiles().find(p => p.contact === editingReplyContact);
        if (!profile?.paused) throw new Error('该联系人当前无需恢复');
        await execute('profile', { id: profile.id, value: { style: profile.style, paused: false } }, state.settings.enabled ? '已恢复该联系人自动回复' : '已恢复该联系人，开启 AI 总开关后生效');
      }
      if (action === 'resume-profile' || action === 'delete-profile') {
        const key = $('#ai-profile-form').dataset.id, profile = state.profiles.find(p => p.id === key);
        if (action === 'delete-profile' && button.dataset.confirm !== 'yes') { button.dataset.confirm = 'yes'; button.textContent = '再次点击确认删除'; return; }
        await workflow(async step => {
          await step('profile', { id: key, value: action === 'delete-profile' ? { delete: true } : { style: profile.style, paused: false } });
          editingProfile = null; tab = profileReturn;
        }, action === 'delete-profile' ? '风格已删除' : '已保存，请重新开启需要的功能');
      }
    } catch (e) { message(e.message, true); }
  });
  return {
    show,
    attached: () => !!id,
    async attach(instanceId) {
      rememberRecords();
      analysisDraft = { request: '', from: '', to: '', contacts: [] }; analysisSearch = ''; analysisHistoryReport = null; analysisHistoryEpoch++; learnRange = {from:'',to:''}; learnScope='range'; learnTarget='both'; defaultStylePerspective = 'self'; analysisResult = null; proactiveUI.reset();
      reviewAlert.hidden = true;
      concealKey(true); modelDraft = null; learningDraft = null; renderedView = ''; profileDrafts.clear(); manualReplyDrafts.clear(); objectDrafts.clear(); selectedObject = ''; objectSearch = ''; objectKind = 'person'; editingReplyContact = null; contactSearch = ''; providerRevision++;
      generation++; clearInterval(timer); id = instanceId; state = null; busy = false; polling = false; tab = 'overview'; replyDraft = null; editingProfile = null; contactsLoaded = false; contactsLoading = false; resultProfileIds = null;
      const attachedGeneration = generation;
      selectedContacts.clear(); replyProfiles.clear(); panel.hidden = true; rail.hidden = false; panel.setAttribute('aria-busy', 'false');
      proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordLoading = false; proactiveRecordEpoch++; errorHistory = []; errorPage = null; errorLoading = false; errorEpoch++;
      replyContactSearch = ''; logRecords = []; logLoading = false; logEpoch++; logSignature = ''; logFilters = { source: 'reply' }; lastAutoScanAt = 0;
      $('#ai-content').innerHTML = '<p class="ai-help">正在读取设置…</p>'; message('');
      try { const result = await call(); if (!result) return; restoreRecords(); modeTargets('reply').forEach(id => replyProfiles.add(id)); render(); } catch (e) { if (attachedGeneration !== generation) return; message(e.message, true); }
      if (attachedGeneration !== generation) return;
      const current = generation;
      timer = setInterval(async () => {
        if (polling || current !== generation) return; polling = true;
        try {
          if (busy) { const epoch = requestEpoch; const result = await api(`/instances/${id}/ai`).catch(() => null); if (current !== generation || epoch !== requestEpoch || !busy || !result) return; if (analysisQueueAccount !== null && result.account !== analysisQueueAccount) { analysisQueueToken++; analysisQueueAccount = null; for (const report of analysisResult?.reports || []) if (report.status === 'waiting' || report.status === 'analyzing') { report.status = 'cancelled'; report.error = ''; } render(); message('微信账号已变化，已停止剩余联系人分析', true); return; } $('#ai-operation').hidden = !result.operation && !contactsLoading; $('#ai-operation-text').textContent = operationText(result.operation) || (contactsLoading ? '正在获取联系人…' : ''); }
          else { const result = await call(); if (result) { controls(); if (tab === 'activity' && !panel.hidden && !logLoading && logSignature !== JSON.stringify([state.activity || [], state.activityHistory || []])) await loadActivity(); } }
        } catch (e) { if (current === generation && !panel.hidden) message(e.message, true); }
        finally { if (current === generation) polling = false; }
      }, 2500);
    },
    detach() { analysisQueueToken++; analysisQueueAccount = null; rememberRecords(); proactiveRecordEpoch++; proactiveRecordLoading = false; proactiveHistory = []; proactiveHistoryPage = null; errorEpoch++; errorLoading = false; errorHistory = []; errorPage = null; logEpoch++; analysisDraft = { request: '', from: '', to: '', contacts: [] }; analysisSearch = ''; analysisHistoryReport = null; analysisHistoryEpoch++; analysisResult = null; reviewAlert.hidden = true; concealKey(true); modelDraft = null; learningDraft = null; profileDrafts.clear(); manualReplyDrafts.clear(); objectDrafts.clear(); selectedObject = ''; objectSearch = ''; objectKind = 'person'; editingReplyContact = null; providerRevision++; generation++; clearInterval(timer); id = null; state = null; rail.hidden = true; panel.hidden = true; $('#ai-content').replaceChildren(); selectedContacts.clear(); replyProfiles.clear(); proactiveUI.reset(); replyDraft = null; },
  };
}
