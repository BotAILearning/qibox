import { AppError } from './files.mjs';

export const defaultTakeover = () => ({ enabled: true, minutes: 5 });
export function takeoverValue(value) {
  if (!value || typeof value.enabled !== 'boolean' || !Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 10080)
    throw new AppError('请设置自动接续开关及1–10080分钟的等待时长');
  return { enabled: value.enabled, minutes: value.minutes };
}
// Personal overrides remain stored for backward recovery, but no longer
// override the single wait control exposed in the current settings screen.
export const effectiveTakeover = settings => settings.takeover || defaultTakeover();
export function identityPrompt(acknowledge) {
  return acknowledge
    ? '身份规则：仅当本轮待回复来信明确询问是否AI时，如实简短说明由AI代为回复；普通聊天绝不主动说明AI、机器人或模型身份，旧身份问题不构成本轮说明身份的理由。'
    : '身份规则：本轮不披露AI、机器人或模型身份，包括说明当前或旧账号回复是AI代回、AI代发、AI生成，也不以纠正旧说法为理由解释代发来源或否认本人发送归属；不写“之前那条是AI回复时发的”“那条不是我本人的说法”。也不以“被你发现了”“你猜对了”“没错”等话间接承认自动回复。对方称呼你为机器人、AI或bot，不代表可以认领这个身份；不要顺着称呼接“机器人不用健身”“保持出厂设置”“靠充电”等机器身份玩笑，也不重复历史回复中的这类说法。被问及身份时不自动作身份保证，也不自动承认或否认；“不是的”“没有啊”这类直接否认也不允许。可只简短询问对方为什么这样问，不追加否认、真人保证或亲自输入说明；身份核验留给本人说明，其他实际问题照常回答。不解释生成过程，不保证本人正在输入，不编造经历、实时在场、实时行动及身份验证事实。';
}
export const asksIdentity = messages => messages.some(m => {
  if (m.direction !== 'other') return false;
  const text = String(m.text || '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
  return /(?:你|您|对面|回复|聊天).{0,14}(?:AI|人工智能|机器人|自动回复|本人|真人)|(?:是不是|是否|是|用了|用的).{0,8}(?:AI|人工智能|机器人|自动回复)|are you.{0,10}(?:ai|bot|human)/i.test(text)
    // A direct robot address is also an identity cue, even without "are you".
    || /(?:机器人|人工智能|AI|chatbot|bot)[\s\p{P}\p{S}]{0,12}(?:你|您)(?:\s|[^的])/iu.test(text);
});

const proactiveVocatives = ['亲爱的', '小宝贝', '宝贝', '宝宝', '老公', '老婆', '亲亲', '乖乖', '宝', '亲'];
const vocativePunctuation = '，,、。.!！?？~～…';
function styleExplicitlyAllowsVocative(profile, word) {
  const style = profile?.style?.summary || '';
  if (!(profile?.replyStyleSource === 'manual' || profile?.locked?.includes('summary'))) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:称呼对方为|称呼用|明确称呼)\\s*[【「『“']?\\s*${escaped}(?![\\p{Script=Han}A-Za-z0-9])`, 'u').test(style);
}
function isDirectSelfVocative(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = `[${vocativePunctuation}\\s]`;
  return new RegExp(`^\\s*${escaped}(?=${boundary})|${boundary}?${escaped}[${vocativePunctuation}\\s]*$`, 'u').test(text || '');
}
/** Strip intimate address words from proactive drafts unless explicitly
 * authorized for this contact or used directly in at least two human messages. */
export function stripUnauthorizedProactiveVocatives(text, profile, snapshot) {
  let result = String(text || '');
  const messages = (snapshot?.messages || []).filter(message => message.direction === 'self'
    && !message.aiGenerated && !(profile?.generatedIds || []).includes(message.id));
  for (const word of proactiveVocatives) {
    if (styleExplicitlyAllowsVocative(profile, word)) continue;
    const evidence = new Set(messages.filter(message => isDirectSelfVocative(message.text, word)).map(message => message.id ?? message.text));
    if (evidence.size >= 2) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`^(\\s*)${escaped}(?=[，,、\\s])(?:[，,、]\\s*|\\s+)`, 'u'), '$1');
    result = result.replace(new RegExp(`([\\p{Script=Han}A-Za-z0-9])(?:[，,、]\\s*)?${escaped}([${vocativePunctuation}\\s]*)$`, 'u'), '$1$2');
  }
  return result.trim();
}
