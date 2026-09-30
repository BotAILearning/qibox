// Keep the saved Wiki intact. A reply receives only the memories useful for
// this turn, with historical material explicitly marked as background.
const durableFields = new Set(['name', 'addressing', 'phone', 'birthday', 'date', 'school', 'household', 'residence', 'workplace', 'employer', 'shipping', 'group_info', 'group_member', 'group_rule']);
const lastKnownFields = new Set(['phone', 'household', 'residence', 'workplace', 'employer', 'shipping']);
const timeBoundFields = new Set(['group_plan', 'group_event']);
const temporaryWords = /(?:生病|发烧|感冒|不舒服|例假|经期|月经|痛经|怀孕|住院|请假|出差|加班|考试|失眠|今天|今晚|明天|昨天|这周|本周|下周|上周|最近|目前|暂时|正在|刚刚|待会|稍后|准备去|计划去|打算去|约好|预约)/u;
const preferenceWords = /(?:喜欢|不喜欢|偏好|讨厌|介意|习惯|爱好)/u;
const ignoredTerms = new Set(['我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '觉得', '现在', '今天', '明天', '最近', '一下', '的话', '时候']);

function terms(value) {
  const result = new Set();
  const text = String(value || '').toLowerCase();
  for (const word of text.match(/[a-z0-9]{3,}/g) || []) result.add(word);
  for (const run of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let size = 2; size <= Math.min(3, run.length); size++) {
      for (let index = 0; index + size <= run.length; index++) {
        const term = run.slice(index, index + size);
        if (!ignoredTerms.has(term)) result.add(term);
      }
    }
  }
  return result;
}

export function memoryIsHistorical(entry, now = Date.now()) {
  if (entry?.status === 'historical' || entry?.status === 'uncertain') return true;
  if (Number.isSafeInteger(entry?.from) && now < entry.from) return true;
  if (Number.isSafeInteger(entry?.to) && now > entry.to) return true;
  if (timeBoundFields.has(entry?.field)) return true;
  return temporaryWords.test(String(entry?.text || ''));
}

export function selectMemoryForChat(memory, { query = '', now = Date.now(), maxEntries = 24, maxChars = 4500 } = {}) {
  if (memory?.unavailable) return { summary: '', entries: [], unavailable: true };
  const queryTerms = terms(query);
  const candidates = (memory?.entries || []).map((entry, index) => {
    const historical = memoryIsHistorical(entry, now);
    const entryTerms = terms(entry.text);
    const matches = [...queryTerms].filter(term => entryTerms.has(term)).length;
    const durable = durableFields.has(entry.field);
    const observedAt = Number.isSafeInteger(entry.observedAt) ? entry.observedAt : Number.isSafeInteger(entry.recordedAt) ? entry.recordedAt : 0;
    return { entry, index, historical, matches, durable, observedAt,
      score: matches * 20 + (durable && !historical ? 9 : 0) + (!historical && preferenceWords.test(entry.text) ? 5 : 0) + (entry.manual && !historical ? 3 : 0) };
  }).filter(row => !row.historical || row.matches > 0);
  candidates.sort((a, b) => b.score - a.score || b.observedAt - a.observedAt || a.index - b.index);
  const selected = []; let chars = 0;
  for (const row of candidates) {
    if (selected.length >= maxEntries) break;
    const length = row.entry.text.length;
    if (chars + length > maxChars) continue;
    chars += length;
    selected.push({ ...row.entry, contextRole: row.historical ? 'historical' : lastKnownFields.has(row.entry.field) ? 'lastKnown' : 'current' });
  }
  return { summary: selected.map(entry => entry.text).join('\n'), entries: selected };
}
