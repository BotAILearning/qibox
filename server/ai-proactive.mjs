import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './files.mjs';
import { defaultStyle, textField } from './ai-schema.mjs';
import { messageSegments } from './ai-prompts.mjs';
import { stripUnauthorizedProactiveVocatives } from './ai-reply-rules.mjs';
import { proactiveSchedule, nextProactiveOccurrence, proactiveOccurrenceDeadline } from './ai-proactive-schedule.mjs';

const terminal = new Set(['sent', 'skipped', 'failed', 'uncertain', 'cancelled', 'reviewed']);
// Recipients who failed inside one occurrence are re-queued for the next one.
// The cap stops a recurring task from retrying forever against someone whose
// chat can never be read, while a manual reply stays untouched.
const maxAutoRetries = 3;
// 分段发送中途对方回了话时，本次发起尚未完成，需要结合新消息重新生成剩余内容。
// 设上限避免对方连续回话时不停重生成。
const maxSegmentRegens = 2;
// Kept equal to ai-service's concurrentRunLimit so a task is never turned away
// before the shared run ceiling is actually reached.
const concurrentRunCeiling = 6;
const types = ['greeting', 'relationship', 'work', 'invitation', 'holiday', 'custom'];
const publicTask = task => { const { legacy, ...view } = task; return structuredClone({ ...view, version: task.revision }); };
const legacyClock = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const notSentPhase = { 'native-start': '启动发送助手', 'native-session': '会话识别', 'native-navigation': '聊天定位', 'native-prepare': '发送准备' };
const notSentCode = { timeout: '超时', cancelled: '已取消', 'controls-unavailable': '界面控件不可用', unavailable: '暂不可用' };
// A pre-submission failure carries the real cause when it can: either the data
// layer's own AppError text (reason) or the native helper's phase/code report
// (diagnostic). Without either, fall back to the generic message.
const notSentReason = delivery => delivery?.reason ||
  (delivery?.diagnostic ? `消息未提交（${notSentPhase[delivery.diagnostic.phase] || delivery.diagnostic.phase}·${notSentCode[delivery.diagnostic.code] || delivery.diagnostic.code}），请检查微信后重试` : '消息未提交，请检查微信后重试');
function migratedSchedule(row, now) {
  if (!['daily', 'weekly'].includes(row.repeat) || ![row.minuteStart, row.minuteEnd].every(n => Number.isInteger(n) && n >= 0 && n < 1440) || row.repeat === 'weekly' && (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6)) return null;
  return proactiveSchedule({ cycle: row.repeat, ...(row.repeat === 'weekly' ? { weekdays: [row.weekday] } : {}),
    ...(row.minuteStart === row.minuteEnd ? { mode: 'fixed', time: legacyClock(row.minuteStart) } : { mode: 'random', start: legacyClock(row.minuteStart), end: legacyClock(row.minuteEnd) }) }, now);
}

export class ProactiveTasks {
  constructor(ai) { this.ai = ai; this.active = new Map(); this.index = 0; }
  get tasks() { return this.ai.data.proactiveTasks; }
  init() {
    const a = this.ai, d = a.data;
    d.proactiveTasks ??= []; d.proactiveRecords ??= [];
    for (const record of d.proactiveRecords) if (Object.hasOwn(record, 'text')) {
      record.body = a.vault.seal({ text: record.text }); delete record.text;
    }
    // Explicit legacy API calls remain compatible in a fresh process until v2
    // is selected. Persisted old work is always migrated paused on startup.
    if (d.proactiveVersion === 2 || d.queue.items.length || d.schedules.length) this.activate();
    for (const task of this.tasks) for (const item of task.run?.items || []) {
      if (item.status === 'sending') {
        for (const segment of item.segments || []) if (segment.status === 'sending') segment.status = 'uncertain';
        item.status = 'uncertain'; item.reason = '服务重启，发送结果待核对，禁止自动重发';
        this.record(task, item, 'uncertain', item.reason);
      } else if (item.status === 'generating') { item.status = 'pending'; delete item.recordId; }
    }
    for (const task of this.tasks) {
      if (task.run?.items.some(i => i.status === 'uncertain') && !task.deletedAt && task.status !== 'ended') {
        task.status = 'failed'; task.reason = '发送结果待核对'; task.nextAt = null;
      }
    }
  }
  activate() {
    const a = this.ai, d = a.data;
    if (d.proactiveVersion === 2) return;
    a.invalidate(); d.proactiveVersion = 2;
    d.proactiveLegacy = { at: a.now(), queue: structuredClone(d.queue), schedules: structuredClone(d.schedules) };
    const old = [...d.schedules.map(s => ({ ...s, legacyKind: 'schedule' }))];
    if (d.queue.items.length && !d.queue.scheduleId) old.push({ id: 'queue', account: d.account, targets: d.queue.items.map(i => i.id), strategy: d.strategy, legacyKind: 'queue' });
    for (const row of old) {
      const contacts = (row.targets || []).map(id => d.profiles[id]).filter(Boolean).map(p => ({ id: p.contact, label: p.label, profileId: p.id }));
      const schedule = migratedSchedule(row, a.now());
      const oldRequirements = [['旧内容要求', row.strategy?.content], ['已知信息', row.strategy?.facts], ['限制', row.strategy?.boundaries]].filter(([, text]) => text).map(([label, text]) => `${label}：${text}`).join('\n');
      const legacyScheduleText = row.text || (schedule ? `${row.repeat === 'daily' ? '每天' : `每周${row.weekday}`} ${schedule.mode === 'fixed' ? schedule.time : `${schedule.start}–${schedule.end} 随机`}` : row.legacyKind === 'queue' ? '旧单轮主动聊天队列' : '旧时间无法可靠转换，请重新选择执行周期');
      this.tasks.push({ id: randomUUID(), account: row.account, name: row.name || '旧主动聊天任务（待核对）', taskType: 'custom', contacts,
        goal: row.strategy?.purpose || '', requirements: oldRequirements, schedule: schedule || { cycle: 'once', mode: 'fixed', timezone: 'Asia/Shanghai' },
        status: 'paused', nextAt: null, lastRunAt: row.lastRunAt || null, createdAt: row.createdAt || a.now(), revision: 1,
        migrationScheduleMapped: !!schedule, legacyScheduleText,
        migrationSummary: [`原安排：${legacyScheduleText}`, `原目标：${row.strategy?.purpose || '未设置'}`, oldRequirements, !schedule ? '无法可靠转换原执行时间，必须明确选择新周期后保存。' : '已预填可转换的周期，仍需人工核对后保存。'].filter(Boolean).join('\n'),
        migrationRequired: true, legacySchedule: { text: row.text || '', repeat: row.repeat || 'once', nextAt: row.nextAt ?? d.proactiveLegacy.queue.nextAt, timezone: row.timezone || 'Asia/Shanghai' },
        reason: '旧任务已暂停；请核对联系人、目标和执行周期后保存，再继续', legacy: structuredClone(row) });
    }
    if (d.queue.items.length) d.queue.status = 'paused'; d.queue.nextAt = null;
    for (const s of d.schedules) if (!['cancelled', 'ended', 'completed'].includes(s.status)) { s.status = 'paused'; s.nextAt = null; }
    for (const p of Object.values(d.profiles)) delete p.continuation;
  }
  state() {
    const a = this.ai;
    return { proactiveTasks: this.tasks.filter(t => t.account === a.data.account && !t.deletedAt).map(publicTask),
      proactiveRecords: this.records({ limit: 100 }).records, proactiveRecordsPage: this.records({ limit: 100 }).page,
      proactiveRequirements: this.requirements() };
  }
  requirements() {
    const a = this.ai, result = [];
    if (!a.data.settings.enabled) result.push('请开启 AI 辅助');
    if (!a.data.settings.proactive) result.push('请开启主动聊天');
    if (!a.modelReady()) result.push('请先配置模型并允许使用聊天内容');
    if (!a.ready() || !a.available) result.push('请打开微信并完成联系人检测');
    return result;
  }
  records({ taskId, limit = 100, before } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || before !== undefined && typeof before !== 'string') throw new AppError('记录分页参数无效');
    const deleted = new Set((this.ai.data.deletedActivityRecords || []).filter(row => row.account === this.ai.data.account && row.source === 'proactive').map(row => row.id));
    const rows = this.ai.data.proactiveRecords.filter(r => r.account === this.ai.data.account && !deleted.has(r.id) && (!taskId || r.taskId === taskId));
    const offset = before ? rows.findIndex(r => r.id === before) + 1 : 0;
    if (before && !offset) throw new AppError('记录分页游标已失效，请刷新');
    const selected = rows.slice(offset, offset + limit), hasMore = offset + selected.length < rows.length;
    return { records: selected.map(record => {
      const { body, ...view } = structuredClone(record);
      try { return { ...view, text: body ? this.ai.vault.open(body).text : '' }; }
      catch { return { ...view, text: '', bodyUnavailable: true }; }
    }), page: { limit, hasMore, nextBefore: hasMore ? selected.at(-1).id : null, total: rows.length } };
  }
  validate(value, previous) {
    const a = this.ai, contacts = value.contacts ?? previous?.contacts.map(c => c.id);
    if (!a.data.account || !Array.isArray(contacts) || !contacts.length || contacts.length > 200 || contacts.some(id => a.contacts.get(id)?.kind !== 'person')) throw new AppError('请选择当前账号检测到的联系人（最多 200 人）');
    const taskType = value.taskType ?? previous?.taskType ?? 'custom';
    if (!types.includes(taskType)) throw new AppError('任务类型无效');
    const sendMode = value.sendMode ?? previous?.sendMode ?? 'segments';
    if (!['single', 'segments'].includes(sendMode)) throw new AppError('发送方式无效');
    const fields = { name: textField(value.name ?? previous?.name ?? '', 120, true), taskType, sendMode,
      goal: textField(value.goal ?? previous?.goal ?? '', 6000, true), requirements: textField(value.requirements ?? previous?.requirements ?? '', 6000),
      schedule: proactiveSchedule(value.schedule ?? previous?.schedule, a.now()) };
    fields.contacts = [...new Set(contacts)].map(contact => {
      const target = a.contacts.get(contact), id = createHash('sha256').update(`${a.data.account}\0${contact}`).digest('hex');
      return { id: contact, label: target.label, ...(target.nickname ? { nickname: target.nickname } : {}), profileId: id };
    });
    return fields;
  }
  ensureProfiles(task) {
    const a = this.ai;
    for (const c of task.contacts) a.data.profiles[c.profileId] ||= { id: c.profileId, account: task.account, contact: c.id, label: c.label, kind: 'person', source: 'default', preparedAt: a.now(), style: structuredClone(defaultStyle), paused: false, rounds: 0 };
  }
  action(value = {}) {
    return this.ai.exclusive(async () => {
      const a = this.ai, command = value.command;
      if (!['create', 'edit', 'pause', 'resume', 'end', 'retry', 'delete'].includes(command)) throw new AppError('主动聊天操作无效');
      if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.requestId))) throw new AppError('创建请求标识无效');
      if (command === 'create' && value.requestId && this.tasks.some(t => t.account === a.data.account && t.requestId === value.requestId)) { await a.save(); return a.publicState(); }
      let task = this.tasks.find(t => t.id === value.id && t.account === a.data.account && !t.deletedAt);
      if (command !== 'create' && !task) throw new AppError('任务不存在或不属于当前账号', 404);
      if (value.revision !== undefined && value.revision !== task?.revision) throw new AppError('任务已被修改，请刷新后重试', 409);
      if (value.version !== undefined && value.version !== task?.revision) throw new AppError('任务已被修改，请刷新后重试', 409);
      const fields = ['create', 'edit'].includes(command) ? this.validate(value, task) : null;
      if (command === 'edit' && task.migrationRequired && !task.migrationScheduleMapped && !Object.hasOwn(value, 'schedule')) throw new AppError('旧时间无法自动转换，请明确选择执行周期后保存');
      if (command === 'create' && this.tasks.filter(t => t.account === a.data.account && !t.deletedAt).length >= 200) throw new AppError('最多保留 200 个任务，请先删除不用的任务');
      if (['resume', 'retry'].includes(command) && task.migrationRequired) throw new AppError('请先核对并保存旧任务的联系人、目标和执行周期');
      if (['resume', 'retry'].includes(command) && task.status === 'ended') throw new AppError('任务已结束，请新建任务');
      if (command === 'resume' && task.status === 'failed') throw new AppError('失败任务请使用重试');
      if (command === 'resume' && task.run?.completedAt) {
        const failed = task.run.items.filter(i => i.status === 'failed');
        // A recurring failure below the retry cap already owns a future slot.
        // Pausing that schedule must not turn normal resume into an immediate
        // retry. Preserve the slot and let tick revive it when it becomes due.
        const scheduledRetry = task.schedule.cycle !== 'once' && Number.isFinite(task.nextAt) &&
          failed.length > 0 && failed.every(i => (i.attempts || 0) < maxAutoRetries);
        if (task.run.items.some(i => i.status === 'uncertain') || failed.length && !scheduledRetry) throw new AppError('请重试失败对象；不确定的发送结果需先核对');
      }
      if (command === 'retry' && !task.run?.items.some(i => i.status === 'failed')) throw new AppError('没有可以安全重试的失败对象；不确定的发送不会重发');
      this.activate();
      if (command === 'create') {
        task = { id: randomUUID(), account: a.data.account, ...fields, ...(value.requestId ? { requestId: value.requestId } : {}), status: 'running', revision: 1, createdAt: a.now(), lastRunAt: null,
          ...nextProactiveOccurrence(fields.schedule, a.now(), a.random) };
        this.ensureProfiles(task); this.tasks.push(task);
        if (!a.data.settings.enabled) a.data.replyWatchSince = a.now();
        a.data.settings.enabled = true; a.data.settings.proactive = true;
      } else {
        // Only invalidate this task. Other independent tasks keep their work.
        this.active.get(task.id)?.controller.abort();
        task.revision++; task.updatedAt = a.now();
        if (command === 'edit') {
          const scheduleChanged = JSON.stringify(fields.schedule) !== JSON.stringify(task.schedule);
          Object.assign(task, fields); this.ensureProfiles(task); delete task.migrationRequired;
          // An in-flight occurrence is immutable. Existing recipients already
          // sent/uncertain stay consumed; new values apply to pending recipients.
          if (task.run && !task.run.completedAt) {
            const old = task.run.items;
            for (const i of old) if (!task.contacts.some(c => c.id === i.contact) && i.status === 'pending') i.status = 'cancelled';
            for (const c of task.contacts) if (!old.some(i => i.contact === c.id)) old.push(this.item(c));
          }
          if (!task.run || task.run.completedAt) {
            if (task.status !== 'ended' && (scheduleChanged || task.nextAt === null)) Object.assign(task, nextProactiveOccurrence(task.schedule, a.now(), a.random));
          }
        } else if (command === 'pause') { if (task.status !== 'ended') task.status = 'paused'; }
        else if (command === 'end' || command === 'delete') {
          task.status = 'ended'; task.endedAt = a.now(); task.nextAt = null;
          if (command === 'delete') task.deletedAt = a.now();
          for (const i of task.run?.items || []) if (i.status === 'pending') i.status = 'cancelled';
        } else {
          task.status = 'running'; delete task.reason;
          if (command === 'retry') {
            for (const i of task.run.items) if (i.status === 'failed') { i.status = 'pending'; delete i.recordId; delete i.reason; }
            delete task.run.completedAt; task.nextAt = a.now();
          } else if (task.run && !task.run.completedAt) task.nextAt = a.now();
          else if (task.nextAt === null) Object.assign(task, nextProactiveOccurrence(task.schedule, a.now(), a.random, task.run?.occurrenceDate));
          if (task.nextAt === null && task.schedule.cycle === 'once') task.status = 'ended';
        }
      }
      await a.save(); return a.publicState();
    });
  }
  item(c) { return { id: randomUUID(), contact: c.id, label: c.label, ...(c.nickname ? { nickname: c.nickname } : {}), profileId: c.profileId, status: 'pending', attempts: 0 }; }
  record(task, item, status, reason = '', text) {
    const a = this.ai;
    let record = a.data.proactiveRecords.find(r => r.id === item.recordId);
    if (!record) {
      record = { id: randomUUID(), account: task.account, taskId: task.id, taskName: task.name, taskType: task.taskType, runId: task.run.id,
        profileId: item.profileId, contact: item.contact, label: item.label, ...(item.nickname ? { nickname: item.nickname } : {}), at: a.now(), source: 'proactive' };
      item.recordId = record.id; a.data.proactiveRecords.unshift(record);
    }
    Object.assign(record, { status, reason, updatedAt: a.now(), ...(text !== undefined ? { body: a.vault.seal({ text }) } : {}) });
    if (item.operationId) record.operationId = item.operationId;
    if (item.messageId) record.messageId = item.messageId;
    item.status = status; item.reason = reason;
    return record;
  }
  resolveProfile(profileId) {
    const a = this.ai;
    for (const task of this.tasks.filter(t => t.account === a.data.account)) {
      let changed = false;
      for (const item of task.run?.items || []) if (item.profileId === profileId && item.status === 'uncertain') {
        const record = this.record(task, item, 'reviewed', '本人已核对；本次已结束，不会补发');
        record.resolvedAt = a.now(); record.previousStatus = 'uncertain'; changed = true;
      }
      if (!changed) continue;
      task.revision++;
      if (task.deletedAt || ['paused', 'ended'].includes(task.status)) continue;
      if (task.run.items.some(i => ['failed', 'uncertain'].includes(i.status))) continue;
      task.status = 'running'; task.nextAt = a.now(); delete task.reason;
      this.settle(task);
    }
  }
  runnable(task) {
    const a = this.ai;
    return !a.closed && !task.deletedAt && task.status === 'running' && task.account === a.data.account && a.data.settings.enabled && a.data.settings.proactive && a.available && a.ready() && a.modelReady() && !a.operation && !a.scanOperation && !a.manualHolds.size && a.now() >= (a.userBusyUntil || 0);
  }
  async tick({ background = false } = {}) {
    const a = this.ai;
    if (a.data.proactiveVersion !== 2) return;
    const candidates = this.tasks.filter(t => this.runnable(t) && t.nextAt !== null && t.nextAt <= a.now());
    if (!candidates.length) return;
    const work = [], start = this.index++ % candidates.length;
    for (let n = 0; n < candidates.length; n++) {
      const task = candidates[(start + n) % candidates.length];
      if (this.active.has(task.id) || a.activeRuns.size >= concurrentRunCeiling) continue;
      this.reviveRetryable(task);
      if (!task.run || task.run.completedAt) {
        task.run = { id: randomUUID(), at: a.now(), occurrenceDate: task.occurrenceDate, schedule: structuredClone(task.schedule), items: task.contacts.map(c => this.item(c)) };
        task.lastRunAt = a.now();
      }
      if (this.expired(task)) {
        for (const item of task.run.items) if (item.status === 'pending') this.record(task, item, 'skipped', '本轮执行时间已过，未发送；按下一周期安排');
        this.settle(task); await a.save(); continue;
      }
      const item = task.run.items.find(i => i.status === 'pending' && !a.activeRuns.has(i.profileId));
      if (!item) { if (task.run.items.every(i => terminal.has(i.status))) { this.settle(task); await a.save(); } continue; }
      const controller = new AbortController(), revision = task.revision;
      const deadline = proactiveOccurrenceDeadline(task.run.schedule || task.schedule, task.run.occurrenceDate, task.run.at);
      // A native request can wait behind another navigation/send. Expiry must
      // cancel that queued request too, not just the preceding model call.
      const signals = [controller.signal, a.controller.signal];
      const windowSignal = Number.isFinite(deadline) ? AbortSignal.timeout(Math.max(1, Math.min(2147483647, deadline - a.now() + 1))) : null;
      if (windowSignal) signals.push(windowSignal);
      const signal = AbortSignal.any(signals);
      const entry = { controller };
      this.active.set(task.id, entry);
      const promise = a.startRun(item.profileId, () => this.execute(task, item, revision, signal, windowSignal), a.revision);
      if (!promise) { this.active.delete(task.id); continue; }
      entry.promise = promise;
      promise.finally(() => { if (this.active.get(task.id) === entry) this.active.delete(task.id); }).catch(() => {});
      work.push(promise);
    }
    if (!background) await Promise.allSettled(work);
  }
  expired(task) { return this.ai.now() > proactiveOccurrenceDeadline(task.run?.schedule || task.schedule, task.run?.occurrenceDate || task.occurrenceDate, task.run?.at || task.nextAt); }
  // A finished occurrence whose failed recipients are still under the retry cap
  // resumes in place once the next occurrence comes due: only those recipients
  // go back to pending, everyone already contacted stays consumed.
  reviveRetryable(task) {
    const a = this.ai;
    if (!task.run?.completedAt || task.schedule.cycle === 'once' || task.deletedAt || task.status !== 'running') return;
    if (task.run.items.some(i => i.status === 'uncertain')) return;
    let revived = false;
    for (const item of task.run.items) if (item.status === 'failed' && (item.attempts || 0) < maxAutoRetries) {
      item.status = 'pending'; delete item.reason; delete item.recordId; delete item.interrupted; delete item.segments; revived = true;
    }
    if (!revived) return;
    delete task.run.completedAt; delete task.reason;
    task.run.at = a.now(); task.run.occurrenceDate = task.occurrenceDate; task.run.schedule = structuredClone(task.schedule);
  }
  settle(task) {
    if (!task.run || task.run.items.some(i => !terminal.has(i.status))) return;
    task.run.completedAt = this.ai.now();
    if (task.deletedAt || task.status === 'ended') return;
    if (task.status === 'paused') { task.nextAt = null; return; }
    const failed = task.run.items.filter(i => i.status === 'failed'), uncertain = task.run.items.some(i => i.status === 'uncertain');
    const autoRetry = !uncertain && failed.length && failed.every(i => (i.attempts || 0) < maxAutoRetries);
    if (uncertain) { task.status = 'failed'; task.nextAt = null; task.reason = '部分发送结果待核对，不会自动重发'; }
    else if (failed.length && !(autoRetry && task.schedule.cycle !== 'once')) {
      task.status = 'failed'; task.nextAt = null;
      task.reason = task.schedule.cycle === 'once' ? '部分联系人执行失败，可重试失败对象' : `部分联系人已自动重试 ${maxAutoRetries} 次仍未成功，请手动重试失败对象`;
    }
    else if (task.schedule.cycle === 'once') { task.status = 'ended'; task.nextAt = null; task.endedAt = this.ai.now(); }
    else { delete task.reason; Object.assign(task, nextProactiveOccurrence(task.schedule, this.ai.now(), this.ai.random, task.run.occurrenceDate)); }
  }
  // A reply sent by hand does not cancel a proactive message, it only makes it
  // wait out the manual-activity window. Another manual reply inside the wait
  // re-arms it, so the occurrence window stays the only real bound.
  async waitManualWindow(profileId, signal) {
    const a = this.ai, windowMs = a.manualActivityWindow || 300000;
    for (let guard = 0; guard < 240; guard++) {
      const profile = a.data.profiles[profileId];
      if (!profile?.lastManualAt) return;
      const since = a.now() - profile.lastManualAt;
      if (since >= windowMs) return;
      await a.delay(Math.min(windowMs - since, 30000) + 1000, signal);
    }
  }
  // 主动聊天不再自造暂停状态：暂停只有自动回复那一套。这里只尊重「面向本人」的
  // 三类（本人显式关闭、转交本人、对方要求停止），回复侧的连续上限、群聊冷却与
  // 发送未确认都不冻结主动任务。
  blocked(profile) { return !!profile?.paused && ['explicit', 'stop'].includes(profile.pauseReason); }
  // 段落之间聊天发生变化时判断是谁在说话：对方回话要重新生成剩余内容，
  // 本人自己发了话则按接管处理、停止剩余段落。
  interruption(snapshot, profile) {
    const last = snapshot?.messages?.at(-1);
    if (!last) return null;
    if (last.direction === 'other') return 'other';
    if (last.direction === 'self' && !(profile.generatedIds || []).includes(last.id)) return 'self';
    return null;
  }
  // One generation attempt for one recipient. Returns null when the model asked
  // for anything other than sending; that decision is already recorded.
  async draft(task, item, profile, context, signal, check, extra = '') {
    const a = this.ai;
    const result = await a.generateProactiveMessage(task, profile, context, signal, extra); check();
    let texts = messageSegments(result, { multiTurn: task.sendMode !== 'single', allowSkip: false });
    if (result.action !== 'send') {
      this.record(task, item, result.action === 'skip' ? 'skipped' : 'failed', result.action === 'skip' ? '模型判断本次无需发送' : result.action === 'stop' ? '对方要求停止联系，请人工核对' : '需要本人决定，请人工核对');
      // 只记录、不暂停：需要本人处理或对方要求停止都体现在运行记录与任务状态里，
      // 暂停与恢复交给自动回复那套状态统一处理。
      return null;
    }
    texts = texts.map(text => stripUnauthorizedProactiveVocatives(text, profile, context)).filter(Boolean);
    if (!texts.length) { this.record(task, item, 'skipped', '生成内容只有未获授权的亲昵称呼，本次未发送'); return null; }
    const unsupported = a.proactiveUnsupported(texts.join('\n'), context);
    if (unsupported) { this.record(task, item, 'skipped', unsupported); return null; }
    return { texts };
  }
  async execute(task, item, revision, signal, windowSignal) {
    const a = this.ai, profile = a.data.profiles[item.profileId];
    const valid = () => !signal.aborted && revision === task.revision && this.runnable(task);
    const check = () => {
      if (!valid()) throw new AppError('任务已取消或设置已变化', 409, 'proactive_cancelled');
      if (!profile || a.data.profiles[item.profileId] !== profile || profile.account !== task.account) throw new AppError('联系人配置已变化，请刷新后重试');
      if (this.expired(task)) throw new AppError('本轮执行时间已过，未发送', 409, 'proactive_expired');
    };
    let enteredSend = false, sent = 0, texts = [], planned = 0;
    const partial = reason => { this.record(task, item, 'sent', `已发送 ${sent}/${planned} 段；${reason}`, texts.slice(0, sent).join('\n')); item.interrupted = true; };
    try {
      check(); item.status = 'generating'; item.attempts++; await a.save(); check();
      if (!a.contacts.has(item.contact) || !profile) throw new AppError('联系人暂不可读取，请刷新联系人后重试');
      if (['sending', 'uncertain'].includes(profile.proactiveDelivery?.status)) throw new AppError('此联系人存在待核对的主动发送结果，请先核对');
      const snapshot = await a.read(profile, signal); check();
      await a.observe(profile, snapshot); check();
      await this.waitManualWindow(item.profileId, signal); check();
      if (this.blocked(profile)) throw new AppError('本人已接管或已要求停止联系，本次未发送');
      let context = snapshot, prepared = null, fresh = null;
      // The chat is re-read right before the copy is handed to the sender. A
      // message arriving mid-generation regenerates once against the newer chat
      // rather than cancelling; anything after that still gets delivered.
      for (let regen = 0; regen < 2; regen++) {
        prepared = await this.draft(task, item, profile, context, signal, check);
        if (!prepared) return;
        fresh = await a.read(profile, signal); check();
        await a.observe(profile, fresh); check();
        if (this.blocked(profile)) throw new AppError('本人已接管或已要求停止联系，本次未发送');
        if (fresh.revision === context.revision || regen > 0) break;
        context = fresh; await a.save(); check(); prepared = null;
      }
      let plan = prepared.texts;
      planned = plan.length; texts = plan;
      item.segmentsTotal = planned; item.segmentsSent = 0; item.segments = [];
      let expectedRevision = fresh.revision, regens = 0;
      for (let index = 0; index < plan.length; index++) {
        const text = plan[index];
        if (sent) {
          await a.delay(a.randomDelay('segmentDelay'), signal); check();
          fresh = await a.read(profile, signal); check(); await a.observe(profile, fresh); check();
          if (this.blocked(profile)) { partial('本人已接管或已要求停止联系，剩余段落已取消'); return; }
          if (fresh.revision !== expectedRevision) {
            // 对方在段落之间回了话：本次发起还没完成，结合这条回复重新生成剩余内容，
            // 而不是直接取消。本人自己发了话仍停止剩余段落，把对话交还给本人。
            if (this.interruption(fresh, profile) !== 'other' || regens >= maxSegmentRegens || sent >= planned) { partial('聊天已变化，剩余段落已取消'); return; }
            regens++;
            const next = await this.draft(task, item, profile, fresh, signal, check, ` 补充：本次任务已经发出 ${sent} 条（见聊天记录末尾自己发出的内容），对方刚刚回了话。请结合对方这条回复继续完成这次发起，只输出接下来还要发送的内容，不要重复已经发过的话；围绕本次目标自然接续即可。`);
            if (!next) return;
            // 与已发内容完全相同的段落直接丢掉：模型若把原开场又写一遍，不应重复发送。
            plan = next.texts.filter(t => !texts.slice(0, sent).includes(t)).slice(0, Math.max(0, planned - sent));
            if (!plan.length) { partial('对方已回复，本次发起已完成'); return; }
            texts = texts.slice(0, sent).concat(plan);
            expectedRevision = fresh.revision; index = -1;
            await a.save(); check();
            continue;
          }
        }
        item.operationId = randomUUID();
        const segment = { index: sent, operationId: item.operationId, status: 'sending' }; item.segments.push(segment);
        const record = this.record(task, item, 'sending', '', texts.slice(0, sent + 1).join('\n'));
        record.segments = item.segments; record.segmentsTotal = planned; record.segmentsSent = sent;
        profile.proactiveDelivery = { operationId: item.operationId, status: 'sending', at: a.now(), source: 'proactive', taskId: task.id, segmentsSent: sent, segmentsTotal: planned };
        // Persist intent and exact generated text before crossing the native boundary.
        await a.save(); check(); enteredSend = true;
        let delivery;
        try { delivery = await a.bridge.send({ account: task.account, contact: item.contact, revision: fresh.revision, text, operationId: item.operationId, signal }); }
        catch (error) {
          delivery = { status: 'uncertain' };
          if (error.code === 'ai_account_changed') { a.invalidate(); a.available = false; a.data.settings.enabled = false; }
        }
        // Cancellation cannot erase a late, confirmed receipt or make an ambiguous
        // native submission retryable. This writes only the captured account/run.
        if (delivery?.status === 'sent' && delivery.messageId) {
          enteredSend = false; sent++; item.segmentsSent = sent; expectedRevision = delivery.revision;
          segment.status = 'sent'; segment.messageId = delivery.messageId;
          item.messageId = delivery.messageId; this.record(task, item, 'sent', '', texts.slice(0, sent).join('\n')); record.segmentsSent = sent;
          profile.proactiveDelivery.status = 'sent'; profile.proactiveDelivery.segmentsSent = sent;
          profile.generatedIds = [...(profile.generatedIds || []), delivery.messageId].slice(-300);
          profile.sentMessages = [...(profile.sentMessages || []), { id: delivery.messageId, at: a.now(), body: a.vault.seal({ text }), source: 'proactive', taskId: task.id }].slice(-300);
          if (a.data.account === task.account) {
            a.cursors.set(profile.id, { sent: delivery.messageId, own: delivery.messageId, last: delivery.messageId, pending: false, revision: delivery.revision || fresh.revision, changedAt: a.now() });
            if (sent === 1) a.event('contacted', profile.id, 'proactive');
            // 发起完成即交棒：把这次任务的目标与要求留给该联系人的自动回复当背景。
            a.setReplyBackground(profile, task);
          }
          await a.save();
        } else if (['not-sent', 'stale'].includes(delivery?.status)) {
          enteredSend = false; segment.status = 'not-sent'; profile.proactiveDelivery.status = sent ? 'sent' : 'cancelled';
          if (sent) { partial('后续消息未提交，剩余段落已取消'); return; }
          if (windowSignal?.aborted) this.record(task, item, 'skipped', '执行窗口已结束，消息未提交');
          else if (!valid()) { this.record(task, item, 'cancelled', '任务已取消，消息未提交'); item.status = task.status === 'ended' ? 'cancelled' : 'pending'; delete item.recordId; }
          else this.record(task, item, 'failed', delivery.status === 'stale' ? '聊天内容已变化，消息未发送' : notSentReason(delivery));
          return;
        } else {
          segment.status = 'uncertain';
          profile.proactiveDelivery.status = 'uncertain';
          this.record(task, item, 'uncertain', '未获得数据库发送确认，禁止自动重发');
          return;
        }
      }
    } catch (error) {
      if (sent && !enteredSend) {
        if (profile?.proactiveDelivery && profile.proactiveDelivery.operationId === item.operationId) { profile.proactiveDelivery.status = 'sent'; profile.proactiveDelivery.interrupted = true; }
        if (item.segments?.at(-1)?.status === 'sending') item.segments.at(-1).status = 'not-sent';
        partial('执行已中断，剩余段落已取消');
      } else if (!enteredSend && windowSignal?.aborted) {
        if (profile?.proactiveDelivery && profile.proactiveDelivery.operationId === item.operationId) profile.proactiveDelivery.status = 'cancelled';
        this.record(task, item, 'skipped', '执行窗口已结束，本次未发送');
      } else if (enteredSend || item.status === 'sending' && !valid()) {
        if (enteredSend) { if (profile?.proactiveDelivery) profile.proactiveDelivery.status = 'uncertain'; this.record(task, item, 'uncertain', '发送结果待核对，禁止自动重发'); }
        else { if (profile?.proactiveDelivery && profile.proactiveDelivery.operationId === item.operationId) profile.proactiveDelivery.status = 'cancelled'; this.record(task, item, 'cancelled', '提交前取消，未发送'); item.status = task.status === 'ended' ? 'cancelled' : 'pending'; delete item.recordId; }
      } else if (!valid()) { item.status = task.status === 'ended' ? 'cancelled' : 'pending'; }
      else if (error.code === 'proactive_expired') { if (profile?.proactiveDelivery && profile.proactiveDelivery.operationId === item.operationId) profile.proactiveDelivery.status = 'cancelled'; this.record(task, item, 'skipped', error.message); }
      else this.record(task, item, 'failed', error instanceof AppError ? error.message : '本次执行失败，请检查模型或微信后重试');
    } finally {
      if (!task.contacts.some(c => c.id === item.contact) && item.status === 'pending') item.status = 'cancelled';
      this.settle(task); await a.save();
    }
  }
}
