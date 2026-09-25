import { contactName, contactSearch } from './ai-contact-name.mjs';
import { renderProactiveTable } from './ai-proactive-table-new.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
export const taskTypes = [
  ['custom', '自定义', ''],
  ['greeting', '日常问候', '自然问候对方近况，保持轻松联系。'],
  ['relationship', '关系维护', '关注对方最近状态，维持自然、持续的联系。'],
  ['work', '工作跟进', '跟进当前事项进展，确认下一步安排。'],
  ['invitation', '邀约活动', '询问对方近期安排，发起轻量邀约。'],
  ['holiday', '节日祝福', '结合节日氛围发送自然、真诚的祝福。'],
];
const statuses = { running: '执行中', paused: '已暂停', ended: '已结束', failed: '执行失败' };
const cycles = [['once', '立即执行一次'], ['daily', '每天执行'], ['weekdays', '每个工作日执行'], ['weekly', '每周执行'], ['custom', '自定义周期']];
const days = [[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [0, '周日']];
const requestId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  // NAS HTTP origins may not expose randomUUID, but still expose getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export function beijingTime(at) {
  if (at === null || at === undefined || at === '') return '—';
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
}
export function taskDraft(task, today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })) {
  return {
    id: task?.id, version: task?.version, revision: task?.revision, requestId: task?.id ? undefined : requestId(), name: task?.name || '', taskType: task?.taskType || 'custom',
    contacts: (task?.contacts || []).map(c => typeof c === 'string' ? { id: c, label: c } : { ...c }),
    goal: task?.goal || '', requirements: task?.requirements || '', sendMode: task?.sendMode || 'segments',
    schedule: { cycle: 'once', mode: 'fixed', time: '14:40', start: '18:00', end: '21:00', weekdays: [1], intervalDays: 2, startDate: today, ...task?.schedule, ...(task?.schedule?.weekdays ? { weekdays: [...task.schedule.weekdays] } : {}), ...(task?.migrationRequired && !task.migrationScheduleMapped ? { cycle: '' } : {}) },
  };
}
export function readTaskDraft(form, draft) {
  if (!form || !draft || form.querySelector('fieldset')?.disabled) return draft;
  const data = new FormData(form), next = { ...draft, schedule: { ...draft.schedule } };
  for (const key of ['name', 'taskType', 'goal', 'requirements', 'sendMode']) if (data.has(key)) next[key] = data.get(key);
  for (const key of ['cycle', 'mode', 'time', 'start', 'end', 'intervalDays', 'startDate']) if (data.has(key)) next.schedule[key] = data.get(key);
  if (form.querySelector('[name="weekdays"]')) next.schedule.weekdays = data.getAll('weekdays').map(Number);
  return next;
}
export function taskPayload(draft) {
  const value = { command: draft.id ? 'edit' : 'create', ...(draft.id ? { id: draft.id, ...(Number.isInteger(draft.version) ? { version: draft.version } : Number.isInteger(draft.revision) ? { revision: draft.revision } : {}) } : { requestId: draft.requestId }),
    name: draft.name.trim(), taskType: draft.taskType || 'custom', contacts: [...new Set(draft.contacts.map(c => c.id))],
    goal: draft.goal.trim(), requirements: draft.requirements.trim(), sendMode: draft.sendMode || 'segments', schedule: { ...draft.schedule, weekdays: [...draft.schedule.weekdays], intervalDays: Number(draft.schedule.intervalDays) } };
  if (!value.name) throw new Error('请填写任务名称');
  if (!value.contacts.length) throw new Error('请至少选择一位联系人');
  if (value.contacts.length > 200) throw new Error('每个任务最多选择 200 位联系人');
  if (!value.goal) throw new Error('请填写聊天目标');
  if (value.name.length > 120 || value.goal.length > 6000 || value.requirements.length > 6000) throw new Error('任务名称限 120 字，目标和其他要求各限 6000 字');
  const s = value.schedule, validTime = time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time || '');
  if (!cycles.some(([key]) => key === s.cycle)) throw new Error('请选择有效的执行周期');
  if (s.cycle !== 'once') {
    if (!['fixed', 'random'].includes(s.mode)) throw new Error('请选择执行时间方式');
    if (s.mode === 'fixed' && !validTime(s.time)) throw new Error('请填写固定执行时间');
    if (s.mode === 'random' && (!validTime(s.start) || !validTime(s.end) || s.start === s.end)) throw new Error('请填写不同的开始和结束时间，支持跨午夜');
    if (s.cycle === 'weekly' && (!s.weekdays.length || s.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error('请至少选择一个星期');
    if (s.cycle === 'custom') {
      if (!Number.isInteger(s.intervalDays) || s.intervalDays < 1 || s.intervalDays > 365) throw new Error('自定义周期须为 1–365 天的整数');
      const date = new Date(`${s.startDate}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== s.startDate) throw new Error('请选择有效的开始日期');
    }
  }
  return value;
}
export function contactChoices(state, query = '', selected = []) {
  const profiles = new Map((state.profiles || []).map(p => [p.contact, p]));
  const contacts = new Map((state.contacts || []).filter(c => c.kind === 'person').map(c => [c.id, c]));
  // Retain chosen contacts even when a refresh temporarily returns an incomplete list.
  for (const c of selected) if (!contacts.has(c.id)) contacts.set(c.id, { ...c, missing: true });
  const q = query.trim().normalize('NFKC').toLocaleLowerCase();
  return [...contacts.values()].map(c => {
    const p = profiles.get(c.id), learned = !!p?.learnedAt;
    const reply = p?.replyOptions?.enabled ?? (state.settings?.replyScope === 'all' || (state.replyTargets || []).includes(p?.id));
    return { ...c, label: c.label || c.id, profileId: p?.id || c.profileId, rank: learned ? 0 : reply ? 1 : 2, tag: learned ? '已学习' : reply ? '已设置自动回复' : '未设置' };
  }).filter(c => !q || contactSearch(c).includes(q))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'zh-CN'));
}
export function scheduleLabel(schedule = {}) {
  if (schedule.cycle === 'once') return '立即执行一次';
  const cycle = { daily: '每天', weekdays: '周一至周五', weekly: `每${days.filter(([d]) => schedule.weekdays?.includes(d)).map(([, label]) => label).join('、')}`, custom: `每 ${schedule.intervalDays} 天` }[schedule.cycle] || '未设置';
  return `${cycle} · ${schedule.mode === 'random' ? `${schedule.start}–${schedule.start > schedule.end ? '次日 ' : ''}${schedule.end} 随机` : schedule.time || '未设置时间'}`;
}
export function uncertainProfiles(task, state) {
  return [];
}
export function proactiveTable(state, view = {}) { return renderProactiveTable(state, view, { beijingTime, scheduleLabel }); }
// 主动聊天只负责发起：没开自动回复的联系人，对方此后的回复不会被处理。
// 这里只在发起时做判断并给出快捷开启，不在后端做兜底接管。
function replyOffContacts(state, contacts) {
  return (contacts || []).filter(c => {
    const p = (state.profiles || []).find(x => x.id === c.profileId || x.contact === c.id);
    const enabled = p?.replyOptions?.enabled ?? (state.settings?.replyScope === 'all' || (state.replyTargets || []).includes(p?.id || c.profileId));
    return !enabled;
  });
}
function taskEditor(state, draft) {
  const task = draft.id && state.proactiveTasks?.find(t => t.id === draft.id), readonly = !!draft.id && (!task || task.status === 'ended'), s = draft.schedule;
  const heading = readonly ? '查看任务' : draft.id ? '编辑任务' : '新建任务';
  return `<header class="ap-heading ap-editor-heading"><button type="button" class="secondary" data-proactive-back>← 返回任务列表</button><div><h3>${heading}</h3><p>${readonly ? '已结束或删除的任务仅供查看。' : draft.id ? '调整联系人和执行规则，保存后保持当前任务状态。' : '设置联系人和执行规则，任务建立后会自动执行。'}</p></div></header>${task?.migrationRequired ? `<div class="ap-readiness ap-migration-summary"><b>旧任务已暂停，请核对后再继续。</b><p>${esc(task.migrationSummary || task.legacyScheduleText || task.legacySchedule?.text || '原安排未记录')}</p><p>${task.migrationScheduleMapped ? '已预填可识别的原执行周期，请核对时间和联系人。' : '原周期无法可靠转换，请明确选择下方执行周期；不会自动按一次任务保存。'}</p></div>` : ''}<form id="ai-proactive-form" class="ap-editor"><fieldset ${readonly ? 'disabled' : ''}>
    <section class="ap-form-card"><label class="ai-field">任务名称<input name="name" maxlength="120" required value="${esc(draft.name)}" placeholder="例如：春日问候计划"></label></section>
    <section class="ap-form-card"><div class="ap-card-head"><div><h4>选择联系人</h4><p>已学习和已设置自动回复的联系人会优先显示。</p></div><button type="button" class="secondary" data-proactive-pick>＋ 添加联系人</button></div><div class="ap-contact-summary">从微信联系人中选择 <b id="ai-proactive-contact-count">已选 ${draft.contacts.length} 人</b></div><div class="ap-selected" id="ai-proactive-selected">${(() => { const off = new Set(replyOffContacts(state, draft.contacts).map(c => c.id)); return draft.contacts.map(c => `<span class="ap-chip">${contactName(c) || esc(c.id)}${off.has(c.id) ? '（未开自动回复）' : ''}<button type="button" data-proactive-remove="${esc(c.id)}" aria-label="移除 ${esc(c.label || c.id)}">×</button></span>`).join(''); })() || '<div class="ap-empty ap-empty-contacts">暂未选择联系人<br>点击右上角“添加联系人”开始选择</div>'}</div>${(() => { const off = replyOffContacts(state, draft.contacts); return off.length ? `<div class="ap-reply-hint"><p>${esc(off.map(c => contactName(c) || c.id).join('、'))} 未开启自动回复：任务仍会按计划发起，但对方此后的回复不会再被自动处理。</p><button type="button" class="secondary" data-proactive-enable-reply>为这些联系人开启自动回复</button></div>` : ''; })()}</section>
    <section class="ap-form-card"><h4>聊天目标</h4><p>告诉 AI 这次联系想达成什么。</p><label class="ai-field">任务类型<select name="taskType">${taskTypes.map(([key, label]) => option(key, label, draft.taskType === key)).join('')}</select></label><label class="ai-field"><span class="sr-only">聊天目标</span><textarea name="goal" rows="4" maxlength="6000" required placeholder="例如：自然问候近况，询问周末是否有空…">${esc(draft.goal)}</textarea></label></section>
    <section class="ap-form-card"><h4>其他要求 <small>（选填）</small></h4><p>可补充称呼、语气、禁用话题或必须提到的信息。</p><label class="ai-field"><span class="sr-only">其他要求</span><textarea name="requirements" rows="3" maxlength="6000" placeholder="例如：称呼对方小名；语气轻松；不要提及工作压力…">${esc(draft.requirements)}</textarea></label></section>
    <section class="ap-form-card"><label class="ai-field">发送方式<select name="sendMode">${option('segments', '按内容自然分段（1–3 条）', draft.sendMode !== 'single')}${option('single', '只发一条', draft.sendMode === 'single')}</select></label><p>分段之间固定随机等待 15–60 秒。第一段发出后由自动回复承接对方回复；对方在剩余段落发出前回复时，将取消剩余段落并交给自动回复处理。</p></section>
    <section class="ap-form-card"><h4>执行安排 <small></small></h4><label class="ai-field">执行周期<select name="cycle" required>${!s.cycle ? option('', '请选择执行周期', true) : ''}${cycles.map(([key, label]) => option(key, label, s.cycle === key)).join('')}</select></label>
    ${s.cycle === 'weekdays' ? '<p>工作日指周一至周五，不按节假日调休调整。</p>' : ''}
    ${s.cycle === 'weekly' ? `<div class="ap-weekdays" role="group" aria-label="每周执行日期">${days.map(([d, label]) => `<label><input type="checkbox" name="weekdays" value="${d}" ${s.weekdays.includes(d) ? 'checked' : ''}>${label}</label>`).join('')}</div>` : ''}
    ${s.cycle === 'custom' ? `<div class="ap-time-range"><label class="ai-field">每隔几天<input type="number" name="intervalDays" min="1" max="365" step="1" required value="${esc(s.intervalDays)}"></label><label class="ai-field">开始日期<input type="date" name="startDate" required value="${esc(s.startDate)}"></label></div><p>从开始日期起，每 ${esc(s.intervalDays)} 天执行一次，以开始日为固定锚点。</p>` : ''}
    ${!s.cycle ? '<p class="ap-time-summary">请先确认执行周期，再设置时间。</p>' : s.cycle === 'once' ? '<p class="ap-time-summary">创建后立即执行一次，无需设置时间。</p>' : `<div id="ai-proactive-time"><label class="ai-field">执行时间方式<select name="mode">${[['fixed', '固定时间'], ['random', '模糊时间']].map(([key, label]) => option(key, label, s.mode === key)).join('')}</select></label>${s.mode === 'random' ? `<div class="ap-time-range"><label class="ai-field">开始时间<input type="time" name="start" required value="${esc(s.start)}"></label><label class="ai-field">结束时间<input type="time" name="end" required value="${esc(s.end)}"></label></div><p class="ap-time-summary">每个周期在时间段内随机选择发送时刻，本次执行后再确定下一次时间。结束早于开始时跨至次日。</p>` : `<label class="ai-field">固定时刻<input type="time" name="time" required value="${esc(s.time)}"></label><p class="ap-time-summary">按固定时刻执行，不会在周期内随机变动。</p>`}</div>`}</section>
    </fieldset><p class="ap-time-summary">任务负责按计划主动发起联系；对方后续消息按该联系人的自动回复设置处理。</p><footer class="ap-editor-footer"><button type="button" class="secondary" data-proactive-cancel>${readonly ? '返回列表' : '取消'}</button>${readonly ? '' : `<button type="submit" class="primary" data-proactive-submit>${draft.id ? '保存修改' : '新建任务'}</button>`}</footer></form>`;
}
export function proactivePage(state, view = {}) {
  return `<div class="ai-proactive-page" data-proactive-root>${view.editing && view.draft ? taskEditor(state, view.draft) : `<header class="ap-heading"><div><h3>主动聊天</h3><p>让每一次主动联系都有目标、有边界，也随时可接管。</p></div><button type="button" class="primary" data-proactive-new>＋ ${view.draft ? '继续编辑任务' : '新建任务'}</button></header><div id="ai-proactive-list">${proactiveTable(state, view)}</div>`}</div>`;
}
// View-local state survives polling and rerenders, and resets on instance changes.
export function createProactiveUI({ panel, getState, context, isBusy, mutate, render, showRecords, refreshContacts, enableReply = async () => {} }) {
  let view = { filter: 'all', menu: '', editing: false, draft: null }, picker = null, dialog = null, returnFocus = null;
  const form = () => panel.querySelector('#ai-proactive-form');
  const remember = () => { view.draft = readTaskDraft(form(), view.draft); };
  function closeDialog() {
    if (dialog) { dialog.close(); dialog.remove(); dialog = null; }
    picker = null;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  function openDialog(html, label) {
    closeDialog(); returnFocus = document.activeElement;
    dialog = document.createElement('dialog'); dialog.className = 'ai-proactive-dialog'; dialog.setAttribute('aria-label', label); dialog.innerHTML = html;
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('keydown', event => { event.stopPropagation(); });
    panel.append(dialog); dialog.showModal();
    return dialog;
  }
  function drawPicker() {
    if (!picker || !dialog) return;
    const selected = [...picker.contacts.values()].filter(c => picker.ids.has(c.id));
    const choices = contactChoices(getState(), picker.query, selected), list = dialog.querySelector('#ai-proactive-picker-list');
    for (const c of choices) picker.contacts.set(c.id, c);
    const scroll = list.scrollTop;
    list.innerHTML = choices.map(c => `<label class="ap-person ${picker.ids.has(c.id) ? 'selected' : ''}"><input type="checkbox" data-proactive-contact="${esc(c.id)}" ${picker.ids.has(c.id) ? 'checked' : ''}><span class="ap-avatar">${esc([...c.label][0])}</span><span><b>${contactName(c)}</b><small class="ap-contact-tag rank-${c.rank}">${c.tag}</small>${c.missing ? '<small>本次列表未读取到，保留原选择</small>' : ''}</span></label>`).join('') || '<p class="ap-empty">没有匹配联系人，可尝试刷新列表。</p>';
    list.scrollTop = scroll;
    dialog.querySelector('[data-proactive-picked-count]').textContent = `已选 ${picker.ids.size} 人`;
  }
  function pickContacts() {
    remember();
    const node = openDialog(`<header><div><h3>添加联系人</h3><p>已学习 → 已设置自动回复 → 未设置，按优先级排列</p></div><button type="button" data-proactive-picker-cancel aria-label="关闭">×</button></header><div class="ap-picker-tools"><input id="ai-proactive-contact-search" type="search" aria-label="搜索联系人" placeholder="搜索姓名或备注"><button type="button" data-proactive-select-all>全选</button><button type="button" data-proactive-clear>清空</button><button type="button" data-proactive-refresh>刷新</button></div><div class="ap-picker-summary"><span>全选作用于当前搜索结果</span><b data-proactive-picked-count></b></div><div id="ai-proactive-picker-list" class="ap-picker-list"></div><p class="ap-picker-error" role="alert"></p><footer><button type="button" class="secondary" data-proactive-picker-cancel>取消</button><button type="button" class="primary" data-proactive-picker-confirm>确定</button></footer>`, '选择主动聊天联系人');
    picker = { ids: new Set(view.draft.contacts.map(c => c.id)), query: '', contacts: new Map(contactChoices(getState(), '', view.draft.contacts).map(c => [c.id, c])) };
    const current = context();
    node.addEventListener('input', event => { event.stopPropagation(); if (event.target.id === 'ai-proactive-contact-search') { picker.query = event.target.value; drawPicker(); } });
    node.addEventListener('change', event => { event.stopPropagation(); const key = event.target.dataset.proactiveContact; if (key) { if (event.target.checked) picker.ids.add(key); else picker.ids.delete(key); drawPicker(); } });
    node.addEventListener('click', async event => {
      event.stopPropagation(); const button = event.target.closest('button'); if (!button) return;
      if (button.hasAttribute('data-proactive-picker-cancel')) { closeDialog(); return; }
      if (button.hasAttribute('data-proactive-picker-confirm')) {
        view.draft.contacts = [...picker.contacts.values()].filter(c => picker.ids.has(c.id)).map(({ id, label, nickname, profileId }) => ({ id, label, ...(nickname ? { nickname } : {}), profileId }));
        closeDialog(); render(); panel.querySelector('[data-proactive-pick]')?.focus(); return;
      }
      if (button.hasAttribute('data-proactive-select-all')) contactChoices(getState(), picker.query, [...picker.contacts.values()].filter(c => picker.ids.has(c.id))).forEach(c => { picker.ids.add(c.id); picker.contacts.set(c.id, c); });
      if (button.hasAttribute('data-proactive-clear')) picker.ids.clear();
      if (button.hasAttribute('data-proactive-refresh')) {
        button.disabled = true;
        try { await refreshContacts(); } catch (e) { if (current === context() && dialog === node) node.querySelector('.ap-picker-error').textContent = e.message; }
        if (current !== context() || dialog !== node) return;
        button.disabled = false;
      }
      drawPicker();
    });
    drawPicker(); node.querySelector('input').focus();
  }
  async function click(button) {
    if (!button.closest('[data-proactive-root]')) return false;
    if ([...button.attributes].every(a => !a.name.startsWith('data-proactive-'))) return false;
    if (isBusy()) throw new Error('请等待当前操作完成');
    remember();
    if (button.hasAttribute('data-proactive-new')) { view.draft ||= taskDraft(); view.editing = true; view.menu = ''; render(); }
    else if (button.hasAttribute('data-proactive-back')) { view.editing = false; render(); }
    else if (button.hasAttribute('data-proactive-cancel')) { view.editing = false; view.draft = null; render(); }
    else if (button.hasAttribute('data-proactive-pick')) pickContacts();
    else if (button.hasAttribute('data-proactive-remove')) { view.draft.contacts = view.draft.contacts.filter(c => c.id !== button.dataset.proactiveRemove); render(); }
    else if (button.hasAttribute('data-proactive-enable-reply')) {
      const contacts = replyOffContacts(getState(), view.draft?.contacts || []).map(c => c.id);
      if (!contacts.length) { render(); return true; }
      button.disabled = true;
      try { await enableReply(contacts); } finally { button.disabled = false; }
      render();
    }
    else if (button.hasAttribute('data-proactive-filter')) { view.filter = button.dataset.proactiveFilter; view.menu = ''; render(); }
    else if (button.hasAttribute('data-proactive-menu')) { view.menu = view.menu === button.dataset.proactiveMenu ? '' : button.dataset.proactiveMenu; refresh(true); }
    else if (button.dataset.proactiveCommand) {
      const command = button.dataset.proactiveCommand, id = button.dataset.taskId, task = getState().proactiveTasks?.find(t => t.id === id);
      if (!task) throw new Error('任务已变化，请刷新列表');
      view.menu = '';
      if (command === 'edit') { view.draft = taskDraft(task); view.editing = true; render(); }
      else if (command === 'records') { await showRecords(id); }
      else if (command === 'delete') {
        refresh(true);
        const current = context(), node = openDialog(`<header><h3>删除任务</h3></header><p>删除「${esc(task.name)}」后将停止后续执行，并从任务列表移除。运行记录会保留。</p><p class="ap-picker-error" role="alert"></p><footer><button type="button" class="secondary" data-proactive-delete-cancel>取消</button><button type="button" class="primary" data-proactive-delete-confirm>删除任务</button></footer>`, '删除主动聊天任务');
        node.addEventListener('click', async event => {
          event.stopPropagation(); const b = event.target.closest('button'); if (!b) return;
          if (b.hasAttribute('data-proactive-delete-cancel')) { closeDialog(); return; }
          if (!b.hasAttribute('data-proactive-delete-confirm') || b.disabled) return;
          b.disabled = true;
          try { await mutate({ command: 'delete', id }, () => { if (view.draft?.id === id) view.draft = null; closeDialog(); }, '任务已删除，运行记录已保留'); }
          catch (e) { if (current === context() && dialog === node) { node.querySelector('.ap-picker-error').textContent = e.message; b.disabled = false; } }
        });
      } else {
        // Only ask the backend to retry failed work; never replay contacts in the browser.
        await mutate({ command, id }, () => {}, { pause: '任务已暂停', resume: '任务已继续', end: '任务已结束', retry: '已提交失败项重试，执行结果请查看记录' }[command]);
      }
    }
    return true;
  }
  function change(input) {
    if (!input.closest('#ai-proactive-form')) return false;
    remember();
    if (input.name === 'taskType') {
      const template = taskTypes.find(([key]) => key === input.value)?.[2];
      if (template) { view.draft.goal = template; form().elements.goal.value = template; }
    }
    if (['cycle', 'mode'].includes(input.name)) { render(); form()?.elements.namedItem(input.name)?.focus?.(); }
    return true;
  }
  async function submit() {
    remember();
    const draft = view.draft, task = draft?.id && getState().proactiveTasks?.find(t => t.id === draft.id);
    if (!draft || draft.id && (!task || task.status === 'ended')) throw new Error('任务已结束或移除，无法修改');
    const value = taskPayload(draft), button = form()?.querySelector('[type=submit]'), fields = form()?.querySelector('fieldset');
    if (button) button.disabled = true;
    if (fields) fields.disabled = true;
    const current = context();
    try { await mutate(value, () => { view.draft = null; view.editing = false; view.filter = 'all'; }, value.command === 'edit' ? '修改已保存，任务状态保持不变' : '任务已创建，执行情况请查看任务列表和运行记录'); }
    finally {
      if (current === context()) {
        const latest = draft.id && getState().proactiveTasks?.find(t => t.id === draft.id);
        const readonly = draft.id && (!latest || latest.status === 'ended');
        if (button?.isConnected) button.disabled = !!readonly;
        if (fields?.isConnected) fields.disabled = !!readonly;
      }
    }
  }
  function refresh(force = false) {

    const host = panel.querySelector('#ai-proactive-list');
    // Leave open menus and all editor inputs intact during polling.
    if (host && (force || !view.menu)) host.innerHTML = proactiveTable(getState(), view);
    const task = view.draft?.id && getState().proactiveTasks?.find(t => t.id === view.draft.id);
    if (form() && view.draft?.id && (!task || task.status === 'ended')) {
      form().querySelector('fieldset').disabled = true;
      form().querySelector('[type=submit]')?.remove();
    }
  }
  return {
    page: () => proactivePage(getState(), view), remember, click, change, submit, refresh,
    closeOverlay: () => { if (dialog) { closeDialog(); return true; } if (view.menu) { view.menu = ''; refresh(true); return true; } return false; },
    closeMenu: () => { if (view.menu) { view.menu = ''; refresh(true); } },
    reset: () => { closeDialog(); view = { filter: 'all', menu: '', editing: false, draft: null }; },
  };
}
