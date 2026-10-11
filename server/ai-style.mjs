import { replyPresets } from './ai-presets.mjs';
import { AppError } from './files.mjs';
const summary = style => style?.summary || ['formality', 'warmth', 'length', 'directness', 'emoji', 'humor', 'customTone'].map(key => style?.[key]).filter(Boolean).join('，');
// 风格选择只有一套「默认风格」（账号级 learnedDefaultStyle）。保存时若内容与默认风格完全一致，
// 仍按「默认风格」处理（继续跟随默认风格的更新）；只有改过内容才固化为该对象自己的风格（custom）。
// 学习结果按五个维度产出：语言、节奏、互动、情感、角色。存的时候合成为一段可编辑的风格说明，
// 与「只有 summary」的历史学习和枚举格式保持同一条存储通道。
export const styleLayers = [['language', '语言'], ['rhythm', '节奏'], ['interaction', '互动'], ['emotion', '情感'], ['role', '角色']];
export function composeLearnedStyle(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (Object.hasOwn(raw, 'summary')) return { ...raw };
  const lines = [];
  for (const [key, label] of styleLayers) {
    // Some model values contain the template fragment itself as text, such as
    // 语言层":"样本不足. Remove only this layer's quoted prefix, preserving
    // ordinary quoted prose and anything in the body of the description.
    const text = typeof raw[key] === 'string' ? raw[key].trim()
      .replace(new RegExp(`^"?${label}层"\\s*:\\s*"`), '')
      .replace(/\s+/gu, ' ').trim().slice(0, 600) : '';
    // This runs after the provider's request/repair handling. A template label
    // is not a learned description, and must not create a candidate or retry.
    const unquoted = text.replace(/^["'“‘]|["'”’]$/gu, '');
    if (styleLayers.some(([, name]) => unquoted === name || unquoted === `${name}层`)) {
      throw new AppError(`模型风格学习的${label}维度没有有效说明，原风格未修改`, 502, 'ai_model_schema');
    }
    if (text) lines.push(`${label}：${text}`);
  }
  return lines.length ? { summary: lines.join('\n') } : { ...raw };
}
export function selectedStyleId(profile, style, requested, set = true, defaultStyle = null) {
  if (!set) return '';
  const key = requested ?? '';
  const reference = key === 'learned' ? profile?.learnedStyle
    : key === '' ? defaultStyle
    : replyPresets.find(p => key === `preset:${p.id}`)?.style;
  return reference && summary(reference) === summary(style) ? key : 'custom';
}
export function migrateLearnedStyle(profile) {
  // Old versions overwrote the only style slot when selecting presets/manual
  // edits. Recover only an unmodified learning result, never label a preset as it.
  if (!profile.learnedStyle && profile.learnedAt && !profile.replyConfiguredAt && !profile.replyStyleSource && !profile.locked?.length) profile.learnedStyle = structuredClone(profile.style);
  if (profile.styleId === undefined && profile.learnedStyle && JSON.stringify(profile.style) === JSON.stringify(profile.learnedStyle)) profile.styleId = 'learned';
}
