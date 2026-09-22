import { AppError } from './files.mjs';
import { textField } from './ai-schema.mjs';

const DAY = 86400000, OFFSET = 8 * 3600000;
const fail = () => new AppError('无法识别时间，请用“明天晚上8点”“每天上午”或选择具体时间');
function number(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  if (text === '两') return 2;
  if (text.includes('十')) { const [a, b] = text.split('十'); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0); }
  return digits.indexOf(text);
}
// Calendar times are explicitly Asia/Shanghai, independent of the NAS timezone.
export function parseSchedule(value, now = Date.now(), random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min) {
  const text = textField(value, 120, true).replace(/\s+/g, '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const nextAt = Date.parse(text); if (!Number.isFinite(nextAt) || nextAt <= now) throw new AppError('请选择未来的时间');
    return { text, repeat: 'once', nextAt, timezone: 'Asia/Shanghai' };
  }
  const relative = /^(\d+|[一二两三四五六七八九十]+)(分钟|小时|天)后$/.exec(text);
  if (relative) {
    const count = number(relative[1]); if (count < 1 || count > 365) throw fail();
    return { text, repeat: 'once', nextAt: now + count * ({ 分钟: 60000, 小时: 3600000, 天: DAY }[relative[2]]), timezone: 'Asia/Shanghai' };
  }
  const parsed = /^(每天|每日|每周[一二三四五六日天]|今天|今日|今晚|明天|明晚|后天)?(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间)?(?:(\d{1,2}|[零一二两三四五六七八九十]+)(?:点|时|:)(半|\d{1,2}|[零一二三四五六七八九十]+)?分?)?$/.exec(text);
  if (!parsed || (!parsed[2] && !parsed[3] && !/晚/.test(parsed[1] || ''))) throw fail();
  const [, day = '', part = /晚/.test(day) ? '晚上' : '', hourText, minuteText] = parsed;
  const repeat = /^每[天日]/.test(day) ? 'daily' : day.startsWith('每周') ? 'weekly' : 'once';
  let minuteStart, minuteEnd;
  if (hourText) {
    let hour = number(hourText), minute = minuteText === '半' ? 30 : minuteText ? number(minuteText) : 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw fail();
    if (['下午', '傍晚', '晚上', '晚间'].includes(part) && hour < 12) hour += 12;
    if (part === '中午' && hour < 11) hour += 12;
    if (part === '凌晨' && hour === 12) hour = 0;
    minuteStart = minuteEnd = hour * 60 + minute;
  } else {
    const windows = { 凌晨: [0, 120], 早上: [420, 540], 早晨: [420, 540], 上午: [540, 690], 中午: [720, 780], 下午: [840, 1020], 傍晚: [1020, 1140], 晚上: [1140, 1260], 晚间: [1140, 1260] };
    [minuteStart, minuteEnd] = windows[part] || []; if (minuteStart === undefined) throw fail();
  }
  const local = new Date(now + OFFSET), midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET;
  let offset = day.startsWith('明') ? 1 : day === '后天' ? 2 : 0;
  const weekday = repeat === 'weekly' ? '日一二三四五六'.indexOf(day.slice(2).replace('天', '日')) : null;
  if (repeat === 'weekly') offset = (weekday - local.getUTCDay() + 7) % 7;
  let base = midnight + offset * DAY;
  let start = Math.max(minuteStart, Math.floor((now - base) / 60000) + 1);
  if (start > minuteEnd) {
    if (repeat === 'once' && /今天|今日|今晚/.test(day)) throw new AppError('这个时间已过去，请选择未来的时间');
    base += (repeat === 'weekly' ? 7 : 1) * DAY; start = minuteStart;
  }
  return { text, repeat, weekday, minuteStart, minuteEnd, nextAt: base + random(start, minuteEnd) * 60000, timezone: 'Asia/Shanghai' };
}

export function advanceSchedule(schedule, now, random) {
  if (schedule.repeat === 'once') return null;
  // Move to the next calendar occurrence; never replay missed intervals in a burst.
  const afterWindow = Math.max(now, Math.floor((schedule.nextAt + OFFSET) / DAY) * DAY - OFFSET + (schedule.minuteEnd + 1) * 60000);
  return parseSchedule(schedule.text, afterWindow, random).nextAt;
}
