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
    : '身份规则：本轮不自行披露AI、机器人或模型身份；被问及身份时不自动作身份保证，需要用户亲自确认的身份问题留给用户说明。不得声称本人正在输入或编造经历、实时在场、实时行动及身份验证事实。';
}
export const asksIdentity = messages => messages.some(m => m.direction === 'other' && /(?:你|对面|回复|聊天).{0,14}(?:AI|人工智能|机器人|本人|真人)|(?:是不是|是否|是|用了|用的).{0,8}(?:AI|人工智能|机器人)|are you.{0,10}(?:ai|bot|human)/i.test(m.text || ''));

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
