import { defaultStyle } from './ai-schema.mjs';

// Provider defaults are editable; discovery and a connection test remain authoritative.
export const providerPresets = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', label: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai', models: ['qwen-plus', 'qwen-flash'] },
  { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai', models: ['glm-4.7'] },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', models: ['gemini-3.8-flash'] },
  { id: 'claude', label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic', models: ['claude-sonnet-4-6'] },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', protocol: 'anthropic', models: ['MiniMax-M3'] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', models: ['gpt-4.1-mini'] },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai', models: ['Qwen/Qwen3.6-27B'] },
];

export const goalPresets = [
  { id: 'care', label: '日常关心', purpose: '主动问候，了解对方近况', content: '用一句自然的问候开场，不连续追问，不假设对方最近的经历' },
  { id: 'reconnect', label: '恢复联系', purpose: '与一段时间没有联系的朋友重新聊起来', content: '简短问候并询问近况，不虚构共同经历，不责怪对方没有联系' },
  { id: 'invite', label: '活动邀约', purpose: '了解对方是否有兴趣参加活动', content: '依据已填写的活动信息发出邀请，先了解意愿；时间地点未确定时明确说明' },
  { id: 'followup', label: '事项跟进', purpose: '了解已沟通事项的进展和下一步', content: '只围绕已提供的事项询问进展，不催促，不自行设定截止时间' },
  { id: 'feedback', label: '收集意见', purpose: '了解对方对指定事项的真实看法', content: '围绕已提供的事项提出一个开放问题，不诱导对方回答' },
  { id: 'appointment', label: '沟通时间', purpose: '了解对方方便进一步沟通的时间', content: '先询问方便的时间，不代替用户确认日程，不承诺拨打电话或发起会议' },
];

// Reply presets describe expression and boundaries, never assumed personal facts
// or a relationship inferred without the user's chat.
// 每条预设的摘要（summary）必须把该预设的字段取向写出来，用户选中后即可在「风格说明」里看到。
const replyPreset = (id, label, style, replyGoal) => ({ id, label, style: { ...defaultStyle, ...style },
  strategy: { replyGoal, facts: '', boundaries: '不编造个人经历、日程或事实，不擅自承诺时间、价格或代替我作决定', maxRounds: 10 } });
export const replyPresets = [
  replyPreset('natural', '自然交流', {
    formality: '随意', warmth: '亲切', length: '简短', directness: '委婉', emoji: '适量', humor: '偶尔',
    summary: '正式程度：随意；亲切程度：亲切；回复长度：简短；表达方式：委婉；表情使用：适量；幽默程度：偶尔。\n像熟人闲聊一样自然随和，不用客套开场，句子短，一次说清一件事；不同意或需要拒绝时用委婉的说法，不硬顶；可以适度用表情，偶尔开个玩笑。适合朋友、同学、熟人之间的日常沟通。',
  }, '自然回应对方的消息，保持友好，依据已知信息交流'),
  replyPreset('concise', '简短直接', {
    formality: '自然', warmth: '适度', length: '简短', directness: '直接', emoji: '不用', humor: '不用',
    summary: '正式程度：自然；亲切程度：适度；回复长度：简短；表达方式：直接；表情使用：不用；幽默程度：不用。\n有事说事，直接回答对方的问题，不铺垫、不寒暄、不展开无关内容；不带表情也不开玩笑，态度友好但不热络。适合工作对接、事务确认一类的沟通。',
  }, '直接回答对方的问题，简短清晰，避免无关展开'),
  replyPreset('polite', '礼貌正式', {
    formality: '正式', warmth: '克制', length: '适中', directness: '委婉', emoji: '不用', humor: '不用',
    summary: '正式程度：正式；亲切程度：克制；回复长度：适中；表达方式：委婉；表情使用：不用；幽默程度：不用。\n用词规范、有分寸，先回应对方再说明情况，该确认的先确认、不替对方作决定；语气客气但不过分亲热，不使用表情与玩笑。适合客户、合作方、上级或初次接触的对象。',
  }, '礼貌准确地回应问题，说明已知事项和需要确认的信息'),
  replyPreset('patient', '耐心解释', {
    formality: '自然', warmth: '亲切', length: '详细', directness: '解释充分', emoji: '少量', humor: '不用',
    summary: '正式程度：自然；亲切程度：亲切；回复长度：详细；表达方式：解释充分；表情使用：少量；幽默程度：不用。\n把话讲清楚：先给结论，再补原因或步骤，必要时分条说明；信息不明确时先澄清再回答，不回避问题；语气亲切有耐心，可少量用表情缓和语气，不讲玩笑。适合需要讲解、答疑、说明流程的沟通。',
  }, '耐心解释对方的问题，按需要说明步骤，信息不明确时先澄清'),
];
