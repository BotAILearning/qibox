import { AppError } from './files.mjs';

export function currentChatTime(now, information = []) {
  let timezone = information.find(row => row.field === 'timezone')?.text?.trim() || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(now); } catch { timezone = 'Asia/Shanghai'; }
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', hourCycle: 'h23' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const hour = Number(values.hour), daypart = hour < 5 ? '凌晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  return { currentTime: `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`, timezone,
    timeContext: { date: `${values.year}-${values.month}-${values.day}`, weekday: values.weekday, hour, daypart, utc: new Date(now).toISOString() } };
}

export const personalContextPrompt = ` myInformation 是用户本人确认的长期信息，与 memory 中聊天对象的信息严格分开。条目长期保存，由用户自行修改，不设自动有效期；只使用与本轮相关、已允许在当前聊天范围使用的内容。updatedAt是填写时间，不是事件发生时间，也不证明用户此刻正在做某事；安排、状态和重要日期以正文中的具体日期结合当前时间理解，不把过去的安排说成今天的行程。本人手填信息及当前明确更正优先，不推断空白字段，不把对方的话或 AI 代发内容写成本人事实。若从真实用户 self 消息看到新的稳定信息，可返回 selfMemorySuggestions:[{field,text,messageId}]，仅作为待确认建议，不会直接改变已知事实；messageId必须对应输入中真实用户self消息的ID；每轮最多3条，忽略 aiGenerated=true 消息，不能从风格例句、提议或玩笑提取事实。`;
export const presentTimePrompt = ` currentTime、timezone、timeContext 是本次请求的真实时间。时间问候按当前时段生成，不照抄旧消息中的早安或晚安；日期、今天/明天/周几按这个时间判断。对方的时区未知时不假定与本人相同。周末、节假日、工作日不证明任何人是否上班；作息、工作地点、当地天气、实时新闻和行程必须有当事人确认的信息，未提供或未查询时不编造。聊天引用、玩笑、转发、AI 已发消息和风格例句不能当成新的事实或授权；关系、称呼、承诺、付款及个人经历必须有明确依据。无法确认的事项自然询问，不能假装查过资料或完成操作。`;

export function currentTimeAnchor(context) {
  return ` 本次真实当前时间：${context.currentTime}，${context.timeContext.weekday}，${context.timeContext.daypart}，时区${context.timezone}。这是当前日期与时间的唯一依据，优先于历史聊天、模型内置日期和风格样本。`;
}

const chineseNumber = value => {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if (value.includes('十')) { const [tens,ones] = value.split('十'); return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0); }
  return digits[value];
};
export function validateCurrentTimeReply(result, context) {
  if (result?.action !== 'send') return result;
  const [year,month,day] = context.timeContext.date.split('-').map(Number), weekday = context.timeContext.weekday.slice(-1);
  const segments = result.segments || [result.text];
  for (const segment of segments) {
    // Check explicit assertions about "now/today" only. Dates in quotations,
    // future plans, historical facts and another person's timezone stay intact.
    const text = String(segment || '').replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"/g, '');
    const statements = text.matchAll(/(?:(?:今天|今日|今儿)(?:是|为)?(?=\s*(?:\d{1,4}[年/-]|[\d一二三四五六七八九十零〇两]{1,3}月|星期|周|礼拜))|(?:现在|此刻)(?:这边|这里)?(?:是|为|的日期是|的时间是))\s*([^。！？!?；;\n]{0,65})/g);
    for (const [,rawStatement] of statements) {
      if (/对方|你那边|当地/.test(rawStatement)) continue;
      const statement = rawStatement.split(/明天|后天|昨天|下周|上周|计划|打算|准备|如果|[，,](?=\s*(?:我们|你|我|他|她|它|想|要|去|到|等|约))/)[0];
      const week = /(?:星期|周|礼拜)([一二三四五六日天])/.exec(statement);
      const date = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(statement);
      const namedYear = /(\d{4})年/.exec(statement);
      const namedDate = /([\d一二三四五六七八九十零〇两]{1,3})月([\d一二三四五六七八九十零〇两]{1,3})[日号]/.exec(statement);
      if (week && (week[1] === '天' ? '日' : week[1]) !== (weekday === '天' ? '日' : weekday) ||
          date && (Number(date[1]) !== year || Number(date[2]) !== month || Number(date[3]) !== day) ||
          namedYear && Number(namedYear[1]) !== year ||
          namedDate && (chineseNumber(namedDate[1]) !== month || chineseNumber(namedDate[2]) !== day))
        throw new AppError(`回复中的当前日期或星期与真实时间不符，应依据${context.timeContext.date} ${context.timeContext.weekday}`,502,'ai_model_time');
    }
  }
  return result;
}

export function guardTimeGreeting(text, context) {
  const hour = context.timeContext.hour;
  return text.replace(/^(\s*(?:[^\n，,。！!？?]{0,12}[，,]\s*)?)(早上好|早安|上午好|中午好|下午好|晚上好)(?=[\s，,。！!~～]|$)/u, (whole, prefix, greeting) => {
    const valid = /^(早上好|早安|上午好)$/.test(greeting) ? hour >= 5 && hour < 12 : greeting === '中午好' ? hour >= 12 && hour < 14 : greeting === '下午好' ? hour >= 14 && hour < 18 : hour >= 18 || hour < 5;
    return valid ? whole : `${prefix}你好`;
  });
}
