import { AppError } from './files.mjs';

const DAY = 86400000, OFFSET = 8 * 3600000;
const day = at => Math.floor((at + OFFSET) / DAY);
const dateOf = n => new Date(n * DAY).toISOString().slice(0, 10);
function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError('开始日期无效');
  const n = Date.parse(value + 'T00:00:00Z') / DAY;
  if (!Number.isInteger(n) || dateOf(n) !== value) throw new AppError('开始日期无效');
  return n;
}
function minute(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new AppError('执行时间应为 HH:mm');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
export function proactiveSchedule(value = {}, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['once', 'daily', 'weekdays', 'weekly', 'custom'].includes(value.cycle)) throw new AppError('请选择执行周期');
  // Immediate tasks deliberately ignore every hidden time field from the form.
  if (value.cycle === 'once') return { cycle: 'once', mode: 'fixed', timezone: 'Asia/Shanghai' };
  if (!['fixed', 'random'].includes(value.mode)) throw new AppError('请选择执行时间方式');
  const result = { cycle: value.cycle, mode: value.mode, timezone: 'Asia/Shanghai', startDate: value.startDate || dateOf(day(now)) };
  dateDay(result.startDate);
  if (value.mode === 'fixed') { minute(value.time); result.time = value.time; }
  else {
    minute(value.start); minute(value.end);
    if (value.start === value.end) throw new AppError('随机时间段的起止时间不能相同');
    result.start = value.start; result.end = value.end;
  }
  if (value.cycle === 'weekly') {
    if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw new AppError('请选择每周执行日（0 为周日）');
    result.weekdays = [...new Set(value.weekdays)].sort();
  }
  if (value.cycle === 'custom') {
    if (!Number.isInteger(value.intervalDays) || value.intervalDays < 1 || value.intervalDays > 365) throw new AppError('自定义周期应为每 1–365 天');
    result.intervalDays = value.intervalDays;
  }
  return result;
}

// The occurrence belongs to the calendar day on which its window starts.
// The persisted occurrenceDate prevents a cross-midnight window running twice.
export function nextProactiveOccurrence(schedule, now, random, afterDate = null) {
  if (schedule.cycle === 'once') return { nextAt: afterDate ? null : now, occurrenceDate: 'once' };
  const anchor = dateDay(schedule.startDate), after = afterDate && afterDate !== 'once' ? dateDay(afterDate) : -Infinity;
  const start = minute(schedule.mode === 'fixed' ? schedule.time : schedule.start);
  let end = schedule.mode === 'fixed' ? start : minute(schedule.end);
  if (end < start) end += 1440;
  for (let n = Math.max(anchor, day(now) - 1, after + 1), attempts = 0; attempts < 3660; n++, attempts++) {
    const weekday = new Date(n * DAY).getUTCDay();
    if (schedule.cycle === 'weekdays' && (weekday === 0 || weekday === 6) || schedule.cycle === 'weekly' && !schedule.weekdays.includes(weekday) || schedule.cycle === 'custom' && (n - anchor) % schedule.intervalDays !== 0) continue;
    const low = n * DAY - OFFSET + start * 60000, high = n * DAY - OFFSET + end * 60000;
    if (high < now) continue;
    return { nextAt: schedule.mode === 'fixed' ? low : random(Math.max(low, Math.ceil(now)), high), occurrenceDate: dateOf(n) };
  }
  throw new AppError('无法计算下次执行时间');
}

// How long one occurrence is allowed to keep working. A fixed occurrence runs
// for FIXED_GRACE_MS past its scheduled time. A random one keeps whatever is
// left of its window, but never less than RANDOM_MIN_GRACE_MS from the moment
// it actually started, so a draw that lands near the end still gets room.
export const FIXED_GRACE_MS = 60 * 60000, RANDOM_MIN_GRACE_MS = 15 * 60000;
export function proactiveOccurrenceDeadline(schedule, occurrenceDate, triggerAt = null) {
  if (schedule.cycle === 'once') return Infinity;
  const base = dateDay(occurrenceDate) * DAY - OFFSET;
  // Extending from the real start only applies when the run actually began
  // inside its own slot. A task that was missed for days must not be handed a
  // fresh grace period at reboot time, or it would replay an old occurrence.
  const extend = (natural, grace) => triggerAt !== null && triggerAt <= natural ? Math.max(natural, triggerAt + grace) : natural;
  if (schedule.mode === 'fixed') return extend(base + minute(schedule.time) * 60000 + FIXED_GRACE_MS, FIXED_GRACE_MS);
  const start = minute(schedule.start), end = minute(schedule.end);
  return extend(base + (end < start ? end + 1440 : end) * 60000, RANDOM_MIN_GRACE_MS);
}
