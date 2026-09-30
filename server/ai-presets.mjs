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
  replyPreset('natural', '自然随和', { summary: '顺着当前话题自然接话，友好随和，少客套。按需要说清楚，不刻意追问。' }, '自然回应当前话题'),
  replyPreset('concise', '简短直接', { summary: '直接回应重点，用尽量少的话说清楚。必要的信息不省略，不展开无关内容。' }, '简短清楚地回答'),
  replyPreset('polite', '礼貌得体', { summary: '语气礼貌、有分寸，表达清楚。需要确认的先确认，拒绝时说明情况，不擅自承诺。' }, '礼貌准确地回应'),
  replyPreset('caring', '温柔关心', { summary: '先回应对方的感受，再表达适度关心。少说教，不夸张安慰，不编造对方的处境。' }, '贴合语境地表达关心'),
  replyPreset('humorous', '轻松幽默', { summary: '顺着话题适度开小玩笑，轻松自然。对方认真、着急或难过时先认真回应，不强行抖机灵。' }, '在合适的语境中轻松接话'),
];
