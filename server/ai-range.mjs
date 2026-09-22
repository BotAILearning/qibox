import { AppError } from './files.mjs';

export function dateRange(value = {}) {
  const { from, to } = value;
  if (!from && !to) return { from: 0, to: 9999999999, fromDate: '', toDate: '' };
  function day(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AppError('请选择开始和结束日期');
    const ms = Date.parse(v + 'T00:00:00+08:00');
    if (!Number.isFinite(ms) || new Date(ms + 28800000).toISOString().slice(0, 10) !== v || ms < 0) throw new AppError('日期无效');
    return ms / 1000;
  }
  const start = day(from), end = day(to) + 86400;
  if (start >= end || end > 9999999999) throw new AppError('开始日期不能晚于结束日期');
  return { from: start, to: end, fromDate: from, toDate: to };
}

// Read the selected range once and keep what came back. A second verification
// pass used to compare the material against itself, but WeChat keeps writing
// while a long read runs: the comparison then rejected ranges that were simply
// live, and re-reading only made the window longer. The bridge now returns one
// globally ordered, bounded result, so validate that result in one pass.
export async function readStableRange(bridge, args, check = () => args.signal?.throwIfAborted()) {
  const limit = 30000;
  check();
  const { cursor: _cursor, ...request } = args;
  const page = await bridge.readRange(request);
  check();
  if (page.account !== args.account || page.contact !== args.contact || !Array.isArray(page.messages) ||
      Object.prototype.hasOwnProperty.call(page, 'nextCursor') || page.messages.length > limit ||
      (page.truncated !== undefined && typeof page.truncated !== 'boolean') || (page.truncatedReasons !== undefined && (!Array.isArray(page.truncatedReasons) || page.truncatedReasons.some(value => typeof value !== 'string')))) {
    throw new AppError('无法确认聊天数据归属或范围，请重试');
  }
  const ids = new Set(); let previous = -1;
  for (const message of page.messages) {
    if (!Number.isSafeInteger(message.timestamp) || message.timestamp < args.from || message.timestamp >= args.to ||
        message.timestamp < previous || typeof message.id !== 'string' || !message.id || ids.has(message.id)) {
      throw new AppError('无法确认聊天数据范围或顺序完整性，请重试');
    }
    ids.add(message.id); previous = message.timestamp;
  }
  return { messages: page.messages, count: page.messages.length, truncated: page.truncated === true, truncatedReasons: Array.isArray(page.truncatedReasons) ? [...new Set(page.truncatedReasons)] : [] };
}
