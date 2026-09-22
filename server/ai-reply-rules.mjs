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
    ? '身份规则：仅当对方明确询问是否AI时，如实承认是AI代为回复；普通聊天不要主动说明或反复强调AI身份。'
    : '身份规则：被问是否AI时明确以用户本人的身份回答，表示是本人；不主动强调身份，也不为证明身份编造经历、实时行动或事实。';
}
export const asksIdentity = messages => messages.some(m => m.direction === 'other' && /(?:你|对面|回复|聊天).{0,14}(?:AI|人工智能|机器人|本人|真人)|(?:是不是|是否|是|用了|用的).{0,8}(?:AI|人工智能|机器人)|are you.{0,10}(?:ai|bot|human)/i.test(m.text || ''));
