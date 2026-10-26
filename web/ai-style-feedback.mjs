// Explicit user wording only: no inference from a dislike, model call or edit
// of the saved style. Saving the draft uses the existing new-custom-style path.
export function styleFeedbackCopy(value, note, { id, name = '试聊修订' } = {}) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text || text.length > 400 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('请用1到400字说明希望怎样调整表达');
  if (!value?.style || typeof value.style.summary !== 'string' || !value.style.summary.trim()) throw new Error('当前风格草稿已变化，请重新生成试聊');
  if (!/^draft:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || '')) throw new Error('新风格草稿标识无效');
  const summary = `${value.style.summary}\n补充表达要求：${text}`;
  if (summary.length > 6000) throw new Error('补充后超过6000字，请先精简风格说明；原草稿已保留');
  const style = { ...value.style, summary };
  delete style.personalityId; delete style.traits;
  return { styleId: id, styleName: String(name).trim().slice(0, 40) || '试聊修订', summary, __personality: '', __styleBase: JSON.stringify(style) };
}

export function copiedStyleBase(value, requested) {
  if (!requested?.startsWith('draft:') || typeof value !== 'string' || value.length > 16000) return null;
  try { const style = JSON.parse(value); return style && !Array.isArray(style) && typeof style.summary === 'string' && style.summary.length <= 6000 ? style : null; }
  catch { return null; }
}
