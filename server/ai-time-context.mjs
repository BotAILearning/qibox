const dayMs = 86400000;
const shanghaiOffsetMs = 8 * 3600000;
const localDate = millis => new Date(millis + shanghaiOffsetMs).toISOString().slice(0, 10);

// Native chat timestamps are Unix seconds. Missing/invalid timestamps stay
// unknown; the time this request ran must never become a message's sent time.
const sourceMillis = message => Number.isSafeInteger(message?.timestamp) && message.timestamp >= 0 && message.timestamp <= 253402214399
  ? message.timestamp * 1000 : null;

export function annotateChatTimes(messages, now, timezone = 'Asia/Shanghai') {
  let formatter;
  const formatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  try { formatter = new Intl.DateTimeFormat('en-CA', { ...formatOptions, timeZone: timezone }); }
  catch { timezone = 'Asia/Shanghai'; formatter = new Intl.DateTimeFormat('en-CA', { ...formatOptions, timeZone: timezone }); }
  const parts = millis => Object.fromEntries(formatter.formatToParts(millis).map(part => [part.type, part.value]));
  const dateOf = value => `${value.year}-${value.month}-${value.day}`;
  const dayNumber = value => Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)) / dayMs;
  const today = parts(now);
  return messages.map(message => {
    const { sourceDate: _sourceDate, relativeDates: _relativeDates, relativeDateWords: _relativeDateWords, temporal: _temporal, ...sourceMessage } = message;
    const millis = sourceMillis(message);
    if (millis === null) return { ...sourceMessage, temporal: { known: false, timezone, calendarBasis: 'viewer-timezone', relation: 'unknown', usableAsCurrentState: false } };
    const source = parts(millis), sourceDate = dateOf(source), daysAgo = dayNumber(today) - dayNumber(source);
    const elapsedSeconds = Math.floor((now - millis) / 1000);
    const relativeDates = {};
    const relativeDateWords = [];
    // Only self has a known timezone. The counterpart's day words stay words:
    // the viewer's display date does not establish their local event date.
    for (const [word, offset] of [['今天', 0], ['昨天', -1], ['前天', -2], ['明天', 1], ['后天', 2]]) {
      if (!String(message.text || '').includes(word)) continue;
      if (message.direction === 'self') relativeDates[word] = new Date((dayNumber(source) + offset) * dayMs).toISOString().slice(0, 10);
      else relativeDateWords.push(word);
    }
    return { ...sourceMessage, sourceDate, ...(Object.keys(relativeDates).length ? { relativeDates } : {}),
      ...(relativeDateWords.length ? { relativeDateWords } : {}),
      temporal: { known: true, timezone, calendarBasis: 'viewer-timezone', sourceDate, localTime: `${sourceDate}T${source.hour}:${source.minute}:${source.second}`,
        ageSeconds: elapsedSeconds >= 0 ? elapsedSeconds : null, daysAgo,
        ...(elapsedSeconds < 0 ? { usableAsCurrentState: false } : {}),
        relation: elapsedSeconds < 0 ? 'future' : daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : 'earlier' } };
  });
}

// Only an explicit assertion that the recipient *just spoke* is checked here.
// Semantic topic relevance remains a model decision. A short midnight gap is
// still recent; quotes, unknown timestamps and questions about earlier progress
// must not be blocked merely because the message's calendar date differs.
export function staleProactiveTimeClaim(result, messages, now) {
  if (String(result?.action || '').toLowerCase() !== 'send') return false;
  const text = [result.text, ...(Array.isArray(result.segments) ? result.segments : [])]
    .map(part => typeof part === 'string' ? part : part?.text || '').join(' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"/gu, '');
  if (!/(?:你|您)(?:刚才|刚刚)(?:说|问|提|发)|接着刚才(?:说|聊|的)/u.test(text)) return false;
  const incoming = messages.filter(message => message.direction === 'other');
  if (!incoming.length || incoming.some(message => sourceMillis(message) === null)) return false;
  return incoming.every(message => now - sourceMillis(message) >= 4 * 3600000);
}

export function annotateSourceDates(messages) {
  return messages.map(message => {
    if (!Number.isSafeInteger(message?.timestamp)) return message;
    const text = String(message.text || '');
    if (!/今天|昨天|前天|明天|后天|去年|前年/u.test(text)) return message;
    const at = message.timestamp * 1000;
    const relativeDates = {};
    for (const [word, offset] of [['今天', 0], ['昨天', -1], ['前天', -2], ['明天', 1], ['后天', 2]]) {
      if (text.includes(word)) relativeDates[word] = localDate(at + offset * dayMs);
    }
    const sourceDate = localDate(at);
    for (const [word, years] of [['去年', 1], ['前年', 2]]) {
      if (text.includes(word)) {
        const year = Number(sourceDate.slice(0, 4)) - years;
        relativeDates[word] = `${year}${sourceDate.slice(4)}`;
      }
    }
    return { ...message, sourceDate, relativeDates };
  });
}

const temporaryState = /感冒|发烧|生病|不舒服|住院|压力大|焦虑|很累|太累/u;
const staleFollowup = /好点了吗|好些了吗|好了吗|还难受|还不舒服|感冒|生病|发烧|身体|压力|焦虑|还累|累吗/u;

export function staleTemporaryProactive(result, messages, now, purpose = '') {
  if (String(result?.action || '').toLowerCase() !== 'send' || temporaryState.test(String(purpose))) return false;
  const text = [result.text, ...(Array.isArray(result.segments) ? result.segments : [])]
    .map(part => typeof part === 'string' ? part : part?.text || '').join(' ');
  if (!staleFollowup.test(text)) return false;
  const incoming = (messages || []).filter(message => message.direction === 'other' && Number.isFinite(message.timestamp));
  const threshold = now - 7 * dayMs;
  const at = message => message.timestamp < 1e12 ? message.timestamp * 1000 : message.timestamp;
  return incoming.some(message => at(message) < threshold && temporaryState.test(String(message.text || '')))
    && !incoming.some(message => at(message) >= threshold && temporaryState.test(String(message.text || '')));
}
