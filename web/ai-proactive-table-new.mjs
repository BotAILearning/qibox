import { contactName } from './ai-contact-name.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statuses = { running: '执行中', paused: '已暂停', ended: '已结束', failed: '执行失败' };
const types = { custom: '自定义', greeting: '日常问候', relationship: '关系维护', work: '工作跟进', invitation: '邀约活动', holiday: '节日祝福' };
const publishedAt = task => {
  const value = task.createdAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
};
export function renderProactiveTable(state, view = {}, { beijingTime, scheduleLabel }) {
  const all = (state.proactiveTasks || []).filter(task => !task.deletedAt && !task.deleted)
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const a = publishedAt(left.task), b = publishedAt(right.task);
      if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : right.index - left.index;
      if (!Number.isFinite(b)) return -1;
      return b - a || right.index - left.index;
    }).map(({ task }) => task);
  const tasks = all.filter(task => !view.filter || view.filter === 'all' || task.status === view.filter);
  const cleanupCounts = { ended: all.filter(task => task.status === 'ended').length, failed: all.filter(task => task.status === 'failed').length };
  cleanupCounts['ended-failed'] = cleanupCounts.ended + cleanupCounts.failed;
  const cleanupScope = view.cleanupScope || '', cleanupCount = cleanupCounts[cleanupScope] || 0;
  const cleanupOptions = [['ended','已结束'],['failed','执行失败'],['ended-failed','结束 + 失败']].map(([key,label]) => `<option value="${key}" ${cleanupScope === key ? 'selected' : ''}>${label}（${cleanupCounts[key]}）</option>`).join('');
  const filters = [['all', '全部'], ...Object.entries(statuses)].map(([key, label]) => `<button type="button" data-proactive-filter="${key}" aria-pressed="${(view.filter || 'all') === key}">${label}</button>`).join('');
  const rows = tasks.map(task => {
    const open = view.menu === task.id;
    const command = (key, label, danger = false) => `<button type="button" data-proactive-command="${key}" data-task-id="${esc(task.id)}" ${danger ? 'class="ap-danger"' : ''}>${label}</button>`;
    const actions = `<div class="ap-actions-cell"><button type="button" class="ap-more" data-proactive-menu="${esc(task.id)}" aria-label="${esc(task.name)} · 更多操作" aria-expanded="${open}">···</button>${open ? `<div class="ap-action-menu" aria-label="任务操作">${command('edit', task.status === 'ended' ? '查看任务' : '编辑任务')}${command('records', '查看记录')}${task.status === 'running' ? command('pause', '暂停任务') : task.status === 'paused' ? command('resume', '继续任务') : task.status === 'failed' ? command('retry', '仅重试失败项') : ''}${task.status !== 'ended' ? command('end', '结束任务', true) : ''}${command('delete', '删除任务', true)}</div>` : ''}</div>`;
    const names = (task.contacts || []).map(contact => contactName(contact) || esc(contact.id)).join('、') || '—';
    const cycle = task.migrationRequired && !task.migrationScheduleMapped ? '待确认执行安排' : scheduleLabel(task.schedule);
    const plan = task.status === 'running' && Number.isFinite(task.nextAt) && Number.isFinite(new Date(task.nextAt).getTime())
      ? `<small>${task.run && !task.run.completedAt ? '本次计划' : '下次计划'} <time datetime="${esc(new Date(task.nextAt).toISOString())}">${esc(beijingTime(task.nextAt))}</time></small>` : '';
    return `<article class="ap-reference-task${view.expandedTasks?.includes(task.id) ? ' mobile-expanded' : ''}" data-proactive-task="${esc(task.id)}"><button type="button" class="ap-mobile-task-toggle" data-proactive-expand="${esc(task.id)}" aria-expanded="${!!view.expandedTasks?.includes(task.id)}"><strong>${esc(task.name)}</strong><span class="ap-status ${esc(task.status)}">${esc(statuses[task.status] || '待更新')}</span><small>${task.contacts?.length || 0} 位联系人 · ${esc(cycle)}</small><span>${view.expandedTasks?.includes(task.id) ? '收起详情⌃' : '查看详情⌄'}</span></button><div class="ap-reference-cell"><span class="ap-reference-mobile">任务名称</span><strong>${esc(task.name)}</strong><small>${esc(types[task.taskType || task.type] || task.taskType || task.type || '自定义')}</small></div><div class="ap-reference-cell"><span class="ap-reference-mobile">聊天对象</span><strong>${names}</strong></div><div class="ap-reference-cell ap-reference-goal"><span class="ap-reference-mobile">聊天目标</span><span title="${esc(task.goal)}">${esc(task.goal)}</span>${task.requirements ? `<small title="${esc(task.requirements)}">${esc(task.requirements)}</small>` : ''}</div><div class="ap-reference-cell"><span class="ap-reference-mobile">执行周期</span>${esc(cycle)}${task.legacyScheduleText ? `<small>原安排：${esc(task.legacyScheduleText)}</small>` : ''}</div><div class="ap-reference-cell"><span class="ap-reference-mobile">状态</span><span class="ap-status ${esc(task.status)}">${esc(statuses[task.status] || '状态待更新')}</span>${plan}<small>最近执行 ${esc(beijingTime(task.lastRunAt))}</small>${task.reason || task.lastError ? `<small class="ap-error">${esc(task.reason || task.lastError)}</small>` : ''}</div><div class="ap-reference-cell ap-reference-actions"><span class="ap-reference-mobile">操作</span>${actions}</div></article>`;
  }).join('') || '<div class="ap-empty">这个筛选下还没有任务</div>';
  return `<section class="ap-table-panel ap-reference-list"><div class="ap-reference-toolbar"><div class="ap-filters" role="group" aria-label="任务状态">${filters}</div><div class="ap-task-cleanup"><label class="sr-only" for="ai-proactive-cleanup-scope">清理任务范围</label><select id="ai-proactive-cleanup-scope" data-proactive-cleanup-scope><option value="" ${cleanupScope ? '' : 'selected'}>选择清理范围</option>${cleanupOptions}</select><button type="button" class="secondary" data-ai-clear-tasks="${esc(cleanupScope)}" ${cleanupCount ? '' : 'disabled'} title="${!cleanupScope ? '请先选择清理范围' : cleanupCount ? '清理所选状态的任务，执行记录保留' : '所选范围内没有可清理的任务'}">清理任务</button></div></div><header class="ap-table-head"><h4>任务列表</h4><span>${all.length} 个任务</span></header><div class="ap-reference-columns" aria-hidden="true"><span>任务名称</span><span>聊天对象</span><span>聊天目标</span><span>执行周期</span><span>状态</span><span>操作</span></div>${rows}</section>`;
}
