import { AppError } from './files.mjs';
import { verifyAccountScope } from './ai-account-scope.mjs';
import { styleValue } from './ai-schema.mjs';
import { replyStyleOrigin } from './ai-context-learning.mjs';
import { replyFixedRules, currentReplyScopePrompt } from './ai-reply-prompt.mjs';

// Synthetic material only. It is never inserted into WeChat, memory or learning.
export const styleTrialScenes = Object.freeze([
  { id: 'question', label: '问一件事', messages: [{ direction: 'self', text: '我周末去过那家新开的面馆，点的清汤面，店里挺安静。' }, { direction: 'other', text: '那家面馆你点的什么？店里吵不吵？' }] },
  { id: 'sharing', label: '随口分享', messages: [{ direction: 'other', text: '午后下了阵雨，阳台那盆薄荷倒精神了。小周出差把他的花托给邻居，我这盆一直自己养。刚摘了两片泡水，味道还挺清爽。' }] },
  { id: 'venting', label: '接一句吐槽', messages: [{ direction: 'self', text: '我那台旧风扇上周修好了。' }, { direction: 'other', text: '阿明的风扇今天又停了，他换个插座也没用。我自己的没坏，刚拿来给他比了下声音。他就想安静看个电影，片头还没过就被吵醒了，服了。' }] },
  { id: 'disagreement', label: '有点不同意见', messages: [{ direction: 'self', text: '我还是更喜欢上一版的封面，留白多一点。' }, { direction: 'other', text: '我反倒喜欢新封面，颜色亮，缩小看更显眼。老版的字我每次都得放大才看清。' }] },
  { id: 'closing', label: '自然收尾', messages: [{ direction: 'other', text: '小周刚说他的行李找到了，不用我再问了。明天的事明天再说，我先去吃饭，今天就这样。' }] },
]);
const slots = new WeakMap();
const invalid = () => new AppError('试聊结果不完整，本次未重试；原风格和上次结果已保留', 502, 'ai_style_trial_format');
export function validateStyleTrial(result) {
  if (!Array.isArray(result?.trials) || result.trials.length !== styleTrialScenes.length) throw invalid();
  return styleTrialScenes.map(scene => {
    const matches = result.trials.filter(row => row?.id === scene.id);
    if (matches.length !== 1 || typeof matches[0].reply !== 'string' || !matches[0].reply.trim() || matches[0].reply.length > 6000) throw invalid();
    return { ...scene, reply: matches[0].reply.trim() };
  });
}
export function cancelStyleTrial(a, value = {}) {
  let slot = slots.get(a);
  if (value.account === a.data.account && /^[a-zA-Z0-9_-]{16,100}$/.test(value.operationId || '')) {
    if (!slot) { slot = { seen: new Set(), active: null }; slots.set(a, slot); }
    slot.seen.add(value.operationId);
  }
  if (slot?.active?.id === value.operationId && slot.active.account === value.account) slot.active.controller.abort();
  return { cancelled: true };
}
export async function generateStyleTrial(a, value = {}, { signal } = {}) {
  const operation = await a.exclusive(async () => {
    if (!value.account || value.account !== a.data.account) throw new AppError('微信账号已变化，请重新打开 AI 辅助', 409, 'AI_SCOPE_CHANGED');
    const account = await verifyAccountScope(a, value.account);
    if (signal?.aborted) throw new AppError('试聊已停止', 409, 'ai_style_trial_cancelled');
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(value.operationId || '')) throw new AppError('试聊操作标识无效');
    if (!a.contacts.has(value.contact)) throw new AppError('当前聊天对象不可用，请刷新列表', 409);
    if (!a.modelReady()) throw new AppError('请先配置当前聊天模型');
    let slot = slots.get(a);
    if (!slot) { slot = { seen: new Set(), active: null }; slots.set(a, slot); }
    if (slot.active) throw new AppError('已有试聊正在生成，请先等待或停止', 409, 'ai_style_trial_busy');
    // Never replay an unknown/failed operation, even if the client lost its response.
    if (slot.seen.has(value.operationId)) throw new AppError('这次试聊已请求过，请查看已有结果；需要重试时重新点击生成', 409, 'ai_style_trial_used');
    const style = styleValue(value.style, { manual: true });
    const profile = a.profiles().find(p => p.contact === value.contact && p.account === account);
    const origin = value.styleId === '' && a.activeDefaultStyle()?.style && a.activeDefaultStyle().source !== 'manual'
      ? replyStyleOrigin({ learnedStyle: a.activeDefaultStyle().style }, style, { reference: style.summary === a.activeDefaultStyle().style.summary })
      : value.styleId === 'learned' ? replyStyleOrigin(profile, style) : replyStyleOrigin(null, style);
    const controller = new AbortController(), config = structuredClone(a.modelFor('chat'));
    const op = { id: value.operationId, account, contact: value.contact, controller, config, style, origin,
      revision: a.providerRevision('chat'), signal: AbortSignal.any([controller.signal, a.controller.signal, ...(signal ? [signal] : [])]) };
    slot.seen.add(op.id); slot.active = op; return op;
  });
  try {
    const result = await a.provider.complete(operation.config,
      replyFixedRules + currentReplyScopePrompt + '\n这是用户主动点击的合成试聊，不是真实消息。为scenes各独立生成本人一句或几句自然接话，不串用场景事实；不得发送、学习或新增行动。styleOrigin.summary=user-setting为用户明确要求；learned-observation和reference-style只借鉴历史倾向，不强制复述、指导或每次装饰，不迁入其他对象称呼与事实。只返回JSON：{"trials":[{"id":"场景id","reply":"接话正文"}]}，五个id各一次。',
      { mode: 'style-trial', style: operation.style, styleOrigin: operation.origin, scenes: styleTrialScenes }, operation.signal,
      { retry: false, purpose: '用户主动生成五场景试聊', budget: 4096 });
    operation.signal.throwIfAborted();
    await verifyAccountScope(a, operation.account);
    if (operation.revision !== a.providerRevision('chat') || !a.contacts.has(operation.contact)) throw new AppError('配置或聊天对象已变化，本次试聊结果已作废', 409, 'AI_SCOPE_CHANGED');
    return { operationId: operation.id, account: operation.account, contact: operation.contact, trials: validateStyleTrial(result) };
  } finally {
    const slot = slots.get(a); if (slot?.active === operation) slot.active = null;
  }
}
