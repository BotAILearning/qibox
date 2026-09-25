import { AppError } from './files.mjs';

export const categories = {
  intimate: { label: '亲密关系', roles: ['伴侣', '配偶', '约会对象'] },
  family: { label: '家庭亲属', roles: ['父母', '子女', '兄弟姐妹', '其他亲属'] },
  friends: { label: '朋友社交', roles: ['密友', '普通朋友', '同学', '熟人'] },
  work: { label: '职场协作', roles: ['上级', '平级同事', '下属', '跨部门同事'] },
  business: { label: '商务合作', roles: ['潜在客户', '现有客户', '合作方', '供应商'] },
  education: { label: '教育学习', roles: ['老师', '学生', '导师', '家长'] },
  service: { label: '服务事务', roles: ['客服', '快递', '中介', '房东', '物业'] },
  community: { label: '社群兴趣', roles: ['群友', '游戏伙伴', '社团成员', '活动伙伴'] },
  new: { label: '初识关系', roles: ['新联系人', '初次接触对象'] },
  custom: { label: '自定义', roles: ['复合关系', '自定义'] },
  unknown: { label: '暂未确定', roles: ['暂未确定'] },
};
export const styleOptions = {
  formality: ['自然', '随意', '正式'], warmth: ['适度', '亲切', '克制'],
  length: ['简短', '适中', '详细'], directness: ['直接', '委婉', '解释充分'],
  emoji: ['不用', '少量', '适量'], humor: ['不用', '偶尔', '轻松'],
};
export const avoidOptions = ['擅自承诺', '过度客气', '过度亲昵', '追问隐私', '不耐烦', '网络梗', '连续追问', '含糊表达', '嘲讽', '说教'];
export const roles = [...new Set(Object.values(categories).flatMap(x => x.roles))];
export function textField(value, max = 1200, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value.trim())) throw new AppError('请检查填写内容');
  return value.trim();
}
function enumStyle(value) {
  if (!value || !Object.hasOwn(categories, value.category)) throw new AppError('未能识别沟通风格，请补充聊天后重试');
  const result = { category: value.category };
  for (const [key, options] of Object.entries(styleOptions)) {
    if (!options.includes(value[key])) throw new AppError('风格结果不完整，请重新学习');
    result[key] = value[key];
  }
  for (const [key, allowed, max] of [['roles', roles, 4], ['avoid', avoidOptions, 10]]) {
    if (!Array.isArray(value[key]) || value[key].length > max || value[key].some(x => !allowed.includes(x))) throw new AppError('风格结果不完整，请重新学习');
    result[key] = [...new Set(value[key])];
  }
  result.customTone = '';
  result.customAvoid = '';
  return result;
}
export function styleValue(value, { manual = false } = {}) {
  if (value && Object.hasOwn(value, 'summary')) {
    const summary = textField(value.summary, 6000, true);
    const result = { summary, customTone: textField(value.customTone || '', 500), customAvoid: textField(value.customAvoid || '', 1200) };
    // 带说明的风格（例如内置预设）如果同时带有完整枚举参数，一并保留，避免说明替换掉结构化取向。
    if (Object.hasOwn(categories, value.category)) Object.assign(result, enumStyle(value), { summary, customTone: result.customTone, customAvoid: result.customAvoid });
    return result;
  }
  const result = enumStyle(value);
  result.customTone = manual ? textField(value.customTone || '', 500) : '';
  result.customAvoid = manual ? textField(value.customAvoid || '', 500) : '';
  return result;
}
export function strategyValue(value) {
  if (!value || typeof value !== 'object') throw new AppError('请先制定策略');
  const result = {};
  for (const key of ['purpose', 'content', 'persona', 'replyGoal', 'facts', 'boundaries']) result[key] = textField(value[key] || '', key === 'facts' ? 4000 : 1200);
  result.sendMode = value.sendMode ?? 'single';
  if (!['single', 'segments'].includes(result.sendMode)) throw new AppError('请选择发送方式');
  result.styleSource = value.styleSource ?? 'manual';
  if (!['manual', 'learned', 'paste'].includes(result.styleSource)) throw new AppError('请选择风格来源');
  result.styleProfileId = textField(value.styleProfileId || '', 64);
  if (result.styleProfileId && !/^[a-f0-9]{64}$/.test(result.styleProfileId)) throw new AppError('请选择已学习的风格');
  result.maxRounds = replyLimitValue(value.maxRounds);
  return result;
}
export function replyLimitValue(value) {
  if (value === 'unlimited') return 'unlimited';
  const number = Number(value ?? 50);
  if (!Number.isSafeInteger(number) || number < 1) throw new AppError('自动回复上限应为正整数或不限');
  return number;
}
export function strategyReady(value, mode) {
  return mode === 'proactive' ? !!value?.purpose && !!value?.content : true;
}
export function replyStrategyValue(value) {
  const normalized = strategyValue(value);
  return Object.fromEntries(['replyGoal', 'facts', 'boundaries', 'maxRounds'].map(key => [key, normalized[key]]));
}
export const defaultStyle = { category: 'unknown', roles: ['暂未确定'], formality: '自然', warmth: '适度', length: '简短', directness: '委婉', emoji: '少量', humor: '偶尔', avoid: ['擅自承诺'], customTone: '', customAvoid: '' };
export const styleSchema = { category: Object.keys(categories), roles, ...styleOptions, avoid: avoidOptions };
