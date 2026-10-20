import { restoreAppearance } from './appearance.mjs';
import { desktopLoader } from './desktop-loader.mjs';
import { nativeInput } from './native-input.mjs';
import { clipboardFiles } from './clipboard-files.mjs';
import { appIcon } from './app-icons.mjs';
import { host, apiPrefix, hostHeaders, invalidateHostToken } from './host.mjs';
import { localFiles } from './local-files.mjs';
import { loginLabel, desktopAction, desktopStatus, aiAvailable } from './wechat-state.mjs';
import { desktopPointer } from './desktop-pointer.mjs';
import { desktopReconnect } from './desktop-reconnect.mjs';
import { desktopAudio } from './desktop-audio.mjs';
import { dismissibleNotice } from './dismissible-notice.mjs';
import { visibleRefresh, stateRefreshDelay } from './visible-refresh.mjs';
import { bindDialogFocus } from './dialogs.mjs';
import { readApiResponse, parseApiResponse, requireDownloadResponse } from './http-response.mjs';
import './qiapp-adopt.mjs';

const $ = selector => document.querySelector(selector);
const connectionNotice = dismissibleNotice($('#connection-error'), { fallbackFocus: () => $('.brand') });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefix = apiPrefix;
restoreAppearance();
const small = matchMedia('(max-width: 760px)');
const phone = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
// A phone that requests a desktop-sized viewport should receive the PC controls.
const mobile = () => small.matches || (phone && innerWidth < 980);
const syncLayout = () => document.documentElement.classList.toggle('mobile', mobile());
syncLayout();
window.addEventListener('resize', syncLayout);
let session, state, toastTimer, modalSubmit, requiredModal = false, polling = false, rfb, ime, fileBridge, desktopId, remoteGeneration = 0, lastInstancesMarkup = '';
let modalGeneration = 0, submittingModalGeneration = null;
let desktopConnected = false, desktopBusy = false, desktopConnecting = false, pointer, connectionTimer, desktopOperation = 0;
let pendingAIEntry = null;
let sound, standaloneAI = false;
let mobileLoginId = null;
let mobileLoginCheckTimer = null, mobileLoginChecking = false;
let hostSessionEpoch = 0;
const mobileAISettings = new Map(), mobileAISettingsLoading = new Set(), mobileAIGeneration = new Map(), mobileAIRequests = new Map();
// Rendering a failed read must not immediately launch another request.
const mobileAIReadErrors = new Set();
let lastMobileAIMarkup = '', lastMobileInstancesMarkup = '';
const busyIds = new Set();
const inputDrafts = new Map();
const reconnect = desktopReconnect({ notify, reconnect: async () => {
  const id = desktopId;
  if (!id || $('#desktop-view').hidden || standaloneAI) return;
  const mobileLogin = mobile() && mobileLoginId === id;
  await openDesktop(id, false, false, mobileLogin, true);
} });
function showInputRecovery(id, text) {
  inputDrafts.set(id, text);
  if (desktopId !== id) return;
  $('#input-recovery-text').value = text; $('#input-recovery').hidden = false;
}
const modal = $('#modal');
function syncDesktopInteraction() {
  const desktopVisible = !$('#desktop-view').hidden;
  const aiVisible = !$('#ai-panel').hidden;
  // Covered controls must leave both the keyboard order and accessibility tree.
  // viewOnly also stops an already queued noVNC key from reaching WeChat.
  for (const element of document.querySelectorAll('.topbar, main.content')) element.inert = desktopVisible;
  for (const element of document.querySelectorAll('#desktop-screen, .desktop-bar, #ai-rail')) element.inert = aiVisible;
  if (rfb) rfb.viewOnly = aiVisible;
}
const loadDesktop = desktopLoader();
let assistant;
function initializeAssistant(aiAssistant) {
  assistant ??= aiAssistant({ api, downloadAnalysisReport, guard: aiRailGuard, onVisibilityChange: syncDesktopInteraction, onClose: () => { if (standaloneAI) disconnect(); },
  // 入口常驻后，入口可能先于实例挂载出现：操作开关 / 打开面板前补一次挂载，避免用空实例 id 请求。
  ensure: async () => {
    if (mobile() && !standaloneAI) return;
    const target = desktopId || state?.instances.find(item => (item.appId || 'wechat') === 'wechat')?.id || null;
    if (!target) return;
    if (assistantId === target && assistant.attached()) return;
    assistant.detach(); assistantId = target; await assistant.attach(target);
  },
  onOpenChat: async id => { if (standaloneAI || !desktopConnected || desktopId !== id) await openDesktop(id, false, false, true); } });
}
function aiBlockedHint(runtime, connected) {
  if (runtime?.status !== 'running') return '微信尚未运行，请先打开微信并完成登录，再使用 AI 辅助。';
  if (['logged-out', 'relogin-required'].includes(runtime?.loginStatus) || (runtime?.loginStatus !== 'logged-in' && runtime?.aiEntryAvailable !== true)) return '微信尚未登录，请先完成微信登录，再使用 AI 辅助。';
  if (!connected) return '请先连接微信后再使用 AI 辅助。';
  return '';
}
function aiBlockedDialog(hint) {
  dialog('暂无法使用 AI 辅助', `<p>${esc(hint)}</p>`, '<button type="button" data-close class="primary">知道了</button>');
}
function aiRailGuard() {
  if (mobile() && !standaloneAI) return false;
  const entry = state?.instances.find(item => item.id === desktopId);
  if (!entry || (entry.appId || 'wechat') !== 'wechat') return false;
  const hint = aiBlockedHint(entry.runtime, standaloneAI ? true : desktopConnected);
  if (hint) { aiBlockedDialog(hint); return false; }
  return true;
}
async function openAIEntry(id) {
  const entry = state.instances.find(item => item.id === id);
  if (!entry || (entry.appId || 'wechat') !== 'wechat') return;
  const hint = aiBlockedHint(entry.runtime, true);
  if (hint) return aiBlockedDialog(hint);
  if (mobile()) {
    const operation = ++desktopOperation; disconnect(false);
    const { aiAssistant } = await loadDesktop();
    if (operation !== desktopOperation || !session) return;
    initializeAssistant(aiAssistant); standaloneAI = true; desktopId = id;
    $('#desktop-view').classList.add('ai-only'); $('#desktop-view').hidden = false;
    $('#ai-rail').hidden = true;
    await syncAssistant(id);
    if (operation !== desktopOperation) return;
    $('#ai-account-label').textContent = '当前微信：' + entry.name;
    $('#ai-mobile-context').textContent = '实例：' + entry.name;
    $('#ai-close').setAttribute('aria-label', '返回栖盒'); $('#ai-close span').textContent = '返回栖盒';
    assistant.show(); syncDesktopInteraction(); return;
  }
  if (standaloneAI) return;
  let operation = desktopOperation;
  if (desktopId !== id || $('#desktop-view').hidden || !desktopConnected) {
    const opening = openDesktop(id, false, false, true);
    operation = desktopOperation;
    await opening;
  }
  if (operation !== desktopOperation || desktopId !== id || mobile() || $('#desktop-view').hidden) return;
  pendingAIEntry = { id, operation };
  renderDesktop();
}
let assistantId = null;
function syncAssistant(id) {
  if (mobile() && !standaloneAI) id = null;
  if (assistantId === id) return;
  assistant?.detach(); assistantId = id;
  if (id && assistant) return assistant.attach(id);
}
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.app-menu[open]')) if (!menu.contains(event.target)) menu.removeAttribute('open');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || modal.open) return;
  const menu = document.querySelector('.app-menu[open]');
  if (menu) { menu.removeAttribute('open'); menu.querySelector('summary').focus(); event.preventDefault(); }
});
function notify(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function expireHostSession(message) {
  hostSessionEpoch++;
  invalidateHostToken();
  stopMobileLoginChecks(); mobileLoginId = null;
  disconnect(); desktopId = null;
  requiredModal = false; closeModal();
  session = null; state = null;
  inputDrafts.clear(); busyIds.clear(); renderMobileAI();
  for (const selector of ['#instances', '#mobile-instance-list', '#catalog-list', '#modal-body', '#modal-actions']) $(selector).replaceChildren();
  lastInstancesMarkup = lastMobileInstancesMarkup = lastCatalogMarkup = '';
  for (const selector of ['#desktop-count', '#ai-account-label', '#ai-mobile-context', '#mobile-login-instance']) $(selector).textContent = '';
  $('#native-input').value = ''; $('#input-recovery-text').value = ''; $('#input-recovery').hidden = true;
  $('#empty-state').hidden = true; $('#mobile-instance-empty').hidden = true;
  clearTimeout(toastTimer); $('#toast').hidden = true; $('#toast').textContent = '';
  connectionNotice.show(message, true, { repeat: false });
}
async function authenticatedResponse(pending, epoch) {
  try {
    const value = await pending;
    if (epoch !== hostSessionEpoch) throw new Error('飞牛登录状态已变化，请重新打开栖盒后再操作。');
    return value;
  } catch (error) {
    if (error.code === 'HOST_SESSION_EXPIRED' && epoch === hostSessionEpoch) expireHostSession(error.message);
    throw error;
  }
}
async function api(route, data, timeout = data === undefined ? 15000 : 120000) {
  const epoch = hostSessionEpoch;
  const headers = { ...await hostHeaders(), ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' }) };
  let response;
  try { response = await fetch(`${prefix}/api${route}`, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeout) }); }
  catch (error) {
    if (error.name === 'TimeoutError') throw new Error(data === undefined ? '连接超时，将自动重连' : '连接超时，请先核对操作结果再重试');
    if (error instanceof TypeError) throw new Error(data === undefined ? '网络连接已中断，将自动重连' : '网络连接已中断，请先核对操作结果再重试');
    throw error;
  }
  if (response.status === 401) invalidateHostToken();
  return authenticatedResponse(readApiResponse(response), epoch);
}
async function downloadAnalysisReport(instanceId, value, signal) {
  const epoch = hostSessionEpoch;
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
  let response;
  try {
    response = await fetch(`${prefix}/api/instances/${instanceId}/ai/reports/export`, {
      method: 'POST', credentials: 'same-origin',
      headers: { ...await hostHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' },
      body: JSON.stringify(value), signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('导出已取消');
    if (error.name === 'TimeoutError') throw new Error('导出超时，请减少选择数量后重试');
    throw error;
  }
  if (response.status === 401) invalidateHostToken();
  await authenticatedResponse(requireDownloadResponse(response, '导出失败，请重试'), epoch);
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') || '')?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : `分析报告.${value.ids.length === 1 ? value.format : 'zip'}`;
  const blob = await response.blob();
  if (signal?.aborted) throw new Error('导出已取消');
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.hidden = true; document.body.append(link);
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return filename;
}
bindDialogFocus(modal);
modal.setAttribute('aria-labelledby', 'modal-title');
function closeModal(generation = modalGeneration) { if (requiredModal || generation !== modalGeneration) return; modalGeneration++; modal.close(); modalSubmit = null; }
let windowCloseDialogContext = null;
modal.addEventListener('close', () => {
  const context = windowCloseDialogContext; windowCloseDialogContext = null;
  if (context) void api(`/instances/${context.id}/window-close`, { requestId: context.requestId, choice: 'cancel' }).catch(() => {});
});
function showWindowClose(item) {
  const request = item?.runtime.windowCloseRequest;
  if (windowCloseDialogContext && (!request || request.id !== windowCloseDialogContext.requestId || item.id !== windowCloseDialogContext.id)) { windowCloseDialogContext = null; closeModal(); }
  if (!request || modal.open || mobile() || $('#desktop-view').hidden || standaloneAI) return;
  const id = item.id, requestId = request.id;
  dialog('关闭微信窗口', `<p>请选择关闭后的行为。关闭栖盒网页本身不会退出微信。</p><label class="choice"><input type="radio" name="choice" value="background" checked><span><strong>后台运行（最小化）</strong><small>保留当前登录和任务，可从栖盒点击“显示微信”恢复。</small></span></label><label class="choice"><input type="radio" name="choice" value="quit"><span><strong>退出微信</strong><small>停止此实例和正在进行的任务；重新使用时需要再次打开。</small></span></label><label class="check-label"><input type="checkbox" name="remember">记住此选择，可在实例菜单“关闭行为”修改</label>`, undefined, async form => {
    await api(`/instances/${id}/window-close`, { requestId, choice: form.get('choice'), remember: form.has('remember') });
    windowCloseDialogContext = null; await refresh();
  });
  windowCloseDialogContext = { id, requestId };
}
function windowCloseSettings(item) {
  const mode = item.runtime.windowCloseBehavior || 'ask';
  dialog('关闭行为', `<p>只影响微信主窗口的关闭按钮，不影响关闭网页。</p><label class="field">关闭微信窗口时<select name="mode" class="qi-input">${[['ask','每次询问'],['background','后台运行（最小化）'],['quit','退出微信']].map(([value,label])=>`<option value="${value}" ${value===mode?'selected':''}>${label}</option>`).join('')}</select></label>`, undefined, async form => { await api(`/instances/${item.id}/window-close`, { action: 'preference', mode: form.get('mode') }); await refresh(); notify('关闭行为已保存'); });
}
function dialog(title, content, actions = '<button type="button" data-close class="secondary">取消</button><button type="submit" class="primary">确定</button>', submit, required = false) {
  const generation = ++modalGeneration;
  requiredModal = required; modalSubmit = submit;
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = content; $('#modal-actions').innerHTML = actions;
  $('#modal-error').hidden = true; $('#modal-close').hidden = required;
  $('#modal-pending').hidden = true; $('#modal-form').setAttribute('aria-busy', 'false');
  if (!modal.open) modal.showModal();
  setTimeout(() => { if (modal.open && generation === modalGeneration) $('#modal-body input[type=text]')?.focus(); }, 60);
}
modal.addEventListener('cancel', event => { if (requiredModal) event.preventDefault(); else { modalGeneration++; modalSubmit = null; } });
$('#modal-close').onclick = () => closeModal();
$('#modal-form').onsubmit = async event => {
  event.preventDefault(); if (!modalSubmit || submittingModalGeneration === modalGeneration) return;
  const generation = modalGeneration, submit = modalSubmit;
  submittingModalGeneration = generation;
  const dismissal = $('#modal-actions [data-close]'), dismissalLabel = dismissal?.textContent;
  if (dismissal) dismissal.textContent = '关闭';
  $('#modal-error').hidden = true;
  $('#modal-pending').textContent = requiredModal ? '正在处理…' : '正在处理，关闭窗口后仍会继续。';
  $('#modal-pending').hidden = false; $('#modal-form').setAttribute('aria-busy', 'true');
  const button = $('#modal-actions button[type=submit]'); if (button) button.disabled = true;
  try { await submit(new FormData(event.target)); if (generation === modalGeneration && modal.open) { requiredModal = false; closeModal(generation); } }
  catch (e) { if (generation === modalGeneration && modal.open) { $('#modal-error').textContent = e.message; $('#modal-error').hidden = false; } }
  finally {
    if (submittingModalGeneration === generation) submittingModalGeneration = null;
    if (generation === modalGeneration) {
      if (button) button.disabled = false;
      if (dismissal) dismissal.textContent = dismissalLabel;
      $('#modal-pending').hidden = true; $('#modal-form').setAttribute('aria-busy', 'false');
    }
  }
};
function pcHint() {
  dialog('请用电脑端操作', '<p>微信已安装在 NAS 上。请在电脑上打开栖盒，登录并使用微信。</p>', '<button type="button" data-close class="primary">知道了</button>');
}
function stopMobileLoginChecks() {
  clearTimeout(mobileLoginCheckTimer);
  mobileLoginCheckTimer = null;
}
function checkMobileLogin(id) {
  stopMobileLoginChecks();
  if (mobileLoginId !== id) return;
  if (mobileLoginChecking) {
    mobileLoginCheckTimer = setTimeout(() => checkMobileLogin(id), 500);
    return;
  }
  mobileLoginChecking = true;
  void api(`/instances/${id}/recheck`, {}, 6000).then(runtime => {
    if (mobileLoginId !== id) return;
    const entry = state?.instances.find(item => item.id === id);
    if (!entry) return;
    entry.runtime = runtime;
    if (runtime.loginStatus === 'logged-in') {
      mobileLoginComplete(id);
      return;
    }
    render(); renderDesktop();
  }).catch(() => {
    if (mobileLoginId === id) $('#mobile-login-status').textContent = '正在等待微信确认登录…';
  }).finally(() => {
    mobileLoginChecking = false;
    if (mobileLoginId === id) mobileLoginCheckTimer = setTimeout(() => checkMobileLogin(id), 250);
  });
}
function mobileLoginComplete(id) {
  if (mobileLoginId !== id) return;
  stopMobileLoginChecks();
  mobileLoginId = null;
  disconnect();
  render();
  notify('微信登录成功');
}
async function openMobileLogin(id) {
  const entry = state.instances.find(item => item.id === id);
  if (!entry || (entry.appId || 'wechat') !== 'wechat') return;
  if (entry.runtime.loginStatus === 'logged-in') {
    dialog('请在电脑端操作', '<p>微信已登录。请在电脑上打开栖盒，继续使用微信。</p>', '<button type="button" data-close class="primary">知道了</button>');
    return;
  }
  mobileLoginId = id;
  try {
    await openDesktop(id, true, true, true);
    if (mobileLoginId === id) checkMobileLogin(id);
  }
  catch (error) {
    if (mobileLoginId === id) { mobileLoginId = null; disconnect(); }
    throw error;
  }
}
function consentDialog() {
  dialog('欢迎使用栖盒', '<p>在开始之前，请阅读我们的用户协议和隐私政策。</p><label class="check-label"><input type="checkbox" name="consent" required><span>我已阅读并同意<a href="./terms.html" target="_blank" rel="noopener">用户协议</a>与<a href="./privacy.html" target="_blank" rel="noopener">隐私政策</a></span></label>', '<button type="submit" class="primary">开始使用</button>', async form => {
    if (!form.has('consent')) throw new Error('请先阅读并勾选协议');
    await api('/consent', { accepted: true }); session.consent.accepted = true;
  }, true);
}
const definition = id => state.catalog.find(app => app.id === (id || 'wechat'));
const retainedFor = id => state.retained.filter(item => (item.appId || 'wechat') === id);
function renderMobileAI() {
  const entries = (state?.instances || []).filter(item => (item.appId || 'wechat') === 'wechat');
  const ids = new Set(entries.map(item => item.id));
  for (const id of new Set([...mobileAISettings.keys(), ...mobileAIGeneration.keys(), ...mobileAIRequests.keys(), ...mobileAIReadErrors])) if (!ids.has(id)) {
    mobileAISettings.delete(id); mobileAISettingsLoading.delete(id); mobileAIRequests.delete(id); mobileAIGeneration.delete(id); mobileAIReadErrors.delete(id);
  }
  const markup = entries.map(item => {
    const runtimeAvailable = aiAvailable(item.runtime, true), settings = mobileAISettings.get(item.id);
    if (!runtimeAvailable) mobileAIReadErrors.delete(item.id);
    const loading = mobileAISettingsLoading.has(item.id);
    const known = runtimeAvailable && settings?.available === true && typeof settings.enabled === 'boolean';
    const checked = settings?.enabled === true;
    const hint = runtimeAvailable && !loading && !known ? `<button type="button" class="quiet" data-mobile-ai-retry="${esc(item.id)}">重试读取开关</button>` : '';
    const message = !runtimeAvailable ? '微信登录后可用' : loading ? '正在读取开关…' : '暂时无法读取开关';
    const control = known ? `<input type="checkbox" role="switch" data-mobile-ai-master="${esc(item.id)}" aria-label="${esc(item.name)} AI 总开关" ${checked ? 'checked' : ''} ${loading ? 'disabled aria-busy="true"' : ''}>` : `<span class="mobile-ai-state" role="status">${message}</span>`;
    return `<article class="mobile-ai-card"><button type="button" class="mobile-ai-open" data-mobile-ai-open="${esc(item.id)}" ${runtimeAvailable ? '' : 'disabled'}>${esc(item.name)} · AI 设置</button>${control}${hint ? `<div class="mobile-ai-status">${hint}</div>` : ''}</article>`;
  }).join('');
  if (markup !== lastMobileAIMarkup) { $('#mobile-ai-list').innerHTML = markup; lastMobileAIMarkup = markup; }
  $('#mobile-ai').hidden = !entries.length;
  if (mobile()) for (const item of entries) {
    const settings = mobileAISettings.get(item.id);
    if (aiAvailable(item.runtime, true) && !mobileAIReadErrors.has(item.id) && !mobileAISettingsLoading.has(item.id) && (!settings || document.visibilityState === 'visible' && Date.now() - settings.lastReadAt >= 5000)) void loadMobileAISettings(item.id);
  }
}
async function loadMobileAISettings(id) {
  if (!state?.instances.some(item => item.id === id) || document.visibilityState !== 'visible' || mobileAISettingsLoading.has(id)) return;
  mobileAIReadErrors.delete(id);
  mobileAISettingsLoading.add(id); const generation = mobileAIGeneration.get(id) || 0, requestId = Symbol(); mobileAIGeneration.set(id, generation); renderMobileAI();
  mobileAIRequests.set(id, requestId);
  try {
    const settings = await api(`/instances/${id}/ai/master`);
    if (mobileAIGeneration.get(id) === generation && mobileAIRequests.get(id) === requestId && state?.instances.some(item => item.id === id)) mobileAISettings.set(id, { ...settings, lastReadAt: Date.now() });
  } catch (error) {
    if (mobileAIGeneration.get(id) === generation && mobileAIRequests.get(id) === requestId && state?.instances.some(item => item.id === id)) { mobileAISettings.delete(id); mobileAIReadErrors.add(id); if (!['AI_SCOPE_CHANGED', 'AI_ACCOUNT_UNVERIFIED'].includes(error.code)) notify(`无法读取 AI 开关：${error.message}`); }
  } finally { if (mobileAIRequests.get(id) === requestId) { mobileAIRequests.delete(id); mobileAISettingsLoading.delete(id); renderMobileAI(); } }
}
async function changeMobileAIMaster(input) {
  const id = input.dataset.mobileAiMaster;
  const before = mobileAISettings.get(id);
  if (!before?.available || mobileAISettingsLoading.has(id)) { input.checked = before?.enabled === true; return; }
  const enabled = input.checked;
  mobileAISettingsLoading.add(id); const generation = mobileAIGeneration.get(id) || 0; renderMobileAI();
  try {
    await api(`/instances/${id}/ai`, { action: 'mobile-master', value: { enabled, scopeToken: before.scopeToken, settingsToken: before.settingsToken } });
    if (mobileAIGeneration.get(id) === generation) { mobileAISettings.delete(id); mobileAISettingsLoading.delete(id); await loadMobileAISettings(id); const confirmed = mobileAISettings.get(id); if (confirmed?.enabled === enabled) notify(enabled ? 'AI 总开关已开启' : 'AI 总开关已关闭'); }
  } catch (error) {
    if (mobileAIGeneration.get(id) === generation) { mobileAISettings.delete(id); notify(error.message); }
  } finally { mobileAISettingsLoading.delete(id); renderMobileAI(); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderMobileAI(); });
window.addEventListener('focus', () => renderMobileAI());
window.addEventListener('online', () => { for (const id of mobileAISettings.keys()) mobileAISettings.delete(id); mobileAIReadErrors.clear(); renderMobileAI(); });
let marketAppId = 'wechat', lastCatalogMarkup = '';
let libraryUpdatePreview = null;
function renderMarket(app) {
  const card = document.querySelector(`[data-market-app="${app.id}"]`);
  const part = name => card.querySelector(`[data-part="${name}"]`);
  const installed = app.library.installed, job = app.library.job, manualUpdate = app.library.manualUpdate;
  const jobPending = job && !['complete', 'error'].includes(job.status);
  const manualBusy = manualUpdate && ['downloading', 'verifying', 'installing'].includes(manualUpdate.status);
  const pending = jobPending || manualBusy;
  const actions = part('actions');
  part('format').hidden = !!installed;
    const id = value => app.id === 'wechat' ? `id="${value}"` : '';
  const signature = `${!!installed}/${!!pending}/${!!session?.user.isAdmin}/${manualUpdate?.status || ''}`;
  if (actions.dataset.state !== signature) {
    actions.dataset.state = signature;
    actions.innerHTML = installed
      ? `<button ${id('add-instance')} data-market-action="add" class="primary" ${pending ? 'disabled' : ''}>添加微信</button>${app.id === 'wechat' && session.user.isAdmin ? `<button data-market-action="update" class="secondary" ${manualBusy || jobPending ? 'disabled' : ''}>${manualUpdate?.status === 'paused' ? '继续更新' : manualUpdate?.status === 'error' ? '重试更新' : '手动更新'}</button>` : ''}`
      : `<button ${id('download')} data-market-action="download" class="primary" ${pending ? 'disabled' : ''}>下载安装${esc(app.name)}</button><button ${id('import-open')} data-market-action="import" class="quiet" ${pending ? 'disabled' : ''}>导入安装包</button>`;
  }
  part('status').textContent = manualUpdate && !['complete'].includes(manualUpdate.status) ? manualUpdate.message
    : pending ? job.message
    : installed ? `已安装 · ${installed.version}`
      : app.edition;
  part('retained').hidden = !retainedFor(app.id).length;
  part('uninstall').hidden = app.id !== 'wechat' || !installed || !session.user.isAdmin;
  part('uninstall').disabled = !!pending;
  part('menu').hidden = part('retained').hidden && part('uninstall').hidden;
  part('menu-separator').hidden = part('retained').hidden || part('uninstall').hidden;
  const visibleJob = manualUpdate && manualUpdate.status !== 'complete' ? manualUpdate : job;
  part('progress').hidden = !visibleJob || visibleJob.status === 'complete';
  if (visibleJob) {
    part('message').textContent = visibleJob.message;
    part('percent').textContent = visibleJob.progress != null ? `${visibleJob.progress}%` : '';
    part('bar').hidden = visibleJob.status === 'error';
    if (visibleJob.progress == null) part('bar').removeAttribute('value'); else part('bar').value = visibleJob.progress;
    const size = value => value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${Math.round(value)} B`;
    const transferred = visibleJob.bytes != null ? visibleJob.total ? `${size(visibleJob.bytes)} / ${size(visibleJob.total)}` : `已处理 ${size(visibleJob.bytes)}` : '';
    const speed = visibleJob.bytesPerSecond != null ? `${size(visibleJob.bytesPerSecond)}/s` : '';
    part('detail').textContent = [transferred, speed].filter(Boolean).join(' · ');
    let controls = card.querySelector('[data-download-controls]');
    if (!controls) { controls = document.createElement('div'); controls.dataset.downloadControls = ''; part('progress').append(controls); }
    const mark = manualUpdate ? (manualUpdate.status === 'downloading' ? '<button type="button" class="secondary" data-update-command="pause">暂停更新</button>' : manualUpdate.status === 'paused' ? '<button type="button" class="primary" data-update-command="resume">继续更新</button>' : '') : (job.status === 'downloading' ? '<button type="button" class="secondary" data-download-command="pause">暂停下载</button>' : ['paused', 'error'].includes(job.status) ? '<button type="button" class="primary" data-download-command="continue">'+(job.status === 'paused' ? '继续下载' : '重试下载')+'</button>' : '');
    if (controls.innerHTML !== mark) controls.innerHTML = mark;
  }
}
async function unsupportedVersion(error) { throw error; }
function render() {
  if (!state) return;
  const catalogMarkup = state.catalog.map(app => {
    const part = (name, legacy) => `data-part="${name}"${app.id === 'wechat' && legacy ? ` id="${legacy}"` : ''}`;
    return `<article class="store-card" data-market-app="${esc(app.id)}"><div class="store-card-main"><span class="wechat-icon" aria-hidden="true">${appIcon(app.icon)}</span><div><h3>${esc(app.name)}</h3><p ${part('status', 'package-status')}></p></div><details class="app-menu market-menu pc-only" data-part="menu" hidden><summary aria-label="${esc(app.name)}更多操作"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="19" cy="12" r="1.75"/></svg></summary><div><button ${part('retained', 'retained-open')} data-market-action="retained" class="quiet" hidden>保留的数据</button><hr data-part="menu-separator" hidden><button ${part('uninstall', 'uninstall')} data-market-action="uninstall" class="quiet danger-link" hidden>卸载${esc(app.name)}</button></div></details></div><p class="app-description">${esc(app.description)}</p><div ${part('actions', 'install-actions')} class="install-actions"></div><p ${part('format', 'install-format')} class="install-format">手动安装请选择 <strong>${esc(app.architecture)}</strong> 版 <strong>${esc(app.packageFormat)}</strong> 安装包。<a href="${esc(app.website)}" target="_blank" rel="noopener">${esc(app.name)}官网 ↗</a></p><div ${part('progress', 'install-progress')} class="install-progress" hidden><div><strong ${part('message', 'job-message')}></strong><span ${part('percent', 'job-percent')}></span></div><progress ${part('bar', 'job-progress')} max="100" aria-label="${esc(app.name)}安装进度"></progress><p ${part('detail', 'job-detail')}></p></div></article>`;
  }).join('');
  if (lastCatalogMarkup !== catalogMarkup) { $('#catalog-list').innerHTML = catalogMarkup; lastCatalogMarkup = catalogMarkup; }
  state.catalog.forEach(renderMarket);
  $('#empty-state').hidden = state.instances.length > 0;
  $('#desktop-count').textContent = state.instances.length ? `${state.instances.length} 个应用` : '';
  const modes = { manual: '手动启动', continuous: '持续备份', idle: '闲时备份' };
  const markup = state.instances.map(item => {
    const app = definition(item.appId), installed = app?.library.installed;
    const pending = app?.library.job && !['complete', 'error'].includes(app.library.job.status);
    const busy = !!pending || busyIds.has(item.id) || item.busy || ['preparing', 'starting', 'stopping'].includes(item.runtime.status);
    return `<article class="instance-card" data-instance="${esc(item.id)}" data-app-id="${esc(item.appId || 'wechat')}"><button class="desktop-icon" data-action="open" aria-label="打开${esc(item.name)}" title="${esc(modes[item.schedule.mode] || '')}${item.schedule.paused ? ' · 已暂停' : ''}" ${busy || !installed ? 'disabled' : ''}><span class="wechat-icon" aria-hidden="true">${appIcon(app?.icon)}</span><h3 title="${esc(item.name)}">${esc(item.name)}</h3><span class="status ${item.runtime.status === 'running' && item.runtime.loginStatus === 'logged-in' ? 'logged-in' : 'logged-out'}">${busy ? '请稍候…' : installed ? (app?.id === 'wechat' ? loginLabel(item.runtime) : item.runtime.status === 'running' ? '运行中' : item.runtime.status === 'error' ? '启动失败' : '已停止') : '待重新安装'}</span></button><details class="app-menu"><summary aria-label="${esc(item.name)}的更多操作">•••</summary><div>${app?.capabilities.includes('startup-settings') ? `<button data-action="settings" ${busy || !installed ? 'disabled' : ''}>启动设置</button>` : ''}${(item.appId || 'wechat') === 'wechat' ? '<button data-action="ai">AI 辅助</button><button data-action="window-close-settings">关闭行为</button>' : ''}${item.runtime.loginCheckTimedOut ? '<button data-action="recheck">重新检测</button>' : ''}<button data-action="rename">重命名</button>${item.runtime.status === 'running' ? `<button data-action="stop" ${busy ? 'disabled' : ''}>停止</button>` : ''}<button class="danger-link" data-action="delete">删除</button></div></details></article>`;
  }).join('');
  if (lastInstancesMarkup !== markup) {
    const opened = [...document.querySelectorAll('#instances .app-menu[open]')].map(menu => menu.closest('[data-instance]').dataset.instance);
    const focused = document.activeElement, focusId = focused?.closest('[data-instance]')?.dataset.instance;
    const focusAction = focused?.dataset.action || (focused?.tagName === 'SUMMARY' ? 'menu' : null);
    $('#instances').innerHTML = markup; lastInstancesMarkup = markup;
    for (const id of opened) document.querySelector(`[data-instance="${id}"] .app-menu`)?.setAttribute('open', '');
    if (focusId && focusAction) document.querySelector(`[data-instance="${focusId}"] ${focusAction === 'menu' ? 'summary' : `[data-action="${focusAction}"]`}`)?.focus({ preventScroll: true });
  }
  updateIdleChoice();
  const mobileEntries = state.instances.filter(item => (item.appId || 'wechat') === 'wechat');
  const mobileMarkup = mobileEntries.map(item => {
    const busy = busyIds.has(item.id) || item.busy || ['preparing', 'starting', 'stopping'].includes(item.runtime.status);
    const loggedIn = item.runtime.status === 'running' && item.runtime.loginStatus === 'logged-in';
    const status = item.runtime.status === 'running' ? loginLabel(item.runtime) : item.runtime.status === 'error' ? '启动失败' : '已停止';
    return `<article class="mobile-instance-card" data-mobile-instance="${esc(item.id)}"><div class="mobile-instance-info"><strong>${esc(item.name)}</strong><span class="status ${loggedIn ? 'logged-in' : ''}">${busy ? '请稍候…' : status}</span></div><div class="mobile-instance-actions">${loggedIn ? `<button type="button" class="secondary" data-mobile-stop="${esc(item.id)}" ${busy ? 'disabled' : ''}>停止</button>` : `<button type="button" class="primary" data-mobile-login="${esc(item.id)}" ${busy || !definition(item.appId)?.library.installed ? 'disabled' : ''}>登录</button>`}<details class="app-menu mobile-instance-menu"><summary aria-label="${esc(item.name)}的更多操作">•••</summary><div><button type="button" data-action="rename" ${busy ? 'disabled' : ''}>重命名</button><button type="button" class="danger-link" data-action="delete" ${busy ? 'disabled' : ''}>删除</button></div></details></div></article>`;
  }).join('');
  if (lastMobileInstancesMarkup !== mobileMarkup) {
    const opened = [...document.querySelectorAll('#mobile-instance-list .app-menu[open]')].map(menu => menu.closest('[data-mobile-instance]').dataset.mobileInstance);
    const focused = document.activeElement, focusId = focused?.closest('[data-mobile-instance]')?.dataset.mobileInstance;
    const focusAction = focused?.dataset.action || (focused?.tagName === 'SUMMARY' ? 'menu' : focused?.dataset.mobileStop ? 'stop' : focused?.dataset.mobileLogin ? 'login' : null);
    $('#mobile-instance-list').innerHTML = mobileMarkup; lastMobileInstancesMarkup = mobileMarkup;
    for (const id of opened) document.querySelector(`[data-mobile-instance="${id}"] .app-menu`)?.setAttribute('open', '');
    if (focusId && focusAction) document.querySelector(`[data-mobile-instance="${focusId}"] ${focusAction === 'menu' ? 'summary' : ['stop', 'login'].includes(focusAction) ? `[data-mobile-${focusAction}]` : `[data-action="${focusAction}"]`}`)?.focus({ preventScroll: true });
  }
  $('#mobile-instance-empty').hidden = mobileEntries.length > 0;
  renderMobileAI();
}
function renderDesktop() {
  syncDesktopInteraction();
  if ($('#desktop-view').hidden) return;
  const entry = state?.instances.find(item => item.id === desktopId);
  const runtime = entry?.runtime;
  const mobileLogin = mobile() && mobileLoginId === desktopId;
  if (mobileLogin) {
    $('#mobile-login-instance').textContent = entry?.name || '微信实例';
    $('#mobile-login-status').textContent = desktopBusy || desktopConnecting ? '正在连接微信登录画面…'
      : runtime?.status === 'error' ? '微信登录未完成，请返回实例列表后重试。'
        : runtime?.status !== 'running' ? '正在启动微信…'
        : runtime.loginStatus === 'logged-in' ? '已检测到微信登录，正在完成确认…'
          : ['logged-out', 'relogin-required'].includes(runtime.loginStatus) ? '微信登录画面已显示，请按画面提示完成登录。'
            : '正在检测微信登录状态…';
  }
  if (standaloneAI) { if (!aiAvailable(runtime, true)) { disconnect(); notify('请先登录微信'); } return; }
  // 登录确认且桌面已连接时显示入口；短暂未知状态沿用 aiEntryAvailable。
  const wechatEntry = !!(entry && (entry.appId || 'wechat') === 'wechat');
  const showAI = !mobile() && aiAvailable(runtime, desktopConnected);
  $('#ai-rail').hidden = !showAI;
  syncAssistant(showAI && wechatEntry ? desktopId : null);
  if (showAI && pendingAIEntry?.id === desktopId && pendingAIEntry.operation === desktopOperation && !$('#desktop-view').hidden) {
    pendingAIEntry = null;
    assistant.show();
  }
  const action = desktopAction(runtime, desktopConnected);
  $('#desktop-reconnect').hidden = !action;
  $('#desktop-reconnect').textContent = action?.label || '显示微信';
  $('#desktop-reconnect').disabled = desktopBusy || desktopConnecting;
  const waiting = desktopBusy && !desktopConnected || desktopConnecting;
  const offline = !desktopConnected || runtime?.status !== 'running';
  // Derive both directions on every render; a previous offline response must
  // never leave this full-screen layer intercepting input after recovery.
  $('#desktop-status').hidden = !waiting && !offline && runtime?.windowVisible !== false;
  $('#desktop-status').textContent = desktopStatus(runtime, desktopConnected, waiting);
  if (wechatEntry) showWindowClose(entry);
}
async function refresh() {
  if (polling) return true; polling = true;
  try {
    state = await api('/state'); render(); renderDesktop(); connectionNotice.show('');
    if (mobileLoginId && state.instances.find(item => item.id === mobileLoginId)?.runtime.loginStatus === 'logged-in') mobileLoginComplete(mobileLoginId);
    return true;
  }
  catch (e) { connectionNotice.show(e.message, true, { repeat: false }); return false; }
  finally { polling = false; }
}
function centerMobileLoginViewport(client) {
  const display = client?._display;
  if (!display?.viewportChangeSize || !display?.viewportChangePos) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const bounds = $('#desktop-screen').getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width)), height = Math.max(1, Math.floor(bounds.height));
    display.viewportChangeSize(width, height);
    const viewport = display._viewportLoc;
    if (!viewport) return;
    const x = Math.max(0, Math.floor((display.width - viewport.w) / 2));
    const y = Math.max(0, Math.floor((display.height - viewport.h) / 2));
    display.viewportChangePos(x - viewport.x, y - viewport.y);
  }));
}
function nameTaken(name, exceptId) {
  return [...state.instances, ...state.retained].some(item => item.id !== exceptId && item.name.trim() === name.trim());
}
function checkedName(name, exceptId) {
  name = name.trim();
  if (!name || [...name].length > 30 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('请输入 1–30 个字的名称');
  if (nameTaken(name, exceptId)) throw new Error('名称已存在，请修改名称');
  return name;
}
function newInstance(fresh = false, appId = marketAppId) {
  if (!fresh && retainedFor(appId).length) return retainedDialog(true);
  const app = definition(appId);
  let name = app.name, suffix = 2;
  while (nameTaken(name)) name = `${app.name} ${suffix++}`;
  dialog(`添加${app.name}`, `<label class="field">名称<input type="text" name="name" value="${esc(name)}" maxlength="60" required></label><p>名称可填写 1–30 个字。</p>`, undefined, async form => {
    await api('/instances', { appId, name: checkedName(form.get('name')) });
    await refresh();
    notify(mobile() && appId === 'wechat' ? '实例已添加，请从列表中点击“登录”' : '已添加到桌面');
  });
}
function settings(item) {
  dialog('启动设置', `<p>${esc(item.name)}</p>
    <label class="choice"><input type="radio" name="mode" value="manual" ${item.schedule.mode === 'manual' ? 'checked' : ''}><span><strong>手动启动</strong><small>需要时打开。</small></span></label>
    <label class="choice"><input type="radio" name="mode" value="continuous" ${item.schedule.mode === 'continuous' ? 'checked' : ''}><span><strong>在线实时同步</strong><small>运行官方微信，在线期间持续接收并保存可获取的消息。与电脑登录同一微信冲突，适合主要使用手机时开启。</small></span></label>
    <label id="idle-choice" class="choice"><input id="idle-mode" data-instance-id="${esc(item.id)}" type="radio" name="mode" value="idle" ${item.schedule.mode === 'idle' ? 'checked' : ''}><span><strong>闲时备份</strong><small>按时段低优先级运行；检测到网络、负载繁忙或可用内存不足时退让，恢复空闲后继续。</small></span></label>
    <p class="field-help">因微信限制，前期使用需扫码登录。后续在微信勾选“自动登录该设备”后，才能在定时重启后自动登录；栖盒会自动点击启动页的“登录”按钮。</p>
    <div id="idle-window" class="time-fields" ${item.schedule.mode === 'idle' ? '' : 'hidden'}><label>开始时间<input type="time" name="startTime" value="${esc(item.schedule.startTime)}" required></label><label>结束时间<input type="time" name="endTime" value="${esc(item.schedule.endTime)}" required></label><small>支持跨夜时段。</small><label>负载上限（%）<input type="number" name="loadPercent" min="10" max="100" value="${item.schedule.resourceLimits?.loadPercent ?? 70}" required></label><label>网络繁忙阈值（MB/s）<input type="number" name="networkMBps" min="0.1" max="10000" step="0.1" value="${item.schedule.resourceLimits?.networkMBps ?? 2}" required></label><label>最低可用内存（MB）<input type="number" name="freeMemoryMB" min="128" max="1048576" value="${item.schedule.resourceLimits?.freeMemoryMB ?? 512}" required></label><p class="field-help">按整机一分钟负载、总网络吞吐和可用内存检测；仅调度本计划启动的微信，不区分上传来源，不能保证零影响。${esc(item.schedule.resourceState?.reason || '')}</p></div>
    <p class="field-help">关闭页面后微信继续运行；主动停止后，需再次打开或保存设置。</p>`, `${item.schedule.mode === 'idle' ? `<button type="button" class="secondary" data-idle-command="${item.schedule.paused ? 'resume-idle' : 'pause-idle'}" data-instance-id="${esc(item.id)}">${item.schedule.paused ? '恢复闲时备份' : '暂停闲时备份'}</button>` : ''}<button type="button" data-close class="secondary">取消</button><button type="submit" class="primary">保存设置</button>`, async form => {
      await api(`/instances/${item.id}/settings`, { mode: form.get('mode'), startTime: form.get('startTime'), endTime: form.get('endTime'), resourceLimits: Object.fromEntries(['loadPercent','networkMBps','freeMemoryMB'].map(key=>[key,Number(form.get(key))])) });
      await refresh(); notify('启动设置已保存');
    });
  updateIdleChoice();
}
function updateIdleChoice() {
  if (!modal.open || !$('#idle-mode')) return;
  $('#idle-window').hidden = !$('#idle-mode').checked;
}
function uninstallDialog() {
  dialog('卸载微信', '<p>卸载共享微信程序，并停止正在运行的微信实例。删除单个实例请在实例菜单操作。</p><label class="choice"><input type="radio" name="deleteData" value="no" checked><span><strong>保留数据</strong><small>重新安装后可继续使用。</small></span></label><label class="choice"><input type="radio" name="deleteData" value="yes"><span><strong>同时清除我的微信数据</strong><small>仅清除我名下的微信实例及保留数据，不清理其他用户的数据，删除后无法恢复。</small></span></label><label id="delete-confirm" class="field" hidden>请输入：<strong>确认删除微信</strong><input type="text" name="confirmName" autocomplete="off" placeholder="确认删除微信"></label>', '<button type="button" data-close class="secondary">取消</button><button type="submit" class="danger">卸载</button>', async form => {
    await api(`/apps/${marketAppId}/install/uninstall`, { deleteData: form.get('deleteData') === 'yes', confirmName: form.get('confirmName') }); disconnect(); await refresh(); notify('微信已卸载');
  });
  $('#modal-actions [data-close]').focus();
}
function removeInstance(item, retained = false) {
  dialog(retained ? '删除保留的数据' : '删除应用', `<p>确定删除应用：<strong>${esc(item.name)}</strong>？</p>${!retained ? '<label class="choice"><input type="radio" name="deleteData" value="no" checked><span><strong>保留数据</strong><small>从保留数据恢复后，登录原微信继续使用。</small></span></label><label class="choice"><input type="radio" name="deleteData" value="yes"><span><strong>同时删除数据</strong><small>删除这个应用的登录状态和聊天数据，无法恢复。</small></span></label>' : '<p>这会永久删除该应用的登录状态和聊天数据。</p><input type="hidden" name="deleteData" value="yes">'}<label id="delete-confirm" class="field" ${retained ? '' : 'hidden'}>请输入：<strong>确认删除${esc(item.name)}</strong><input type="text" name="confirmName" autocomplete="off" placeholder="确认删除${esc(item.name)}"></label>`, '<button type="button" data-close class="secondary">取消</button><button type="submit" class="danger">删除</button>', async form => {
    await api(`/instances/${item.id}/delete`, { deleteData: form.get('deleteData') === 'yes', confirmName: form.get('confirmName') }); await refresh(); notify('已删除');
  });
}
function retainedDialog(adding = false) {
  const entries = retainedFor(marketAppId).map(x => `<div class="retained-row"><strong>${esc(x.name)}</strong><div><button type="button" class="quiet" data-restore="${x.id}" ${definition(marketAppId).library.installed && !definition(marketAppId).library.job?.status?.includes('uninstall') ? '' : 'disabled'}>恢复使用</button><button type="button" class="quiet danger-link" data-purge="${x.id}">删除数据</button></div></div>`).join('');
  dialog('保留的数据', `<p>${state.library.installed ? '选择原来的应用，恢复后登录原微信。' : '请先安装微信，再恢复保留的数据。'}</p>${entries || '<p>暂无保留的数据。</p>'}`, `${adding ? '<button type="button" id="create-fresh" class="quiet">新建微信</button>' : ''}<button type="button" data-close class="secondary">关闭</button>`);
}
function restoreNameDialog(item) {
  dialog('修改名称后恢复', `<p>名称已存在，请修改名称。</p><label class="field">名称<input type="text" name="name" value="${esc(item.name)}" maxlength="60" required></label><p>名称可填写 1–30 个字。</p>`, '<button type="button" data-close class="secondary">取消</button><button type="submit" class="primary">恢复使用</button>', async form => {
    await api(`/instances/${item.id}/restore`, { name: checkedName(form.get('name'), item.id) });
    await refresh(); notify('已恢复，请打开并登录原微信');
  });
}
async function restoreInstance(item, button) {
  if (!item) throw new Error('未找到保留的数据，请刷新页面');
  if (nameTaken(item.name, item.id)) return restoreNameDialog(item);
  button.disabled = true;
  const generation = modalGeneration;
  try {
    await api(`/instances/${item.id}/restore`, {}); closeModal(generation); await refresh(); notify('已恢复，请打开并登录原微信');
  } catch (error) {
    // Another page can reserve the name after the local check. Keep the data
    // retained and let the user resolve the server-confirmed conflict here.
    if (error.code !== 'NAME_CONFLICT') throw error;
    await refresh(); if (generation === modalGeneration && modal.open) restoreNameDialog(item);
  } finally { button.disabled = false; }
}
function importDialog() {
  dialog('导入微信安装包', `<p>选择从官网下载的 ${esc(definition(marketAppId).architecture)} 版微信 .deb 安装包。安装后按实际能力检测，版本号仅用于诊断。</p><div class="import-options"><button type="button" id="import-local" class="secondary"><strong>从本机上传</strong><span>选择这台设备上的安装包</span></button>${session.capabilities?.nasPicker ? '<button type="button" id="import-nas" class="secondary"><strong>从 NAS 选择</strong><span>选择已经保存到 NAS 的安装包</span></button>' : ''}</div>`, '');
}
async function uploadLibraryUpdate(file, updateToken) {
  if (!file || !file.name.toLowerCase().endsWith('.deb')) throw new Error('请选择微信 .deb 安装包');
  if (file.size > 1024 ** 3) throw new Error('请选择 1 GB 以内的安装包');
  const authentication = await hostHeaders();
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${prefix}/api/wechat-update/upload`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-CSRF-Token', session.csrf);
    request.setRequestHeader('X-Wechat-Update-Token', updateToken);
    for (const [name, value] of Object.entries(authentication)) request.setRequestHeader(name, value);
    request.timeout = 20 * 60 * 1000;
    request.onload = () => { try { const result = JSON.parse(request.responseText || '{}'); if (request.status >= 400 || result.status === 'error') throw new Error(result.error || result.message || '更新包上传失败'); resolve(result); } catch (error) { reject(error); } };
    request.onerror = request.ontimeout = () => reject(new Error('上传中断，请检查网络后重试'));
    request.send(file);
  });
}
const sourceError = preview => preview?.sourceError ? `官方版本暂不可用：${preview.sourceError}，可导入已有安装包` : '';
async function openLibraryUpdate() {
  const preview = await api('/wechat-update', { action: 'preview' });
  libraryUpdatePreview = preview;
  const resume = state?.catalog?.find(app => app.id === 'wechat')?.library?.manualUpdate?.status === 'paused';
  const affected = (preview.affected || []).map(item => `<li><strong>${esc(item.name)}</strong><span>${item.running ? '运行中，更新时会停止' : '已停止'}</span></li>`).join('');
  const source = preview.source || {};
  const sourceText = sourceError(preview) || (source.size ? `官方包约 ${Math.round(source.size / 1024 / 1024)} MB` : '从官方渠道获取可用版本');
  dialog('手动更新微信', `<p>当前版本：<strong>${esc(preview.current?.version || preview.current || definition('wechat')?.library?.installed?.version || '未知')}</strong></p>${affected ? `<section class="update-impact"><h4>将受影响的微信实例</h4><ul>${affected}</ul><p>更新期间实例会暂时停止，完成后请手动重新打开；已有数据会保留。版本回退需要完整数据备份。</p></section>` : '<p>暂未发现会受影响的微信实例。</p>'}<fieldset class="update-source"><legend>选择更新来源</legend><label class="choice"><input type="radio" name="source" value="official" checked ${source.url ? '' : 'disabled'}><span><strong>官方下载</strong><small>${esc(sourceText)}</small></span></label><label class="choice"><input type="radio" name="source" value="upload"><span><strong>导入 .deb 安装包</strong><small>选择与 NAS 架构匹配的官方微信安装包</small></span></label><label class="field" id="library-update-file-field" hidden>安装包<input type="file" name="package" accept=".deb"></label><label class="choice"><input type="checkbox" name="confirmImpact" required><span><strong>我确认更新会暂时影响上述实例</strong></span></label></fieldset>`, '<button type="button" data-close class="secondary">取消</button><button type="submit" class="primary">确认并开始更新</button>', async form => {
    const source = form.get('source');
    if (source === 'upload') await uploadLibraryUpdate(form.get('package'), preview.token);
    else await api('/wechat-update', { action: resume ? 'resume' : 'download', token: preview.token });
    await refresh(); notify('微信更新已开始');
  });
}
let pickerPromise;
async function loadPicker() {
  const { nasPicker } = await import('./nas-picker.mjs');
  return nasPicker({ notify, receive: async (purpose, file, context) => {
    if (purpose === 'chat' || purpose === 'chat-export') {
      if (context.instance !== desktopId || !fileBridge) throw new Error('文件选择已结束，请重新打开微信选择');
      return purpose === 'chat-export' ? fileBridge.selectExportNas(file, context) : fileBridge.selectNas(file, context);
    }
    await api(`/apps/${marketAppId}/install/nas`, { path: file }); await refresh();
  } });
}
const getPicker = () => pickerPromise ??= loadPicker();
const picker = {
  refresh: async (...args) => host === 'fnos' && (await getPicker()).refresh(...args),
  pick: async (...args) => host === 'fnos' && (await getPicker()).pick(...args),
  openFolder: async (...args) => host === 'fnos' && (await getPicker()).openFolder(...args),
};
async function upload(file) {
  if (!file || !file.name.toLowerCase().endsWith('.deb')) throw new Error('请选择微信 .deb 安装包');
  if (file.size > 1024 ** 3) throw new Error('请选择 1 GB 以内的安装包');
  closeModal();
  const authentication = await hostHeaders();
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('POST', `${prefix}/api/apps/${marketAppId}/install/upload`);
    request.setRequestHeader('Content-Type', 'application/octet-stream'); request.setRequestHeader('X-CSRF-Token', session.csrf);
    for (const [name, value] of Object.entries(authentication)) request.setRequestHeader(name, value);
    request.timeout = 20 * 60 * 1000;
    request.onload = () => { try { const result = JSON.parse(request.responseText); if (request.status >= 400) throw new Error(result.error); if (result.job?.status === 'error') throw new Error(result.job.message); resolve(result); } catch (e) { reject(e); } };
    request.onerror = request.ontimeout = () => reject(new Error('上传中断，请检查网络后重试'));
    request.send(file);
  });
  await refresh(); notify('微信已安装');
}
function disconnect(invalidate = true, keepAssistant = false, recovering = false) {
  pendingAIEntry = null;
  if (!recovering) reconnect.stop();
  sound?.dispose(); sound = null;
  if (!keepAssistant) syncAssistant(null);
  standaloneAI = false; $('#desktop-view').classList.remove('ai-only', 'mobile-login-view');
  if (invalidate) { desktopOperation++; desktopBusy = false; }
  desktopConnected = false; desktopConnecting = false; clearTimeout(connectionTimer);
  remoteGeneration++; pointer?.dispose(); pointer = null; fileBridge?.dispose(); fileBridge = null; ime?.dispose(); ime = null; rfb?.disconnect(); rfb = null;
  $('#remote-canvas').replaceChildren(); $('#desktop-view').hidden = true;
  syncDesktopInteraction();
  if (document.fullscreenElement === $('#desktop-view')) void document.exitFullscreen().catch(() => {});
}
async function openDesktop(id, start = true, login = false, allowMobile = false, recovering = false) {
  if (mobile() && !allowMobile) return pcHint();
  const operation = ++desktopOperation;
  disconnect(false, recovering, recovering); desktopId = id; desktopBusy = true; busyIds.add(id);
  const mobileLogin = mobile() && mobileLoginId === id;
  $('#desktop-view').classList.toggle('mobile-login-view', mobileLogin);
  $('#mobile-login-instance').textContent = state.instances.find(x => x.id === id)?.name || '微信实例';
  $('#mobile-login-help').textContent = '请按下方微信画面的提示登录；需要扫码时，请用另一台设备扫码。';
  const entry = state.instances.find(x => x.id === id), app = definition(entry?.appId);
  const isWechat = app?.id === 'wechat';
  sound?.dispose();
  if (isWechat) sound = desktopAudio({ surface: $('#desktop-screen'), endpoint: `${prefix}/api/instances/${id}/audio`,
    headers: async () => ({ ...await hostHeaders(), 'X-CSRF-Token': session.csrf }), notify });
  $('#ai-account-label').textContent = '当前微信：' + (entry?.name || '微信');
  $('#ai-mobile-context').textContent = '实例：' + (entry?.name || '微信');
  $('#desktop-name').textContent = state.instances.find(x => x.id === id)?.name || '微信';
  $('#desktop-view').hidden = false; render(); renderDesktop();
  try {
    const { RFB, aiAssistant } = await loadDesktop();
    if (operation !== desktopOperation || !session) return;
    initializeAssistant(aiAssistant);
    if (start) await api(`/instances/${id}/start`, {});
    if (operation !== desktopOperation) return;
    if (app?.adapter === 'docker') {
      const frame = document.createElement('iframe'); frame.title = entry.name; frame.setAttribute('sandbox', '');
      frame.src = `${prefix}/applications/${id}/`; frame.style.cssText = 'border:0;width:100%;height:100%;background:white';
      $('#remote-canvas').replaceChildren(frame); desktopConnected = true; desktopBusy = false; renderDesktop(); return;
    }
    if (login) await api(`/instances/${id}/login`, {});
    if (operation !== desktopOperation) return;
    if (mobile() && !allowMobile) return pcHint();
    const connection = await api(`/instances/${id}/desktop`, {});
    if (operation !== desktopOperation) return;
    const generation = remoteGeneration;
    desktopConnecting = true; renderDesktop();
    const url = new URL(connection.path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const client = rfb = new RFB($('#remote-canvas'), url.href, { credentials: { password: connection.password } });
    syncDesktopInteraction();
    const mobileLoginView = mobile() && mobileLoginId === id;
    client.scaleViewport = !mobileLoginView; client.clipViewport = mobileLoginView;
    client.resizeSession = false; client.background = '#eaf0ec';
    client.dragViewport = mobileLoginView;
    client.focusOnClick = false; client.showDotCursor = false;
    connectionTimer = setTimeout(() => { if (generation === remoteGeneration && desktopConnecting) { client.disconnect(); notify('连接超时，请点击连接微信重试'); } }, 20000);
    client.addEventListener('connect', () => {
      if (generation !== remoteGeneration) return;
      clearTimeout(connectionTimer); desktopConnecting = false; desktopConnected = true; renderDesktop();
      if (mobileLoginView) centerMobileLoginViewport(client);
      reconnect.connected();
      pointer = desktopPointer($('#remote-canvas canvas'));
      ime = nativeInput({ input: $('#native-input'), screen: $('#desktop-screen'), client, mac: /Mac/.test(navigator.platform), paste: text => api(`/instances/${id}/clipboard`, { text, paste: true }, 15000), pasteFiles: async files => api(`/instances/${id}/clipboard`, { files: await clipboardFiles(files) }, 30000), notify,
        connected: () => generation === remoteGeneration && desktopConnected && $('#ai-panel').hidden, recover: text => showInputRecovery(id, text) });
      $('#input-recovery').hidden = !inputDrafts.has(id);
      if (inputDrafts.has(id)) { ime.pause(); showInputRecovery(id, inputDrafts.get(id)); }
      if (isWechat) fileBridge = localFiles({ screen: $('#desktop-screen'), input: $('#chat-file'), panel: $('#file-transfer'),
        pickNas: session.capabilities?.nasPicker ? context => picker.pick(context.exporting ? 'chat-export' : 'chat', { ...context, instance: id }) : null,
        openFolder: session.capabilities?.nasPicker ? path => picker.openFolder(path) : null,
        api: data => api(`/instances/${id}/files`, data, data.action === 'export-nas' ? 20 * 60 * 1000 : 10000), notify, focus: () => ime?.focus(),
        download: async ({ signal, ...data }) => {
          const epoch = hostSessionEpoch;
          const response = await fetch(`${prefix}/api/instances/${id}/files`, { method: 'POST', credentials: 'same-origin', headers: { ...await hostHeaders(), 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
          return authenticatedResponse(requireDownloadResponse(response, '文件下载未完成，请重试'), epoch);
        },
        upload: async ({ requestId, fileId, client: fileClient, file, signal, progress }) => {
          const epoch = hostSessionEpoch;
          const headers = { ...await hostHeaders(), 'X-CSRF-Token': session.csrf, 'X-File-Client': fileClient, 'Content-Type': 'application/octet-stream' };
          signal.throwIfAborted();
          return new Promise((resolve, reject) => {
            const request = new XMLHttpRequest(); request.open('POST', `${prefix}/api/instances/${id}/file-upload/${requestId}/${fileId}`);
            request.timeout = 20 * 60 * 1000;
            for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
            const abort = () => request.abort();
            signal.addEventListener('abort', abort, { once: true });
            request.onloadend = () => signal.removeEventListener('abort', abort);
            request.upload.onprogress = event => progress(event.loaded);
            request.onload = () => {
              if (request.status === 401) invalidateHostToken();
              void authenticatedResponse(Promise.resolve().then(() => parseApiResponse(request.responseText, request.status, '文件未传完，请重新选择')), epoch).then(resolve, reject);
            };
            request.onerror = request.ontimeout = () => reject(new Error('文件传输中断，请检查网络后重试'));
            request.onabort = () => reject(new DOMException('已取消', 'AbortError'));
            request.send(file);
          });
        } });
    });
    client.addEventListener('disconnect', () => {
      if (generation !== remoteGeneration) return;
      clearTimeout(connectionTimer); desktopConnecting = false; desktopConnected = false;
      sound?.dispose(); sound = null;
      pointer?.dispose(); pointer = null; fileBridge?.dispose(); fileBridge = null; ime?.dispose(); ime = null; renderDesktop();
      if (connection.transport !== 'http') reconnect.lost();
    });
    client.addEventListener('securityfailure', () => notify('连接失败，请点击连接微信重试'));
  } finally { if (operation === desktopOperation) desktopBusy = false; busyIds.delete(id); await refresh(); }
}
$('#desktop-back').onclick = () => { stopMobileLoginChecks(); mobileLoginId = null; disconnect(); };
$('#mobile-login-back').onclick = () => { stopMobileLoginChecks(); mobileLoginId = null; disconnect(); void refresh(); };
$('#desktop-reconnect').onclick = async () => {
  if (desktopBusy || desktopConnecting) return;
  const runtime = state?.instances.find(item => item.id === desktopId)?.runtime;
  const action = desktopAction(runtime, desktopConnected);
  if (!action) return;
  const operation = desktopOperation, id = desktopId;
  try {
    if (!desktopConnected || runtime?.status !== 'running') return await openDesktop(desktopId, true, action.login);
    desktopBusy = true; renderDesktop();
    await api(`/instances/${id}/${action.login ? 'login' : 'show'}`, {}, 15000);
    if (operation === desktopOperation) ime?.focus();
  } catch (e) { notify(e.message); }
  finally { if (operation === desktopOperation) desktopBusy = false; await refresh(); }
};
const syncFullscreen = () => { const full = document.fullscreenElement === $('#desktop-view'); $('#desktop-fullscreen').textContent = full ? '退出全屏' : '全屏'; $('#desktop-fullscreen').setAttribute('aria-pressed', String(full)); };
document.addEventListener('fullscreenchange', syncFullscreen); syncFullscreen();
$('#desktop-fullscreen').onclick = () => { (document.fullscreenElement === $('#desktop-view') ? document.exitFullscreen() : $('#desktop-view').requestFullscreen()).then(syncFullscreen).catch(() => notify('当前浏览器暂不支持全屏')); };
let lastMobileLayout = mobile();
window.addEventListener('resize', () => {
  const nextMobileLayout = mobile();
  if (nextMobileLayout === lastMobileLayout) return;
  lastMobileLayout = nextMobileLayout;
  if (mobileLoginId && mobileLoginId === desktopId) { renderDesktop(); }
  else if (mobile() && !$('#ai-panel').hidden && desktopId && assistant?.attached()) {
    // Keep the same form and draft when crossing the mobile breakpoint. Only
    // the desktop stream is disconnected; this is the same account workspace.
    disconnect(true, true); standaloneAI = true;
    $('#desktop-view').classList.add('ai-only'); $('#desktop-view').hidden = false;
    $('#ai-rail').hidden = true;
    $('#ai-close').setAttribute('aria-label', '返回栖盒'); $('#ai-close span').textContent = '返回栖盒';
    syncDesktopInteraction();
  }
  else if (mobile() && !standaloneAI) { mobileLoginId = null; disconnect(); }
  render();
});
document.addEventListener('change', e => {
  if (e.target.name === 'mode') updateIdleChoice();
  if (e.target.name === 'deleteData') $('#delete-confirm').hidden = e.target.value !== 'yes';
  if (e.target.matches('[data-mobile-ai-master]')) void changeMobileAIMaster(e.target);
  if (e.target.id === 'package-file') { upload(e.target.files[0]).catch(err => notify(err.message)); e.target.value = ''; }
  if (e.target.name === 'source' && e.target.closest('.update-source')) $('#library-update-file-field').hidden = e.target.value !== 'upload';
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  try {
    if (button.hasAttribute('data-close')) return closeModal();
    if (button.dataset.downloadCommand) { button.disabled = true; try { await api('/install/' + button.dataset.downloadCommand, {}); } finally { button.disabled = false; await refresh(); } return; }
    if (button.dataset.updateCommand) {
      button.disabled = true;
      try {
        if (button.dataset.updateCommand === 'resume') await openLibraryUpdate();
        else await api('/wechat-update', { action: 'pause' });
      } finally { button.disabled = false; await refresh(); }
      return;
    }
    if (button.id === 'about-qibox') { dialog('关于栖盒', '<p>栖盒 '+esc(session?.product?.version || '')+'</p><h3>NAS 登录微信</h3><p>运行官方微信客户端，支持自动登录及在线期间可获取消息的实时同步，具体范围遵循官方客户端能力。</p><h3>AI 辅助</h3><p>使用你自己的模型 API，提供学习、总结、分析和自动回复等功能。</p><h3>闲时备份</h3><p>与在线同步分开调度，可设置时间段及负载、网络、内存阈值。计划启动的微信低优先级运行，检测到繁忙时退让，支持暂停恢复。避让取决于可检测的整机指标，不能保证零影响。</p><p>开发者：Bot · <a href="mailto:bot@qiapp.online">bot@qiapp.online</a></p>', '<button type="button" data-close class="secondary">关闭</button>'); return; }
    if (button.dataset.idleCommand) { await api('/instances/'+button.dataset.instanceId+'/settings',{command:button.dataset.idleCommand});closeModal();await refresh();notify('闲时备份设置已更新');return; }
      if (button.dataset.mobileAiOpen) { await openAIEntry(button.dataset.mobileAiOpen); return; }
      if (button.dataset.mobileAiRetry) { mobileAISettings.delete(button.dataset.mobileAiRetry); await loadMobileAISettings(button.dataset.mobileAiRetry); return; }
    if (button.dataset.mobileLogin) { const id = button.dataset.mobileLogin; closeModal(); await openMobileLogin(id); return; }
    if (button.dataset.mobileStop) {
      const id = button.dataset.mobileStop;
      busyIds.add(id); render();
      try {
        if (mobileLoginId === id || desktopId === id) { mobileLoginId = null; disconnect(); }
        await api(`/instances/${id}/stop`, {});
        notify('微信已停止');
      } finally { busyIds.delete(id); await refresh(); }
      return;
    }
    const menu = button.closest('details.app-menu');
    if (menu) {
      menu.querySelector('summary')?.focus({ preventScroll: true });
      menu.removeAttribute('open');
    }
    if (button.dataset.marketAction) {
      marketAppId = button.closest('[data-market-app]').dataset.marketApp;
      const action = button.dataset.marketAction;
      if (action === 'add') newInstance();
      if (action === 'open') pcHint();
      if (action === 'import') importDialog();
      if (action === 'uninstall') uninstallDialog();
      if (action === 'retained') retainedDialog();
      if (action === 'update') { button.disabled = true; try { await openLibraryUpdate(); } finally { button.disabled = false; } }
      if (action === 'download') { button.disabled = true; try { try { await api(`/apps/${marketAppId}/install/download`, {}); } catch (error) { await unsupportedVersion(error); } } finally { button.disabled = false; await refresh(); } }
      return;
    }
    if (button.id === 'install-anyway') {
      const generation = modalGeneration;
      try { await api(`/apps/${marketAppId}/install/download`, { allowUnverified: true }); closeModal(generation); }
      catch (error) { if (generation === modalGeneration && modal.open) dialog('安装未完成', `<p>${esc(String(error?.message || error))}</p>`, '<button type="button" data-close class="secondary">关闭</button>'); }
      finally { await refresh(); }
    }
    if (button.id === 'import-local') $('#package-file').click();
    if (button.id === 'input-recovery-done') { inputDrafts.delete(desktopId); $('#input-recovery').hidden = true; ime?.resume(); ime?.focus(); }
    if (button.id === 'input-recovery-select') { $('#input-recovery-text').focus(); $('#input-recovery-text').select(); }
    if (button.id === 'import-nas') { closeModal(); await picker.pick('install', ''); }
    if (button.id === 'create-fresh') newInstance(true);
    if (button.dataset.restore) await restoreInstance(state.retained.find(x => x.id === button.dataset.restore), button);
    if (button.dataset.purge) removeInstance(state.retained.find(x => x.id === button.dataset.purge), true);
    if (button.dataset.action) {
      const card = button.closest('[data-instance], [data-mobile-instance]');
      if (mobile() && (!card?.dataset.mobileInstance || !['delete', 'rename'].includes(button.dataset.action))) return pcHint();
      const id = card?.dataset.instance || card?.dataset.mobileInstance, item = state.instances.find(x => x.id === id);
      if (!item) return;
      if (button.dataset.action === 'open') await openDesktop(id);
      if (button.dataset.action === 'settings') settings(item);
      if (button.dataset.action === 'window-close-settings') windowCloseSettings(item);
      if (button.dataset.action === 'ai') await openAIEntry(id);
      if (button.dataset.action === 'recheck') { button.disabled = true; try { await api(`/instances/${id}/recheck`, {}, 15000); } finally { await refresh(); button.disabled = false; } }
      if (button.dataset.action === 'delete') removeInstance(item);
      if (button.dataset.action === 'rename') dialog('重命名', `<label class="field">名称<input type="text" name="name" value="${esc(item.name)}" maxlength="60" required></label><p>名称可填写 1–30 个字。</p>`, undefined, async form => { await api(`/instances/${id}/rename`, { name: checkedName(form.get('name'), id) }); await refresh(); });
      if (button.dataset.action === 'stop') {
        if (busyIds.has(id) || item.busy || ['preparing', 'starting', 'stopping'].includes(item.runtime.status)) return;
        busyIds.add(id); render();
        try { await api(`/instances/${id}/stop`, {}); }
        finally { busyIds.delete(id); await refresh(); }
      }
    }
  } catch (error) { notify(error.message); }
});
async function init() {
  try {
    session = await api('/session'); $('#version').textContent = `栖盒 ${session.product.buildId || session.product.version}`;
    const loaded = await refresh();
    if (!session) return false;
    if (!session.consent.accepted) consentDialog();
    else void picker.refresh().catch(error => connectionNotice.show(error.message, true, { repeat: false }));
    return loaded;
  } catch (e) {
    connectionNotice.show(e.name === 'TimeoutError' ? '连接超时，请检查网络' : e.message, true, { repeat: false });
    return false;
  }
}
const stateRefresh = visibleRefresh({ document, window,
  refresh: () => session ? refresh() : init(),
  interval: () => stateRefreshDelay({ ready: !!session, busy: desktopConnecting || busyIds.size > 0, job: state?.library?.manualUpdate || state?.library?.job, instances: state?.instances }),
});
window.addEventListener('offline', () => connectionNotice.show('网络连接已中断，当前显示最近的状态；恢复连接后将自动更新', true, { repeat: false }));
stateRefresh.start();
