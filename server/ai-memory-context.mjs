// Keep the saved Wiki intact. A reply receives only the memories useful for
// this turn, with historical material explicitly marked as background.
const durableFields = new Set(['name', 'addressing', 'phone', 'birthday', 'date', 'school', 'household', 'residence', 'workplace', 'employer', 'shipping', 'group_info', 'group_member', 'group_rule']);
const lastKnownFields = new Set(['phone', 'household', 'residence', 'workplace', 'employer', 'shipping']);
const timeBoundFields = new Set(['group_plan', 'group_event']);
const temporaryWords = /(?:生病|发烧|感冒|不舒服|例假|经期|月经|痛经|怀孕|住院|请假|出差|加班|考试|失眠|今天|今晚|明天|昨天|这周|本周|下周|上周|最近|目前|暂时|正在|刚刚|待会|稍后|准备去|计划去|打算去|约好|预约)/u;
const preferenceWords = /(?:喜欢|不喜欢|偏好|讨厌|介意|习惯|爱好)/u;
const fieldTerms = {city:'住哪里 哪个城市 居住地 地址 哪里人',occupation:'工作 职业 单位 公司 学校 专业',schedule:'作息 空闲 忙 联系 休息',interests:'爱好 兴趣 喜欢 活动',preferences:'饮食 忌口 出行 习惯 喜欢',status:'近况 最近 安排 行程 出差',birthday:'生日 公历 农历',relationships:'家人 家庭 婚姻 宠物 孩子',health:'身体 健康 运动 过敏',experiences:'家乡 经历 旅行 求学'};
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

export function selectMemoryForChat(memory, { query = '', now = Date.now(), maxEntries = 16, maxChars = 3200, relevantOnly = false } = {}) {
  if (memory?.unavailable) return { summary: '', entries: [], unavailable: true };
  const topic = String(query || '');
  const expansion = [/(?:吃|饭|餐|饮食|菜单|聚餐)/u.test(topic) ? '饮食 忌口 过敏 健康 生活习惯' : '',
    /(?:有空|空闲|约|见面|聚会|几点|安排|日程)/u.test(topic) ? '作息 空闲 近况 安排 行程' : '',
    /(?:住|城市|地址|哪里)/u.test(topic) ? '居住地 城市 住所' : '',
    /(?:工作|职业|单位|公司|上班|学校|专业)/u.test(topic) ? '职业 工作 学校 单位' : ''].join(' ');
  const queryTerms = terms(topic + ' ' + expansion);
  const candidates = (memory?.entries || []).map((entry, index) => {
    const historical = memoryIsHistorical(entry, now);
    const entryTerms = terms(entry.text + ' ' + (fieldTerms[entry.field] || ''));
    const matches = [...queryTerms].filter(term => entryTerms.has(term)).length;
    const durable = durableFields.has(entry.field);
    const observedAt = Number.isSafeInteger(entry.observedAt) ? entry.observedAt : Number.isSafeInteger(entry.recordedAt) ? entry.recordedAt : 0;
    return { entry, index, historical, matches, durable, observedAt,
      score: matches * 20 + (durable && !historical ? 9 : 0) + (!historical && preferenceWords.test(entry.text) ? 5 : 0) + (entry.manual && !historical ? 3 : 0) };
  }).filter(row => (!row.historical || row.matches > 0) && (!relevantOnly || row.matches > 0 || row.entry.field === 'addressing'));
  candidates.sort((a, b) => b.score - a.score || b.observedAt - a.observedAt || a.index - b.index);
  const selected = [], seen = new Set(); let chars = 0;
  for (const row of candidates) {
    if (selected.length >= maxEntries) break;
    const key = `${row.entry.subjectId || ''}\0${row.entry.text.trim().normalize('NFKC')}`;
    if (seen.has(key)) continue;
    const length = row.entry.text.length;
    if (chars + length > maxChars) continue;
    chars += length; seen.add(key);
    selected.push({ ...row.entry, contextRole: row.historical ? 'historical' : lastKnownFields.has(row.entry.field) ? 'lastKnown' : 'current' });
  }
  return { summary: selected.map(entry => entry.text).join('\n'), entries: selected };
}
