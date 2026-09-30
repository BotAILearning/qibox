const dayMs = 86400000;
const shanghaiOffsetMs = 8 * 3600000;
const localDate = millis => new Date(millis + shanghaiOffsetMs).toISOString().slice(0, 10);

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
