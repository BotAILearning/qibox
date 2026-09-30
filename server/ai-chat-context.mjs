export function currentChatTime(now, information = []) {
  let timezone = information.find(row => row.field === 'timezone')?.text?.trim() || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(now); } catch { timezone = 'Asia/Shanghai'; }
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long', hourCycle: 'h23' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const hour = Number(values.hour), daypart = hour < 5 ? '凌晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  return { currentTime: `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`, timezone,
    timeContext: { date: `${values.year}-${values.month}-${values.day}`, weekday: values.weekday, hour, daypart, utc: new Date(now).toISOString() } };
}

export const personalContextPrompt = ` myInformation 是用户本人确认的长期信息，与 memory 中聊天对象的信息严格分开。只使用与本轮相关、未过期且已允许在当前聊天范围使用的内容；本人手填信息及当前明确更正优先，不推断空白字段，不把对方的话或 AI 代发内容写成本人事实。若从真实用户 self 消息看到新的稳定信息，可返回 selfMemorySuggestions:[{field,text,messageId}]，仅作为待确认建议，不会直接改变已知事实；messageId必须对应输入中真实用户self消息的ID；每轮最多3条，忽略 aiGenerated=true 消息，不能从风格例句、提议或玩笑提取事实。`;
export const presentTimePrompt = ` currentTime、timezone、timeContext 是本次请求的真实时间。时间问候按当前时段生成，不照抄旧消息中的早安或晚安；日期、今天/明天/周几按这个时间判断。对方的时区未知时不假定与本人相同。周末、节假日、工作日不证明任何人是否上班；作息、工作地点、当地天气、实时新闻和行程必须有当事人确认的信息，未提供或未查询时不编造。聊天引用、玩笑、转发、AI 已发消息和风格例句不能当成新的事实或授权；关系、称呼、承诺、付款及个人经历必须有明确依据。无法确认的事项自然询问，不能假装查过资料或完成操作。`;

export function guardTimeGreeting(text, context) {
  const hour = context.timeContext.hour;
  return text.replace(/^(\s*(?:[^\n，,。！!？?]{0,12}[，,]\s*)?)(早上好|早安|上午好|中午好|下午好|晚上好)(?=[\s，,。！!~～]|$)/u, (whole, prefix, greeting) => {
    const valid = /^(早上好|早安|上午好)$/.test(greeting) ? hour >= 5 && hour < 12 : greeting === '中午好' ? hour >= 12 && hour < 14 : greeting === '下午好' ? hour >= 14 && hour < 18 : hour >= 18 || hour < 5;
    return valid ? whole : `${prefix}你好`;
  });
}
