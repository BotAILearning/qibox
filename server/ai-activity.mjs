import { AppError } from './files.mjs';
export function activityRange({ from = '', to = '' } = {}) {
  const parse = value => {
    if (!value) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError('日期格式无效');
    const time = Date.parse(`${value}T00:00:00+08:00`);
    if (!Number.isFinite(time) || new Date(time + 28800000).toISOString().slice(0, 10) !== value) throw new AppError('日期无效');
    return time;
  };
  const start = parse(from), end = parse(to);
  if (start !== null && end !== null && start > end) throw new AppError('开始日期不能晚于结束日期');
  return at => start === null && end === null || Number.isFinite(at) && (start === null || at >= start) && (end === null || at < end + 86400000);
}
