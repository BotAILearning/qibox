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
