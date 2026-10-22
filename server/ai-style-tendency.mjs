import { createHash } from 'node:crypto';

// A deliberately small, text-free learning state. The caller owns persistence,
// decrypts confirmed message bodies before calling this module, and supplies
// samples only after its normal authorship checks.
const traitMatchers = Object.freeze({
  // WeChat stores native expression names as bracketed text. Recognize only
  // this finite set so ordinary bracketed words do not become emoji evidence.
  emoji: /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\[(?:微笑|撇嘴|色|发呆|得意|流泪|害羞|闭嘴|睡|大哭|尴尬|发怒|调皮|龇牙|惊讶|难过|酷|冷汗|抓狂|吐|偷笑|可爱|白眼|傲慢|饥饿|困|惊恐|流汗|憨笑|奋斗|疑问|嘘|晕|衰|骷髅|敲打|再见|擦汗|抠鼻|鼓掌|糗大了|坏笑|哈欠|鄙视|委屈|快哭了|阴险|亲亲|吓|可怜|菜刀|西瓜|啤酒|咖啡|猪头|玫瑰|凋谢|嘴唇|爱心|心碎|蛋糕|闪电|炸弹|足球|便便|月亮|太阳|礼物|拥抱|强|弱|握手|胜利|抱拳|拳头|差劲|爱你|ok|捂脸|奸笑|机智|耶|皱眉|红包|蜡烛|烟花|庆祝|破涕为笑|苦涩|裂开|旺柴)\])/iu,
  laughter: /(?:哈哈+|呵呵+|嘿嘿+|嘻嘻+|笑死|笑不活|lol+|lmao+)/iu,
  addressing: /^(?:亲爱的|亲|宝贝|宝宝|老公|老婆|哥|姐|老师|老板|兄弟|姐妹|老铁|朋友)[，,、\s]/u,
  rhetorical: /(?:难道.{0,12}吗|不是.{0,12}吗|这还用问|这不就是|何必.{0,8}呢|怎么可能|有必要.{0,8}吗)/u,
  teasing: /(?:逗你呢|开玩笑|别逗|少来|服了你|你可真会|真会说|笑死我了)/u,
});
const comicTraits = new Set(['laughter', 'rhetorical', 'teasing']);
const MAX_PLANS = 128;
const MAX_COMMITTED_ROUNDS = 128;
const MAX_OPERATION_IDS = 16;
const minTextLength = 2;

const validKeyPart = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scopeFor = (account, contact) => {
  if (!validKeyPart(account) || !validKeyPart(contact)) throw new TypeError('account and contact are required for style tendency scope');
  return createHash('sha256').update(account).update('\0').update(contact).digest('hex');
};

export function scopeStyleTendencyKey(account, contact) {
  return scopeFor(account, contact);
}

function blankTraits() {
  return Object.fromEntries(Object.keys(traitMatchers).map(key => [key, {
    positive: 0, eligible: 0, weightedPositive: 0, weightedEligible: 0, lastSeenAt: null,
  }]));
}

function freshState(scopeKey) {
  return { version: 1, scopeKey, traits: blankTraits(), sampleCount: 0, confirmedSendCount: 0,
    recentUsage: { roundCount: 0, traits: Object.fromEntries(Object.keys(traitMatchers).map(key => [key, { rounds: 0, latestUsed: false, consecutiveRounds: 0, lastUsedAt: null }])) },
    plans: {}, roundLedger: {}, roundCount: 0, roundHighWatermark: null };
}

function cloneState(state, scopeKey) {
  if (!state || state.version !== 1 || state.scopeKey !== scopeKey) return freshState(scopeKey);
  const base = freshState(scopeKey);
  for (const key of Object.keys(traitMatchers)) {
    const value = state.traits?.[key];
    if (value && typeof value.preference === 'string' && typeof value.confidence === 'string' && Number.isFinite(value.rate)) {
      base.traits[key] = structuredClone(value);
      continue;
    }
    if (value && Number.isFinite(value.positive) && Number.isFinite(value.eligible)) {
      base.traits[key] = {
        positive: Math.max(0, value.positive), eligible: Math.max(0, value.eligible),
        weightedPositive: Number.isFinite(value.weightedPositive) ? Math.max(0, value.weightedPositive) : Math.max(0, value.positive),
        weightedEligible: Number.isFinite(value.weightedEligible) ? Math.max(0, value.weightedEligible) : Math.max(0, value.eligible),
        lastSeenAt: Number.isFinite(value.lastSeenAt) ? value.lastSeenAt : null,
      };
    }
  }
  base.sampleCount = Number.isSafeInteger(state.sampleCount) ? Math.max(0, state.sampleCount) : 0;
  base.confirmedSendCount = Number.isSafeInteger(state.confirmedSendCount) ? Math.max(0, state.confirmedSendCount) : 0;
  if (state.recentUsage && Number.isSafeInteger(state.recentUsage.roundCount)) {
    base.recentUsage.roundCount = Math.max(0, state.recentUsage.roundCount);
    for (const key of Object.keys(traitMatchers)) {
      const row = state.recentUsage.traits?.[key];
      if (row && Number.isSafeInteger(row.rounds)) base.recentUsage.traits[key] = {
        rounds: Math.max(0, row.rounds),
        latestUsed: row.latestUsed === true,
        consecutiveRounds: Number.isSafeInteger(row.consecutiveRounds) ? Math.max(0, row.consecutiveRounds) : 0,
        lastUsedAt: Number.isFinite(row.lastUsedAt) ? row.lastUsedAt : null,
      };
    }
  }
  base.plans = Object.fromEntries(Object.entries(state.plans || {}).slice(-MAX_PLANS));
  base.roundLedger = structuredClone(Object.fromEntries(Object.entries(state.roundLedger || {}).slice(-MAX_COMMITTED_ROUNDS)));
  base.roundCount = Number.isSafeInteger(state.roundCount) ? Math.max(0, state.roundCount) : 0;
  base.roundHighWatermark = Number.isSafeInteger(state.roundHighWatermark) && state.roundHighWatermark >= 0 ? state.roundHighWatermark : null;
  return base;
}

function trustedHumanSample(row) {
  return row && row.direction === 'self' && row.authorship === 'human' && row.aiGenerated !== true
    && row.assumedPresent !== true && row.deliveryConfidence !== 'unknown' && row.trusted !== false
    && validKeyPart(String(row.id ?? '')) && typeof row.text === 'string' && row.text.trim().length >= minTextLength;
}

function timeMs(value) {
  if (!Number.isFinite(value)) return null;
  return value < 100000000000 ? value * 1000 : value;
}

function confirmedReply(row) {
  return row && row.source === 'reply' && row.confirmed === true && row.deliveryConfidence === 'confirmed'
    && row.assumedPresent !== true && typeof row.text === 'string' && row.text.trim().length >= minTextLength;
}

function addObservation(traits, text, { weight, at, capTime }) {
  const normalized = text.trim();
  for (const [name, matcher] of Object.entries(traitMatchers)) {
    const row = traits[name];
    row.eligible++;
    row.weightedEligible += weight;
    if (matcher.test(normalized)) {
      row.positive++;
      row.weightedPositive += weight;
      if (Number.isFinite(at)) row.lastSeenAt = Math.max(row.lastSeenAt || 0, at);
    }
  }
}

function scoreTrait(row, eligibleSampleCount) {
  const rate = row.weightedEligible > 0 ? row.weightedPositive / row.weightedEligible : 0;
  const effectiveCount = Math.min(eligibleSampleCount, row.eligible);
  const confidence = effectiveCount >= 8 && row.positive >= 3 ? 'high'
    : effectiveCount >= 5 && row.positive >= 2 ? 'medium'
      : effectiveCount >= 3 && row.positive >= 2 ? 'low' : 'unclear';
  // Low confidence is not enough to label a person's habit. It remains neutral
  // until several explicit observations point the same way.
  const preference = confidence !== 'unclear' && row.positive >= 2 && rate >= 0.2 ? 'sometimes' : 'neutral';
  return { preference, confidence, rate: Number(rate.toFixed(3)), evidenceCount: row.positive,
    sampleCount: row.eligible, ...(Number.isFinite(row.lastSeenAt) ? { lastSeenAt: row.lastSeenAt } : {}) };
}

/**
 * Learn scoped tendencies from explicitly trusted human samples. Recent,
 * confirmed AI replies are tracked separately as usage, never as training
 * evidence. No message text is retained in state.
 */
export function learnStyleTendency({ account, contact, existing, samples = [], recentSends = [], now = Date.now() } = {}) {
  const scopeKey = scopeFor(account, contact);
  const next = cloneState(existing, scopeKey);
  const uniqueSamples = new Map();
  for (const row of samples) {
    if (!trustedHumanSample(row)) continue;
    const at = timeMs(row.timestamp);
    if (Number.isFinite(at) && at > now) continue;
    if (!uniqueSamples.has(row.id)) uniqueSamples.set(row.id, { ...row, normalizedAt: at });
  }
  // Consecutive manually typed segments form one observed expression turn.
  // Without an explicit grouping ID, conservatively fall back to one message.
  const humanRounds = new Map();
  for (const row of uniqueSamples.values()) {
    const key = typeof row.styleRoundId === 'string' && row.styleRoundId.length > 0 && row.styleRoundId.length <= 512
      ? `round:${row.styleRoundId}` : `message:${row.id}`;
    const prior = humanRounds.get(key);
    if (prior) {
      prior.text += `\n${row.text.trim()}`;
      if (Number.isFinite(row.normalizedAt)) prior.at = Math.max(prior.at || 0, row.normalizedAt);
    } else humanRounds.set(key, { text: row.text.trim(), at: row.normalizedAt });
  }
  const eligible = [...humanRounds.values()];
  const traits = blankTraits();
  for (const row of eligible) addObservation(traits, row.text, { weight: 1, at: row.at, capTime: now });

  const sends = new Map(), seenOperations = new Set();
  for (const row of recentSends) {
    if (!confirmedReply(row) || !Number.isFinite(row.at) || row.at > now) continue;
    if (!Number.isSafeInteger(row.styleRoundId) || row.styleRoundId < 0) continue;
    const id = String(row.operationId || row.id || '');
    if (!id || seenOperations.has(id)) continue;
    seenOperations.add(id);
    const key = `round:${row.styleRoundId}`;
    const prior = sends.get(key);
    if (prior) {
      prior.text += `\n${row.text.trim()}`;
      prior.at = Math.max(prior.at, row.at);
    } else sends.set(key, { ...row, text: row.text.trim() });
  }
  // Confirmed AI output is usage history, never learning evidence. It is kept
  // separately and only helps avoid repetitive consecutive decoration.
  const recentRounds = [...sends.values()].sort((a, b) => b.at - a.at || b.styleRoundId - a.styleRoundId).slice(0, 8);
  const recentUsage = { roundCount: recentRounds.length, traits: {} };
  for (const name of Object.keys(traitMatchers)) {
    const uses = recentRounds.map(row => traitMatchers[name].test(row.text));
    const usedAt = recentRounds.filter(row => traitMatchers[name].test(row.text)).map(row => row.at);
    let consecutiveRounds = 0;
    for (const used of uses) { if (!used) break; consecutiveRounds++; }
    recentUsage.traits[name] = { rounds: usedAt.length, latestUsed: uses[0] === true, consecutiveRounds,
      lastUsedAt: usedAt.length ? Math.max(...usedAt) : null };
  }

  next.traits = Object.fromEntries(Object.keys(traitMatchers).map(key => [key, scoreTrait(traits[key], eligible.length)]));
  next.sampleCount = eligible.length;
  next.confirmedSendCount = sends.size;
  next.recentUsage = recentUsage;
  next.learnedAt = Number.isFinite(now) ? now : Date.now();
  return next;
}

function normalizedContext(context = {}) {
  return {
    serious: context.serious === true,
    sensitive: context.sensitive === true,
    banter: context.banter === true,
    relationshipConfirmed: context.relationshipConfirmed === true,
    questionNeeded: context.questionNeeded === true,
  };
}

function tendencyText(name, item, context) {
  if (item.preference !== 'sometimes') return '真人样本不足或倾向不明确，保持自然中性，不刻意加入';
  if (name === 'addressing' && context.relationshipConfirmed !== true) return '历史中偶有明确称呼；当前关系依据不足时不使用亲密称呼';
  if (comicTraits.has(name) && (context.serious || context.sensitive)) return '本人有此表达倾向，但本轮语境偏严肃，优先克制；只有确实合适时才使用';
  if (comicTraits.has(name) && !context.banter && !context.questionNeeded) return '本人偶尔这样表达；只有当前语境自然合适时才使用';
  return '本人有时这样表达；结合当前语境自然决定是否使用，不必每轮体现';
}

function buildPlan(state, styleRoundId, context, now) {
  const current = normalizedContext(context);
  const traits = Object.fromEntries(Object.entries(state.traits).map(([name, item]) => [name, {
    ...item, guidance: tendencyText(name, item, current),
  }]));
  for (const [name, usage] of Object.entries(state.recentUsage.traits)) {
    const trait = traits[name];
    if (usage.rounds > 0) trait.recentUsage = { rounds: usage.rounds, lastUsedAt: usage.lastUsedAt };
    if (usage.consecutiveRounds >= 2) trait.guidance += `；最近连续${usage.consecutiveRounds}轮实际用过，避免机械重复，只有自然合适时再使用`;
    else if (usage.latestUsed) trait.guidance += '；上一轮实际用过，避免无理由重复';
  }
  const lines = Object.entries(traits).map(([name, value]) => `${name}：${value.guidance}`);
  const plan = {
    version: 1, styleRoundId, scopeKey: state.scopeKey, createdAt: now,
    source: state.sampleCount >= 3 ? 'observed' : 'neutral',
    context: current, manualStylePriority: true, traits,
    instruction: `先遵守用户明确保存的风格，再参考本人的历史表达倾向；仅作概率倾向，不是配额或必须项。按本轮语境自然判断；不要为体现倾向添加表情、笑声、称呼、反问或调侃。\n${lines.join('\n')}`,
  };
  return plan;
}

/** Return a persisted candidate state and one immutable plan per reply round. */
export function planStyleTendency({ state, account, contact, styleRoundId, context = {}, now = Date.now() } = {}) {
  const scopeKey = scopeFor(account, contact);
  if (!Number.isSafeInteger(styleRoundId) || styleRoundId < 0) throw new TypeError('styleRoundId must be a non-negative safe integer');
  const next = cloneState(state, scopeKey);
  const key = String(styleRoundId);
  const existingPlan = next.plans[key];
  if (existingPlan && existingPlan.scopeKey === scopeKey) return { state: next, plan: structuredClone(existingPlan) };
  const plan = buildPlan(next, styleRoundId, context, Number.isFinite(now) ? now : Date.now());
  next.plans[key] = plan;
  const planKeys = Object.keys(next.plans).sort((a, b) => Number(a) - Number(b));
  while (planKeys.length > MAX_PLANS) delete next.plans[planKeys.shift()];
  return { state: next, plan: structuredClone(plan) };
}

function floorFor(highWatermark) {
  return highWatermark === null ? 0 : Math.max(0, highWatermark - MAX_COMMITTED_ROUNDS + 1);
}

/**
 * Idempotently count a round only after a positively confirmed actual send.
 * Unknown and failed attempts leave the state unchanged and can later be
 * confirmed by the normal receipt reconciliation path.
 */
export function commitStyleTendencyRound(state, { account, contact, styleRoundId, operationId, status, at = Date.now() } = {}) {
  const scopeKey = scopeFor(account, contact);
  const next = cloneState(state, scopeKey);
  if (!Number.isSafeInteger(styleRoundId) || styleRoundId < 0 || status !== 'confirmed' || !validKeyPart(operationId)) return next;
  const key = String(styleRoundId);
  if (!next.plans[key] || next.plans[key].scopeKey !== scopeKey) return next;
  if (next.roundHighWatermark !== null && styleRoundId < floorFor(next.roundHighWatermark)) return next;
  const existing = next.roundLedger[key];
  if (existing) {
    if (!existing.operationIds.includes(operationId) && existing.operationIds.length < MAX_OPERATION_IDS) existing.operationIds.push(operationId);
    return next;
  }
  next.roundLedger[key] = { styleRoundId, operationIds: [operationId], confirmedAt: Number.isFinite(at) ? at : Date.now() };
  next.roundCount++;
  next.roundHighWatermark = Math.max(next.roundHighWatermark ?? styleRoundId, styleRoundId);
  const floor = floorFor(next.roundHighWatermark);
  for (const oldKey of Object.keys(next.roundLedger)) if (Number(oldKey) < floor) delete next.roundLedger[oldKey];
  const planKeys = Object.keys(next.plans).sort((a, b) => Number(a) - Number(b));
  while (planKeys.length > MAX_PLANS) delete next.plans[planKeys.shift()];
  return next;
}
