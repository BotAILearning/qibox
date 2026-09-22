import RFB from '@novnc/novnc';
import { nativeInput } from './native-input.mjs';
import { clipboardFiles } from './clipboard-files.mjs';
import { appIcon } from './app-icons.mjs';
import { host, apiPrefix, hostHeaders, invalidateHostToken } from './host.mjs';
import { HttpDesktop } from './http-desktop.mjs';
import { localFiles } from './local-files.mjs';
import { loginLabel, desktopAction, desktopStatus, aiAvailable } from './wechat-state.mjs';
import { desktopPointer } from './desktop-pointer.mjs';
import { desktopReconnect } from './desktop-reconnect.mjs';
import { aiAssistant } from './ai-assistant.mjs';
import { desktopAudio } from './desktop-audio.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefix = apiPrefix;
const small = matchMedia('(max-width: 760px)');
const phone = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
if (phone) document.documentElement.classList.add('mobile');
const mobile = () => phone || small.matches;
let session, state, toastTimer, modalSubmit, requiredModal = false, polling = false, rfb, ime, fileBridge, desktopId, remoteGeneration = 0, lastInstancesMarkup = '';
let desktopConnected = false, desktopBusy = false, desktopConnecting = false, pointer, connectionTimer, desktopOperation = 0;
let sound, standaloneAI = false;
const busyIds = new Set();
const inputDrafts = new Map();
const reconnect = desktopReconnect({ notify, reconnect: async () => {
  const id = desktopId;
  if (!id || $('#desktop-view').hidden || standaloneAI) return;
  await openDesktop(id, false, false, false, true);
} });
function showInputRecovery(id, text) {
  inputDrafts.set(id, text);
  if (desktopId !== id) return;
  $('#input-recovery-text').value = text; $('#input-recovery').hidden = false;
}
const modal = $('#modal');
const assistant = aiAssistant({ api, guard: aiRailGuard, onClose: () => { if (standaloneAI) disconnect(); },
  // 入口常驻后，入口可能先于实例挂载出现：操作开关 / 打开面板前补一次挂载，避免用空实例 id 请求。
  ensure: async () => {
    const target = desktopId || state?.instances.find(item => (item.appId || 'wechat') === 'wechat')?.id || null;
    if (!target) return;
    if (assistantId === target && assistant.attached()) return;
    assistant.detach(); assistantId = target; await assistant.attach(target);
  },
  onOpenChat: async id => { if (standaloneAI || !desktopConnected || desktopId !== id) await openDesktop(id, false, false, true); } });
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
  if (standaloneAI) return;
  if (mobile()) return pcHint();
  if (desktopId !== id || $('#desktop-view').hidden || !desktopConnected) await openDesktop(id, false, false, true);
  if (assistantId === id && !$('#desktop-view').hidden) assistant.show();
}
let assistantId = null;
function syncAssistant(id) {
  if (assistantId === id) return;
  assistant.detach(); assistantId = id;
  if (id) return assistant.attach(id);
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
async function api(route, data, timeout = data === undefined ? 15000 : 120000) {
  const headers = { ...await hostHeaders(), ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' }) };
  let response;
  try { response = await fetch(`${prefix}/api${route}`, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeout) }); }
  catch (error) { if (error.name === 'TimeoutError') throw new Error('连接超时，请重试'); throw error; }
  if (response.status === 401) invalidateHostToken();
  let result; try { result = await response.json(); } catch { throw new Error('连接已中断，请刷新页面'); }
  if (!response.ok) throw Object.assign(new Error(result.error || '操作未完成，请重试'), { code: result.code }); return result;
}
function closeModal() { if (requiredModal) return; modal.close(); modalSubmit = null; }
function dialog(title, content, actions = '<button type="button" data-close class="secondary">取消</button><button type="submit" class="primary">确定</button>', submit, required = false) {
  requiredModal = required; modalSubmit = submit;
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = content; $('#modal-actions').innerHTML = actions;
  $('#modal-error').hidden = true; $('#modal-close').hidden = required;
  if (!modal.open) modal.showModal();
  setTimeout(() => $('#modal-body input[type=text]')?.focus(), 60);
}
modal.addEventListener('cancel', event => { if (requiredModal) event.preventDefault(); });
$('#modal-close').onclick = closeModal;
$('#modal-form').onsubmit = async event => {
  event.preventDefault(); if (!modalSubmit) return;
  const button = $('#modal-actions button[type=submit]'); if (button) button.disabled = true;
  try { await modalSubmit(new FormData(event.target)); requiredModal = false; modal.close(); modalSubmit = null; }
  catch (e) { $('#modal-error').textContent = e.message; $('#modal-error').hidden = false; }
  finally { if (button) button.disabled = false; }
};
function pcHint() {
  dialog('请用电脑端操作', '<p>微信已安装在 NAS 上。请在电脑上打开栖盒，登录并使用微信。</p>', '<button type="button" data-close class="primary">知道了</button>');
}
function consentDialog() {
  dialog('欢迎使用栖盒', '<p>在开始之前，请阅读我们的用户协议和隐私政策。</p><label class="check-label"><input type="checkbox" name="consent" required><span>我已阅读并同意<a href="./terms.html" target="_blank" rel="noopener">用户协议</a>与<a href="./privacy.html" target="_blank" rel="noopener">隐私政策</a></span></label>', '<button type="submit" class="primary">开始使用</button>', async form => {
    if (!form.has('consent')) throw new Error('请先阅读并勾选协议');
    await api('/consent', { accepted: true }); session.consent.accepted = true;
  }, true);
}
const definition = id => state.catalog.find(app => app.id === (id || 'wechat'));
const retainedFor = id => state.retained.filter(item => (item.appId || 'wechat') === id);
let marketAppId = 'wechat', lastCatalogMarkup = '';
function renderMarket(app) {
  const card = document.querySelector(`[data-market-app="${app.id}"]`);
  const part = name => card.querySelector(`[data-part="${name}"]`);
  const installed = app.library.installed, job = app.library.job;
  const pending = job && !['complete', 'error'].includes(job.status);
  const actions = part('actions');
  part('format').hidden = !!installed;
  const id = value => app.id === 'wechat' ? `id="${value}"` : '';
  const signature = `${!!installed}/${!!pending}/${!!session?.user.isAdmin}`;
  if (actions.dataset.state !== signature) {
    actions.dataset.state = signature;
    actions.innerHTML = installed
      ? `<button ${id('add-instance')} data-market-action="add" class="primary pc-only" ${pending ? 'disabled' : ''}>添加到桌面</button><button ${id('launch-installed')} data-market-action="open" class="primary mobile-only" ${pending ? 'disabled' : ''}>打开${esc(app.name)}</button>`
      : `<button ${id('download')} data-market-action="download" class="primary" ${pending ? 'disabled' : ''}>下载安装${esc(app.name)}</button><button ${id('import-open')} data-market-action="import" class="secondary" ${pending ? 'disabled' : ''}>导入安装包</button>`;
  }
  part('status').textContent = pending ? job.message
    : installed ? `已安装 · ${installed.version}${installed.support === 'unknown' ? ' · 版本未适配' : ''}`
      : app.edition;
  part('retained').hidden = !retainedFor(app.id).length;
  part('uninstall').hidden = app.id !== 'wechat' || !installed || !session.user.isAdmin;
  part('uninstall').disabled = !!pending;
  part('progress').hidden = !job || job.status === 'complete';
  if (job) {
    part('message').textContent = job.message;
    part('percent').textContent = pending && job.progress != null ? `${job.progress}%` : '';
    part('bar').hidden = job.status === 'error';
    if (job.progress == null) part('bar').removeAttribute('value'); else part('bar').value = job.progress;
    const size = value => value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${Math.round(value)} B`;
    const transferred = job.bytes != null ? job.total ? `${size(job.bytes)} / ${size(job.total)}` : `已下载 ${size(job.bytes)}` : '';
    const speed = job.bytesPerSecond != null ? `${size(job.bytesPerSecond)}/s` : '';
    part('detail').textContent = [transferred, speed].filter(Boolean).join(' · ');
  }
}
async function unsupportedVersion(error) {
  const message = String(error?.message || error || '');
  // Only a genuinely unknown structure earns a confirmation. Every other failure
  // is reported as-is, so a real error never gets buried behind a "continue"
  // button. A merely newer build is not that case: it installs without asking.
  if (!/结构差异较大/.test(message)) {
    dialog('安装未完成', `<p>${esc(message)}</p>`, '<button type="button" data-close class="secondary">关闭</button>');
    return;
  }
  const supported = definition(marketAppId)?.library?.supported || '暂无';
  dialog('微信版本差异较大',
    `<p>${esc(message)}</p><p>栖盒已适配的版本：${esc(supported)}。可以继续安装；如果自动发送、语音转文字或当前会话识别不可用，换回已适配的版本即可恢复。</p>`,
    '<button type="button" data-close class="secondary">取消</button><button type="button" id="install-anyway" class="primary">仍要安装</button>');
}
function render() {
  if (!state) return;
  const catalogMarkup = state.catalog.map(app => {
    const part = (name, legacy) => `data-part="${name}"${app.id === 'wechat' && legacy ? ` id="${legacy}"` : ''}`;
    return `<article class="store-card" data-market-app="${esc(app.id)}"><div class="store-card-main"><span class="wechat-icon" aria-hidden="true">${appIcon(app.icon)}</span><div><h3>${esc(app.name)}</h3><p ${part('status', 'package-status')}></p></div></div><p class="app-description">${esc(app.description)}</p><div ${part('actions', 'install-actions')} class="install-actions"></div><p ${part('format', 'install-format')} class="install-format">手动安装请选择 <strong>${esc(app.architecture)}</strong> 版 <strong>${esc(app.packageFormat)}</strong> 安装包。<a href="${esc(app.website)}" target="_blank" rel="noopener">${esc(app.name)}官网 ↗</a></p><div ${part('progress', 'install-progress')} class="install-progress" hidden><div><strong ${part('message', 'job-message')}></strong><span ${part('percent', 'job-percent')}></span></div><progress ${part('bar', 'job-progress')} max="100" aria-label="${esc(app.name)}安装进度"></progress><p ${part('detail', 'job-detail')}></p></div><div class="market-tools pc-only"><button ${part('retained', 'retained-open')} data-market-action="retained" class="quiet" hidden>保留的数据</button><button ${part('uninstall', 'uninstall')} data-market-action="uninstall" class="quiet danger-link" hidden>卸载${esc(app.name)}</button></div></article>`;
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
    return `<article class="instance-card" data-instance="${esc(item.id)}" data-app-id="${esc(item.appId || 'wechat')}"><button class="desktop-icon" data-action="open" aria-label="打开${esc(item.name)}" title="${esc(modes[item.schedule.mode] || '')}${item.schedule.paused ? ' · 已暂停' : ''}" ${busy || !installed ? 'disabled' : ''}><span class="wechat-icon" aria-hidden="true">${appIcon(app?.icon)}</span><h3 title="${esc(item.name)}">${esc(item.name)}</h3><span class="status ${item.runtime.status === 'running' && item.runtime.loginStatus === 'logged-in' ? 'logged-in' : 'logged-out'}">${busy ? '请稍候…' : installed ? (app?.id === 'wechat' ? loginLabel(item.runtime) : item.runtime.status === 'running' ? '运行中' : item.runtime.status === 'error' ? '启动失败' : '已停止') : '待重新安装'}</span></button><details class="app-menu"><summary aria-label="${esc(item.name)}的更多操作">•••</summary><div>${app?.capabilities.includes('startup-settings') ? `<button data-action="settings" ${busy || !installed ? 'disabled' : ''}>启动设置</button>` : ''}${(item.appId || 'wechat') === 'wechat' ? '<button data-action="ai">AI 辅助</button>' : ''}${item.runtime.loginCheckTimedOut ? '<button data-action="recheck">重新检测</button>' : ''}<button data-action="rename">重命名</button>${item.runtime.status === 'running' ? '<button data-action="stop">停止</button>' : ''}<button class="danger-link" data-action="delete">删除</button></div></details></article>`;
  }).join('');
  if (lastInstancesMarkup !== markup) {
    const opened = [...document.querySelectorAll('.app-menu[open]')].map(menu => menu.closest('[data-instance]').dataset.instance);
    const focused = document.activeElement, focusId = focused?.closest('[data-instance]')?.dataset.instance;
    const focusAction = focused?.dataset.action || (focused?.tagName === 'SUMMARY' ? 'menu' : null);
    $('#instances').innerHTML = markup; lastInstancesMarkup = markup;
    for (const id of opened) document.querySelector(`[data-instance="${id}"] .app-menu`)?.setAttribute('open', '');
    if (focusId && focusAction) document.querySelector(`[data-instance="${focusId}"] ${focusAction === 'menu' ? 'summary' : `[data-action="${focusAction}"]`}`)?.focus({ preventScroll: true });
  }
  updateIdleChoice();
  const mobileEntries = state.instances.filter(item => (item.appId || 'wechat') === 'wechat');
  $('#mobile-ai-list').innerHTML = mobileEntries.map(item => `<button class="secondary" data-mobile-ai="${esc(item.id)}" ${aiAvailable(item.runtime, true) ? '' : 'disabled'}>${esc(item.name)} · AI 辅助</button>`).join('');
  $('#mobile-ai').hidden = !mobileEntries.length;
}
function renderDesktop() {
  if ($('#desktop-view').hidden) return;
  const entry = state?.instances.find(item => item.id === desktopId);
  const runtime = entry?.runtime;
  if (standaloneAI) { if (!aiAvailable(runtime, true)) { disconnect(); notify('请先在电脑端登录微信'); } return; }
  // 入口常驻：只要打开的是微信实例就让入口显示，且与 assistant 挂载解耦——
  // 即使挂载 / 接口异常也不会让入口消失；可用性延迟到操作开关、打开面板时判断。
  const wechatEntry = !!(entry && (entry.appId || 'wechat') === 'wechat');
  $('#ai-rail').hidden = !wechatEntry;
  syncAssistant(wechatEntry ? desktopId : null);
  const action = desktopAction(runtime, desktopConnected);
  $('#desktop-reconnect').hidden = !action;
  $('#desktop-reconnect').textContent = action?.label || '显示微信';
  $('#desktop-reconnect').disabled = desktopBusy || desktopConnecting;
  const waiting = desktopBusy && !desktopConnected || desktopConnecting;
  const offline = !desktopConnected || runtime?.status !== 'running';
  // Derive both directions on every render; a previous offline response must
  // never leave this full-screen layer intercepting input after recovery.
  $('#desktop-status').hidden = !waiting && !offline;
  $('#desktop-status').textContent = desktopStatus(runtime, desktopConnected, waiting);
}
async function refresh() {
  if (polling) return; polling = true;
  try { state = await api('/state'); render(); renderDesktop(); $('#connection-error').hidden = true; }
  catch (e) { $('#connection-error').textContent = e.message; $('#connection-error').hidden = false; }
  finally { polling = false; }
}
function nameTaken(name, exceptId) {
  return [...state.instances, ...state.retained].some(item => item.id !== exceptId && item.name.trim() === name.trim());
}
function checkedName(name, exceptId) {
  if (nameTaken(name, exceptId)) throw new Error('名称已存在，请修改名称');
  return name.trim();
}
function newInstance(fresh = false, appId = marketAppId) {
  if (mobile()) return pcHint();
  if (!fresh && retainedFor(appId).length) return retainedDialog(true);
  const app = definition(appId);
  let name = app.name, suffix = 2;
  while (nameTaken(name)) name = `${app.name} ${suffix++}`;
  dialog(`添加${app.name}`, `<label class="field">名称<input type="text" name="name" value="${esc(name)}" maxlength="30" required></label>`, undefined, async form => { await api('/instances', { appId, name: checkedName(form.get('name')) }); await refresh(); notify('已添加到桌面'); });
}
function settings(item) {
  dialog('启动设置', `<p>${esc(item.name)}</p>
    <label class="choice"><input type="radio" name="mode" value="manual" ${item.schedule.mode === 'manual' ? 'checked' : ''}><span><strong>手动启动</strong><small>需要时打开。</small></span></label>
    <label class="choice"><input type="radio" name="mode" value="continuous" ${item.schedule.mode === 'continuous' ? 'checked' : ''}><span><strong>持续备份</strong><small>登录后持续接收并保存记录。与电脑登录同一微信冲突，适合主要使用手机时开启。</small></span></label>
    <label id="idle-choice" class="choice"><input id="idle-mode" data-instance-id="${esc(item.id)}" type="radio" name="mode" value="idle" ${item.schedule.mode === 'idle' ? 'checked' : ''}><span><strong>闲时备份</strong><small>按时启动并退出，适合不使用电脑微信的时段。</small></span></label>
    <p class="field-help">因微信限制，前期使用需扫码登录。后续在微信勾选“自动登录该设备”后，才能在定时重启后自动登录；栖盒会自动点击启动页的“登录”按钮。</p>
    <div id="idle-window" class="time-fields" ${item.schedule.mode === 'idle' ? '' : 'hidden'}><label>开始时间<input type="time" name="startTime" value="${esc(item.schedule.startTime)}" required></label><label>结束时间<input type="time" name="endTime" value="${esc(item.schedule.endTime)}" required></label><small>北京时间，支持跨夜时段。</small></div>
    <p class="field-help">关闭页面后微信继续运行；主动停止后，需再次打开或保存设置。</p>`, '<button type="button" data-close class="secondary">取消</button><button type="submit" class="primary">保存设置</button>', async form => {
      await api(`/instances/${item.id}/settings`, { mode: form.get('mode'), startTime: form.get('startTime'), endTime: form.get('endTime') });
      await refresh(); notify('启动设置已保存');
    });
  updateIdleChoice();
}
function updateIdleChoice() {
  if (!modal.open || !$('#idle-mode')) return;
  $('#idle-window').hidden = !$('#idle-mode').checked;
}
function uninstallDialog() {
  dialog('卸载微信', '<p>卸载微信程序，并停止已添加的微信。</p><label class="choice"><input type="radio" name="deleteData" value="no" checked><span><strong>保留数据</strong><small>重新安装后可继续使用。</small></span></label><label class="choice"><input type="radio" name="deleteData" value="yes"><span><strong>同时清除我的微信数据</strong><small>包含保留的数据，删除后无法恢复。</small></span></label><label id="delete-confirm" class="field" hidden>请输入：<strong>确认删除微信</strong><input type="text" name="confirmName" autocomplete="off" placeholder="确认删除微信"></label>', '<button type="button" data-close class="secondary">取消</button><button type="submit" class="danger">卸载</button>', async form => {
    await api(`/apps/${marketAppId}/install/uninstall`, { deleteData: form.get('deleteData') === 'yes', confirmName: form.get('confirmName') }); disconnect(); await refresh(); notify('微信已卸载');
  });
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
  dialog('修改名称后恢复', `<p>名称已存在，请修改名称。</p><label class="field">名称<input type="text" name="name" value="${esc(item.name)}" maxlength="30" required></label>`, '<button type="button" data-close class="secondary">取消</button><button type="submit" class="primary">恢复使用</button>', async form => {
    await api(`/instances/${item.id}/restore`, { name: checkedName(form.get('name'), item.id) });
    await refresh(); notify('已恢复，请打开并登录原微信');
  });
}
async function restoreInstance(item, button) {
  if (!item) throw new Error('未找到保留的数据，请刷新页面');
  if (nameTaken(item.name, item.id)) return restoreNameDialog(item);
  button.disabled = true;
  try {
    await api(`/instances/${item.id}/restore`, {}); closeModal(); await refresh(); notify('已恢复，请打开并登录原微信');
  } catch (error) {
    // Another page can reserve the name after the local check. Keep the data
    // retained and let the user resolve the server-confirmed conflict here.
    if (error.code !== 'NAME_CONFLICT') throw error;
    await refresh(); restoreNameDialog(item);
  } finally { button.disabled = false; }
}
function importDialog() {
  dialog('导入微信安装包', `<p>选择从官网下载的 ${esc(definition(marketAppId).architecture)} 版微信 .deb 安装包。当前支持 ${esc((state.library.importVersions || []).join('、'))}。</p><div class="import-options"><button type="button" id="import-local" class="secondary"><strong>从本机上传</strong><span>选择这台设备上的安装包</span></button>${session.capabilities?.nasPicker ? '<button type="button" id="import-nas" class="secondary"><strong>从 NAS 选择</strong><span>选择已经保存到 NAS 的安装包</span></button>' : ''}</div>`, '');
}
let picker = { refresh: async () => {}, pick: async () => {} };
if (host === 'fnos') {
  const { nasPicker } = await import('./nas-picker.mjs');
  picker = nasPicker({ notify, receive: async (purpose, file, context) => {
    if (purpose === 'chat' || purpose === 'chat-export') {
      if (context.instance !== desktopId || !fileBridge) throw new Error('文件选择已结束，请重新打开微信选择');
      return purpose === 'chat-export' ? fileBridge.selectExportNas(file, context) : fileBridge.selectNas(file, context);
    }
    await api(`/apps/${marketAppId}/install/nas`, { path: file }); await refresh();
  } });
}
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
  if (!recovering) reconnect.stop();
  sound?.dispose(); sound = null;
  if (!keepAssistant) syncAssistant(null);
  standaloneAI = false; $('#desktop-view').classList.remove('ai-only');
  if (invalidate) { desktopOperation++; desktopBusy = false; }
  desktopConnected = false; desktopConnecting = false; clearTimeout(connectionTimer);
  remoteGeneration++; pointer?.dispose(); pointer = null; fileBridge?.dispose(); fileBridge = null; ime?.dispose(); ime = null; rfb?.disconnect(); rfb = null;
  $('#remote-canvas').replaceChildren(); $('#desktop-view').hidden = true;
  if (document.fullscreenElement === $('#desktop-view')) void document.exitFullscreen().catch(() => {});
}
async function openMobileAI(id) {
  const entry = state.instances.find(item => item.id === id);
  if (!entry || (entry.appId || 'wechat') !== 'wechat' || !aiAvailable(entry.runtime, true)) throw new Error('请先在电脑端登录微信');
  disconnect(); const operation = desktopOperation; desktopId = id; standaloneAI = true;
  $('#desktop-view').classList.add('ai-only'); $('#desktop-view').hidden = false;
  $('#ai-account-label').textContent = '当前微信：' + entry.name;
  await syncAssistant(id);
  if (operation === desktopOperation && standaloneAI && assistantId === id) assistant.show();
}
async function openDesktop(id, start = true, login = false, allowMobile = false, recovering = false) {
  if (mobile() && !allowMobile) return pcHint();
  const operation = ++desktopOperation;
  disconnect(false, recovering, recovering); desktopId = id; desktopBusy = true; busyIds.add(id);
  const entry = state.instances.find(x => x.id === id), app = definition(entry?.appId);
  const isWechat = app?.id === 'wechat';
  sound?.dispose();
  if (isWechat) sound = desktopAudio({ surface: $('#desktop-screen'), endpoint: `${prefix}/api/instances/${id}/audio`,
    headers: async () => ({ ...await hostHeaders(), 'X-CSRF-Token': session.csrf }), notify });
  $('#ai-account-label').textContent = '当前微信：' + (entry?.name || '微信');
  $('#desktop-name').textContent = state.instances.find(x => x.id === id)?.name || '微信';
  $('#desktop-view').hidden = false; render(); renderDesktop();
  try {
    if (start) await api(`/instances/${id}/start`, {});
    if (operation !== desktopOperation) return;
    if (app?.adapter === 'docker') {
      const frame = document.createElement('iframe'); frame.title = entry.name; frame.setAttribute('sandbox', '');
      frame.src = `${prefix}/applications/${id}/`; frame.style.cssText = 'border:0;width:100%;height:100%;background:white';
      $('#remote-canvas').replaceChildren(frame); desktopConnected = true; desktopBusy = false; renderDesktop(); return;
    }
    if (login) await api(`/instances/${id}/login`, {});
    if (operation !== desktopOperation) return;
    if (mobile()) return pcHint();
    const connection = await api(`/instances/${id}/desktop`, {});
    if (operation !== desktopOperation) return;
    const generation = remoteGeneration;
    desktopConnecting = true; renderDesktop();
    const url = new URL(connection.path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const channel = connection.transport === 'http' ? new HttpDesktop({ stream: connection.path, input: connection.input,
      headers: async () => ({ ...await hostHeaders(), 'X-CSRF-Token': session.csrf }) }) : url.href;
    const client = rfb = new RFB($('#remote-canvas'), channel, { credentials: { password: connection.password } });
    client.scaleViewport = true; client.resizeSession = false; client.background = '#eaf0ec';
    client.focusOnClick = false; client.showDotCursor = false;
    connectionTimer = setTimeout(() => { if (generation === remoteGeneration && desktopConnecting) { client.disconnect(); notify('连接超时，请点击连接微信重试'); } }, 20000);
    client.addEventListener('connect', () => {
      if (generation !== remoteGeneration) return;
      clearTimeout(connectionTimer); desktopConnecting = false; desktopConnected = true; renderDesktop();
      reconnect.connected();
      pointer = desktopPointer($('#remote-canvas canvas'));
      ime = nativeInput({ input: $('#native-input'), screen: $('#desktop-screen'), client, mac: /Mac/.test(navigator.platform), paste: text => api(`/instances/${id}/clipboard`, { text }, 10000), pasteFiles: async files => api(`/instances/${id}/clipboard`, { files: await clipboardFiles(files) }, 30000), notify,
        connected: () => generation === remoteGeneration && desktopConnected, recover: text => showInputRecovery(id, text) });
      $('#input-recovery').hidden = !inputDrafts.has(id);
      if (inputDrafts.has(id)) { ime.pause(); showInputRecovery(id, inputDrafts.get(id)); }
      if (isWechat) fileBridge = localFiles({ screen: $('#desktop-screen'), input: $('#chat-file'), panel: $('#file-transfer'),
        pickNas: session.capabilities?.nasPicker ? context => picker.pick(context.exporting ? 'chat-export' : 'chat', { ...context, instance: id }) : null,
        openFolder: session.capabilities?.nasPicker ? path => picker.openFolder(path) : null,
        api: data => api(`/instances/${id}/files`, data, data.action === 'export-nas' ? 20 * 60 * 1000 : 10000), notify, focus: () => ime?.focus(),
        download: async ({ signal, ...data }) => {
          const response = await fetch(`${prefix}/api/instances/${id}/files`, { method: 'POST', credentials: 'same-origin', headers: { ...await hostHeaders(), 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
          if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || '文件下载未完成，请重试'); }
          return response;
        },
        upload: async ({ requestId, fileId, client: fileClient, file, signal, progress }) => {
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
              let value; try { value = JSON.parse(request.responseText); } catch {}
              if (request.status === 401) invalidateHostToken();
              request.status >= 200 && request.status < 300 ? resolve(value) : reject(new Error(value?.error || '文件未传完，请重新选择'));
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
$('#desktop-back').onclick = () => disconnect();
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
small.addEventListener('change', () => {
  if (mobile() && !$('#ai-panel').hidden && assistantId) {
    disconnect(false, true); standaloneAI = true; $('#desktop-view').classList.add('ai-only'); $('#desktop-view').hidden = false;
  } else if (mobile()) disconnect();
  render();
});
document.addEventListener('change', e => {
  if (e.target.name === 'mode') updateIdleChoice();
  if (e.target.name === 'deleteData') $('#delete-confirm').hidden = e.target.value !== 'yes';
  if (e.target.id === 'package-file') { upload(e.target.files[0]).catch(err => notify(err.message)); e.target.value = ''; }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  try {
    if (button.hasAttribute('data-close')) return closeModal();
    if (button.dataset.mobileAi) { await openMobileAI(button.dataset.mobileAi); return; }
    button.closest('details.app-menu')?.removeAttribute('open');
    if (button.dataset.marketAction) {
      marketAppId = button.closest('[data-market-app]').dataset.marketApp;
      const action = button.dataset.marketAction;
      if (action === 'add') newInstance();
      if (action === 'open') pcHint();
      if (action === 'import') importDialog();
      if (action === 'uninstall') uninstallDialog();
      if (action === 'retained') retainedDialog();
      if (action === 'download') { button.disabled = true; try { try { await api(`/apps/${marketAppId}/install/download`, {}); } catch (error) { await unsupportedVersion(error); } } finally { button.disabled = false; await refresh(); } }
      return;
    }
    if (button.id === 'install-anyway') {
      try { await api(`/apps/${marketAppId}/install/download`, { allowUnverified: true }); closeModal(); }
      catch (error) { dialog('安装未完成', `<p>${esc(String(error?.message || error))}</p>`, '<button type="button" data-close class="secondary">关闭</button>'); }
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
      if (mobile()) return pcHint();
      const id = button.closest('[data-instance]').dataset.instance, item = state.instances.find(x => x.id === id);
      if (!item) return;
      if (button.dataset.action === 'open') await openDesktop(id);
      if (button.dataset.action === 'settings') settings(item);
      if (button.dataset.action === 'ai') await openAIEntry(id);
      if (button.dataset.action === 'recheck') { button.disabled = true; try { await api(`/instances/${id}/recheck`, {}, 15000); } finally { await refresh(); button.disabled = false; } }
      if (button.dataset.action === 'delete') removeInstance(item);
      if (button.dataset.action === 'rename') dialog('重命名', `<label class="field">名称<input type="text" name="name" value="${esc(item.name)}" maxlength="30" required></label>`, undefined, async form => { await api(`/instances/${id}/rename`, { name: checkedName(form.get('name'), id) }); await refresh(); });
      if (button.dataset.action === 'stop') { busyIds.add(id); render(); try { await api(`/instances/${id}/stop`, {}); } finally { busyIds.delete(id); await refresh(); } }
    }
  } catch (error) { notify(error.message); }
});
async function init() {
  try {
    session = await api('/session'); $('#version').textContent = `栖盒 ${session.product.buildId || session.product.version}`;
    await refresh();
    if (!session.consent.accepted) consentDialog(); else await picker.refresh();
    setInterval(refresh, 1000);
  } catch (e) {
    $('#connection-error').textContent = e.name === 'TimeoutError' ? '连接超时，请检查网络' : e.message;
    $('#connection-error').hidden = false;
    // The NAS gateway/SDK can be unavailable briefly while an app is opening.
    // Retry session initialization; polling alone cannot recover without it.
    setTimeout(init, 3000);
  }
}
init();
