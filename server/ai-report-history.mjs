import { AppError } from './files.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const dateText = timestamp => {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return '';
  return new Date(timestamp * 1000 + 28800000).toISOString().slice(0, 10);
};
const timeText = timestamp => {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return '';
  return new Date(timestamp * 1000 + 28800000).toISOString().slice(11, 16);
};

export function reportMetrics(messages) {
  const rows = Array.isArray(messages) ? messages.filter(message => typeof message?.text === 'string' && message.text.trim()) : [];
  const self = rows.filter(message => message.direction === 'self').length;
  const other = rows.filter(message => message.direction === 'other').length;
  const dates = rows.map(message => dateText(message.timestamp)).filter(Boolean);
  const hours = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const message of rows) {
    const time = timeText(message.timestamp), hour = time ? Number(time.slice(0, 2)) : -1;
    if (hour >= 6 && hour < 12) hours.morning++;
    else if (hour >= 12 && hour < 18) hours.afternoon++;
    else if (hour >= 18 && hour < 24) hours.evening++;
    else if (hour >= 0) hours.night++;
  }
  return { total: rows.length, self, other, unknown: Math.max(0, rows.length - self - other), activeDays: new Set(dates).size, hours };
}

export function reportExcerpts(messages, limit = 4) {
  const rows = Array.isArray(messages) ? messages : [];
  return rows.filter(message => (message?.direction === 'self' || message?.direction === 'other') && typeof message?.text === 'string' && message.text.trim()).slice(0, limit).map(message => ({
    direction: message.direction,
    date: dateText(message.timestamp),
    text: message.text.trim().slice(0, 120),
  }));
}

export function actualRange(messages) {
  const rows = (Array.isArray(messages) ? messages : []).filter(message => Number.isSafeInteger(message?.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  return rows.length ? { from: dateText(rows[0].timestamp), to: dateText(rows.at(-1).timestamp) } : null;
}

export function historySummary(report) {
  return {
    id: report.id,
    contact: report.contact,
    label: report.label,
    nickname: report.nickname,
    createdAt: report.createdAt,
    requestedRange: report.requestedRange,
    actualRange: report.actualRange,
    count: report.count,
    skipped: report.skipped,
    truncated: report.truncated === true,
    summary: typeof report.report === 'string' ? report.report.replace(/\s+/g, ' ').trim().slice(0, 140) : '',
  };
}

export function validReportId(id) {
  if (!uuid(id)) throw new AppError('报告标识无效', 400);
  return id;
}
