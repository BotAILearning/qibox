import { productDialog as platformProductDialog } from './dialogs.mjs';
import { personalInformationPage, personalEntriesFromForm, personalDraftFromForm, updatePersonalInformationForm, globalReplyStrategyPage, objectStyleTabs } from './ai-account-settings.mjs';
import { retiredPersonalFields } from '../server/ai-personal-fields.mjs';
import { dateRangeField, chooseDateRange } from './ai-date-range.mjs';
import { providerPage } from './ai-provider-view.mjs';
import { settingsPage } from './ai-settings-view.mjs';
import { icon, iconSprite, logoIcon } from './ai-icons.mjs';
import { keyIcon } from './ai-key-icon.mjs';
import { memoryFields, pendingMemoryFields, wikiEntryMarkup, sameWikiEntries, degreeOptions } from './ai-memory-view.mjs';
import { objectPage, objectList, objectExecutionStatus, objectWindow, OBJECT_ROW_HEIGHT } from './ai-object-view.mjs';
import { replyLimitControl, syncReplyLimitControl, parseReplyLimit, replyLimitManualMax } from './ai-reply-limit.mjs';
import { styleChoice, styleSummary as styleSummaryText } from './ai-style-view.mjs';
import { learnedObjectDraft } from './ai-learning-draft.mjs';
import { analysisPage, analysisContactList, copyReport, presetRequest, analysisRequestState, presetChips } from './ai-analysis-view.mjs';
import { activityPage, activityEntries, activityRows, activityPagination, proactiveRecordRows, liveActivityBox, recentErrorsBox, skipRecordsView, updateActivityCounts } from './ai-activity-view.mjs';
import { beijingTime, createProactiveUI } from './ai-proactive-view.mjs';
import { RecordCache, mergeRecordResults } from './ai-record-cache.mjs';
import { refreshRecordContent, skipDisclosureKeys } from './ai-record-refresh.mjs';
import { errorDisclosureState, refreshErrors, revealErrorRecord } from './ai-error-view.mjs';
import { contactName, nicknameOf, contactSearch as searchableContact } from './ai-contact-name.mjs';
import { contactPickerMatches, contactPickerRow, openContactPickerDialog, setContactAvatarInstance, resetContactAvatarFailures, noteContactAvatarFailure } from './ai-contact-picker.mjs';
import { refreshReplyCountdowns } from './ai-reply-flow-view.mjs';
import { dismissibleNotice } from './dismissible-notice.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eventLabels = { contacted: '已主动联系', replied: '已自动回复', manual: '已交由你回复', limit: '已达到回复次数上限', skip: '本轮无需回复', stop: '已收到停止联系要求', uncertain: '发送结果未知，本次不重发', error: '任务已暂停', failed: '对象不可读取，本次未发送' };
const names = { formality: '正式程度', warmth: '亲切程度', length: '回复长度', directness: '表达方式', emoji: '表情使用', humor: '幽默程度' };
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
const field = (name, label, value, max = 1200, placeholder = '') => `<label class="ai-field">${label}<textarea name="${name}" maxlength="${max}" rows="${name === 'summary' ? 6 : 2}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
const KEY_MASK = '********';
const LEARN_TARGETS = [
  { id: 'both', label: '风格 + 记忆', hint: '两项结果一起确认应用' },
  { id: 'style', label: '仅学习风格', hint: '保留现有记忆' },
  { id: 'memory', label: '仅学习记忆', hint: '记忆结果逐位确认' },
];
const serviceIdentity = value => `${String(value?.protocol || 'openai')}|${String(value?.baseUrl || '').trim().replace(/\/+$/, '')}`;

export function aiAssistant({ api, downloadAnalysisReport, onClose, onOpenChat, onVisibilityChange, guard, ensure }) {
  const rail = document.querySelector('#ai-rail'), panel = document.querySelector('#ai-panel');
  const setPanelVisible = visible => { panel.hidden = !visible; onVisibilityChange?.(visible); };
  panel.addEventListener('error', event => { noteContactAvatarFailure(event.target); }, true);
  // guard：入口常驻后，操作开关 / 打开面板前由外层判断可用性，不满足时弹窗提醒并返回 false。
  const pass = () => guard ? guard() !== false : true;
  // ensure：入口常驻后入口可能先于实例挂载出现，操作前补一次挂载，避免用空实例 id 发请求。
  async function ensureInstance() {
    if (id) return true;
    if (!ensure) return false;
    await ensure();
    return !!id;
  }
  let id, state, tab = 'overview', timer, lastPollAt = 0, generation = 0, requestEpoch = 0, workToken = 0, analysisQueueToken = 0, analysisQueueAccount = null, polling = false, busy = false, attaching = false;
  let personalDraft = null, personalDraftAccount = null;
  const loadingContent = '<div class="ai-entry-loading" role="status" aria-live="polite"><div class="ai-entry-loading-art" aria-hidden="true"><span class="ai-entry-loading-ring"></span><span class="ai-entry-loading-mark">AI</span></div><strong>正在打开 AI 辅助</strong><p>正在读取当前微信的设置…</p></div>';
  // Profiles carry a snapshot label; the WeChat nickname still lives in the
  // address book, so rows derived from a profile borrow it from there.
  // These must stay inside the closure: `state` is declared here, and a
  // module-level arrow would throw "ReferenceError: state is not defined".
  const profileContact = profile => (state.contacts || []).find(c => c.id === profile?.contact);
  const profileName = profile => contactName(profile, profileContact(profile));
  const profilePlainName = profile => {
    const contact = profileContact(profile), nickname = nicknameOf(profile, contact);
    return String(profile?.label ?? contact?.label ?? '联系人') + (nickname ? `（${nickname}）` : '');
  };
  let lastActivity = 0;
  let replyDraft = null, editingProfile = null, profileReturn = 'results';
  let contactsLoaded = false, contactsLoading = false, resultProfileIds = null;
  let lastAutoScanAt = 0;
  let editingReplyContact = null, replyContactSearch = '', contactSearch = '', learnContactKind = 'person';
  let modelDraft = null, providerRevision = 0, revealRevision = 0, learningDraft = null, renderedView = '';
  const profileDrafts = new Map();
  const manualReplyDrafts = new Map();
  const objectDrafts = new Map();
  const objectDirtyContacts = new Set();
  let learnRange = { from: '', to: '' }, learnScope = 'range', learnRangeMode = 'all', learnTarget = 'both', memoryPendingSignature = '';
  let defaultStylePerspective = 'self', defaultStyleMode = 'contacts';
  let defaultStyleReturn = 'settings';
  let contactDialog = null;
  let analysisDraft = { request: '', from: '', to: '', contacts: [], includeVoice: false, includeVisual: false }, analysisRangeMode = 'all', analysisRangeBeforeCustom = null, analysisContactsExpanded = false, analysisResult = null, analysisSearch = '', analysisHistoryReport = null, analysisHistoryEpoch = 0;
  let analysisExportSelecting = false, analysisExportSelected = new Set(), analysisExportDialog = null, analysisExportController = null;
  let objectKind = 'person', selectedObject = '', objectSection = 'reply', objectMemoryCategory = 'name', objectSearch = '', logFilters = { source: 'reply' };
  let objectScrollKey = '', objectScrollTop = 0;
  function rememberedObjectScroll() {
    const key = JSON.stringify([id, state?.account, objectKind, objectSearch]);
    if (key !== objectScrollKey) { objectScrollKey = key; objectScrollTop = 0; return 0; }
    const list = $('#ai-object-list');
    if (list) objectScrollTop = list.scrollTop;
    return objectScrollTop;
  }
  const acknowledgedReplyLimitOverflow = new WeakMap();
  let replyLimitOverflowDialogOpen = false;
  let replyLimitConfirmController = null;
  const confirmationControllers = new Set();
  async function productDialog(options = {}) {
    const current = generation, target = id, account = state?.account, controller = new AbortController();
    const cancel = () => controller.abort();
    confirmationControllers.add(controller);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      const answer = await platformProductDialog({ ...options, signal: controller.signal });
      return !controller.signal.aborted && current === generation && target === id && account === state?.account ? answer : null;
    } finally { confirmationControllers.delete(controller); options.signal?.removeEventListener('abort', cancel); }
  }
  const confirmDialog = message => productDialog({ message });
  const objectView = () => ({ kind: objectKind, selected: selectedObject, section: objectSection, memoryCategory: objectMemoryCategory, search: objectSearch, draft: objectDrafts.get(selectedObject), dirty: objectDirtyContacts.has(selectedObject), scrollTop: rememberedObjectScroll(), height: $('#ai-object-list')?.clientHeight || 600 });
  function objects() { return objectPage(state, objectView()); }
  function drawObjectList() {
    const list = $('#ai-object-list');
    if (!list || !state) return;
    const html = objectList(state, objectView());
    if (list._objectHtml === html) return;
    const scroll = list.scrollTop, focus = list.contains?.(document.activeElement) ? document.activeElement.closest('[data-ai-object]')?.dataset.aiObject : null;
    list.innerHTML = html; list._objectHtml = html; list.scrollTop = scroll;
    if (focus) [...list.querySelectorAll('[data-ai-object]')].find(row => row.dataset.aiObject === focus)?.focus({ preventScroll: true });
  }
  let objectScrollFrame = 0;
  panel.addEventListener('scroll', event => {
    if (event.target.id !== 'ai-object-list' || objectScrollFrame) return;
    objectScrollFrame = requestAnimationFrame(() => {
      objectScrollFrame = 0;
      const list = $('#ai-object-list');
      if (!list || !state) return;
      const contacts = contactPickerMatches(state.contacts, objectKind, objectSearch);
      const range = objectWindow(contacts.length, list.scrollTop, list.clientHeight);
      if (list.querySelector('[data-object-window]')?.dataset.objectWindow !== `${range.start}:${range.end}`) drawObjectList();
    });
  }, true);
  panel.addEventListener('keydown', event => {
    const row = event.target.closest?.('[data-ai-object-index]');
    if (!row || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !state) return;
    event.preventDefault();
    const total = contactPickerMatches(state.contacts, objectKind, objectSearch).length;
    const index = Math.max(0, Math.min(total - 1, event.key === 'Home' ? 0 : event.key === 'End' ? total - 1 : Number(row.dataset.aiObjectIndex) + (event.key === 'ArrowDown' ? 1 : -1)));
    const list = $('#ai-object-list');
    if (index * OBJECT_ROW_HEIGHT < list.scrollTop) list.scrollTop = index * OBJECT_ROW_HEIGHT;
    else if ((index + 1) * OBJECT_ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = (index + 1) * OBJECT_ROW_HEIGHT - list.clientHeight;
    drawObjectList();
    list.querySelector(`[data-ai-object-index="${index}"]`)?.focus({ preventScroll: true });
  });
  let logRecords = [], logLoading = false, logEpoch = 0, logSignature = '';
  let skipLoading = false, skipEpoch = 0, skipHistory = [], skipHistoryPage = null, skipPageLoading = false;
  const skipContent = new Map();
  const markReplyStatus = new Map();
  function skipState() {
    const rows = new Map([...skipHistory, ...(state?.skipRecords || [])].map(row => [row.id, row]));
    return { ...state, skipPageLoading, skipRecordsPage: skipHistoryPage ? { ...skipHistoryPage, total: Math.max(skipHistoryPage.total || 0, state?.skipRecordsPage?.total || 0) } : state?.skipRecordsPage, skipRecordsLoading: skipLoading, skipMessageExpanded: logFilters.skipMessageExpanded || [], skipRecords: [...rows.values()].map(row => ({ ...row, ...(skipContent.get(row.id) || {}), markedForReply: row.markedForReply === true, ...(markReplyStatus.get(row.id) || {}) })) };
  }
  function drawSkips() {
    const box = tab === 'activity' && $('#ai-skip-records');
    if (box) refreshRecordContent(box, () => {
      logFilters.skipMessageExpanded = skipDisclosureKeys(box, logFilters.skipMessageExpanded);
      return skipRecordsView(skipState());
    }, { outerMarkup: true });
  }
  async function loadSkipContent(retry = false) {
    if (!state || skipLoading || logFilters.source !== 'reply') return;
    if (retry) skipContent.clear();
    const rows = skipState().skipRecords.sort((a, b) => b.at - a.at);
    const eventIds = rows.filter(row => row.id && !row.incomingMessages?.length && !skipContent.has(row.id)).map(row => row.id);
    if (!eventIds.length) return;
    const current = generation, target = id, account = state.account, epoch = ++skipEpoch;
    const valid = () => current === generation && target === id && account === state?.account && epoch === skipEpoch;
    skipLoading = true; drawSkips();
    try {
      for (let start = 0; start < eventIds.length && valid(); start += 50) {
        const result = await api(`/instances/${target}/ai`, { action: 'skip-record-content', value: { eventIds: eventIds.slice(start, start + 50) } }, 130000);
        if (!valid() || result.account !== account) return;
        for (const row of result.records || []) skipContent.set(row.id, row);
      }
    } catch (error) {
      if (valid()) for (const eventId of eventIds) skipContent.set(eventId, { contentUnavailable: true, contentUnavailableMessage: '原消息暂时无法读取，请稍后重新进入执行记录重试。' });
    } finally { if (valid()) { skipLoading = false; drawSkips(); } }
  }
  async function loadSkipPage() {
    const page = skipHistoryPage || state?.skipRecordsPage;
    if (!page?.hasMore || skipPageLoading) return;
    const current = generation, target = id, account = state.account;
    skipPageLoading = true; drawSkips();
    try {
      const result = await api(`/instances/${target}/ai`, { action: 'skip-records', value: { limit: 50, before: page.nextBefore } });
      if (current !== generation || target !== id || account !== state?.account) return;
      skipHistory = [...new Map([...skipState().skipRecords, ...result.records].map(row => [row.id, row])).values()]; skipHistoryPage = result.page;
    } catch (error) { if (current === generation) message(error.message, true); }
    finally { if (current === generation) { skipPageLoading = false; drawSkips(); void loadSkipContent(); } }
  }
  const summaryResults = new Map();
  function showSummary(profileId, value) {
    summaryResults.set(profileId, value);
    const row = document.querySelector(`[data-ai-reply-card="${CSS.escape(profileId)}"]`);
    const output = row?.querySelector('[data-ai-summary-result]');
    if (output) { output.hidden = false; output.textContent = value.text; }
    const button = row?.querySelector('[data-ai-summary-profile]');
    if (button) button.disabled = !!value.pending;
  }
  let proactiveHistory = [], proactiveHistoryPage = null, proactiveRecordLoading = false, proactiveRecordEpoch = 0;
  let errorHistory = [], errorPage = null, errorLoading = false, errorEpoch = 0, errorLocatorEpoch = 0;
  const recordCache = new RecordCache();
  let logRequestScope = '';
  const rememberRecords = () => recordCache.save(id, state?.account, { logRecords, proactiveHistory, proactiveHistoryPage, errorHistory, errorPage, logFilters });
  function restoreRecords() {
    const saved = recordCache.take(id, state?.account);
    if (saved) ({ logRecords, proactiveHistory, proactiveHistoryPage, errorHistory, errorPage, logFilters } = saved, logFilters.source = 'reply', delete logFilters.taskId);
  }
  function drawRecords() {
    if (state && tab === 'activity') updateActivityCounts(panel, skipState(), logFilters, logRecords);
    if (state && tab === 'activity' && $('#ai-activity-entries')) $('#ai-activity-entries').innerHTML = activityRows(state, logFilters, logRecords, logLoading, summaryResults);
    const pagination = panel.querySelector('[data-ai-log-pagination]');
    if (state && tab === 'activity' && pagination) pagination.innerHTML = activityPagination(state, logFilters, logRecords);
  }
  function drawErrors() {
    if (state && tab === 'activity') {
      const box = $('#ai-recent-errors');
      if (box) refreshErrors(box, () => {
        Object.assign(logFilters, errorDisclosureState(box, logFilters));
        return recentErrorsBox(activityState(), logFilters.errorsOpen, errorLoading, logFilters.errorExpanded);
      });
    }
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
    return { ...skipState(), proactiveRecords: [...rows.values()].sort((a, b) => new Date(b.at) - new Date(a.at)), proactiveRecordsPage: proactiveHistoryPage || (logFilters.taskId ? { hasMore: true } : state?.proactiveRecordsPage),
      recentErrors: [...errors.values()].sort((a, b) => new Date(b.at) - new Date(a.at)), errorsPage: { ...serverPage, ...(errorPage || {}), total } };
  };
  function activity() { Object.assign(logFilters, errorDisclosureState($('#ai-recent-errors'), logFilters)); return activityPage(activityState(), logFilters, logRecords, logLoading, proactiveRecordLoading, errorLoading, summaryResults); }
  function drawProactiveRecords(loading = proactiveRecordLoading) {
    const box = $('#ai-proactive-records');
    if (box) refreshRecordContent(box, () => proactiveRecordRows(activityState(), logFilters, loading));
  }
  async function loadProactiveRecords(more = false) {
    if (proactiveRecordLoading) return;
    const current = generation, target = id, epoch = ++proactiveRecordEpoch, taskId = logFilters.taskId || '';
    const page = proactiveHistoryPage || (!taskId ? state?.proactiveRecordsPage : null);
    if (more && !page?.hasMore) return;
    proactiveRecordLoading = true;
    drawProactiveRecords(true);
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
        drawProactiveRecords(false);
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
  async function openConversation(profileId, button) {
    const current = generation, target = id;
    const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '正在打开聊天…'; }
    message('正在按联系人身份定位微信聊天…');
    let result;
    try { result = await api(`/instances/${target}/ai`, { action: 'open-conversation', id: profileId }, 30000); }
    catch (error) { if (current !== generation || target !== id) return; throw error; }
    finally { if (button?.isConnected && current === generation) { button.disabled = false; button.textContent = original; } }
    if (current !== generation || target !== id) return;
    if (!result.opened) throw new Error('尚未确认打开目标聊天');
    setPanelVisible(false);
    await onOpenChat?.(target);
  }
  function confirmRealtime() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'ai-confirm-dialog';
      dialog.innerHTML = '<h3>开启 AI 实时回复？</h3><p>开启后，AI 会根据群聊消息自动回复。消息较多时可能增加费用；自动发言过于频繁可能导致账号受限。</p><form method="dialog" class="ai-actions"><button class="secondary" value="cancel">取消</button><button class="primary" value="confirm">确认开启</button></form>';
      dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  function confirmReplyLimitOverflow() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'ai-confirm-dialog ai-reply-limit-warning';
      dialog.innerHTML = '<h3>警告</h3><p>你又不会跟TA聊那么多！</p><form method="dialog" class="ai-actions"><button class="secondary" value="understood">好的，明白</button><button class="primary" value="unlimited">那我选（不限）吧</button></form>';
      dialog.addEventListener('close', () => { const choice = dialog.returnValue; dialog.remove(); resolve(choice); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  function handleReplyLimitOverflow(input) {
    if (!input?.matches?.('[data-ai-reply-limit-custom]')) return;
    if (!(Number(input.value) > replyLimitManualMax)) { acknowledgedReplyLimitOverflow.delete(input); return; }
    if (acknowledgedReplyLimitOverflow.get(input) === input.value || replyLimitOverflowDialogOpen) return;
    acknowledgedReplyLimitOverflow.set(input, input.value);
    replyLimitOverflowDialogOpen = true;
    void confirmReplyLimitOverflow().then(choice => {
      if (!input.isConnected) return;
      const select = input.closest('[data-ai-reply-limit]')?.querySelector('[data-ai-reply-limit-choice]');
      if (!select) return;
      if (choice === 'understood') {
        input.value = '';
        syncReplyLimitControl(input);
        acknowledgedReplyLimitOverflow.delete(input);
        rememberDraft();
        if (select.closest('#ai-object-form') && $('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false;
        return;
      }
      if (choice !== 'unlimited') return;
      select.value = 'unlimited';
      syncReplyLimitControl(select);
      rememberDraft();
      if (select.closest('#ai-object-form') && $('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false;
    }).finally(() => { replyLimitOverflowDialogOpen = false; });
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
  const needsContacts = () => !state.contacts?.length || state.avatarReady === false;
  const operationText = operation => {
    if (operation?.phase?.startsWith('analysis-')) {
      const labels = { 'analysis-reading': '读取聊天记录', 'analysis-voice': '分析语音', 'analysis-image': '分析图片', 'analysis-video': '分析视频', 'analysis-vision': '分析图片和视频', 'analysis-model': '生成报告' };
      const elapsed = operation.startedAt ? Math.max(0, Math.floor((Date.now() - operation.startedAt) / 1000)) : 0;
      return `正在${labels[operation.phase] || '分析'}${operation.total > 1 ? ` ${operation.completed}/${operation.total}` : ''}${operation.skipped ? `，跳过 ${operation.skipped}` : ''}${elapsed >= 10 ? `，已等待 ${elapsed} 秒` : ''}`;
    }
    return operation ? operation.phase === 'contacts' ? operation.total ? `正在获取联系人 ${operation.completed}/${operation.total}` : '正在读取通讯录…' : operation.phase === 'memory' ? `正在学习聊天记忆 ${operation.completed}/${operation.total} 批，请勿关闭页面` : operation.phase === 'model' ? `正在分析 ${operation.total} 位联系人的聊天风格…` : `正在读取聊天 ${operation.completed}/${operation.total}` : '';
  };
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
    const skipWait = event.target.closest('[data-ai-skip-reply-wait]');
    if (skipWait) {
      event.preventDefault();
      void execute('skip-reply-wait', { id: skipWait.dataset.aiSkipReplyWait }, '已跳过等待，正在交给 AI 处理').catch(error => message(error.message, true));
      return;
    }
    const resume = event.target.closest('[data-ai-resume-profile]');
    if (resume) {
      event.preventDefault(); const p = state.profiles.find(p => p.id === resume.dataset.aiResumeProfile);
      if (p) void execute('profile', { id: p.id, value: { style: p.style, paused: false } }, '已开启，将处理后续新消息').catch(error => message(error.message, true));
      return;
    }
    const open = event.target.closest('[data-ai-open-conversation]');
    if (open) { event.preventDefault(); if (!open.disabled) void openConversation(open.dataset.aiOpenConversation, open).catch(error => message(error.message, true)); return; }
  });
  const { show: message } = dismissibleNotice($('#ai-feedback'), {
    fallbackFocus: () => panel.querySelector('.ai-main-tabs [aria-current="page"]'),
  });
  function confirmRecordDelete() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ai-confirm-dialog ai-record-delete-dialog';
      dialog.innerHTML = '<div class="ai-record-delete-symbol" aria-hidden="true">!</div><h3>删除这条执行记录？</h3><p>删除后无法恢复。微信中的聊天消息不会被删除。</p><div class="ai-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="button" class="danger" data-confirm>删除记录</button></div>';
      let confirmed = false;
      dialog.addEventListener('close', () => { dialog.remove(); resolve(confirmed); }, { once: true });
      dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
      dialog.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.hasAttribute('data-confirm')) confirmed = true;
        dialog.close();
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }
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
  function resetAnalysisExport() {
    analysisExportController?.abort(); analysisExportController = null;
    analysisExportSelecting = false; analysisExportSelected.clear(); analysisExportDialog = null;
  }
  function closeAnalysisExport() {
    analysisExportController?.abort(); analysisExportController = null;
    analysisExportDialog = null; render();
  }
  function openAnalysisExport(ids, report = null) {
    if (!downloadAnalysisReport) throw new Error('当前页面暂不支持文件下载，请刷新后重试');
    if (!state?.account || !ids.length) throw new Error('请选择已保存的分析报告');
    analysisExportDialog = { ids: [...ids], account: state.account, format: 'pdf', label: report?.label, actualRange: report?.actualRange };
    render();
  }
  async function startAnalysisExport() {
    const dialogState = analysisExportDialog, element = $('#ai-report-export-dialog');
    if (!dialogState || !element || analysisExportController) return;
    if (dialogState.account !== state?.account) throw new Error('微信账号已变化，请重新选择报告');
    dialogState.format = element.querySelector('[name=report-export-format]:checked')?.value;
    const controller = new AbortController(); analysisExportController = controller;
    const downloadButton = element.querySelector('[data-ai-export-download]');
    downloadButton.disabled = true; downloadButton.textContent = '正在准备文件…';
    try {
      await downloadAnalysisReport(id, { ids: dialogState.ids, format: dialogState.format }, controller.signal);
      if (controller.signal.aborted || analysisExportDialog !== dialogState) return;
      analysisExportDialog = null; analysisExportController = null;
      analysisExportSelecting = false; analysisExportSelected.clear();
      render(); message('已开始下载分析报告');
    } catch (error) {
      if (controller.signal.aborted || analysisExportDialog !== dialogState) return;
      const output = element.querySelector('#ai-report-export-error');
      output.textContent = error.message || '导出失败，请重试'; output.hidden = false;
      downloadButton.disabled = false; downloadButton.textContent = dialogState.ids.length === 1 ? '下载文件' : '下载 ZIP';
      analysisExportController = null;
    }
  }
  async function call(action, extras = {}, compact = false) {
    const current = generation, target = id, epoch = action ? ++requestEpoch : requestEpoch;
    // 未挂载实例时不要用空 id 发请求（会落到不存在的路由上），先补挂载或明确提示。
    if (!target) throw new Error('AI 辅助尚未就绪，请重新打开微信后再试');
    let result;
    try { result = await api(`/instances/${target}/ai${compact && state ? '?view=live' + (selectedObject ? '&contact=' + encodeURIComponent(selectedObject) : '') : ''}`, action ? { action, ...extras } : undefined, ['learn', 'scan'].includes(action) ? 30 * 60 * 1000 : 130000); }
    catch (error) { if (current !== generation || target !== id || epoch !== requestEpoch) return null; throw error; }
    if (current !== generation || target !== id || epoch !== requestEpoch) return null;
    // The action acknowledges a queued request; it does not return an AI state.
    // Keep the current account and drafts if the follow-up read temporarily fails.
    if (action === 'skip-reply-wait' && result.accepted === true) {
      try { return await call(undefined, {}, true); }
      catch { return result; }
    }
    return acceptState(result);
  }
  async function acceptState(result) {
    const initialState = !state;
    const accountChanged = state && state.account !== result.account;
    if (accountChanged) {
      // Invalidate pending reads and discard local edits from the old account,
      // even when both accounts have the same contact ID.
      requestEpoch++;
      workToken++; busy = false; contactsLoading = false; panel.setAttribute('aria-busy', 'false');
      // Removing a focused input emits a change event synchronously. Detach
      // the old account first so that event cannot remember its private text.
      state = null; $('#ai-content').innerHTML = loadingContent;
      replyLimitConfirmController?.abort(); replyLimitConfirmController = null;
      for (const controller of confirmationControllers) controller.abort();
      concealKey(true); providerRevision++; modelDraft = null; learningDraft = null; replyDraft = null;
      profileDrafts.clear(); manualReplyDrafts.clear(); objectDrafts.clear(); objectDirtyContacts.clear();
      objectScrollKey = ''; objectScrollTop = 0; selectedObject = ''; objectSearch = ''; objectKind = 'person'; objectSection = 'reply'; objectMemoryCategory = 'name';
      editingProfile = null; editingReplyContact = null; selectedContacts.clear(); replyProfiles.clear();
      learnRange = { from: '', to: '' }; learnRangeMode = 'all'; learnScope = 'range'; learnTarget = 'both';
      analysisQueueToken++; analysisQueueAccount = null;
      analysisDraft = { request: '', from: '', to: '', contacts: [], includeVoice: false, includeVisual: false }; analysisRangeMode = 'all'; analysisContactsExpanded = false; analysisSearch = '';
      proactiveUI.reset();
      personalDraft = null; personalDraftAccount = null;
      analysisHistoryEpoch++; analysisHistoryReport = null; analysisResult = null; resetAnalysisExport();
      summaryResults.clear();
      skipContent.clear(); markReplyStatus.clear(); skipEpoch++; skipLoading = false; skipHistory = []; skipHistoryPage = null; skipPageLoading = false;
      recordCache.delete(id); logEpoch++; proactiveRecordEpoch++; errorEpoch++;
      logRecords = []; proactiveHistory = []; proactiveHistoryPage = null; errorHistory = []; errorPage = null; errorLoading = false; logLoading = false; proactiveRecordLoading = false; logSignature = '';
    }
    if (accountChanged && result.compact) {
      // The live read already establishes a new account. Conceal old private
      // forms immediately, even if fetching its full configuration is slow.
      return call();
    }
    if (result.compact && (result.account !== state?.account || result.configurationRevision !== state?.configurationRevision)) return call();
    if (result.compact) { const updates = new Map(result.profiles.map(profile => [profile.id, profile])); result = { ...state, ...result, profiles: state.profiles.map(profile => updates.has(profile.id) ? { ...profile, ...updates.get(profile.id) } : profile) }; }
    state = result;
    // Repaint every page immediately so old private text cannot remain in the
    // form after its draft has been discarded.
    if (accountChanged || initialState) render();
    return result;
  }
  function selectProfiles(includePaste = true) { return (state?.profiles || []).filter(p => includePaste || p.contact && state.contacts.some(c => c.id === p.contact)); }
  function scopeOptions(selected = '') { return option('', '通用策略', !selected) + selectProfiles().map(p => option(p.id, p.label, p.id === selected)).join(''); }
  function replaceLiveContent(node, html) {
    const expanded = new Map([...node.querySelectorAll('details[data-ai-optional]')].map(row => [row.dataset.aiOptional, row.open]));
    node.innerHTML = html;
    for (const row of node.querySelectorAll('details[data-ai-optional]')) if (expanded.has(row.dataset.aiOptional)) row.open = expanded.get(row.dataset.aiOptional);
  }
  const hasPendingAnalysis = () => analysisQueueAccount !== null && analysisResult?.reports?.some(row => ['waiting', 'analyzing'].includes(row.status));
  function controls() {
    if (!state) return;
    // 记忆合并在后台跑，轮询拿到新状态时重画对象页，让合并结果立刻可确认。
    const memoryPending = JSON.stringify((state.profiles || []).map(p => [p.id, p.pendingMemoryId || '', p.pendingMemoryAt || 0, p.pendingMemorySource || '', p.memoryMerge?.status || '']));
    if (memoryPending !== memoryPendingSignature) {
      memoryPendingSignature = memoryPending;
      if (['overview', 'profile'].includes(tab)) { render(); return; }
    }
    for (const input of document.querySelectorAll('[data-ai-setting]')) input.checked = !!state.settings[input.dataset.aiSetting];
    const panelMaster = panel.querySelector('[data-ai-panel-master]'); if (panelMaster) panelMaster.checked = state.settings.enabled;
    const masterLabel = panel.querySelector('#ai-panel-master-label'); if (masterLabel) masterLabel.textContent = state.settings.enabled ? 'AI 已开启' : 'AI 已关闭';
    const pending = (state.activity || []).filter(p => p.needsHelp); reviewAlert.hidden = !pending.length; reviewAlert.textContent = `需处理 ${pending.length}`;
    $('#ai-operation').hidden = !state.operation && !contactsLoading && !hasPendingAnalysis();
    $('#ai-operation-text').textContent = operationText(state.operation) || (contactsLoading ? '正在获取联系人…' : hasPendingAnalysis() ? '正在分析聊天记录…' : '');
    const readiness = $('#ai-readiness');
    if (readiness) {
      const needs = [...new Set([state.requirements.proactive, state.requirements.reply].filter(Boolean))];
      readiness.textContent = needs.length ? needs.join('；') : '已完成准备，可以选择需要运行的功能';
    }
    proactiveUI.refresh();
    if (tab === 'overview') drawObjectList();
    if (tab === 'overview' && selectedObject) {
      const execution = panel.querySelector('[data-ai-object-execution]');
      if (execution?.dataset.aiObjectExecution === selectedObject) replaceLiveContent(execution, objectExecutionStatus(state, selectedObject));
    }
    if (tab === 'activity') {
      updateActivityCounts(panel, skipState(), logFilters, logRecords);
      const liveBox = $('#ai-live-box'); if (liveBox) replaceLiveContent(liveBox, liveActivityBox(state));
      drawErrors();
      drawProactiveRecords();
      drawSkips(); void loadSkipContent();
    }
    if (state.notice) { const note = $('#ai-state-notice'); if (note) note.textContent = state.notice; }
  }
  function replyContactList() {
    const query = replyContactSearch.trim().normalize('NFKC').toLocaleLowerCase();
    const contacts = (state.contacts || []).filter(c => c.kind === 'person' && (!query || searchableContact(c).includes(query)));
    return contacts.map(contact => {
      const profile = selectProfiles().find(p => p.contact === contact.id), applied = profile && (state.settings.replyScope === 'all' || modeTargets('reply').includes(profile.id));
      const strategy = profile && { ...replyStrategy(), ...(profile.strategy || {}), ...(profile.replyStrategy || {}) };
      return `<article class="ai-reply-contact" data-ai-reply-contact="${esc(contact.id)}"><strong>${contactName(contact)}</strong><div class="ai-contact-strategy" data-ai-contact-strategy aria-label="${esc(contact.label)}的回复策略">${applied ? `${styleSummary(profile)}<p class="ai-help">回复目的：${esc(strategy.replyGoal)}</p>` : ''}</div><div class="ai-actions"><button type="button" class="secondary" data-ai-manual-contact="${esc(contact.id)}">${applied ? '调整回复风格' : '选择回复风格'}</button><button type="button" class="quiet" data-ai-learn-contact="${esc(contact.id)}" title="学习风格或记忆，可选择学习目标">学习</button>${profile?.learnedAt || profile?.pendingStyle ? `<button type="button" class="quiet" data-ai-profile="${esc(profile.id)}">查看学习结果</button>${!applied && !profile?.pendingStyle ? `<button type="button" class="quiet" data-ai-apply-contact="${esc(contact.id)}">应用聊天风格</button>` : ''}` : ''}</div></article>`;
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
    if (modelDraft?.editing) throw new Error('请先保存当前模型，或返回模型列表放弃编辑');
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
  function resizeStyleSummary(textarea = panel.querySelector('#ai-object-form .ai-reference-style textarea[name="summary"]')) {
    if (!textarea || textarea.closest?.('[hidden]') || panel.hidden) return;
    const content = panel.querySelector('#ai-content'), footer = textarea.form?.querySelector('.ai-object-save');
    if (!content || !footer) return;
    const scrollTop = textarea.scrollTop;
    textarea.style.height = 'auto';
    textarea.style.overflowY = 'hidden';
    const minHeight = Math.max(100, parseFloat(getComputedStyle(textarea).minHeight) || 0);
    const naturalHeight = Math.max(textarea.scrollHeight, minHeight);
    const visibleBottom = Math.min(content.getBoundingClientRect().bottom, panel.getBoundingClientRect().bottom, window.innerHeight);
    const availableHeight = Math.max(minHeight, textarea.getBoundingClientRect().height + visibleBottom - footer.getBoundingClientRect().bottom - 12);
    const height = Math.min(naturalHeight, availableHeight);
    textarea.style.height = `${Math.floor(height)}px`;
    textarea.style.overflowY = naturalHeight > height ? 'auto' : 'hidden';
    textarea.scrollTop = scrollTop;
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
    const edit = p => `<button type="button" class="quiet" data-ai-profile="${esc(p.id)}" aria-label="${editable ? '调整' : '查看'}${esc(profilePlainName(p))}的学习结果">${editable ? '调整' : '查看'}${p.paused ? ' · 待你处理' : ''}</button>`;
    return profiles.map(p => {
      const combined = p.pendingMemorySource === 'combined';
      const memory = combined ? p.pendingMemory : p.memory;
      const memoryBody = combined && memory?.entries?.length
        ? `<ul class="ai-result-memory">${memory.entries.map(entry => `<li>${esc(entry.text)}</li>`).join('')}</ul>`
        : `<p class="ai-result-memory">${esc(memory?.summary || (combined ? '本次没有提取到新的聊天记忆' : '暂无明确记忆'))}</p>`;
      return `<details class="ai-style-group" data-ai-result-profile="${esc(p.id)}" open><summary>${profileName(p)}</summary><h4>风格${combined ? '（待应用）' : ''}</h4>${styleSummary(p)}<h4>记忆${combined ? '（待应用）' : ''}</h4>${memoryBody}${combined ? '<p class="ai-help">应用后与已保存的记忆合并。</p>' : ''}${(p.replyStrategy?.replyGoal || p.strategy?.replyGoal) ? `<p class="ai-help">专属回复目的：${esc(p.replyStrategy?.replyGoal || p.strategy.replyGoal)}</p>` : ''}${combined ? '' : edit(p)}</details>`;
    }).join('');
  }
  function contactPickerRows(contacts, query) {
    const learned = new Set(learnedProfiles().map(p => p.contact));
    const rows = contactPickerMatches(contacts, null, query).map((c, index) => contactPickerRow(c, { index, multiple: true, selected: selectedContacts.has(c.id), input: `data-ai-contact="${esc(c.id)}"`, disabled: !['person', 'group'].includes(c.kind), detail: learned.has(c.id) ? '<small>已学习</small>' : '' })).join('');
    if (rows) return rows;
    if (String(query || '').trim()) return `<p class="ai-help">未找到匹配的${tab === 'learning' && learnContactKind === 'group' ? '群聊' : '联系人'}。</p>`;
    return `<p class="ai-help">${contactsLoading ? '正在获取联系人…' : tab === 'learning' && learnContactKind === 'group' ? '暂无群聊，可以刷新列表。' : '暂未获取到联系人，请确认微信已登录后刷新。'}</p>`;
  }
  function selectedContactRows(kinds = ['person', 'group']) {
    const chosen = (state.contacts || []).filter(c => kinds.includes(c.kind) && selectedContacts.has(c.id));
    return chosen.length ? chosen.map((contact, index) => contactPickerRow(contact, { index, selected: true, button: `data-ai-remove-contact="${esc(contact.id)}"`, trailing: '<span aria-hidden="true">×</span>' })).join('') : '<p class="ai-help">还没有选择联系人。</p>';
  }
  function contactPicker(headingSide = '', note = '', kinds = null) {
    return `<section class="ai-card ai-learning-contacts ai-contact-picker"><div class="ai-card-heading"><div><h4>选择联系人</h4><p>${note || '选择要学习聊天风格的联系人或群聊。'}</p></div><button type="button" class="secondary" data-ai-action="open-contact-picker">选择联系人</button></div><p id="ai-contact-count" class="ai-help ai-learning-count" aria-live="polite">已选择 ${selectedContacts.size} 位联系人</p><div class="ai-selected-contact-list ai-contact-picker-list">${selectedContactRows(kinds || ['person', 'group'])}</div>${headingSide}</section>`;
  }
  function learnTargetCards() {
    return `<div class="ai-learn-targets" role="radiogroup" aria-label="学习目标">${LEARN_TARGETS.map(t => `<label class="ai-learn-target${learnTarget === t.id ? ' selected' : ''}"><input type="radio" name="learnTarget" value="${esc(t.id)}" ${learnTarget === t.id ? 'checked' : ''}><span class="ai-learn-target-mark" aria-hidden="true"></span><span class="ai-learn-target-text"><strong>${esc(t.label)}</strong><small>${esc(t.hint)}</small></span></label>`).join('')}</div>`;
  }
  function learning() {
    return `<div class="ai-learning-page ai-reference-learning"><div class="ai-reference-learning-top"><button type="button" class="secondary" data-ai-nav="overview">← 返回</button><h3>批量学习风格与记忆</h3></div><div class="ai-reference-learning-shell"><section class="ai-card ai-reference-learning-list ai-contact-picker"><header><h4>选择联系人或群聊</h4><span id="ai-contact-count">已选 ${selectedContacts.size} 位</span></header><div class="ai-reference-learning-tools"><button type="button" class="primary" data-ai-action="open-contact-picker">选择联系人或群聊</button><button type="button" class="secondary" data-ai-action="scan">刷新联系人</button><button type="button" class="secondary" data-ai-action="select-contacts">选择未学习（每次 20 位）</button><button type="button" class="secondary" data-ai-action="clear-contacts">清空</button></div><div class="ai-reference-learning-choices ai-selected-contact-list ai-contact-picker-list" aria-label="已选择的联系人或群聊">${selectedContactRows()}</div></section><aside class="ai-card ai-reference-learning-config"><section><h4>学习目标</h4>${learnTargetCards()}</section><section><h4>聊天时间范围</h4><div class="ai-reference-range-pills"><button type="button" data-ai-learn-range="all" class="${learnRangeMode === 'all' ? 'active' : ''}">全部记录</button><button type="button" data-ai-learn-range="custom" class="${learnRangeMode === 'custom' ? 'active' : ''}">自定义日期</button></div>${learnRangeMode === 'custom' ? `<div class="ai-reference-learning-dates"><label>开始日期<input type="date" data-ai-learn-date="from" value="${esc(learnRange.from)}"></label><label>结束日期<input type="date" data-ai-learn-date="to" value="${esc(learnRange.to)}"></label></div>` : ''}</section><footer><button type="button" class="primary" data-ai-action="learn-selected" ${selectedContacts.size ? '' : 'disabled'}>开始学习 ${selectedContacts.size ? `(${selectedContacts.size})` : ''}</button><small>每位对象独立学习，结果逐位确认</small></footer></aside></div></div>`;
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
    return `<form id="ai-paste-form" class="ai-default-paste-form"><h4>粘贴聊天内容</h4><p class="ai-help">按聊天顺序粘贴，区分“我”和“对方”。</p><label class="ai-field"><span class="sr-only">聊天内容</span><textarea name="text" required maxlength="90000" rows="9" placeholder="我：你好，周五的会议时间可以调整吗？&#10;对方：可以的，改到下午三点吧。"></textarea></label><p class="ai-help">学习结果生成后，确认并保存才会生效。</p></form>`;
  }
  function defaultStyleLearning() {
    const ds = state.learnedDefaultStyle || null;
    const perspectiveLabel = p => p === 'other' ? '对方的风格' : '我的风格';
    const meta = ds ? `${perspectiveLabel(ds.perspective)}${ds.source === 'paste' ? ' · 来自粘贴的聊天' : ` · 基于 ${ds.labels?.length || ds.contacts?.length || 0} 位联系人的聊天`}${ds.learnedAt ? ` · ${new Date(ds.learnedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}` : '';
    const current = ds ? `<section class="ai-card ai-default-current"><div class="ai-card-heading"><h4>当前默认风格</h4><span class="ai-badge blue">${state.defaultStyleUndoable ? '待确认' : '已保存'}</span></div><form id="ai-default-style-form"><label class="ai-field"><span class="sr-only">风格总结</span><textarea name="summary" maxlength="6000" rows="7" placeholder="用自然语言描述默认的口吻与表达习惯">${esc(ds.style?.summary || summaryText(ds.style))}</textarea></label><small class="ai-default-count">${String(ds.style?.summary || summaryText(ds.style)).length} / 6000</small><p class="ai-help">${esc(meta)}。这将作为后续自动回复的默认风格。</p><div class="ai-actions">${state.defaultStyleUndoable ? '<button type="button" class="secondary" data-ai-action="cancel-default-style">取消当前学习</button>' : ''}<button type="submit" class="primary">保存修改</button></div></form></section>` : `<section class="ai-card ai-default-current ai-default-empty"><div><span class="ai-badge muted">尚未设置</span><h4>当前还没有默认风格</h4><p>选择联系人聊天或粘贴聊天内容开始学习。确认并保存后，才会应用于没有单独风格设置的对象。</p></div></section>`;
    const backLabel = ({ overview: '自动回复', settings: '系统设置', 'personal-info': '我的信息', 'global-reply': '全局回复策略', results: '学习结果', learning: '学习聊天风格', profile: '学习结果', 'manual-reply': '自动回复' })[defaultStyleReturn] || '系统设置';
    const sourceTabs = `<div class="ai-default-source-tabs" role="tablist" aria-label="学习素材来源"><button type="button" role="tab" data-ai-default-mode="contacts" aria-selected="${defaultStyleMode === 'contacts'}" class="${defaultStyleMode === 'contacts' ? 'selected' : ''}">${icon('chat')}<strong>联系人聊天</strong><small>选择与特定联系人的聊天记录</small></button><button type="button" role="tab" data-ai-default-mode="paste" aria-selected="${defaultStyleMode === 'paste'}" class="${defaultStyleMode === 'paste' ? 'selected' : ''}">${icon('file')}<strong>粘贴聊天</strong><small>直接粘贴聊天内容文本</small></button></div>`;
    const direction = `<section class="ai-default-direction"><h4>学习方向</h4><p class="ai-help">确定以谁的聊天风格为主要参考</p><div class="ai-default-perspectives"><label><input type="radio" name="default-perspective" value="self" ${defaultStylePerspective === 'self' ? 'checked' : ''}><span><strong>我的风格</strong><small>学习我在聊天中的表达方式，作为默认风格</small></span></label><label><input type="radio" name="default-perspective" value="other" ${defaultStylePerspective === 'other' ? 'checked' : ''}><span><strong>对方的风格</strong><small>仅学习对方的说话方式和表达习惯</small></span></label></div></section>`;
    const range = `<section class="ai-default-range ai-default-source" data-ai-default-source="contacts" ${defaultStyleMode === 'contacts' ? '' : 'hidden'}><h4>时间范围</h4><p class="ai-help">选择要用于学习的聊天记录时间范围</p><div class="ai-reference-learning-range-pills">${[['all','全部'],['day','近一天'],['week','近一周'],['month','近一月'],['custom','自定义']].map(([key,label])=>`<button type="button" data-ai-default-range="${key}" class="${learnRangeMode === key ? 'active' : ''}">${label}</button>`).join('')}</div>${learnRangeMode === 'custom' ? dateRangeField('learning',learnRange,{compact:true,label:'选择日期'}) : ''}</section>`;
    const contacts = `<section class="ai-default-source" data-ai-default-source="contacts" ${defaultStyleMode === 'contacts' ? '' : 'hidden'}>${contactPicker('', '选择一位或多位联系人；仅读取所选联系人的聊天记录。', ['person'])}</section>`;
    const paste = `<section class="ai-default-source" data-ai-default-source="paste" ${defaultStyleMode === 'paste' ? '' : 'hidden'}>${pasteModule()}</section>`;
    return `<div class="ai-default-style-page"><div class="ai-page-heading ai-learning-page-heading"><div><button type="button" class="quiet ai-learning-back" data-ai-nav="${esc(defaultStyleReturn)}">${icon('arrow-l')}返回${esc(backLabel)}</button><h3>学习默认风格</h3><p>通过你的聊天素材，学习并建立默认的回复风格。</p></div></div><div class="ai-default-style-layout"><aside class="ai-default-result">${current}</aside><section class="ai-card ai-default-material"><h3>重新学习</h3><p class="ai-help">选择聊天素材和学习方向，基于真实聊天内容重新学习并更新默认风格。</p>${sourceTabs}${contacts}${paste}${direction}${range}<button type="button" class="primary ai-default-learn ai-default-source" data-ai-default-source="contacts" data-ai-action="learn-default" ${defaultStyleMode === 'contacts' ? '' : 'hidden'} ${selectedContacts.size ? '' : 'disabled'}>${icon('sparkle')}学习默认风格</button><button type="submit" form="ai-paste-form" class="primary ai-default-learn ai-default-source" data-ai-default-source="paste" ${defaultStyleMode === 'paste' ? '' : 'hidden'}>${icon('sparkle')}学习默认风格</button></section></div></div>`;
  }
  function results() {
    const profiles = selectProfiles().filter(p => (p.learnedAt && p.learnedStyle) || p.pendingStyle).filter(p => !resultProfileIds || resultProfileIds.has(p.id));
    return back('学习结果') + (profiles.length ? profiles.map(p => styleResults([{...p,style:p.pendingStyle || p.style}]) + '<div class="ai-actions ai-result-footer"><button type="button" class="secondary" data-ai-nav="overview">返回</button>' + (p.contact && state.contacts.some(c => c.id === p.contact) ? '<button type="button" class="primary" data-ai-apply-result="' + esc(p.id) + '" aria-label="将学习结果应用到' + esc(profilePlainName(p)) + '">' + (p.pendingMemorySource === 'combined' ? '应用风格和记忆' : '应用到此对象') + '</button>' : '') + '</div>').join('') : '<p class="ai-empty">还没有学习结果</p>');
  }
  function advancedSettings() { return settingsPage(state); }
  function proactive() { return proactiveUI.page(); }
  function profileEditor(profile) {
    if (profile.pendingStyle) profile={...profile,style:profile.pendingStyle};
    const draft = profileDrafts.get(profile.id), v = { ...profile.style, summary: summaryText(profile.style), ...draft }, reply = { ...replyStrategy(), ...profile.replyStrategy, ...draft };
    return `<form id="ai-profile-form" data-id="${profile.id}"><button type="button" class="quiet" data-ai-action="back-learning">${icon('arrow-l')}返回学习结果</button><h3>${profileName(profile)}的聊天风格</h3>${field('summary', '风格总结（可修改）', v.summary, 6000, '例如：表达简洁，语气自然，不添加没有依据的称呼。')}<details class="ai-optional-fields ai-profile-optional" data-ai-optional="profile-notes"><summary><span>注意事项 <small>选填</small></span><span class="ai-optional-status">${v.customAvoid ? '已填写' : '点击展开'}</span></summary>${field('customAvoid', '注意事项', v.customAvoid, 1200)}</details>${memoryFields({ ...profile, capabilities: state.capabilities }, draft?.memorySummary)}<details class="ai-paste"><summary>回复策略（可选）</summary>${field('replyGoal', '回复目的与立场', reply.replyGoal)}${field('boundaries', '注意事项', reply.boundaries)}<label class="ai-field">回复次数上限${replyLimitControl(reply.maxRounds, "ai-profile-round-limit")}</label></details><div class="ai-actions"><button type="submit" class="primary">保存风格</button><button type="button" class="quiet danger-link" data-ai-action="delete-profile">删除风格</button></div></form>`;
  }
  function manualReplyEditor() {
    const contact = state.contacts.find(c => c.id === editingReplyContact && c.kind === 'person');
    if (!contact) return back('回复风格') + '<p class="ai-help">请刷新联系人后重试。</p>';
    const v = manualReplyDrafts.get(contact.id), presets = state.schema.replyPresets || [], profile = selectProfiles().find(p => p.contact === contact.id);
    return `<form id="ai-manual-reply-form" data-contact="${esc(contact.id)}"><div class="ai-page-heading"><button type="button" class="quiet" data-ai-action="back-reply-contacts">${icon('arrow-l')}返回联系人列表</button><h3>${contactName(contact)}的回复风格</h3></div><label class="ai-field">选择风格<select id="ai-reply-preset" name="replyPreset">${presets.map(p => option(p.id, p.label, v.replyPreset === p.id)).join('')}${option('custom', '自定义', v.replyPreset === 'custom')}${learnedProfiles().length ? '<optgroup label="已学习的风格">' + learnedProfiles().map(p => option('learned:' + p.id, p.label, v.replyPreset === 'learned:' + p.id)).join('') + '</optgroup>' : ''}</select></label>${field('summary', '风格说明（可修改）', v.summary || summaryText(v), 6000)}<details class="ai-paste"><summary>注意事项与策略（可选）</summary>${field('customAvoid', '注意事项', v.customAvoid, 1200)}${field('replyGoal', '回复目的与立场', v.replyGoal)}${field('boundaries', '不能擅自决定的事项', v.boundaries)}<label class="ai-field">回复次数上限${replyLimitControl(v.maxRounds, "ai-manual-round-limit")}</label></details><button type="submit" class="primary ai-wide">保存回复风格</button></form>`;
  }
  function rememberDraft() {
    if (!state) return;
    const personal = $('#ai-personal-information-form');
    if (personal && personal.dataset.personalAccount === (state?.account || '')) {
      personalDraft = personalDraftFromForm(personal); personalDraftAccount = state.account;
    }
    const analysis = $('#ai-analysis-form');
    if (analysis) { const data = new FormData(analysis); analysisDraft = { request: data.get('request'), from: data.get('from'), to: data.get('to'), contacts: data.getAll('contacts'), includeVoice: data.has('includeVoice'), includeVisual: data.has('includeVisual') }; }
    const object = $('#ai-object-form');
    if (object) {
      if (object.querySelector('[data-ai-dirty]')?.hidden === false) objectDirtyContacts.add(selectedObject);
      const draft = { ...Object.fromEntries(new FormData(object)) };
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
    if (next !== 'analysis') { analysisHistoryReport = null; analysisHistoryEpoch++; resetAnalysisExport(); }
    tab = next; editingProfile = null; editingReplyContact = null; message(''); render(); $('#ai-content').scrollTop = 0;
    if (next === 'activity') await Promise.all([loadActivity(), loadProactiveRecords(), loadSkipContent(true)]);
    if ((next === 'analysis' || next === 'learning' || next === 'default-style' || next === 'proactive' || next === 'overview' && state.settings.reply) && needsContacts()) await refreshContacts();
  }
  function mobileLayout() {
    if (!window.matchMedia?.('(max-width:860px)').matches) return;
    for (const node of panel.querySelectorAll('textarea')) {
      if (node.id === 'ai-analysis-request-text') continue;
      node.style.height = 'auto';
      node.style.height = Math.min(Math.max(node.scrollHeight, 96), window.innerHeight * .5) + 'px';
      node.style.overflowY = 'auto';
    }
  }
  function resizeAnalysisRequest(textarea = $('#ai-analysis-request-text')) {
    if (!textarea?.closest) return;
    const card = textarea.closest('.ai-analysis-request');
    if (!card?.getBoundingClientRect || !textarea.getBoundingClientRect) return;
    textarea.style.height = 'auto';
    const naturalHeight = textarea.scrollHeight;
    const cardHeightWithoutText = card.getBoundingClientRect().height - textarea.getBoundingClientRect().height;
    const availableHeight = window.innerHeight - card.getBoundingClientRect().top - cardHeightWithoutText - 24;
    const limit = Math.max(76, availableHeight);
    textarea.style.height = `${Math.max(76, Math.min(naturalHeight, limit))}px`;
    textarea.style.overflowY = naturalHeight > limit ? 'auto' : 'hidden';
  }
  function render() {
    if (!state) return;
    revealRevision++;
    const view = `${tab}:${editingProfile || editingReplyContact || (tab === 'overview' ? selectedObject : '')}:${tab === 'proactive' ? !!$('#ai-proactive-form') : ''}`;
    const objectScroll = rememberedObjectScroll();
    const disclosureStates = view === renderedView ? [...panel.querySelectorAll('#ai-content details')].filter(node => !node.hasAttribute('data-ai-record-expand') && !node.hasAttribute('data-ai-skip-messages') && !node.hasAttribute('data-ai-error-detail')).map(node => ({ label: node.dataset.aiOptional || node.querySelector('summary')?.textContent, open: node.open })) : [];
    renderedView = view; panel.dataset.page = tab;
    if (personalDraftAccount !== state.account) { personalDraft = null; personalDraftAccount = state.account; }
    const pageTitle = ({ overview: '自动回复', proactive: '主动聊天', activity: '执行记录', provider: '模型设置', settings: '系统设置', 'personal-info': '我的信息', 'global-reply': '全局回复策略', analysis: '分析报告', learning: '批量学习风格与记忆', 'default-style': '学习默认风格', results: '学习结果', profile: '编辑学习结果', 'manual-reply': '手动回复' })[tab] || 'AI 辅助';
    $('#ai-title').textContent = pageTitle;
    $('#ai-mobile-title').textContent = pageTitle;
    const content = tab === 'profile' && editingProfile ? profileEditor(state.profiles.find(p => p.id === editingProfile)) : ({ overview: objects, analysis: () => analysisPage(state, analysisDraft, analysisResult, analysisSearch, analysisHistoryReport, analysisRangeMode, analysisContactsExpanded, { selecting: analysisExportSelecting, selected: analysisExportSelected, dialog: analysisExportDialog }), activity, provider, settings: advancedSettings, 'personal-info': () => personalInformationPage(state, personalDraft || {}), 'global-reply': () => globalReplyStrategyPage(state), learning, 'default-style': defaultStyleLearning, results, proactive, 'manual-reply': manualReplyEditor }[tab] || objects)();
    const nav = `<nav class="ai-main-tabs qbx-bottom-nav" aria-label="AI 页面"><div class="ai-nav-brand"><span>${logoIcon}</span><div>AI 辅助<small>栖盒 · QIBOX</small></div></div><p class="ai-nav-caption">工作台</p>${[['overview', '自动回复', 'chat'], ['proactive', '主动聊天', 'send'], ['activity','执行记录','clock'],['analysis','分析报告','file'], ['settings', '系统设置', 'sliders']].map(([key, name, symbol]) => `<button type="button" data-ai-nav="${key}" title="${name}" aria-label="${name}" aria-current="${tab === key || key === 'overview' && ['learning','results','profile','manual-reply'].includes(tab) || key === 'settings' && ['default-style','provider','personal-info','global-reply'].includes(tab) ? 'page' : 'false'}">${icon(symbol)}<span>${name}</span></button>`).join('')}</nav>`;
    panel.querySelector(':scope > .ai-main-tabs')?.remove();
    $('#ai-content').innerHTML = iconSprite + nav + (tab === 'overview' ? content : `<div class="ai-page-body">${content}</div>`);
    if (analysisExportDialog) {
      const dialog = $('#ai-report-export-dialog');
      dialog?.addEventListener('cancel', event => { event.preventDefault(); closeAnalysisExport(); });
      dialog?.showModal();
    }
    panel.append($('#ai-content .ai-main-tabs'));
    const activeMemoryCategory = panel.querySelector(`.ai-reference-memory-categories button[data-ai-memory-category="${objectMemoryCategory}"]`)?.dataset.aiMemoryCategory || panel.querySelector('.ai-reference-memory-categories button')?.dataset.aiMemoryCategory;
    for (const node of panel.querySelectorAll('.ai-reference-memory [data-ai-wiki-field]')) node.hidden = node.dataset.aiWikiField !== activeMemoryCategory;
    for (const textarea of $('#ai-content').querySelectorAll('.ai-wiki-bubble textarea[aria-label="信息内容"]')) resizeWikiTextarea(textarea);
    if ($('#ai-object-list')) { $('#ai-object-list').scrollTop = objectScroll; drawObjectList(); }
    panel.classList.toggle('object-selected', !!selectedObject && tab === 'overview');
    for (const node of panel.querySelectorAll('#ai-content details')) {
      if (node.hasAttribute('data-ai-record-expand') || node.hasAttribute('data-ai-skip-messages')) continue;
      const previous = disclosureStates.find(item => item.label === (node.dataset.aiOptional || node.querySelector('summary')?.textContent));
      if (previous) node.open = previous.open;
    }
    const paste = $('#ai-paste-form'); if (paste && learningDraft) for (const [key, value] of Object.entries(learningDraft)) if (paste.elements[key]) paste.elements[key].value = value;
    updatePersonalInformationForm($('#ai-personal-information-form'), state);
    controls();
    resizeStyleSummary();
    mobileLayout();
    resizeAnalysisRequest();
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
      resetContactAvatarFailures();
      if (!contactDialog) for (const key of selectedContacts) if (!state.contacts.some(c => c.id === key && ['person', 'group'].includes(c.kind))) selectedContacts.delete(key);
      contactsLoading = false; render(); message(state.notice || (state.contacts.length ? '联系人已更新' : '暂未获取到联系人，请确认微信已登录后重试'));
    } finally { if (current === generation && target === id) { contactsLoading = false; controls(); } }
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
        if (first) { objectDrafts.delete(first.contact); objectDirtyContacts.delete(first.contact); selectedObject = first.contact; objectKind = first.kind === 'group' ? 'group' : 'person'; tab = 'overview'; }
        return;
      }
      const learned = selectProfiles().filter(p => (p.learnedAt && p.learnedStyle) || p.pendingStyle).filter(p => value.contacts?.includes(p.contact) || (value.contact && p.contact === value.contact) || (!value.contacts && !value.contact && !previous.has(p.id)));
      resultProfileIds = new Set(learned.map(p => p.id));
      rememberDraft();
      learned.forEach(p => { replyProfiles.add(p.id); if (objectDrafts.has(p.contact)) objectDrafts.set(p.contact, learnedObjectDraft(objectDrafts.get(p.contact), beforeDrafts.get(p.contact), beforeProfiles.find(x => x.contact === p.contact), p)); });
      replyDraft = null; tab = 'results';
    });
    if (workToken !== expectedWorkToken) return;
    message(state.notice || (target === 'memory' ? '聊天记忆学习完成，请在下方「聊天记忆」中确认后应用' : target === 'style' ? '聊天风格已更新' : '风格学习完成'), /失败/.test(state.notice || ''));
  }
  function show() {
    setPanelVisible(true); rail.querySelector('#ai-open').setAttribute('aria-expanded', 'true'); if (state) render(); (window.matchMedia?.('(max-width:860px)').matches ? $('#ai-mobile-back') : $('#ai-close')).focus();
    if (!state) {
      if (!$('#ai-content .ai-entry-loading')) $('#ai-content').innerHTML = loadingContent;
      if (id && !attaching) { const current = generation; void call().then(result => { if (result && current === generation && !panel.hidden) render(); }).catch(error => { if (current === generation) message(error.message, true); }); }
      return;
    }
    if (tab === 'overview' && needsContacts() && !busy) {
      const current = generation;
      void refreshContacts().catch(error => { if (current === generation) message(error.message, true); });
    }
  }
  function hide() { rememberDraft(); rememberRecords(); concealKey(true); proactiveUI.closeOverlay(); if (learningDraft) learningDraft.text = ''; setPanelVisible(false); rail.querySelector('#ai-open').setAttribute('aria-expanded', 'false'); panel.querySelectorAll('[name=text], [name=styleText]').forEach(input => { input.value = ''; }); rail.querySelector('#ai-open').focus(); onClose?.(); }
  rail.querySelector('#ai-open').onclick = async () => {
    if (panel.hidden && !pass()) return;
    if (panel.hidden && !id && !(await ensureInstance())) { message('AI 辅助尚未就绪，请重新打开微信后再试', true); return; }
    panel.hidden ? show() : hide();
  };
  $('#ai-close').onclick = hide;
  const goBack = () => {
    const content = $('#ai-content');
    const candidate = ['[data-ai-action="model-cancel"]', '[data-proactive-back]', '[data-ai-object-back]', '[data-ai-action="back-learning"]', '[data-ai-action="back-reply-contacts"]', '.ai-learning-back', '.ai-sticky-back button', '.ai-reference-learning-top [data-ai-nav]'].map(selector => content.querySelector(selector)).find(Boolean);
    if (candidate && (!candidate.hasAttribute('data-ai-object-back') || selectedObject)) candidate.click();
    else if (tab !== 'overview') void navigate('overview');
    else hide();
  };
  $('#ai-mobile-back').onclick = goBack;
  panel.addEventListener('input', event => { if (event.target.tagName === 'TEXTAREA') mobileLayout(); });
  window.addEventListener('resize', mobileLayout);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); if (!proactiveUI.closeOverlay()) hide(); } });
  const changeMaster = async event => {
    if (!pass()) { event.target.checked = !event.target.checked; return; }
    if (!id && !(await ensureInstance())) { event.target.checked = !event.target.checked; message('AI 辅助尚未就绪，请重新打开微信后再试', true); return; }
    try { await execute('settings', { value: { enabled: event.target.checked } }); }
    catch (e) { show(); controls(); message(e.message, true); }
  };
  rail.addEventListener('change', changeMaster);
  panel.addEventListener('change', async event => {
    if (!state) return;
    try {
      const input = event.target;
      if (input.closest('#ai-object-form')) objectDirtyContacts.add(selectedObject);
      if (input.closest('#ai-personal-information-form')) {
        if (input.matches('[data-personal-share]')) input.closest('[data-personal-field]').dataset.personalShareChanged = 'true';
        updatePersonalInformationForm($('#ai-personal-information-form'), state); rememberDraft(); return;
      }
      if (input.name === 'report-export-format') { if (analysisExportDialog) analysisExportDialog.format = input.value; return; }
      if ('aiHistoryExportCheck' in input.dataset) {
        if (input.checked) analysisExportSelected.add(input.dataset.aiHistoryExportCheck);
        else analysisExportSelected.delete(input.dataset.aiHistoryExportCheck);
        const bar = $('.ai-history-export-bar');
        if (bar) { bar.querySelector('strong').textContent = `已选 ${analysisExportSelected.size} 份`; bar.querySelector('[data-ai-history-export-next]').disabled = !analysisExportSelected.size; }
        const all = $('[data-ai-history-export-all]');
        if (all) all.textContent = analysisExportSelected.size === (state.analysis?.history || []).length ? '取消全选' : '全选当前列表';
        return;
      }
      const wikiRow = input.closest('.ai-wiki-bubble');
      if (wikiRow && input.matches('select[aria-label="信息类型"]')) {
        const calendar = ['birthday', 'date'].includes(input.value);
        const school = input.value === 'school';
        const temporal = ['residence', 'workplace', 'employer', 'shipping'].includes(input.value);
        let dateType = wikiRow.querySelector('.ai-wiki-date-type');
        if (calendar && !dateType) { dateType = document.createElement('label'); dateType.className = 'ai-wiki-date-type'; dateType.innerHTML = '历法<select aria-label="生日历法"><option value="">未确定</option><option value="solar">公历</option><option value="lunar">农历</option></select>'; wikiRow.insertBefore(dateType, wikiRow.querySelector('[data-ai-wiki-remove]')); }
        if (dateType) dateType.hidden = !calendar;
        let degree = wikiRow.querySelector('[aria-label="学历"]');
        if (school && !degree) { degree = document.createElement('select'); degree.className = 'ai-wiki-degree'; degree.setAttribute('aria-label', '学历'); degree.innerHTML = degreeOptions(); wikiRow.insertBefore(degree, wikiRow.querySelector('[data-ai-wiki-remove]')); }
        if (degree) degree.hidden = !school;
        wikiRow.classList.toggle('ai-wiki-school', school);
        if (school && !wikiRow.querySelector('[aria-label="信息内容"]').value) wikiRow.querySelector('[aria-label="信息内容"]').placeholder = '具体学校';
        let recorded = wikiRow.querySelector('.ai-wiki-recorded');
        if (temporal && !recorded) { recorded = document.createElement('small'); recorded.className = 'ai-wiki-recorded'; wikiRow.insertBefore(recorded, wikiRow.querySelector('[data-ai-wiki-remove]')); }
        if (recorded) { const rawTime = wikiRow.querySelector('[data-ai-wiki-recorded]')?.value, stamp = Number(rawTime); recorded.hidden = !temporal; if (temporal) recorded.textContent = `时间：${Number.isSafeInteger(stamp) && stamp ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(stamp) : '未知'}`; }
        const remarkAction = wikiRow.querySelector('[data-ai-wiki-remark]');
        if (remarkAction) remarkAction.hidden = !state.capabilities?.writeContactRemark || !['name'].includes(input.value);
        const content = wikiRow.querySelector('[aria-label="信息内容"]'), isOther = input.value === 'other' || input.value.startsWith('group_');
        if (content && (content.tagName === 'TEXTAREA') !== isOther) {
          const replacement = document.createElement(isOther ? 'textarea' : 'input');
          replacement.setAttribute('aria-label', '信息内容'); replacement.maxLength = 2000; replacement.value = content.value;
          replacement.placeholder = input.value.startsWith('group_') ? '记录有依据的群聊事实' : isOther ? '兴趣爱好、偏好或其他记忆' : '填写已确认的信息';
          if (isOther) { replacement.rows = 1; resizeWikiTextarea(replacement); }
          content.replaceWith(replacement);
        }
        const targetField = ['workplace', 'employer'].includes(input.value) ? 'work' : ['birthday', 'date'].includes(input.value) ? 'date_info' : ['household', 'residence', 'shipping'].includes(input.value) ? 'address' : input.value === 'addressing' ? 'name' : input.value;
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
      if (input.name === 'default-perspective') { defaultStylePerspective = input.value; return; }
      if (input.id === 'ai-learning-scope') { rememberDraft(); learnScope = input.value; render(); return; }
      if (input.dataset.aiLearnDate) { learnRange = { ...learnRange, [input.dataset.aiLearnDate]: input.value }; return; }
      if (input.name === 'learnTarget') { rememberDraft(); learnTarget = LEARN_TARGETS.some(t => t.id === input.value) ? input.value : 'both'; render(); return; }
      if ('aiPanelMaster' in input.dataset) { await changeMaster(event); return; }
      if (input.closest('#ai-analysis-form') && ['includeVoice', 'includeVisual'].includes(input.name)) {
        rememberDraft();
        const status = $('[data-ai-optional="analysis-media"] .ai-optional-status');
        if (status) {
          const count = Number(analysisDraft.includeVoice) + Number(analysisDraft.includeVisual);
          status.textContent = count ? `已启用 ${count} 项` : '文字聊天';
        }
        return;
      }
      if (input.closest('#ai-analysis-form') && input.name === 'contacts') {
        const checked = [...panel.querySelectorAll('#ai-analysis-form [name=contacts]:checked')];
        $('#ai-analysis-count').textContent = String(checked.length);
        $('#ai-analysis-mobile-count').textContent = checked.length ? `已选择 ${checked.length} 位联系人` : '选择要分析的联系人';
        $('#ai-analysis-form button[type=submit] span').textContent = `开始分析 · ${checked.length} 位`;
        rememberDraft();
      }
      if (input.dataset.objectOption) {
        // 开关修改只作为草稿，点击【保存设置】后统一生效。
        rememberDraft(); render(); if ($('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false; return;
      }
      if (syncReplyLimitControl(input)) {
        handleReplyLimitOverflow(input);
        rememberDraft(); if (input.closest('#ai-object-form') && $('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false; return;
      }
      if (input.name === 'realtimeMode' && input.closest('#ai-object-form')) {
        rememberDraft(); if ($('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false; return;
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
    if (!state) return;
    if (event.target.closest('#ai-object-form')) objectDirtyContacts.add(selectedObject);
    if (event.target.closest('#ai-personal-information-form')) { updatePersonalInformationForm($('#ai-personal-information-form'), state); rememberDraft(); return; }
    if (event.target.name === 'facts' && event.target.closest('#ai-global-reply-form')) {
      const status = $('[data-ai-optional="global-facts"] .ai-optional-status');
      if (status) status.textContent = event.target.value.trim() ? '已填写' : '按需补充';
    }
    if (syncReplyLimitControl(event.target)) {
      handleReplyLimitOverflow(event.target);
      rememberDraft(); if (event.target.closest('#ai-object-form') && $('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false; return;
    }
    if (event.target?.matches?.('.ai-wiki-bubble textarea[aria-label="信息内容"]')) resizeWikiTextarea(event.target);
    const wikiRow = event.target?.closest?.('.ai-wiki-bubble');
    if (event.target.closest('#ai-object-form') && event.target.name === 'summary') {
      const form = event.target.form;
      // Keep the selected tab; the server creates a separate custom style
      // when a built-in/default/learned style is edited.
      const dirty = form.querySelector('[data-ai-dirty]'); if (dirty) dirty.hidden = false;
      resizeStyleSummary(event.target);
      rememberDraft();
      const list = $('#ai-object-list'); if (list) list.innerHTML = objectList(state, objectView());
      return;
    }
    if (event.target.name === 'request' && event.target.closest('#ai-analysis-form')) {
      $('.ai-analysis-presets').innerHTML = presetChips(event.target.value);
      $('#ai-analysis-request-count').textContent = `${event.target.value.length}/1000`;
      const status = $('[data-ai-optional="analysis"] .ai-optional-status');
      if (status) status.textContent = event.target.value.trim() ? '已填写' : '点击展开';
      resizeAnalysisRequest(event.target);
    }
    if (event.target.id === 'ai-object-search') { objectSearch = event.target.value; $('#ai-object-list').scrollTop = 0; drawObjectList(); return; }
    if (event.target.id === 'ai-log-search') {
      logFilters.query = event.target.value; logFilters.page = 0; rememberRecords();
      drawRecords();
      drawProactiveRecords();
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
      if (list) list.innerHTML = contactPickerRows((state.contacts || []).filter(c => tab === 'learning' ? c.kind === learnContactKind : pickerKinds().includes(c.kind)), contactSearch);
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
    if (event.target.closest('#ai-personal-information-form') && event.target.isConnected) { updatePersonalInformationForm($('#ai-personal-information-form'), state); rememberDraft(); return; }
    const skipId = event.target.dataset?.aiSkipMessages;
    if (skipId && event.target.isConnected) {
      const expanded = new Set(logFilters.skipMessageExpanded || []);
      if (event.target.open) expanded.add(skipId);
      else expanded.delete(skipId);
      logFilters.skipMessageExpanded = [...expanded];
      rememberRecords();
      return;
    }
    const key = event.target.dataset?.aiRecordExpand;
    if (!key || !event.target.isConnected) return;
    const expanded = new Set(logFilters.expanded || []);
    const collapsed = new Set(logFilters.collapsed || []);
    if (event.target.open) { expanded.add(key); collapsed.delete(key); }
    else { expanded.delete(key); collapsed.add(key); }
    logFilters.expanded = [...expanded];
    logFilters.collapsed = [...collapsed];
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
            if (form.id === 'ai-takeover-form') { await execute('settings', {value:{enabled:data.has('master'),acknowledgeAI:data.has('acknowledgeAI'),takeover:{enabled:data.get('enabled')==='on',minutes:Number(data.get('minutes') ?? form.elements.minutes.value ?? 5)}}}, '设置已保存'); return; }
      if (form.id === 'ai-analysis-form') {
        rememberDraft();
        if (!analysisDraft.contacts.length) throw new Error('请至少选择一位联系人');
        if (analysisDraft.from > analysisDraft.to) throw new Error('开始日期不能晚于结束日期');
        const current = generation, target = id, account = state?.account; analysisHistoryEpoch++;
        let generatedReports = false;
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
              if (!valid()) return;
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
          generatedReports = analysisResult.reports.some(report => report.status === 'complete');
          if (generatedReports && valid()) {
            analysisDraft.contacts = [];
            analysisSearch = '';
            analysisContactsExpanded = false;
          }
          if (queueToken === analysisQueueToken) analysisQueueAccount = null;
        });
        if (generatedReports && window.matchMedia?.('(max-width:860px)').matches) $('.ai-analysis-reports')?.scrollIntoView({ block: 'start' });
        return;
      }
      if (form.id === 'ai-object-form') {
        const contact = form.dataset.contact, profile = state.profiles.find(p => p.contact === contact);
        const rawSummary = String(data.get('summary') || '');
        const summary = rawSummary.trim();
        if (!summary) throw new Error('请填写风格说明，或选择默认风格后保存');
        if (rawSummary.length > 6000) throw new Error('风格说明最多6000字，请缩短后保存');
        const styleId = data.get('styleId') || '';
        const strategy = { ...profile?.replyStrategy, replyGoal: data.get('replyGoal') || '', facts: profile?.replyStrategy?.facts || '', boundaries: data.get('boundaries') || '', maxRounds: parseReplyLimit(data.get('maxRounds') ?? 50) };
        // 以页面当前 styleId 对应的完整风格为基础，仅覆盖页面编辑的说明，避免丢失预设/学习风格的其余字段。
        const base = styleId === '' ? (state.learnedDefaultStyle?.style || state.schema?.defaultStyle) : styleId === 'learned' ? (profile?.learnedStyle || profile?.style || state.schema?.defaultStyle)
          : (objectStyleTabs(state, profile).find(row => row.id === styleId)?.style || profile?.style || state.schema?.defaultStyle);
        const style = summary ? { ...base, summary } : { ...state.schema?.defaultStyle };
        // 群聊开启实时回复需要先确认 Token 消耗与账号风险；取消则回滚草稿，不视为已保存。
        let realtimeConfirmed = true;
        if ((profile?.kind || state.contacts.find(item => item.id === contact)?.kind) === 'group' && data.has('realtime') && !profile?.groupOptions?.realtime) {
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
        const changedRealtimeMode = kind === 'group' && String(data.get('realtimeMode') || 'normal') !== (profile?.groupOptions?.realtimeMode || 'normal');
        const currentStyle = styleChoice(profile);
        const baselineStyleId = currentStyle.styleId || '';
        const baselineSummary = currentStyle.styleId ? (currentStyle.summary || '') : styleSummaryText(state.learnedDefaultStyle?.style || state.schema?.defaultStyle);
        const changedStyle = String(data.get('styleId') || '') !== baselineStyleId || String(data.get('summary') || '') !== baselineSummary;
        const hasReplySettings = !!profile?.replyStrategy || ['replyGoal','boundaries'].some(key => String(data.get(key) || '').trim()) || changedSwitch || changedRealtimeMode || changedStyle || String(strategy.maxRounds) !== String(profile?.replyStrategy?.maxRounds ?? state.replyRoundLimits?.[kind] ?? state.replyStrategy?.maxRounds ?? 50);
        const memoryEntries = JSON.parse(String(data.get('memorySummary') || '[]'));
        await execute('reply-profile', { value: { contact, preserveSwitches: true, styleSet: !!summary, styleId, style, strategy,
          inheritStrategy: data.has('inheritStrategy'), options: { multiTurn: optionChecked('multiTurn'), judgeReply: optionChecked('judgeReply'), sendImages: optionChecked('sendImages'), sendAudio: optionChecked('sendAudio') },
          ...(kind === 'group' ? { group: { atMe: data.has('atMe'), atAll: data.has('atAll'), realtime: data.has('realtime'), realtimeMode: data.get('realtimeMode') || 'normal', ...(realtimeConfirmed ? { confirmRealtime: true } : {}) } }
            : { replyEnabled: data.has('enabled'), options: { multiTurn: optionChecked('multiTurn'), judgeReply: optionChecked('judgeReply'), sendImages: optionChecked('sendImages'), sendAudio: optionChecked('sendAudio') } }),
          ...(!sameWikiEntries(memoryEntries, profile?.memory?.entries || []) && !profile?.memory?.unavailable ? { memory: { entries: memoryEntries } } : {})
        } }, '设置已保存');
        objectDrafts.delete(contact); objectDirtyContacts.delete(contact); render(); return;
      }
      if (form.id === 'ai-personal-information-form') {
        if (form.dataset.personalAccount !== state.account) throw new Error('微信账号已变化，请重新打开我的信息');
        const entries = personalEntriesFromForm(form, state);
        await workflow(async step => {
          await step('configuration', { value: { type: 'personal-information', account: form.dataset.personalAccount, entries } });
          if (form.dataset.personalAccount !== state.account) return;
          updatePersonalInformationForm(form, state);
          for (const section of form.querySelectorAll('[data-personal-field]')) if (section.dataset.dirty !== 'true') section.open = false;
          personalDraft = personalDraftFromForm(form); personalDraftAccount = state.account;
        }, '我的信息已保存'); return;
      }
      if (form.id === 'ai-global-reply-form') {
        await execute('configuration', { value: { type: 'global-reply-strategy', strategy: { ...state.replyStrategy, replyGoal: data.get('replyGoal') || '', facts: data.get('facts') || '', boundaries: data.get('boundaries') || '' } } }, '全局回复策略已保存'); return;
      }
      if (form.id === 'ai-model-form') await stageModel();
      if (form.id === 'ai-manual-reply-form') {
        const contact = form.dataset.contact;
        if (!state.contacts.some(c => c.id === contact && ['person', 'group'].includes(c.kind))) throw new Error('联系人已变化，请刷新后重新选择');
        const strategy = { replyGoal: data.get('replyGoal') || '', facts: state.profiles.find(p => p.contact === contact)?.replyStrategy?.facts || '', boundaries: data.get('boundaries') || '', maxRounds: parseReplyLimit(data.get('maxRounds')) };
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
        const reply = { replyGoal: data.get('replyGoal') || '', facts: base.facts || '', boundaries: data.get('boundaries') || '', maxRounds: parseReplyLimit(data.get('maxRounds') ?? 50) };
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
  panel.addEventListener('toggle', event => {
    if (!event.target.isConnected) return;
    if (event.target?.classList?.contains('ap-record-errors')) { logFilters.errorsOpen = event.target.open; rememberRecords(); }
    if (event.target.dataset?.aiErrorDetail) {
      const expanded = new Set(logFilters.errorExpanded || []);
      if (event.target.open) expanded.add(event.target.dataset.aiErrorDetail); else expanded.delete(event.target.dataset.aiErrorDetail);
      logFilters.errorExpanded = [...expanded]; rememberRecords();
    }
  }, true);
  window.addEventListener('scroll', () => hideRecordMenu(), true);
  window.addEventListener('resize', () => { resizeStyleSummary(); resizeAnalysisRequest(); });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') hideRecordMenu(); });
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.hasAttribute('data-ai-collapse-record')) {
        const details = button.closest('details[data-ai-record-expand]');
        if (details) { details.open = false; details.querySelector('summary')?.focus(); }
        return;
      }
      if (button.dataset.aiRemoveContact) { selectedContacts.delete(button.dataset.aiRemoveContact); render(); return; }
      if ('aiAnalysisContactsToggle' in button.dataset || 'aiAnalysisPick' in button.dataset) {
        rememberDraft();
        const account = state.account, current = generation;
        const selected = analysisDraft.contacts.map(key => state.contacts.find(c => c.id === key && c.kind === 'person') || { id: key, label: key, kind: 'person' });
        contactDialog?.close();
        contactDialog = openContactPickerDialog({ parent: panel, title: '选择分析对象', description: '可多选，逐位独立生成报告', kinds: ['person'], selected,
          getContacts: retained => {
            const contacts = new Map((state?.contacts || []).filter(c => c.kind === 'person').map(c => [c.id, c]));
            for (const c of retained) if (!contacts.has(c.id)) contacts.set(c.id, { ...c, missing: true });
            return [...contacts.values()];
          },
          onRefresh: refreshContacts, onClose: () => { contactDialog = null; },
          onConfirm: contacts => { if (current !== generation || account !== state?.account) return; analysisDraft.contacts = contacts.map(c => c.id); render(); $('#ai-analysis-form [data-ai-analysis-pick]')?.focus(); } });
        return;
      }
      if (button.dataset.aiDefaultMode) {
        defaultStyleMode = button.dataset.aiDefaultMode;
        panel.querySelectorAll('[data-ai-default-mode]').forEach(tabButton => { const selected = tabButton.dataset.aiDefaultMode === defaultStyleMode; tabButton.classList.toggle('selected', selected); tabButton.setAttribute('aria-selected', String(selected)); });
        panel.querySelectorAll('[data-ai-default-source]').forEach(source => { source.hidden = source.dataset.aiDefaultSource !== defaultStyleMode; });
        return;
      }
      if (button.hasAttribute('data-ai-apply-limit-kind')) {
        const form = button.closest('form'), value = parseReplyLimit(form.elements.maxRounds.value), kind = button.dataset.aiApplyLimitKind;
        const current = generation, target = id, account = state.account, contacts = state.contacts.filter(contact => contact.kind === kind).map(contact => contact.id).sort();
        const controller = new AbortController(); replyLimitConfirmController?.abort(); replyLimitConfirmController = controller;
        let accepted;
        try { accepted = await productDialog({ title: `应用到全部${kind === 'group' ? '群聊' : '联系人'}？`, message: `将把当前账号全部${contacts.length}个${kind === 'group' ? '群聊' : '联系人'}的回复次数上限设为${value === 'unlimited' ? '不限' : value + '次'}，之后新增的同类对象也默认使用此上限。`, confirm: '应用到全部', signal: controller.signal }); }
        finally { if (replyLimitConfirmController === controller) replyLimitConfirmController = null; }
        if (!accepted || controller.signal.aborted || current !== generation || target !== id || account !== state?.account) return;
        const result = await execute('apply-reply-limit', { value: { kind, maxRounds: value, account, contacts } }, `已应用到全部${kind === 'group' ? '群聊' : '联系人'}`);
        if (result?.appliedReplyLimit) message(`已更新 ${result.appliedReplyLimit.count} 个${kind === 'group' ? '群聊' : '联系人'}的回复次数上限`);
        return;
      }
      if (button.hasAttribute('data-ai-wiki-remark')) {
        const form = button.closest('form'), row = button.closest('.ai-wiki-bubble');
        const field = row?.querySelector('select[aria-label="信息类型"]')?.value;
        const remark = row?.querySelector('input[aria-label="信息内容"]')?.value?.trim();
        if (!state.capabilities?.writeContactRemark || !form?.dataset.id || field !== 'name' || !remark) throw new Error('当前微信连接没有可用的备注写入能力或姓名信息');
        if (!await confirmDialog(`将“${remark}”写入当前联系人微信备注？`)) return;
        await execute('contact-remark', { id: form.dataset.id, value: { remark } }, '已写入并核验微信备注');
        return;
      }
      if (button.hasAttribute('data-ai-wiki-remove')) { if (!await confirmDialog('确认删除这条记忆？保存设置后生效。')) return; button.closest('.ai-wiki-bubble')?.remove(); return; }
      if (button.hasAttribute('data-ai-wiki-add')) {
        const field = button.dataset.aiWikiAddField || 'other';
        const entities=button.closest('form')?.querySelector('[data-ai-wiki-entities]');
        const section=button.closest('[data-ai-wiki-field]') || entities?.querySelector(`[data-ai-wiki-field="${field}"]`);
        const list = section?.querySelector('.ai-wiki-field-values');
        if (!list) return;
        list.insertAdjacentHTML('beforeend', wikiEntryMarkup({ field, text: '', ...(field === 'school' ? { degree: '' } : {}) }, state.capabilities?.writeContactRemark === true, button.closest('#ai-object-form') ? objectKind : 'person'));
        const added = list.lastElementChild; const content = added.querySelector('[aria-label="信息内容"]');
        if (content?.tagName === 'TEXTAREA') resizeWikiTextarea(content);
        content?.focus(); return;
      }
      const action = button.dataset.aiAction;
      if ('aiRetryRecords' in button.dataset) { await loadActivity(); return; }
      if ('aiRetrySkips' in button.dataset) { await loadSkipContent(true); return; }
      if ('aiMarkReply' in button.dataset) {
        const current = generation, target = id, account = state?.account;
        const eventId = button.dataset.eventId, profileId = button.dataset.aiMarkReply, messageId = button.dataset.messageId;
        if (!target || !account || !eventId || !profileId || !messageId) throw new Error('未回复记录已变化，请刷新后重试');
        const valid = () => current === generation && target === id && account === state?.account;
        markReplyStatus.set(eventId, { markingForReply: true }); drawSkips();
        try {
          const result = await api(`/instances/${target}/ai`, { action: 'mark-reply-needed', value: { profileId, eventId, messageId } }, 130000);
          if (!valid()) return;
          if (result?.account !== account) throw new Error('微信账号已变化，请刷新后重试');
          state = { ...state, skipRecords: result.skipRecords, events: result.events };
          markReplyStatus.delete(eventId);
          drawSkips(); message('已标记；下一次自动回复前会先总结这条消息');
        } catch (error) {
          if (!valid()) return;
          markReplyStatus.set(eventId, { markReplyError: error.message || '标记失败，请重试' });
          drawSkips(); message(error.message || '标记失败，请重试', true);
        }
        return;
      }
      if ('aiSummaryProfile' in button.dataset) {
        const profileId = button.dataset.aiSummaryProfile, row = button.closest('[data-ai-reply-card]'), output = row?.querySelector(`[data-ai-summary-result="${CSS.escape(profileId)}"]`);
        const range = row?.querySelector(`[data-ai-summary-range="${CSS.escape(profileId)}"]`)?.value || 'takeover';
        if (!output) return;
        const current = generation, target = id;
        showSummary(profileId, { range, text: '正在整理聊天…', pending: true });
        try {
          const result = await api(`/instances/${id}/ai`, { action: 'activity-summary', id: profileId, value: { range } }, 130000);
          if (current !== generation || target !== id) return;
          const start = beijingTime(result.from), end = beijingTime(result.to);
          showSummary(profileId, { range, text: `${result.summary}\n\n证据范围：${start} 至 ${end}；共读取 ${result.count}/${result.total} 条双方消息，其中 AI 代回复 ${result.aiReplyCount} 条${result.truncated ? '（内容较多，使用最近部分）' : ''}。` });
        } catch (error) { if (current === generation && target === id) showSummary(profileId, { range, text: `总结失败：${error.message || '请重试'}` }); }
        return;
      }
      if ('aiDeleteRecord' in button.dataset) {
        const current = generation, target = id;
        if (!await confirmRecordDelete() || current !== generation || target !== id) return;
        const recordId = button.dataset.aiDeleteRecord, source = button.dataset.aiDeleteSource;
        await call('delete-activity-record', { value: { source, id: recordId } });
        proactiveHistory = proactiveHistory.filter(record => !(source === 'proactive' && record.id === recordId));
        logRecords = logRecords.map(record => ({ ...record, messages: (record.messages || []).filter(message => !(message.id === recordId && (source === 'reply' || source === 'unknown'))) }));
        rememberRecords(); render(); return;
      }
      if ('aiClearErrors' in button.dataset) {
        // 折叠区标题里也放了「清空」，点按钮时不要连带展开 / 收起。
        event.preventDefault();
        if (!await confirmDialog('确认删除「最近异常」的全部记录？删除后无法恢复，不影响聊天内容和运行记录。')) return;
        logFilters.errorsOpen = false;
        logFilters.errorExpanded = [];
        const errorsHost = $('#ai-recent-errors');
        for (const details of errorsHost?.querySelectorAll('details') || []) details.open = false;
        errorHistory = []; errorPage = null; errorEpoch++;
        await call('clear-activity-errors');
        rememberRecords(); render(); return;
      }
      if (await proactiveUI.click(button)) return;
      if ('proactiveRecordMore' in button.dataset) { await loadProactiveRecords(true); return; }
      if ('aiErrorMore' in button.dataset) { await loadErrorRecords(true); return; }
      if ('aiErrorObject' in button.dataset) {
        const error = activityState().recentErrors.find(row => row.id === button.dataset.aiErrorObject);
        const contact = state.contacts.find(row => row.id === error?.objectTarget);
        if (!contact) throw new Error('异常关联对象已不可用，请查看已保存的当时证据');
        rememberDraft(); selectedObject = contact.id; objectKind = contact.kind; objectSection = 'reply';
        await navigate('overview'); return;
      }
      if ('aiErrorRecordTarget' in button.dataset) {
        const current = generation, target = id, account = state.account, epoch = ++errorLocatorEpoch;
        const errorHost = $('#ai-recent-errors');
        const unchanged = () => current === generation && target === id && account === state?.account && epoch === errorLocatorEpoch &&
          tab === 'activity' && !panel.hidden && errorHost?.isConnected && errorHost === $('#ai-recent-errors');
        button.disabled = true;
        let result;
        try { result = await api(`/instances/${target}/ai`, { action: 'error-related-record', id: button.dataset.aiErrorRecordTarget }, 30000); }
        catch (error) { if (!unchanged()) return; throw error; }
        finally { if (button.isConnected) button.disabled = false; }
        if (!unchanged()) return;
        const record = result.record;
        if (!record?.id || record.account !== account || !['proactive', 'skip'].includes(result.source)) throw new Error('关联记录已变化，请重新查看异常');
        logFilters = { ...logFilters, source: result.source === 'proactive' ? 'proactive' : 'reply', query: '', from: '', to: '', kind: '', code: '', page: 0, taskId: result.source === 'proactive' ? record.taskId : '' };
        logEpoch++; proactiveRecordEpoch++; proactiveRecordLoading = false; logLoading = false;
        if (result.source === 'proactive') {
          proactiveHistory = [record, ...proactiveHistory.filter(row => row.id !== record.id && row.taskId === record.taskId)]; proactiveHistoryPage = null;
        } else {
          skipHistory = [record, ...skipHistory.filter(row => row.id !== record.id)]; skipContent.set(record.id, record);
        }
        rememberRecords(); render();
        const attribute = result.source === 'proactive' ? 'data-proactive-record' : 'data-ai-skip-record';
        const row = [...panel.querySelectorAll(`[${attribute}]`)].find(node => node.getAttribute(attribute) === record.id);
        if (!revealErrorRecord(row, panel)) throw new Error('关联记录已读取，但暂时无法定位，请刷新记录后查看');
        message('已定位与这条异常关联的记录'); return;
      }
      if ('aiToggleFilters' in button.dataset) {
        logFilters.open = !logFilters.open;
        const form = $('#ai-log-filter'); form.hidden = !logFilters.open;
        button.setAttribute('aria-expanded', String(logFilters.open)); return;
      }
      if ('aiRecordSource' in button.dataset) {
        logFilters.source = button.dataset.aiRecordSource;
        if (logFilters.source !== 'proactive' && logFilters.taskId) { logFilters.taskId = ''; proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordEpoch++; proactiveRecordLoading = false; }
        logEpoch++; logLoading = logFilters.source === 'reply'; logRequestScope = ''; logSignature = ''; render();
        await Promise.all([loadActivity(), loadSkipContent()]); return;
      }
      if ('aiShowAllProactiveRecords' in button.dataset) {
        logFilters = { ...logFilters, taskId: '', page: 0 };
        proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordLoading = false; proactiveRecordEpoch++;
        rememberRecords(); render();
        panel.querySelector('[data-ai-record-source="proactive"]')?.focus({ preventScroll: true });
        await loadProactiveRecords(); return;
      }
      if ('aiCopyReport' in button.dataset) {
        const report = analysisResult?.reports[Number(button.dataset.aiCopyReport)];
        if (!report || !['complete', 'empty'].includes(report.status)) throw new Error('报告已变化，请重新打开');
        await copyReport(report.report); message('已复制这份报告的全文'); return;
      }
      if ('aiExportClose' in button.dataset) { closeAnalysisExport(); return; }
      if ('aiExportDownload' in button.dataset) { await startAnalysisExport(); return; }
      if ('aiExportReport' in button.dataset) {
        const report = analysisResult?.reports[Number(button.dataset.aiExportReport)];
        if (!report?.historyId || report.status !== 'complete') throw new Error('报告尚未成功保存，请重新打开');
        openAnalysisExport([report.historyId], report); return;
      }
      if ('aiExportCurrent' in button.dataset) {
        const ids = (analysisResult?.reports || []).filter(report => report.status === 'complete' && report.historyId).map(report => report.historyId);
        openAnalysisExport(ids); return;
      }
      if ('aiExportDetail' in button.dataset) {
        if (!analysisHistoryReport) throw new Error('报告已变化，请重新打开');
        openAnalysisExport([analysisHistoryReport.id], analysisHistoryReport); return;
      }
      if ('aiHistoryExport' in button.dataset) {
        const report = state.analysis?.history?.find(item => item.id === button.dataset.aiHistoryExport);
        if (!report) throw new Error('报告已变化，请重新打开');
        openAnalysisExport([report.id], report); return;
      }
      if ('aiHistoryExportMode' in button.dataset) { analysisExportSelecting = true; analysisExportSelected.clear(); render(); return; }
      if ('aiHistoryExportCancel' in button.dataset) { analysisExportSelecting = false; analysisExportSelected.clear(); render(); return; }
      if ('aiHistoryExportAll' in button.dataset) {
        const ids = (state.analysis?.history || []).map(item => item.id);
        if (analysisExportSelected.size === ids.length) analysisExportSelected.clear(); else analysisExportSelected = new Set(ids);
        render(); return;
      }
      if ('aiHistoryExportNext' in button.dataset) {
        const ids = (state.analysis?.history || []).map(item => item.id).filter(reportId => analysisExportSelected.has(reportId));
        openAnalysisExport(ids); return;
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
      if ('aiAnalysisOther' in button.dataset) {
        const field = $('#ai-analysis-form [name=request]'); if (!field) return;
        if (analysisRequestState(field.value) !== 'custom') field.value = '';
        rememberDraft(); render(); $('#ai-analysis-form [name=request]')?.focus(); return;
      }
      if (busy && !['cancel'].includes(action)) throw new Error('请等待当前操作完成，或先取消');
      if (action === 'analysis-use-chat') { await execute('analysis-use-chat', {}, '分析报告已改用聊天模型'); return; }
      if (action === 'analysis-settings') { await navigate('provider'); return; }
      if (button.dataset.aiAnalysisRange) {
        rememberDraft();
        analysisRangeBeforeCustom = button.dataset.aiAnalysisRange === 'custom' && analysisRangeMode !== 'custom' ? analysisRangeMode : null;
        analysisRangeMode = button.dataset.aiAnalysisRange;
        if (analysisRangeMode === 'all') { analysisDraft.from = ''; analysisDraft.to = ''; }
        else if (analysisRangeMode !== 'custom') {
          const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          const start = new Date(`${today}T00:00:00Z`);
          start.setUTCDate(start.getUTCDate() - ({ day: 0, week: 6, month: 29 })[analysisRangeMode]);
          analysisDraft.from = start.toISOString().slice(0, 10); analysisDraft.to = today;
        }
        render();
        if (analysisRangeMode === 'custom') $('#ai-analysis-form [data-ai-date-range="analysis"]')?.click();
        return;
      }
      if (button.dataset.aiLearnRange) { learnRangeMode = button.dataset.aiLearnRange; if (learnRangeMode === 'all') learnRange = { from: '', to: '' }; render(); return; }
      if (button.dataset.aiDefaultRange) {
        learnRangeMode = button.dataset.aiDefaultRange;
        if (learnRangeMode === 'all') learnRange = { from: '', to: '' };
        else if (learnRangeMode !== 'custom') {
          const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          const start = new Date(`${today}T00:00:00Z`);
          start.setUTCDate(start.getUTCDate() - ({ day: 0, week: 6, month: 29 })[learnRangeMode]);
          learnRange = { from: start.toISOString().slice(0, 10), to: today };
        }
        render();
        if (learnRangeMode === 'custom') $('[data-ai-date-range="learning"]')?.click();
        return;
      }
      if ('aiStyleCommand' in button.dataset) {
        const form = $('#ai-object-form'), profile = state.profiles.find(p => p.contact === selectedObject), styleId = form.elements.styleId.value, command = button.dataset.aiStyleCommand;
        if (!profile && command !== 'add') { message('请先保存当前对象的设置', true); return; }
        rememberDraft();
        let name;
        if (command === 'rename') { name = await productDialog({ title: '重命名风格', input: objectStyleTabs(state, profile).find(row => row.id === styleId)?.label || '', confirm: '保存名称' }); if (!name) return; }
        if (command === 'delete' && !await productDialog({ title: '删除这个风格？', message: '只删除当前风格，聊天记忆与回复设置保留。', confirm: '删除风格', danger: true })) return;
        const result = await execute('configuration', { value: { type: 'style', id: profile?.id, contact: selectedObject, styleId, command, name } }, command === 'delete' ? '风格已删除' : command === 'rename' ? '风格已重命名' : '已添加自定义风格');
        const updated = result?.profiles?.find(p => p.contact === selectedObject);
        if (updated) { const selectedStyle = command === 'rename' ? styleId : updated.styleId, selected = objectStyleTabs(state, updated).find(row => row.id === selectedStyle); objectDrafts.set(selectedObject, { ...objectDrafts.get(selectedObject), styleId: selectedStyle, summary: styleSummaryText(selected?.style || (selectedStyle ? updated.style : state.learnedDefaultStyle?.style)) }); render(); }
        return;
      }
      if ('aiClearRecords' in button.dataset || 'aiClearTasks' in button.dataset) {
        const taskCleanup = 'aiClearTasks' in button.dataset, scope = button.dataset.aiClearTasks;
        const scopeLabel = {ended:'已结束',failed:'执行失败','ended-failed':'已结束和执行失败'}[scope];
        if (taskCleanup && !scopeLabel) { message('请先选择清理任务范围'); return; }
        const current = generation, target = id, account = state.account;
        const unchanged = () => current === generation && target === id && account === state?.account;
        const value = taskCleanup ? {type:'clear-ended-tasks',scope} : {type:'clear-records',source:button.dataset.aiClearRecords};
        const preview = await execute('configuration', { value }, ''); const confirmation = preview?.confirmation;
        if (!confirmation || !unchanged()) return;
        if (!confirmation.count) { message(taskCleanup ? '所选范围内没有可清理的任务' : '当前没有可清空的记录'); return; }
        // The preview refresh replaces the original trigger. Give the dialog
        // its current equivalent so cancellation restores the user's place.
        panel.querySelector(taskCleanup ? `[data-ai-clear-tasks="${scope}"]` : `[data-ai-clear-records="${value.source}"]`)?.focus({ preventScroll: true });
        if (!await productDialog({ title: taskCleanup ? `清理${scopeLabel}任务？` : '删除全部记录？', message: taskCleanup ? `将清理当前账号 ${confirmation.count} 个${scopeLabel}任务。执行中、已暂停的任务和执行记录保留。` : `将删除当前账号的 ${confirmation.count} 条该类记录，包含尚未加载的记录。微信中的聊天消息不受影响。`, confirm: taskCleanup ? '确认清理' : '确认删除', danger: true }) || !unchanged()) return;
        const result = await execute('configuration', { value: { ...value, token: confirmation.token } }, '');
        if (!result || !unchanged()) return;
        message(taskCleanup ? `已清理 ${result.clearedCount || 0} 个任务，执行记录已保留` : `已删除 ${result.clearedCount || 0} 条记录`);
        if (taskCleanup) return;
        logRecords = []; logRequestScope = ''; proactiveHistory = []; proactiveHistoryPage = null; skipHistory = []; skipHistoryPage = null; skipContent.clear(); markReplyStatus.clear(); recordCache.delete(id);
        if (tab === 'activity') await loadActivity();
        render(); return;
      }
      if ('aiPersonalSuggestion' in button.dataset) {
        const current = generation, target = id, account = state.account;
        const candidate = state.personalInformation?.suggestions?.find(row => row.id === button.dataset.aiPersonalSuggestion);
        if (!candidate) return;
        if (button.dataset.command === 'accept' && !await productDialog({ title: '确认采用这项个人信息？', message: candidate.text + (state.personalInformation.entries.some(row => row.field === candidate.field) ? '\n确认后将替换该项已有信息，可从历史版本恢复。' : '') + ($('#ai-personal-information-form')?.querySelector('[data-personal-field="' + candidate.field + '"]')?.dataset.dirty === 'true' ? '\n这项尚未保存的编辑也将被替换；其他字段的草稿保留。' : ''), confirm: '确认采用' })) return;
        if (current !== generation || target !== id || account !== state?.account) return;
        await workflow(async step => {
          await step('configuration', { value: { type: 'personal-suggestion', account, id: candidate.id, command: button.dataset.command } });
          if (button.dataset.command === 'accept' && personalDraft) delete personalDraft[candidate.field];
        }, '个人信息建议已处理'); return;
      }
      if ('aiPersonalHistory' in button.dataset) {
        const current = generation, target = id, account = state.account;
        const at = Number(button.dataset.aiPersonalHistory), result = await api(`/instances/${target}/ai`, { action: 'configuration', value: { type: 'personal-history', account, at } });
        if (current !== generation || target !== id || account !== state?.account) return;
        if (!await productDialog({ title: '恢复这个历史版本？', message: (result.history.entries.filter(row => !retiredPersonalFields.includes(row.field)).map(row => (state.personalFields.find(([key]) => key === row.field)?.[1] || row.field) + '：' + row.text).join('\n') || '这个版本没有当前可填写的信息。') + ($('#ai-personal-information-form')?.dataset.dirty === 'true' ? '\n当前尚未保存的编辑也将被替换。' : ''), confirm: '确认恢复' })) return;
        if (current !== generation || target !== id || account !== state?.account) return;
        await workflow(async step => {
          await step('configuration', { value: { type: 'personal-restore', account, at } });
          personalDraft = null; personalDraftAccount = state.account;
        }, '个人信息已恢复'); return;
      }
      if ('aiSkipMore' in button.dataset) { await loadSkipPage(); return; }
      if ('aiRecordKind' in button.dataset) { logFilters.kind = button.dataset.aiRecordKind === 'all' ? '' : button.dataset.aiRecordKind; logFilters.page = 0; logRequestScope = ''; render(); await loadActivity(); return; }
      if ('aiStyle' in button.dataset) {
        const form = $('#ai-object-form'), styleId = button.dataset.aiStyle;
        const profile = state.profiles.find(p => p.contact === selectedObject), preset = state.schema.replyPresets.find(p => 'preset:' + p.id === styleId);
        const style = styleId === 'learned' ? profile?.learnedStyle : objectStyleTabs(state, profile).find(row => row.id === styleId)?.style;
        form.elements.styleId.value = styleId;
        // 【默认风格】只有一套（账号级）：填入学习到的默认风格内容，并跟随其更新。
        if (styleId === '') form.elements.summary.value = summaryText(state.learnedDefaultStyle?.style || state.schema?.defaultStyle);
        else if (style) form.elements.summary.value = summaryText(style);
        rememberDraft();
        objectDrafts.set(selectedObject, { ...objectDrafts.get(selectedObject), styleId: form.elements.styleId.value, summary: form.elements.summary.value });
        render(); $('[data-ai-dirty]').hidden = false; return;
      }
      if (button.dataset.aiNav) { await navigate(button.dataset.aiNav); return; }
      if (button.dataset.aiKind) { rememberDraft(); objectKind = button.dataset.aiKind; selectedObject = ''; objectSection = 'reply'; objectMemoryCategory = objectKind === 'group' ? 'group_info' : 'name'; objectSearch = ''; const list = $('#ai-object-list'); if (list) list.scrollTop = 0; render(); return; }
      if (button.dataset.aiLearnKind) { learnContactKind = button.dataset.aiLearnKind; render(); return; }
      if (button.dataset.aiObjectSection) { rememberDraft(); objectSection = button.dataset.aiObjectSection; render(); return; }
      if (button.dataset.aiMemoryCategory) { rememberDraft(); objectMemoryCategory = button.dataset.aiMemoryCategory; render(); return; }
      if (button.dataset.aiObject) { rememberDraft(); selectedObject = button.dataset.aiObject; objectSection = 'reply'; objectMemoryCategory = objectKind === 'group' ? 'group_info' : 'name'; render(); return; }
      if ('aiObjectBack' in button.dataset) { rememberDraft(); selectedObject = ''; render(); return; }
      if ('aiLogPage' in button.dataset) { logFilters.page = Number(button.dataset.aiLogPage); logLoading = true; logRequestScope = ''; render(); await loadActivity(); return; }
      if (button.dataset.aiMemoryRestore) { const current=generation;const result=await execute('memory', {id:button.dataset.profile,value:{restoreId:button.dataset.aiMemoryRestore}}, '已恢复记忆'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); objectDirtyContacts.delete(selectedObject); render(); return; }
      // 记忆学习的结果先放在待确认区，由用户决定替换、合并还是放弃。
      if (button.dataset.aiMemoryApply) { const current=generation;const result=await execute('memory-apply', {id:button.dataset.aiMemoryApply}, '已用本次学习的记忆替换'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); objectDirtyContacts.delete(selectedObject); render(); return; }
      if (button.dataset.aiMemoryDiscard) { if (!await confirmDialog('确认放弃本次学习到的记忆？')) return; const current=generation;const result=await execute('memory-discard', {id:button.dataset.aiMemoryDiscard}, '已放弃本次学习到的记忆'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); objectDirtyContacts.delete(selectedObject); render(); return; }
      if (button.dataset.aiMemoryMerge) { const current=generation;const result=await execute('memory-merge', {id:button.dataset.aiMemoryMerge}, '正在与原有记忆合并，完成后请再确认一次'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); objectDirtyContacts.delete(selectedObject); render(); return; }
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
          section.querySelector('.ai-wiki-field-values').innerHTML=entries.filter(entry=>field === 'legacy' ? ['name','addressing','phone','birthday','date','school','household','residence','workplace','employer','shipping'].includes(entry.field) : (['birthday','date'].includes(entry.field) ? 'date_info' : ['household','residence','shipping'].includes(entry.field) ? 'address' : ['workplace','employer'].includes(entry.field) ? 'work' : entry.field === 'addressing' ? 'name' : entry.field || 'other')===field).map(entry=>wikiEntryMarkup(entry,state.capabilities?.writeContactRemark===true,form.id === 'ai-object-form' ? objectKind : 'person')).join('');
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
          manualReplyDrafts.set(contact.id, { ...state.schema?.defaultStyle, ...preset?.style, ...profile?.style, ...preset?.strategy, ...profile?.strategy, ...profile?.replyStrategy, replyPreset: profile ? 'custom' : preset?.id || 'custom' });
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
      if (button.dataset.aiModelDelete) { if (!await confirmDialog('确认删除这个模型？点击保存后生效，使用该模型的功能将切换到剩余模型。')) return; rememberDraft(); deleteModel(button.dataset.aiModelDelete); return; }
      if (button.dataset.aiModelApply) { rememberDraft(); applyModelToAll(button.dataset.aiModelApply); return; }
      if (button.dataset.aiModelTest) { await testListModel(button.dataset.aiModelTest); return; }
      if (action === 'model-cancel') { modelDraft = { ...(modelDraft || {}), editing: null, draftId: undefined, form: null, status: '' }; render(); message(''); return; }
      if (action === 'models-save') { await saveModelsAction(); return; }
      if (action === 'test' || action === 'models') await probeProvider(action);
      if (button.dataset.aiDateRange) {
        rememberDraft(); const scope = button.dataset.aiDateRange, contacts = scope === 'analysis' ? analysisDraft.contacts : [...selectedContacts];
        if (!contacts.length) throw new Error('请先选择联系人');
        const current = generation, target = id;
        const calendar = await api(`/instances/${target}/ai`, {action:'calendar',value:{contacts}}, 130000);
        if (current !== generation || target !== id) return;
        const result = await chooseDateRange(calendar.dates, scope === 'analysis' ? analysisDraft : learnRange, { analysis: scope === 'analysis' });
        if (current !== generation || target !== id) return;
        if (!result) {
          if (scope === 'analysis' && analysisRangeBeforeCustom !== null) { analysisRangeMode = analysisRangeBeforeCustom; analysisRangeBeforeCustom = null; render(); }
          (scope === 'analysis' ? $('#ai-analysis-form [data-ai-analysis-range="custom"]') : ($('[data-ai-date-range="learning"]') || $('[data-ai-default-range="all"]')))?.focus({ preventScroll: true });
          return;
        }
        analysisRangeBeforeCustom = null;
        if (scope === 'analysis') { Object.assign(analysisDraft,result); analysisRangeMode = result.from || result.to ? 'custom' : 'all'; } else { learnRange=result; learnRangeMode = result.from || result.to ? 'custom' : 'all'; }
        render();
        (scope === 'analysis' ? $('#ai-analysis-form [data-ai-analysis-range="custom"]') : ($('[data-ai-date-range="learning"]') || $('[data-ai-default-range="all"]')))?.focus({ preventScroll: true });
        return;
      }
      if (button.dataset.aiApplyResult) {
        const profile = state.profiles.find(p => p.id === button.dataset.aiApplyResult);
        if (!profile?.contact) throw new Error('联系人已变化，请刷新后重试');
        const current = generation;
        const combined = profile.pendingMemorySource === 'combined';
        const applied = await execute('reply-profile', {value:{contact:profile.contact,preserveSwitches:true,styleSet:true,styleId:'learned',style:profile.pendingStyle || profile.learnedStyle || profile.style,strategy:profile.replyStrategy || replyStrategy(),...(combined ? {applyCombinedLearning:true,combinedLearningId:profile.pendingMemoryId} : {})}}, combined ? '风格和记忆已一起应用到 '+profile.label : '已应用到 '+profile.label+' 聊天');
        if (!applied || current !== generation) return;
        selectedObject=profile.contact; objectKind=profile.kind || 'person'; objectDrafts.delete(profile.contact); objectDirtyContacts.delete(profile.contact); await navigate('overview');
        return;
      }
      if (action === 'toggle-key') await toggleKey();
      if (action === 'scan' || action === 'detect') await refreshContacts({ manual: true });
      if (action === 'learn-selected') {
        if (learnRangeMode === 'custom' && (!learnRange.from || !learnRange.to || learnRange.from > learnRange.to)) throw new Error('请选择有效的开始和结束日期');
        await learn({ contacts: [...selectedContacts], target: learnTarget, ...(learnScope === 'range' ? {...learnRange, scope:'range'} : {}) });
      }
      if (action === 'learn-default') {
        const picked = [...selectedContacts].filter(id => state.contacts.find(c => c.id === id)?.kind === 'person');
        if (!picked.length) throw new Error('请先选择至少一位联系人');
        await learn({ contacts: picked, perspective: defaultStylePerspective, asDefault: true, ...(learnScope === 'range' ? {...learnRange, scope:'range'} : {}) });
      }
      if (action === 'cancel-default-style') {
        if (!state.defaultStyleUndoable) return;
        if (!await confirmDialog('取消本次学习？默认风格将恢复为学习前的内容，联系人与群聊的设置不受影响。')) return;
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
          for (const report of analysisResult?.reports || []) if (['waiting', 'analyzing'].includes(report.status)) { report.status = 'cancelled'; report.error = ''; }
          render();
        }
        await execute('cancel', {}, '已取消未完成的操作');
      }
      if (action === 'open-contact-picker') {
        const kinds = pickerKinds(), account = state.account, current = generation;
        contactDialog?.close();
        contactDialog = openContactPickerDialog({ parent: panel, title: kinds.length > 1 ? '选择联系人或群聊' : '选择联系人', kinds,
          description: tab === 'learning' ? '每位对象独立学习，支持多选' : '选择要用于学习默认风格的联系人',
          selected: state.contacts.filter(c => kinds.includes(c.kind) && selectedContacts.has(c.id)),
          getContacts: retained => {
            const contacts = new Map((state?.contacts || []).filter(c => kinds.includes(c.kind)).map(c => [c.id, c]));
            for (const c of retained) if (!contacts.has(c.id)) contacts.set(c.id, { ...c, missing: true });
            return [...contacts.values()];
          },
          detail: c => `${learnedProfiles().some(p => p.contact === c.id) ? '<small>已学习</small>' : ''}${c.missing ? '<small>本次列表未读取到，保留原选择</small>' : ''}`,
          onRefresh: refreshContacts, onClose: () => { contactDialog = null; },
          onConfirm: contacts => { if (current !== generation || account !== state?.account) return; selectedContacts.clear(); contacts.forEach(c => selectedContacts.add(c.id)); render(); } });
        return;
      }
      if (['select-contacts', 'clear-contacts'].includes(action)) {
        rememberDraft();
        if (action === 'clear-contacts' || tab !== 'learning') selectedContacts.clear();
        if (action === 'select-contacts') {
          const learned = new Set(learnedProfiles().map(p => p.contact));
          let added = 0;
          for (const contact of state.contacts) {
            if (tab === 'learning' && added >= 20) break;
            if (!pickerKinds().includes(contact.kind) || learned.has(contact.id) || selectedContacts.has(contact.id)) continue;
            selectedContacts.add(contact.id);
            added++;
          }
        }
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
        if (action === 'delete-profile' && !await confirmDialog('确认删除这个已学习的风格？删除后无法恢复。')) return;
        await workflow(async step => {
          if (action === 'delete-profile') await step('configuration', { value: { type: 'style', id: key, styleId: 'learned', command: 'delete' } }); else await step('profile', { id: key, value: { style: profile.style, paused: false } });
          editingProfile = null; tab = profileReturn;
        }, action === 'delete-profile' ? '风格已删除' : '已保存，请重新开启需要的功能');
      }
    } catch (e) {
      if (analysisRangeBeforeCustom !== null) { analysisRangeMode = analysisRangeBeforeCustom; analysisRangeBeforeCustom = null; render(); }
      message(e.message, true);
    }
  });
  return {
    show,
    attached: () => !!id,
    async attach(instanceId) {
      for (const controller of confirmationControllers) controller.abort();
      replyLimitConfirmController?.abort(); replyLimitConfirmController = null;
      contactDialog?.close();
      rememberRecords();
      analysisDraft = { request: '', from: '', to: '', contacts: [], includeVoice: false, includeVisual: false }; analysisRangeMode = 'all'; analysisRangeBeforeCustom = null; analysisContactsExpanded = false; analysisSearch = ''; analysisHistoryReport = null; analysisHistoryEpoch++; resetAnalysisExport(); learnRange = {from:'',to:''}; learnRangeMode = 'all'; learnScope='range'; learnTarget='both'; defaultStylePerspective = 'self'; analysisResult = null; proactiveUI.reset();
      reviewAlert.hidden = true;
      concealKey(true); modelDraft = null; learningDraft = null; renderedView = ''; profileDrafts.clear(); manualReplyDrafts.clear(); objectDrafts.clear(); objectDirtyContacts.clear(); objectScrollKey = ''; objectScrollTop = 0; personalDraft = null; personalDraftAccount = null; summaryResults.clear(); selectedObject = ''; objectSearch = ''; objectKind = 'person'; learnContactKind = 'person'; editingReplyContact = null; contactSearch = ''; providerRevision++;
      generation++; skipEpoch++; skipLoading = false; skipHistory = []; skipHistoryPage = null; skipPageLoading = false; skipContent.clear(); markReplyStatus.clear(); clearInterval(timer); lastPollAt = 0; id = instanceId; setContactAvatarInstance(instanceId); state = null; busy = false; polling = false; attaching = true; tab = 'overview'; replyDraft = null; editingProfile = null; contactsLoaded = false; contactsLoading = false; resultProfileIds = null;
      const attachedGeneration = generation;
      selectedContacts.clear(); replyProfiles.clear(); setPanelVisible(false); rail.hidden = false; panel.setAttribute('aria-busy', 'false');
      proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordLoading = false; proactiveRecordEpoch++; errorHistory = []; errorPage = null; errorLoading = false; errorEpoch++;
      replyContactSearch = ''; logRecords = []; logLoading = false; logEpoch++; logSignature = ''; logFilters = { source: 'reply' }; lastAutoScanAt = 0;
      panel.querySelector(':scope > .ai-main-tabs')?.remove();
      $('#ai-content').innerHTML = loadingContent; message('');
      try { const result = await call(); if (!result) return; restoreRecords(); modeTargets('reply').forEach(id => replyProfiles.add(id)); render(); } catch (e) { if (attachedGeneration !== generation) return; $('#ai-content').innerHTML = '<div class="ai-entry-error" role="alert">设置读取失败，请返回后重试。</div>'; message(e.message, true); }
      finally { if (attachedGeneration === generation) attaching = false; }
      if (attachedGeneration !== generation) return;
      const current = generation;
      timer = setInterval(async () => {
        if (current === generation && !panel.hidden) refreshReplyCountdowns(panel);
        if ((typeof document.visibilityState === 'string' && (panel.hidden || document.hidden)) || Date.now() - lastPollAt < 2500) return;
        lastPollAt = Date.now();
        if (polling || current !== generation) return; polling = true;
        try {
          if (busy) { const epoch = requestEpoch; const result = await api(`/instances/${id}/ai?view=live`).catch(() => null); if (current !== generation || epoch !== requestEpoch || !busy || !result) return; if (state && result.account !== state.account) { await acceptState(result); if (current === generation) message('微信账号已变化，已停止旧账号操作', true); return; } if (analysisQueueAccount !== null && result.account !== analysisQueueAccount) { analysisQueueToken++; analysisQueueAccount = null; for (const report of analysisResult?.reports || []) if (report.status === 'waiting' || report.status === 'analyzing') { report.status = 'cancelled'; report.error = ''; } render(); message('微信账号已变化，已停止剩余联系人分析', true); return; } $('#ai-operation').hidden = !result.operation && !contactsLoading && !hasPendingAnalysis(); $('#ai-operation-text').textContent = operationText(result.operation) || (contactsLoading ? '正在获取联系人…' : hasPendingAnalysis() ? '正在分析聊天记录…' : ''); }
          else { const result = await call(undefined, {}, true); if (result) { controls(); if (tab === 'activity' && !panel.hidden && !logLoading && logSignature !== JSON.stringify([state.activity || [], state.activityHistory || []])) await loadActivity(); } }
        } catch (e) { if (current === generation && !panel.hidden) message(e.message, true); }
        finally { if (current === generation) polling = false; }
      }, 1000);
    },
    detach() { contactDialog?.close(); analysisQueueToken++; analysisQueueAccount = null; rememberRecords(); proactiveRecordEpoch++; proactiveRecordLoading = false; proactiveHistory = []; proactiveHistoryPage = null; errorEpoch++; errorLoading = false; errorHistory = []; errorPage = null; logEpoch++; analysisDraft = { request: '', from: '', to: '', contacts: [] }; analysisSearch = ''; analysisHistoryReport = null; analysisHistoryEpoch++; resetAnalysisExport(); analysisResult = null; reviewAlert.hidden = true; concealKey(true); modelDraft = null; learningDraft = null; profileDrafts.clear(); manualReplyDrafts.clear(); objectDrafts.clear(); objectDirtyContacts.clear(); objectScrollKey = ''; objectScrollTop = 0; personalDraft = null; personalDraftAccount = null; selectedObject = ''; objectSearch = ''; objectKind = 'person'; editingReplyContact = null; providerRevision++; generation++; skipEpoch++; skipLoading = false; skipHistory = []; skipHistoryPage = null; skipPageLoading = false; skipContent.clear(); markReplyStatus.clear(); clearInterval(timer); id = null; setContactAvatarInstance(null); state = null; attaching = false; rail.hidden = true; setPanelVisible(false); panel.querySelector(':scope > .ai-main-tabs')?.remove(); $('#ai-content').replaceChildren(); selectedContacts.clear(); replyProfiles.clear(); proactiveUI.reset(); replyDraft = null; },
  };
}
