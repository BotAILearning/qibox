// Wire-only encoding. State, routing and validation retain the original DTO.
export const replyWireReferencePrompt = ' messages采用messageEncoding指定的表格；按列名读取每行，author仅为发言人，事项主体仍按原话。时间默认字段逐行继承，不推导未提供事实；fields中的text、textRef、quote及其他标记全部有效。原身份、安全、风格与输出协议不变。';
const columns = ['id', 'author', 'authorship', 'aiGenerated', 'timestamp', 'sourceDate', 'temporal', 'pending', 'fields'];
const core = new Set(['id', 'direction', 'speaker', 'authorship', 'aiGenerated', 'timestamp', 'sourceDate', 'temporal', 'pending']);
const supported = new Set([...core, 'type', 'text', 'textRef', 'quote', 'relativeDates', 'relativeDateWords',
  'excerpt', 'truncated', 'textTruncated', 'unresolved', 'assumedPresent', 'deliveryConfidence']);
const temporalKeys = new Set(['known', 'timezone', 'calendarBasis', 'sourceDate', 'localTime', 'ageSeconds', 'daysAgo', 'relation']);
export function compactReplyWire(input) {
  if (input?.mode !== 'reply' || input.kind !== 'person' || input.sourceIndexVersion !== 2 ||
      Object.hasOwn(input, 'messageEncoding') || !Array.isArray(input.messages) || !input.messages.length) return input;
  const authors = {}, rows = input.messages, anchor = input.roleAnchor;
  for (const row of rows) {
    if (!row || !['self', 'other'].includes(row.direction) || !row.speaker || row.speaker.role !== row.direction ||
        ![...core].every(key => Object.hasOwn(row, key)) || Object.keys(row).some(key => !supported.has(key)) ||
        typeof row.id !== 'string' || !row.id || row.temporal?.known !== true ||
        Object.keys(row.temporal).some(key => !temporalKeys.has(key)) || row.temporal.sourceDate !== row.sourceDate ||
        row.speaker.id !== (row.direction === 'self' ? anchor?.author?.id : anchor?.recipient?.id)) return input;
    const label = row.direction === 'self' ? '本人' : '对方', entry = { direction: row.direction, speaker: row.speaker };
    if (authors[label] && JSON.stringify(authors[label]) !== JSON.stringify(entry)) return input;
    authors[label] = entry;
  }
  const defaults = {};
  for (const [key, value] of Object.entries(rows[0].temporal)) {
    if (key !== 'sourceDate' && (value === null || ['string', 'number', 'boolean'].includes(typeof value)) &&
        rows.every(row => Object.hasOwn(row.temporal, key) && row.temporal[key] === value)) defaults[key] = value;
  }
  const encoding = { version: 1, columns: [...columns], authors, temporalDefaults: defaults, temporalSourceDate: 'sourceDate',
    rule: '发言人只表示原话作者，不代表事情主人。temporal继承temporalDefaults和本行sourceDate；fields保留正文、textRef、引用及所有其他原字段。' };
  const packed = rows.map(row => [
    row.id, row.direction === 'self' ? '本人' : '对方', row.authorship, row.aiGenerated, row.timestamp, row.sourceDate,
    Object.fromEntries(Object.entries(row.temporal).filter(([key]) => key !== 'sourceDate' && !Object.hasOwn(defaults, key))),
    row.pending, Object.fromEntries(Object.entries(row).filter(([key]) => !core.has(key))),
  ]);
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'messages') { result.messageEncoding = encoding; result.messages = packed; }
    else result[key] = value;
  }
  // A size guard, not a token/price/quality assertion.
  return JSON.stringify(result).length + replyWireReferencePrompt.length < JSON.stringify(input).length ? result : input;
}
