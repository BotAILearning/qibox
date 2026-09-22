import { dateRangeField, chooseDateRange } from './ai-date-range.mjs';
import { providerPage } from './ai-provider-view.mjs';
import { icon, iconSprite, logoIcon } from './ai-icons.mjs';
import { keyIcon } from './ai-key-icon.mjs';
import { memoryFields } from './ai-memory-view.mjs';
import { objectPage, objectList } from './ai-object-view.mjs';
import { styleSummary as styleSummaryText } from './ai-style-view.mjs';
import { learnedObjectDraft } from './ai-learning-draft.mjs';
import { analysisPage, copyReport } from './ai-analysis-view.mjs';
import { activityPage, activityEntries, activityRows, proactiveRecordRows } from './ai-activity-view.mjs';
import { createProactiveUI } from './ai-proactive-view.mjs';
import { RecordCache, mergeRecordResults } from './ai-record-cache.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eventLabels = { contacted: '已主动联系', replied: '已自动回复', manual: '已交由你回复', limit: '已达到回复上限', skip: '本轮无需回复', handoff: '需要你处理', stop: '已停止自动联系', uncertain: '发送结果待核对', error: '任务已暂停', failed: '对象不可读取，本次未发送' };
const names = { formality: '正式程度', warmth: '亲切程度', length: '回复长度', directness: '表达方式', emoji: '表情使用', humor: '幽默程度' };
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
const field = (name, label, value, max = 1200, placeholder = '') => `<label class="ai-field">${label}<textarea name="${name}" maxlength="${max}" rows="${name === 'summary' ? 6 : 2}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
const switchRow = (key, label, hint = '') => `<label class="ai-switch-row"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" role="switch" data-ai-setting="${key}" aria-label="${label}"></label>`;
const KEY_MASK = '********';
const LEARNING_LIMIT = 10;
const timingDefaults = { segmentDelayMin: 2, segmentDelayMax: 8, followUpDelayMin: 45, followUpDelayMax: 120 };
const serviceIdentity = value => `${String(value?.protocol || 'openai')}|${String(value?.baseUrl || '').trim().replace(/\/+$/, '')}`;

export function aiAssistant({ api, onClose, onOpenChat }) {
  const rail = document.querySelector('#ai-rail'), panel = document.querySelector('#ai-panel');
  let id, state, tab = 'overview', timer, generation = 0, requestEpoch = 0, workToken = 0, polling = false, busy = false;
  let lastActivity = 0;
  let replyDraft = null, editingProfile = null, profileReturn = 'results';
  let contactsLoaded = false, contactsLoading = false, resultProfileIds = null;
  let lastAutoScanAt = 0;
  let editingReplyContact = null, replyContactSearch = '';
  let modelDraft = null, providerRevision = 0, revealRevision = 0, timingDraft = null, learningDraft = null, renderedView = '';
  const profileDrafts = new Map();
  const manualReplyDrafts = new Map();
  const objectDrafts = new Map();
  let learnRange = { from: '', to: '' }, learnScope = 'range';
  let analysisDraft = { request: '', from: '', to: '', contacts: [] }, analysisResult = null;
  let objectKind = 'person', selectedObject = '', objectSearch = '', logFilters = { source: 'proactive' };
  const objectView = () => ({ kind: objectKind, selected: selectedObject, search: objectSearch, draft: objectDrafts.get(selectedObject) });
  function objects() { return objectPage(state, objectView()); }
  let logRecords = [], logLoading = false, logEpoch = 0, logSignature = '';
  let proactiveHistory = [], proactiveHistoryPage = null, proactiveRecordLoading = false, proactiveRecordEpoch = 0;
  const recordCache = new RecordCache();
  let logRequestScope = '';
  const rememberRecords = () => recordCache.save(id, state?.account, { logRecords, proactiveHistory, proactiveHistoryPage, logFilters });
  function restoreRecords() {
    const saved = recordCache.take(id, state?.account);
    if (saved) ({ logRecords, proactiveHistory, proactiveHistoryPage, logFilters } = saved);
  }
  function drawRecords() {
    if (state && tab === 'activity' && $('#ai-activity-entries')) $('#ai-activity-entries').innerHTML = activityRows(state, logFilters, logRecords, logLoading);
  }
  const activityState = () => {
    const rows = new Map(proactiveHistory.map(r => [r.id, r]));
    const newest = proactiveHistory.length ? Math.max(...proactiveHistory.map(r => new Date(r.at).getTime())) : Infinity;
    for (const r of state?.proactiveRecords || []) if ((!logFilters.taskId || r.taskId === logFilters.taskId) && (!proactiveHistoryPage || rows.has(r.id) || new Date(r.at).getTime() >= newest)) rows.set(r.id, r);
    return { ...state, proactiveRecords: [...rows.values()].sort((a, b) => new Date(b.at) - new Date(a.at)), proactiveRecordsPage: proactiveHistoryPage || (logFilters.taskId ? { hasMore: true } : state?.proactiveRecordsPage) };
  };
  function activity() { return activityPage(activityState(), logFilters, logRecords, logLoading, proactiveRecordLoading); }
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
  async function loadActivity() {
    if ((logFilters.source || 'proactive') === 'proactive') return;
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
  async function openConversation(profileId, messageId) {
    const current = generation, target = id;
    let result;
    try { result = await api(`/instances/${target}/ai`, { action: 'open-conversation', id: profileId, ...(messageId ? { value: { messageId } } : {}) }, 130000); }
    catch (error) { if (current !== generation || target !== id) return; throw error; }
    if (current !== generation || target !== id) return;
    if (!result.opened) throw new Error('尚未确认打开目标聊天');
    panel.hidden = true; reviewDialog.close();
    await onOpenChat?.(target);
    if (result.notice) {
      document.querySelector('.ai-message-location-notice')?.remove();
      const notice = document.createElement('div'); notice.className = 'ai-message-location-notice'; notice.setAttribute('role', 'status'); notice.textContent = result.notice;
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.onclick = () => notice.remove(); notice.append(close);
      document.body.append(notice); setTimeout(() => notice.remove(), 10000);
    }
  }
  function confirmRealtime() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'ai-confirm-dialog';
      dialog.innerHTML = '<h3>开启 AI 实时回复？</h3><p>开启后，AI 将持续分析群聊消息，并根据聊天内容自动回复。群聊消息较多时，会消耗大量 Token，增加模型调用费用。</p><p>自动发言过于频繁存在账号被限制或封禁的风险，请谨慎开启。</p><form method="dialog" class="ai-actions"><button class="secondary" value="cancel">取消</button><button class="primary" value="confirm">确认开启</button></form>';
      dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  function showLogDetail(key) {
    const entry = state.events.find(e => String(e.id || e.at) === key); if (!entry) return;
    const profile = state.profiles.find(p => p.id === entry.target), dialog = document.createElement('dialog');
    dialog.className = 'ai-confirm-dialog';
    dialog.innerHTML = `<h3>运行记录详情</h3><p>对象：${esc(profile?.label || '系统')}</p><p>时间：${esc(new Date(entry.at).toLocaleString('zh-CN', { hour12: false }))}</p><p>结果：${esc(eventLabels[entry.code] || ({ wait: '等待', pause: '暂停', resumed: '已恢复', 'not-sent': '未发送' })[entry.code] || entry.code)}</p><p>触发方式：${esc(({ reply: '个人自动回复', proactive: '主动聊天', atMe: '@我', atAll: '@所有人', realtime: '群聊实时回复' })[entry.source] || '状态更新')}</p><p>该条记录不保存聊天正文。需要查看当前聊天或恢复回复时，请使用核对接管入口。</p><form method="dialog"><button class="primary">关闭</button></form>`;
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
  const replyProfiles = new Set();
  const learnedProfiles = () => selectProfiles().filter(p => p.learnedAt && p.learnedStyle);
  const modeTargets = mode => state[`${mode}Targets`] || state.targets;
  const replyStrategy = () => state.replyStrategy || state.strategy;
  const timingValues = () => ({ ...timingDefaults, ...state.settings, ...timingDraft });
  const operationText = operation => operation?.phase?.startsWith('analysis-') ? `正在${operation.phase === 'analysis-model' ? '分析' : '读取'}聊天记录 ${operation.completed}/${operation.total}` : operation ? operation.phase === 'contacts' ? operation.total ? `正在获取联系人 ${operation.completed}/${operation.total}` : '正在读取通讯录…' : operation.phase === 'model' ? `正在分析 ${operation.total} 位联系人的聊天风格…` : `正在读取聊天 ${operation.completed}/${operation.total}` : '';
  const needsContacts = () => !state.contacts?.length;
  const timingFields = () => {
    const value = timingValues();
    const range = (label, prefix, min, max) => `<fieldset class="ai-delay-range"><legend>${label}（秒）</legend><div><label class="ai-field">最短<input name="${prefix}Min" data-ai-timing type="number" required min="${min}" max="${max}" step="1" value="${esc(value[`${prefix}Min`])}"></label><span>至</span><label class="ai-field">最长<input name="${prefix}Max" data-ai-timing type="number" required min="${min}" max="${max}" step="1" value="${esc(value[`${prefix}Max`])}"></label></div></fieldset>`;
    return `${range('同轮消息随机间隔', 'segmentDelay', 1, 30)}${range('按需追问等待时间', 'followUpDelay', 15, 600)}<p class="ai-help">自动回复与主动聊天共用这些时间。对方发来新消息时，会先处理新消息。</p>`;
  };
  function checkedTiming() {
    const value = Object.fromEntries(Object.keys(timingDefaults).map(key => [key, Number(timingValues()[key])]));
    for (const [prefix, min, max] of [['segmentDelay', 1, 30], ['followUpDelay', 15, 600]]) {
      const a = value[`${prefix}Min`], b = value[`${prefix}Max`];
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) throw new Error(`请填写 ${min}–${max} 秒的有效范围，最短不能超过最长`);
    }
    return value;
  }
  const back = title => `<div class="ai-page-heading"><button type="button" class="quiet" data-ai-nav="overview">返回 AI 辅助</button><h3>${title}</h3></div>`;
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
    render,
    refreshContacts: () => refreshContacts({ manual: true }),
    showRecords: async taskId => {
      logFilters = { ...logFilters, taskId, source: 'proactive', page: 0 };
      proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordLoading = false; proactiveRecordEpoch++;
      await navigate('activity');
    },
  });
  let reviewData = null, reviewToken = 0;
  const reviewDialog = document.createElement('dialog'); reviewDialog.className = 'ai-review-dialog'; reviewDialog.setAttribute('aria-label', '核对聊天'); panel.append(reviewDialog);
  const reviewAlert = document.createElement('a'); reviewAlert.href = '#ai-review'; reviewAlert.className = 'ai-review-alert'; reviewAlert.hidden = true; rail.append(reviewAlert);
  reviewAlert.addEventListener('click', event => { event.preventDefault(); show(); void navigate('activity').catch(e => message(e.message, true)); });
  async function openReview(profileId, openChat = false) {
    if (openChat) return openConversation(profileId);
    const current = generation, target = id, token = ++reviewToken;
    reviewData = null;
    reviewDialog.innerHTML = `<h3>核对信息</h3><p role="status">正在读取当前聊天…</p><p id="ai-review-error" role="alert"></p><button type="button" class="secondary" data-ai-close-review>稍后处理</button>`;
    if (!reviewDialog.open) reviewDialog.showModal();
    let result;
    try { result = await api(`/instances/${target}/ai`, { action: 'review', id: profileId, value: { openChat } }, 130000); }
    catch (error) { if (current !== generation || target !== id || token !== reviewToken) return; reviewDialog.querySelector('#ai-review-error').textContent = error.message; return; }
    if (current !== generation || target !== id || token !== reviewToken) return;
    if (openChat) { reviewDialog.close(); hide(); return; }
    reviewData = result;
    reviewDialog.innerHTML = `<h3>${esc(result.label)} · 核对信息</h3><p>${esc(result.reason)}</p><div class="ai-review-messages">${result.messages.map(m => `<p class="${m.direction === 'self' ? 'self' : ''}"><strong>${m.direction === 'self' ? '我' : m.direction === 'other' ? esc(result.label) : '提示'}</strong><span>${esc(m.text)}</span></p>`).join('') || '<p>暂无可读取的文字消息</p>'}</div><p id="ai-review-error" role="alert"></p><div class="ai-actions"><a href="#wechat-chat" data-ai-open-chat>打开微信</a><button type="button" class="primary" data-ai-resolve-review>开启自动回复</button><button type="button" class="secondary" data-ai-close-review>稍后处理</button></div>`;
    if (!reviewDialog.open) reviewDialog.showModal();
  }
  reviewDialog.addEventListener('close', () => { reviewToken++; reviewData = null; });
  reviewDialog.addEventListener('cancel', () => { reviewToken++; reviewData = null; });
  reviewDialog.addEventListener('click', async event => {
    const node = event.target.closest('button,a'); if (!node) return; event.preventDefault(); event.stopPropagation();
    const current = generation;
    try {
      if (node.hasAttribute('data-ai-close-review')) { reviewDialog.close(); return; }
      if (!reviewData || busy) return;
      if (node.hasAttribute('data-ai-open-chat')) await openReview(reviewData.id, true);
      if (node.hasAttribute('data-ai-resolve-review')) { const result = await execute('review', { id: reviewData.id, value: { resolve: true, revision: reviewData.revision } }, '已核对，将处理后续新消息'); if (!result || current !== generation) return; reviewDialog.close(); reviewData = null; }
    } catch (error) { if (current === generation && reviewDialog.querySelector('#ai-review-error')) reviewDialog.querySelector('#ai-review-error').textContent = error.message; }
  });
  panel.addEventListener('click', event => {
    const resume = event.target.closest('[data-ai-resume-profile]');
    if (resume) {
      event.preventDefault(); const p = state.profiles.find(p => p.id === resume.dataset.aiResumeProfile);
      if (p) void execute('profile', { id: p.id, value: { style: p.style, paused: false } }, '已开启，将处理后续新消息').catch(error => message(error.message, true));
      return;
    }
    const open = event.target.closest('[data-ai-open-conversation]');
    if (open) { event.preventDefault(); void openConversation(open.dataset.aiOpenConversation).catch(error => message(error.message, true)); return; }
    const link = event.target.closest('[data-ai-review]'); if (!link) return; event.preventDefault();
    void openReview(link.dataset.aiReview).catch(error => message(error.message, true));
  });
  const message = (text, error = false) => { const node = $('#ai-feedback'); node.textContent = text; node.classList.toggle('error', error); node.hidden = !text; };
  async function call(action, extras = {}) {
    const current = generation, target = id, epoch = action ? ++requestEpoch : requestEpoch;
    let result;
    try { result = await api(`/instances/${target}/ai`, action ? { action, ...extras } : undefined, ['learn', 'scan'].includes(action) ? 30 * 60 * 1000 : 130000); }
    catch (error) { if (current !== generation || target !== id || epoch !== requestEpoch) return null; throw error; }
    if (current !== generation || target !== id || epoch !== requestEpoch) return null;
    if (state && state.account !== result.account) {
      recordCache.delete(id); logEpoch++; proactiveRecordEpoch++;
      logRecords = []; proactiveHistory = []; proactiveHistoryPage = null; logLoading = false; proactiveRecordLoading = false; logSignature = '';
    }
    state = result; return result;
  }
  function selectProfiles(includePaste = true) { return (state?.profiles || []).filter(p => includePaste || p.contact && state.contacts.some(c => c.id === p.contact)); }
  function scopeOptions(selected = '') { return option('', '通用策略', !selected) + selectProfiles().map(p => option(p.id, p.label, p.id === selected)).join(''); }
  function controls() {
    if (!state) return;
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
    if (tab === 'activity' && $('#ai-proactive-records')) $('#ai-proactive-records').innerHTML = proactiveRecordRows(activityState(), logFilters, proactiveRecordLoading);
    if ($('#ai-handoffs')) $('#ai-handoffs').innerHTML = handoffs();
    if (state.notice) { const note = $('#ai-state-notice'); if (note) note.textContent = state.notice; }
  }
  function replyContactList() {
    const query = replyContactSearch.trim().normalize('NFKC').toLocaleLowerCase();
    const contacts = (state.contacts || []).filter(c => c.kind === 'person' && (!query || c.label.normalize('NFKC').toLocaleLowerCase().includes(query)));
    return contacts.map(contact => {
      const profile = selectProfiles().find(p => p.contact === contact.id), applied = profile && (state.settings.replyScope === 'all' || modeTargets('reply').includes(profile.id));
      const strategy = profile && { ...replyStrategy(), ...(profile.strategy || {}), ...(profile.replyStrategy || {}) };
      return `<article class="ai-reply-contact" data-ai-reply-contact="${esc(contact.id)}"><strong>${esc(contact.label)}</strong><div class="ai-contact-strategy" data-ai-contact-strategy aria-label="${esc(contact.label)}的回复策略">${applied ? `${styleSummary(profile)}<p class="ai-help">回复目的：${esc(strategy.replyGoal)}</p>` : ''}</div><div class="ai-actions"><button type="button" class="secondary" data-ai-manual-contact="${esc(contact.id)}">${applied ? '调整回复风格' : '选择回复风格'}</button><button type="button" class="quiet" data-ai-learn-contact="${esc(contact.id)}">学习聊天风格</button>${profile?.learnedAt ? `<button type="button" class="quiet" data-ai-profile="${esc(profile.id)}">查看学习结果</button>${!applied ? `<button type="button" class="quiet" data-ai-apply-contact="${esc(contact.id)}">应用聊天风格</button>` : ''}` : ''}</div></article>`;
    }).join('') || `<p class="ai-help">${query && state.contacts?.length ? '没有找到匹配的联系人' : contactsLoading ? '正在获取联系人…' : contactsLoaded ? '暂未获取到联系人，请确认微信已登录后刷新。' : '打开后会获取联系人，也可以点击刷新联系人。'}</p>`;
  }
  function provider() { return providerPage(state, modelDraft); }
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
    modelDraft.models = modelDraft.models.map(m => m.id === id ? { ...m, label: value.label, baseUrl: value.baseUrl, model: value.model, protocol: value.protocol, timeout: value.timeout, consent: value.consent, apiKey: value.keyStored ? m.apiKey : (value.apiKey || ''), hasKey: value.keyStored || !!value.apiKey, tested: m.tested && !value.keyStored && m.baseUrl === value.baseUrl && m.model === value.model && m.protocol === value.protocol && m.timeout === value.timeout && m.consent === value.consent ? m.tested : false } : m);
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
    return ['label', 'baseUrl', 'apiKey', 'timeout'].every(key => form.elements[key].reportValidity());
  }
  function stageModel() {
    const form = $('#ai-model-form');
    if (!form || !modelDraft?.editing) return;
    if (!validateProvider('configure')) return;
    const value = providerDraft(), editing = modelDraft.editing;
    const id = editing !== 'new' ? editing : (modelDraft.draftId || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const list = modelDraft.models.filter(m => m.id !== id);
    const first = editing === 'new' && !list.length;
    list.push({ id, label: value.label, baseUrl: value.baseUrl, model: value.model, protocol: value.protocol || 'openai', timeout: value.timeout, consent: value.consent, hasKey: value.keyStored || !!value.apiKey, apiKey: value.keyStored ? undefined : (value.apiKey || ''), tested: false, usedBy: [] });
    const assignments = { ...modelDraft.assignments };
    for (const key of Object.keys(assignments)) if (first || assignments[key] === editing) assignments[key] = id;
    modelDraft = { models: list, assignments, editing: null, draftId: undefined, form: null, status: '模型已加入列表，点击“保存”后生效' };
    render(); message('已添加模型，请在功能分配中确认后点击“保存”');
  }
  async function saveModelsAction() {
    const list = modelDraft?.models || state.models || [];
    const models = list.map(({ id, label, baseUrl, model, protocol, timeout, consent, apiKey }) => ({ id, label, baseUrl, model, protocol, timeout, consent, ...(apiKey ? { apiKey } : {}) }));
    const assignments = modelDraft?.assignments || state.assignments || {};
    modelDraft = null;
    await execute('models-save', { value: { models, assignments } }, '模型设置已保存并生效');
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
    modelDraft = { ...(modelDraft || { models: current, assignments: { ...(state.assignments || {}) }, editing: null, form: null, status: '' }), assignments: { chat: id, proactive: id, learning: id, analysis: id }, status: `已将“${current.find(m => m.id === id)?.label || '该模型'}”应用于全部功能，点击“保存”后生效` };
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
  function styleResults(profiles, editable = true) {
    if (!profiles.length) return '';
    const edit = p => `<button type="button" class="quiet" data-ai-profile="${esc(p.id)}">${esc(p.label)} · ${editable ? '调整' : '查看'}${p.paused ? ' · 待你处理' : ''}</button>`;
    return profiles.map(p => `<details class="ai-style-group" data-ai-result-profile="${esc(p.id)}" open><summary>${esc(p.label)}</summary><h4>风格</h4>${styleSummary(p)}<h4>记忆</h4><p class="ai-result-memory">${esc(p.memory?.summary || '暂无明确记忆')}</p>${(p.replyStrategy?.replyGoal || p.strategy?.replyGoal) ? `<p class="ai-help">专属回复目的：${esc(p.replyStrategy?.replyGoal || p.strategy.replyGoal)}</p>` : ''}${edit(p)}</details>`).join('');
  }
  function contactPicker() {
    const contacts = state.contacts || [], selected = selectedContacts;
    const list = contacts.map(c => `<label class="ai-check"><input type="checkbox" data-ai-contact="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''} ${!['person', 'group'].includes(c.kind) ? 'disabled' : ''}><span>${esc(c.label)}${learnedProfiles().some(p => p.contact === c.id) ? '<small class="ai-badge blue">已学习</small>' : ''}${c.kind === 'group' ? '<small>群聊</small>' : ''}</span></label>`).join('');
    return `<div class="ai-actions"><button type="button" class="secondary" data-ai-action="scan">刷新联系人</button><button type="button" class="quiet" data-ai-action="select-contacts">选择未学习的前 10 位</button><button type="button" class="quiet" data-ai-action="clear-contacts">取消选择</button></div><div class="ai-contact-list" aria-label="选择联系人">${list || `<p class="ai-help">${contactsLoading ? '正在获取联系人…' : '暂未获取到联系人，请确认微信已登录后刷新。'}</p>`}</div><p id="ai-contact-count" class="ai-help" aria-live="polite">已选择 ${selected.size} 位联系人，每次最多 ${LEARNING_LIMIT} 位</p>`;
  }
  function learning() {
    return `<div class="ai-learning-heading"><div class="ai-learning-title"><button type="button" class="quiet" data-ai-nav="overview">${icon('arrow-l')}返回 AI 辅助</button><h3>批量学习风格与记忆</h3></div><div class="ai-learning-tools"><details class="ai-paste"><summary>粘贴聊天学习</summary><form id="ai-paste-form"><label class="ai-field">对应联系人<select name="contact">${option('', '单独保存风格', true)}${state.contacts.filter(c => ['person', 'group'].includes(c.kind)).map(c => option(c.id, c.label, false)).join('')}</select></label><label class="ai-field">风格名称（单独保存时填写）<input name="label" maxlength="120" placeholder="为这份风格命名"></label><label class="ai-field">聊天内容<textarea name="text" required maxlength="90000" rows="7" placeholder="我：……&#10;对方：……"></textarea></label><button type="submit" class="primary">学习这段聊天</button></form></details><button type="button" class="primary" data-ai-action="learn-selected" ${selectedContacts.size && selectedContacts.size <= LEARNING_LIMIT ? '' : 'disabled'}>开始学习</button>${learnedProfiles().length ? '<button type="button" class="quiet" data-ai-nav="results">查看学习结果</button>' : ''}</div></div>${contactPicker()}<section class="ai-card">${dateRangeField('learning',learnRange)}</section>`;
  }
  function results() {
    const profiles = learnedProfiles().filter(p => !resultProfileIds || resultProfileIds.has(p.id));
    return back('学习结果') + (profiles.length ? profiles.map(p => styleResults([{...p,style:p.pendingStyle || p.style}]) + '<div class="ai-actions ai-result-footer"><button type="button" class="secondary" data-ai-nav="overview">取消</button>' + (p.contact && state.contacts.some(c => c.id === p.contact) ? '<button type="button" class="primary" data-ai-apply-result="' + esc(p.id) + '">应用到 ' + esc(p.label) + ' 聊天</button>' : '') + '</div>').join('') : '<p class="ai-empty">还没有学习结果</p>');
  }
  function advancedSettings() {
    const rule = state.settings.takeover || {enabled:true,minutes:5};
    return '<h3>高级设置</h3><section class="ai-card">' + switchRow('acknowledgeAI','被问及身份时承认 AI','开启后，仅被询问时说明由 AI 回复；关闭后按本人身份回答。') + '</section><form id="ai-takeover-form" class="ai-card"><h4>手动回复后的自动接续</h4><label class="ai-field">接续方式<select name="enabled"><option value="true" '+(rule.enabled?'selected':'')+'>超时后自动回复</option><option value="false" '+(!rule.enabled?'selected':'')+'>不再自动回复</option></select></label><label class="ai-field">AI辅助等待时长（分钟）<input name="minutes" type="number" min="1" max="10080" required value="'+rule.minutes+'"></label><p class="ai-help">你手动回复后，从对方下一条消息开始计时；对方继续发消息不延长等待。你再次回复后，等待下一轮来信。所有联系人和群聊统一使用此设置。</p><button class="primary" type="submit">保存接续设置</button></form>';
  }
  function proactive() { return proactiveUI.page(); }
  function handoffs() { return state.profiles.filter(p => p.paused && (p.handoffReason || p.delivery?.status === 'uncertain')).map(p => `<p class="ai-help">${esc(p.label)}：${esc(p.delivery?.status === 'uncertain' ? '发送结果待核对' : state.schema.handoffLabels?.[p.handoffReason] || '自动回复已暂停')} <a href="#ai-review" data-ai-review="${p.id}">立即核对</a></p>`).join(''); }
  function profileEditor(profile) {
    if (profile.pendingStyle) profile={...profile,style:profile.pendingStyle};
    const draft = profileDrafts.get(profile.id), v = { ...profile.style, summary: summaryText(profile.style), ...draft }, reply = { ...replyStrategy(), ...profile.replyStrategy, ...draft };
    return `<form id="ai-profile-form" data-id="${profile.id}"><button type="button" class="quiet" data-ai-action="back-learning">返回学习结果</button><h3>${esc(profile.label)}的聊天风格</h3>${field('summary', '风格总结（可修改）', v.summary, 6000, '例如：表达简洁，语气自然，不添加没有依据的称呼。')}${field('customAvoid', '注意事项（可选）', v.customAvoid, 1200)}${memoryFields(profile, draft?.memorySummary)}<details class="ai-paste"><summary>回复策略（可选）</summary>${field('replyGoal', '回复目的与立场', reply.replyGoal)}${field('facts', '允许使用的信息', reply.facts, 4000)}${field('boundaries', '注意事项', reply.boundaries)}<label class="ai-field">连续自动回复上限<input name="maxRounds" type="number" min="1" max="1000" value="${reply.maxRounds ?? 50}"></label></details><div class="ai-actions"><button type="submit" class="primary">保存风格</button>${profile.paused ? '<a href="#ai-review" data-ai-review="' + profile.id + '">核对信息</a>' : ''}<button type="button" class="quiet danger-link" data-ai-action="delete-profile">删除风格</button></div></form>`;
  }
  function manualReplyEditor() {
    const contact = state.contacts.find(c => c.id === editingReplyContact && c.kind === 'person');
    if (!contact) return back('回复风格') + '<p class="ai-help">请刷新联系人后重试。</p>';
    const v = manualReplyDrafts.get(contact.id), presets = state.schema.replyPresets || [], profile = selectProfiles().find(p => p.contact === contact.id);
    return `<form id="ai-manual-reply-form" data-contact="${esc(contact.id)}"><div class="ai-page-heading"><button type="button" class="quiet" data-ai-action="back-reply-contacts">返回联系人列表</button><h3>${esc(contact.label)}的回复风格</h3></div>${profile?.paused ? '<p class="ai-help">该联系人已暂停。<a href="#ai-review" data-ai-review="' + profile.id + '">核对信息</a></p>' : ''}<label class="ai-field">选择风格<select id="ai-reply-preset" name="replyPreset">${presets.map(p => option(p.id, p.label, v.replyPreset === p.id)).join('')}${option('custom', '自定义', v.replyPreset === 'custom')}${learnedProfiles().length ? '<optgroup label="已学习的风格">' + learnedProfiles().map(p => option('learned:' + p.id, p.label, v.replyPreset === 'learned:' + p.id)).join('') + '</optgroup>' : ''}</select></label>${field('summary', '风格说明（可修改）', v.summary || summaryText(v), 6000)}<details class="ai-paste"><summary>注意事项与策略（可选）</summary>${field('customAvoid', '注意事项', v.customAvoid, 1200)}${field('replyGoal', '回复目的与立场', v.replyGoal)}${field('facts', '允许使用的信息', v.facts, 4000)}${field('boundaries', '不能擅自决定的事项', v.boundaries)}<label class="ai-field">连续自动回复上限<input name="maxRounds" type="number" min="1" max="1000" value="${v.maxRounds ?? 50}"></label></details><button type="submit" class="primary ai-wide">保存回复风格</button></form>`;
  }
  function rememberDraft() {
    const analysis = $('#ai-analysis-form');
    if (analysis) { const data = new FormData(analysis); analysisDraft = { request: data.get('request'), from: data.get('from'), to: data.get('to'), contacts: data.getAll('contacts') }; }
    const object = $('#ai-object-form');
    if (object) {
      const draft = { ...Object.fromEntries(new FormData(object)), folds: [...object.querySelectorAll("details[data-ai-fold][open]")].map(x => x.dataset.aiFold) };
      for (const input of object.querySelectorAll('[data-object-option]')) draft[input.dataset.objectOption] = input.checked;
      objectDrafts.set(selectedObject, draft);
    }
    rememberProvider();
    for (const input of panel.querySelectorAll('[data-ai-timing], #ai-reply-delay')) {
      timingDraft ||= {};
      timingDraft[input.id === 'ai-reply-delay' ? 'replyDelay' : input.name] = input.value;
    }
    proactiveUI.remember();
    const profile = $('#ai-profile-form');
    if (profile) { const data = new FormData(profile); profileDrafts.set(profile.dataset.id, { ...profileDrafts.get(profile.dataset.id), ...Object.fromEntries(data) }); }
    const manual = $('#ai-manual-reply-form');
    if (manual) { const data = new FormData(manual); manualReplyDrafts.set(manual.dataset.contact, { ...manualReplyDrafts.get(manual.dataset.contact), ...Object.fromEntries(data) }); }
    const paste = $('#ai-paste-form');
    if (paste) learningDraft = Object.fromEntries(new FormData(paste));
  }
  async function navigate(next) {
    rememberDraft();
    if (tab === 'provider') concealKey(true);
    if (next === 'results') resultProfileIds = null;
    if (next === 'activity') { logLoading = logFilters.source === 'reply'; logRequestScope = ''; }
    tab = next; editingProfile = null; editingReplyContact = null; message(''); render(); $('#ai-content').scrollTop = 0;
    if (next === 'activity') await Promise.all([loadActivity(), loadProactiveRecords()]);
    if ((next === 'analysis' || next === 'learning' || next === 'proactive' || next === 'overview' && state.settings.reply) && needsContacts()) await refreshContacts();
  }
  function render() {
    if (!state) return;
    revealRevision++;
    const view = `${tab}:${editingProfile || editingReplyContact || (tab === 'overview' ? selectedObject : '')}:${tab === 'proactive' ? !!$('#ai-proactive-form') : ''}`;
    const objectScroll = $('#ai-object-list')?.scrollTop || 0;
    const disclosureStates = view === renderedView ? [...panel.querySelectorAll('#ai-content details')].filter(node => !node.hasAttribute('data-ai-record-expand')).map(node => ({ label: node.querySelector('summary')?.textContent, open: node.open })) : [];
    renderedView = view; panel.dataset.page = tab;
    $('#ai-title').textContent = ({ overview: '自动回复', proactive: '主动聊天', activity: '运行记录', provider: '模型设置', settings: '高级设置', analysis: '聊天数据分析', learning: '学习聊天风格', results: '学习结果', profile: '编辑学习结果' })[tab] || 'AI 辅助';
    const content = tab === 'profile' && editingProfile ? profileEditor(state.profiles.find(p => p.id === editingProfile)) : ({ overview: objects, analysis: () => analysisPage(state, analysisDraft, analysisResult), activity, provider, settings: advancedSettings, learning, results, proactive, 'manual-reply': manualReplyEditor }[tab] || objects)();
    const nav = `<nav class="ai-main-tabs" aria-label="AI 页面"><div class="ai-nav-brand"><span>${logoIcon}</span><div>AI 辅助<small>栖盒 · QIBOX</small></div></div><p class="ai-nav-caption">工作台</p>${[['overview', '自动回复', 'chat'], ['proactive', '主动聊天', 'send'], ['analysis', '聊天分析', 'file'], ['activity', '运行记录', 'clock'], ['provider', '模型设置', 'sliders']].map(([key, name, symbol]) => `<button type="button" data-ai-nav="${key}" title="${name}" aria-label="${name}" aria-current="${tab === key || key === 'overview' && ['learning','results','profile','manual-reply'].includes(tab) ? 'page' : 'false'}">${icon(symbol)}<span>${name}</span></button>`).join('')}<div class="ai-nav-footer">${icon('shield')}<span>设置按当前微信独立保存</span></div></nav>`;
    $('#ai-content').innerHTML = iconSprite + nav + (tab === 'overview' ? content : `<div class="ai-page-body">${content}</div>`);
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
    try { await work(step); if (current !== generation) return; render(); if (success) message(success); }
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
  async function learn(value) {
    if (value.contacts && (!value.contacts.length || value.contacts.length > LEARNING_LIMIT)) throw new Error(`请选择 1–${LEARNING_LIMIT} 位联系人`);
    if (value.contacts?.some(key => !state.contacts.some(c => c.id === key && ['person', 'group'].includes(c.kind)))) throw new Error('联系人已变化，请刷新后重新选择');
    rememberDraft();
    const beforeDrafts = new Map(structuredClone([...objectDrafts])), beforeProfiles = structuredClone(state.profiles);
    const previous = new Set(state.profiles.map(p => p.id));
    await workflow(async step => {
      $('#ai-operation').hidden = false; $('#ai-operation-text').textContent = '正在读取聊天并学习风格…';
      await step('learn', { value: {...value,previewOnly:true} });
      state.operation = null;
      const learned = learnedProfiles().filter(p => value.contacts?.includes(p.contact) || (value.contact && p.contact === value.contact) || (!value.contacts && !value.contact && !previous.has(p.id)));
      resultProfileIds = new Set(learned.map(p => p.id));
      rememberDraft();
      learned.forEach(p => { replyProfiles.add(p.id); if (objectDrafts.has(p.contact)) objectDrafts.set(p.contact, learnedObjectDraft(objectDrafts.get(p.contact), beforeDrafts.get(p.contact), beforeProfiles.find(x => x.contact === p.contact), p)); });
      replyDraft = null; tab = 'results';
    }, '风格学习完成');
  }
  function show() {
    panel.hidden = false; rail.querySelector('#ai-open').setAttribute('aria-expanded', 'true'); if (state) render(); $('#ai-close').focus();
    if (state?.settings.reply && tab === 'overview' && needsContacts() && !busy) {
      const current = generation;
      void refreshContacts().catch(error => { if (current === generation) message(error.message, true); });
    }
  }
  function hide() { rememberDraft(); rememberRecords(); reviewToken++; reviewDialog.close(); concealKey(true); proactiveUI.closeOverlay(); if (learningDraft) learningDraft.text = ''; panel.hidden = true; rail.querySelector('#ai-open').setAttribute('aria-expanded', 'false'); panel.querySelectorAll('[name=text], [name=styleText]').forEach(input => { input.value = ''; }); rail.querySelector('#ai-open').focus(); onClose?.(); }
  rail.querySelector('#ai-open').onclick = () => panel.hidden ? show() : hide();
  $('#ai-close').onclick = hide;
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); if (!proactiveUI.closeOverlay()) hide(); } });
  const changeMaster = async event => {
    try { await execute('settings', { value: { enabled: event.target.checked } }); }
    catch (e) { show(); controls(); message(e.message, true); }
  };
  rail.addEventListener('change', changeMaster);
  panel.addEventListener('change', async event => {
    try {
      const input = event.target;
      if (proactiveUI.change(input)) return;
      if (input.id === 'ai-record-task') { logFilters.taskId = input.value; logFilters.source = input.value ? 'proactive' : (logFilters.source || 'proactive'); proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordLoading = false; proactiveRecordEpoch++; render(); await loadProactiveRecords(); return; }
      if (input.id === 'ai-learning-scope') { rememberDraft(); learnScope = input.value; render(); return; }
      if ('aiPanelMaster' in input.dataset) { await changeMaster(event); return; }
      if (input.closest('#ai-analysis-form') && input.name === 'contacts') {
        const checked = [...panel.querySelectorAll('#ai-analysis-form [name=contacts]:checked')];
        if (checked.length > 10) { input.checked = false; throw new Error('一次最多分析 10 位联系人'); }
        $('#ai-analysis-count').textContent = `${checked.length} / 10`;
      }
      if (input.dataset.objectOption) {
        // 开关修改只作为草稿，点击【保存设置】后统一生效。
        rememberDraft(); render(); if ($('[data-ai-dirty]')) $('[data-ai-dirty]').hidden = false; return;
      }
      if (input.closest('#ai-object-form') && input.name === 'styleId') {
        const profile = state.profiles.find(p => p.contact === selectedObject), preset = state.schema.replyPresets.find(p => 'preset:' + p.id === input.value);
        const style = input.value === 'learned' ? profile?.learnedStyle : preset?.style;
        if (style) $('#ai-object-form').elements.summary.value = summaryText(style);
        if (!input.value) $('#ai-object-form').elements.summary.value = '';
        
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
        if (input.checked && !set.has(contact) && set.size >= LEARNING_LIMIT) { input.checked = false; throw new Error(`一次最多学习 ${LEARNING_LIMIT} 位联系人`); }
        if (input.checked) set.add(contact); else set.delete(contact);
        const learnButton = $('[data-ai-action=learn-selected]'); if (learnButton) learnButton.disabled = !selectedContacts.size;
        const count = $('#ai-contact-count'); if (count) count.textContent = `已选择 ${set.size} 位联系人，每次最多 ${LEARNING_LIMIT} 位`;
        message('');
      }
      if (input.id === 'ai-reply-scope') await execute('settings', { value: { replyScope: input.value } });
      if (input.name === 'sendMode') { rememberDraft(); render(); }
      if (input.name === 'replyProfiles') { if (input.checked) replyProfiles.add(input.value); else replyProfiles.delete(input.value); }
      rememberDraft();
    } catch (e) { controls(); message(e.message, true); }
  });
  panel.addEventListener('input', event => {
    if (event.target.id === 'ai-object-search') { objectSearch = event.target.value; $('#ai-object-list').innerHTML = objectList(state, objectView()); return; }
    if (event.target.id === 'ai-reply-contact-search') {
      replyContactSearch = event.target.value;
      $('#ai-reply-contacts').innerHTML = replyContactList();
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
    event.preventDefault(); const form = event.target, data = new FormData(form);
    try {
      if (form.id === 'ai-log-filter') { if (data.get('from') && data.get('to') && data.get('from') > data.get('to')) throw new Error('开始日期不能晚于结束日期'); logFilters = { ...logFilters, ...Object.fromEntries(data), page: 0 }; const refreshed = await call(); if (refreshed) { logLoading = logFilters.source === 'reply'; logRequestScope = ''; proactiveHistoryPage = null; proactiveRecordEpoch++; proactiveRecordLoading = false; render(); await Promise.all([loadActivity(), loadProactiveRecords()]); } return; }
      if (form.id === 'ai-takeover-form') { await execute('settings', {value:{takeover:{enabled:data.get('enabled')==='true',minutes:Number(data.get('minutes'))}}}, '接续设置已保存'); return; }
      if (form.id === 'ai-analysis-form') {
        rememberDraft();
        if (!analysisDraft.contacts.length || analysisDraft.contacts.length > 10) throw new Error('请选择 1–10 位联系人');
        if (analysisDraft.from > analysisDraft.to) throw new Error('开始日期不能晚于结束日期');
        const current = generation, target = id;
        await workflow(async () => {
          analysisResult = null;
          const result = await api(`/instances/${target}/ai`, { action: 'analyze', value: structuredClone(analysisDraft) }, 30 * 60 * 1000);
          if (current === generation && id === target) analysisResult = result;
        }, '分析结束，请查看每位联系人的报告'); return;
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
        await workflow(async step => {
          if (profile?.kind === 'group') {
            await step('group-options', { value: { contact, atMe: data.has('atMe'), atAll: data.has('atAll'), realtime: data.has('realtime'), ...(realtimeConfirmed ? { confirmRealtime: true } : {}) } });
            await step('reply-profile', { value: { contact, preserveSwitches: true, styleSet: !!summary, styleId, style, strategy } });
          } else {
            await step('reply-profile', { value: { contact, preserveSwitches: true, styleSet: !!summary, styleId, style, strategy, replyEnabled: data.has('enabled') } });
            await step('reply-options', { value: { contact, multiTurn: data.has('multiTurn'), judgeReply: data.has('judgeReply') } });
          }
          const saved = state.profiles.find(p => p.contact === contact);
          if (String(data.get('memorySummary') || '').trim() !== (profile?.memory?.summary || '') && !profile?.memory?.unavailable) await step('memory', { id: saved.id, value: { summary: String(data.get('memorySummary') || '') } });
          objectDrafts.delete(contact);
        }, '设置已保存'); return;
      }
      if (form.id === 'ai-model-form') await stageModel();
      if (form.id === 'ai-manual-reply-form') {
        const contact = form.dataset.contact;
        if (!state.contacts.some(c => c.id === contact && ['person', 'group'].includes(c.kind))) throw new Error('联系人已变化，请刷新后重新选择');
        const strategy = { replyGoal: data.get('replyGoal') || '', facts: data.get('facts') || '', boundaries: data.get('boundaries') || '', maxRounds: Number(data.get('maxRounds')) };
        
        if (!Number.isInteger(strategy.maxRounds) || strategy.maxRounds < 1 || strategy.maxRounds > 1000) throw new Error('连续自动回复上限须为 1–1000 的整数');
        const style = { summary: data.get('summary'), customAvoid: data.get('customAvoid') || '' };
        await workflow(async step => {
          await step('reply-profile', { value: { contact, style, strategy } });
          manualReplyDrafts.delete(contact); editingReplyContact = null; tab = 'overview';
        }, '回复风格已保存');
      }
      if (form.id === 'ai-paste-form') { const value = Object.fromEntries(data); form.querySelector('[name=text]').value = ''; if (learningDraft) learningDraft.text = ''; await learn(value); }
      if (form.id === 'ai-proactive-form') { await proactiveUI.submit(); return; }
      if (form.id === 'ai-profile-form') {
        const key = form.dataset.id, original = state.profiles.find(p => p.id === key), base = { ...(original.strategy || replyStrategy()), ...original.replyStrategy };
        const reply = { replyGoal: data.get('replyGoal') || '', facts: data.get('facts') || '', boundaries: data.get('boundaries') || '', maxRounds: Number(data.get('maxRounds') || 50) };
        await workflow(async step => {
          await step('profile', { id: key, value: { style: { summary: data.get('summary'), customAvoid: data.get('customAvoid') || '' } } });
          const existing = state.profiles.find(p => p.id === key);
          if (!existing.memory?.unavailable && String(data.get('memorySummary') || '').trim() !== (existing.memory?.summary || '')) await step('memory', { id: key, value: { summary: String(data.get('memorySummary') || '') } });
          if (Object.keys(reply).some(k => reply[k] !== (base[k] ?? ''))) await step('strategy', { id: key, mode: 'reply', value: { ...base, ...reply } });
          profileDrafts.delete(key); editingProfile = null; tab = profileReturn;
        }, '风格已保存');
      }
    } catch (e) { message(e.message, true); }
  });
  panel.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      const action = button.dataset.aiAction;
      if ('aiRetryRecords' in button.dataset) { await loadActivity(); return; }
      if ('aiLocateMessage' in button.dataset) { await openConversation(button.dataset.profileId, button.dataset.aiLocateMessage); return; }
      if ('aiDeleteRecord' in button.dataset) {
        if (!window.confirm('确认删除这条运行记录？不会删除微信中的聊天消息。')) return;
        const recordId = button.dataset.aiDeleteRecord, source = button.dataset.aiDeleteSource;
        proactiveHistory = proactiveHistory.filter(record => !(source === 'proactive' && record.id === recordId));
        logRecords = logRecords.map(record => ({ ...record, messages: (record.messages || []).filter(message => !(message.id === recordId && (source === 'reply' || source === 'unknown'))) }));
        await call('delete-activity-record', { value: { source, id: recordId } });
        rememberRecords(); render(); return;
      }
      if (await proactiveUI.click(button)) return;
      if ('proactiveRecordMore' in button.dataset) { await loadProactiveRecords(true); return; }
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
      if (busy && !['cancel'].includes(action)) throw new Error('请等待当前操作完成，或先取消');
      if (action === 'analysis-use-chat') { await execute('analysis-use-chat', {}, '聊天分析已改用聊天模型'); return; }
      if (action === 'analysis-settings') { await navigate('provider'); return; }
      if ('aiStyle' in button.dataset) {
        const form = $('#ai-object-form'), styleId = button.dataset.aiStyle;
        const profile = state.profiles.find(p => p.contact === selectedObject), preset = state.schema.replyPresets.find(p => 'preset:' + p.id === styleId);
        const style = styleId === 'learned' ? profile?.learnedStyle : preset?.style;
        form.elements.styleId.value = styleId;
        if (style) form.elements.summary.value = summaryText(style);
        if (!styleId) form.elements.summary.value = '';
        rememberDraft(); render(); $('[data-ai-dirty]').hidden = false; return;
      }
      if (button.dataset.aiNav) { await navigate(button.dataset.aiNav); return; }
      if (button.dataset.aiKind) { rememberDraft(); objectKind = button.dataset.aiKind; selectedObject = ''; objectSearch = ''; render(); return; }
      if (button.dataset.aiObject) { rememberDraft(); selectedObject = button.dataset.aiObject; render(); return; }
      if ('aiObjectBack' in button.dataset) { rememberDraft(); selectedObject = ''; render(); return; }
      if ('aiLogPage' in button.dataset) { logFilters.page = Number(button.dataset.aiLogPage); logLoading = true; logRequestScope = ''; render(); await loadActivity(); return; }
      if (button.dataset.aiMemoryRestore) { const current=generation;const result=await execute('memory', {id:button.dataset.profile,value:{restoreId:button.dataset.aiMemoryRestore}}, '已恢复记忆'); if(!result || current!==generation)return;objectDrafts.delete(selectedObject); render(); return; }
      if (button.dataset.aiAdoptMemory) {
        const profile = state.profiles.find(p => p.id === button.dataset.aiAdoptMemory);
        const input = button.closest('form').querySelector('[name=memorySummary]');
        if (input.value.trim() !== (profile.memory?.summary || '')) throw new Error('请先保存正在编辑的记忆，再合并候选内容');
        const entries = (profile.memory?.entries || []).map(e=>({...e}));
        for(const entry of profile.memorySuggestion?.entries || []) {
          const index=entries.findIndex(e=>e.id===entry.id);
          if(index>=0) entries[index]=entry;else if(!entries.some(e=>e.text===entry.text)) entries.push(entry);
        }
        input.value=entries.map(e=>e.text).join('\n');rememberDraft();return;
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
      if (button.dataset.aiLearnContact) { await learn({ contacts: [button.dataset.aiLearnContact] }); return; }
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
      if (action === 'learn-selected') await learn({ contacts: [...selectedContacts], ...(learnScope === 'range' ? {...learnRange, scope:'range'} : {}) });
      if (action === 'cancel') { contactsLoading = false; await execute('cancel', {}, '已取消未完成的操作'); }
      if (action === 'delay') {
        rememberDraft(); const replyDelay = Number($('#ai-reply-delay').value), timing = checkedTiming();
        if (!Number.isInteger(replyDelay) || replyDelay < 3 || replyDelay > 60) throw new Error('合并消息的等待时间须为 3–60 秒的整数');
        await execute('settings', { value: { replyDelay, ...timing } }, '沟通设置已保存');
      }
      if (['select-contacts', 'clear-contacts'].includes(action)) {
        rememberDraft(); selectedContacts.clear();
        if (action === 'select-contacts') state.contacts.filter(c => ['person', 'group'].includes(c.kind) && !learnedProfiles().some(p => p.contact === c.id)).slice(0, LEARNING_LIMIT).forEach(c => selectedContacts.add(c.id));
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
    async attach(instanceId) {
      rememberRecords();
      analysisDraft = { request: '', from: '', to: '', contacts: [] }; learnRange = {from:'',to:''}; learnScope='range'; analysisResult = null; proactiveUI.reset();
      reviewDialog.close(); reviewDialog.replaceChildren(); reviewData = null; reviewAlert.hidden = true;
      concealKey(true); modelDraft = null; timingDraft = null; learningDraft = null; renderedView = ''; profileDrafts.clear(); manualReplyDrafts.clear(); objectDrafts.clear(); selectedObject = ''; objectSearch = ''; objectKind = 'person'; editingReplyContact = null; providerRevision++;
      generation++; clearInterval(timer); id = instanceId; state = null; busy = false; polling = false; tab = 'overview'; replyDraft = null; editingProfile = null; contactsLoaded = false; contactsLoading = false; resultProfileIds = null;
      const attachedGeneration = generation;
      selectedContacts.clear(); replyProfiles.clear(); panel.hidden = true; rail.hidden = false; panel.setAttribute('aria-busy', 'false');
      proactiveHistory = []; proactiveHistoryPage = null; proactiveRecordLoading = false; proactiveRecordEpoch++;
      replyContactSearch = ''; logRecords = []; logLoading = false; logEpoch++; logSignature = ''; logFilters = { source: 'proactive' }; lastAutoScanAt = 0;
      $('#ai-content').innerHTML = '<p class="ai-help">正在读取设置…</p>'; message('');
      try { const result = await call(); if (!result) return; restoreRecords(); modeTargets('reply').forEach(id => replyProfiles.add(id)); render(); } catch (e) { if (attachedGeneration !== generation) return; message(e.message, true); }
      if (attachedGeneration !== generation) return;
      const current = generation;
      timer = setInterval(async () => {
        if (polling || current !== generation) return; polling = true;
        try {
          if (busy) { const epoch = requestEpoch; const result = await api(`/instances/${id}/ai`).catch(() => null); if (current !== generation || epoch !== requestEpoch || !busy || !result) return; $('#ai-operation').hidden = !result.operation && !contactsLoading; $('#ai-operation-text').textContent = operationText(result.operation) || (contactsLoading ? '正在获取联系人…' : ''); }
          else { const result = await call(); if (result) { controls(); if (tab === 'activity' && !panel.hidden && !logLoading && logSignature !== JSON.stringify([state.activity || [], state.activityHistory || []])) await loadActivity(); } }
        } catch (e) { if (current === generation && !panel.hidden) message(e.message, true); }
        finally { if (current === generation) polling = false; }
      }, 2500);
    },
    detach() { rememberRecords(); reviewToken++; proactiveRecordEpoch++; proactiveRecordLoading = false; proactiveHistory = []; proactiveHistoryPage = null; logEpoch++; analysisDraft = { request: '', from: '', to: '', contacts: [] }; analysisResult = null; reviewDialog.close(); reviewDialog.replaceChildren(); reviewData = null; reviewAlert.hidden = true; concealKey(true); modelDraft = null; timingDraft = null; learningDraft = null; profileDrafts.clear(); manualReplyDrafts.clear(); objectDrafts.clear(); selectedObject = ''; objectSearch = ''; objectKind = 'person'; editingReplyContact = null; providerRevision++; generation++; clearInterval(timer); id = null; state = null; rail.hidden = true; panel.hidden = true; $('#ai-content').replaceChildren(); selectedContacts.clear(); replyProfiles.clear(); proactiveUI.reset(); replyDraft = null; },
  };
}
