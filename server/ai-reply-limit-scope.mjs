import { AppError } from './files.mjs';
import { replyLimitValue } from './ai-schema.mjs';

const validAccount = account => typeof account === 'string' && /^[a-f0-9]{64}$/.test(account);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({ person: null, group: null });
function limits(value) {
  const result = empty();
  for (const kind of ['person', 'group']) if (value?.[kind] != null) {
    try { result[kind] = replyLimitValue(value[kind]); }
    catch { result[kind] = value[kind]; } // Old invalid limits still require explicit confirmation.
  }
  return result;
}

export function initReplyLimitAccounts(data) {
  if (!Object.hasOwn(data, 'accountReplyRoundLimits')) {
    data.accountReplyRoundLimits = {};
    // The map's presence also records that unowned legacy values were examined.
    // Never attach those values later to the first account discovered by scan.
    if (validAccount(data.account) && record(data.replyRoundLimits)) data.accountReplyRoundLimits[data.account] = limits(data.replyRoundLimits);
  }
  if (!record(data.accountReplyRoundLimits)) throw new AppError('回复次数上限暂时无法读取，请恢复备份后重试', 409, 'ai_reply_limits_unreadable');
  for (const [account, value] of Object.entries(data.accountReplyRoundLimits)) if (validAccount(account)) {
    if (!record(value)) throw new AppError('此账号的回复次数上限暂时无法读取，请恢复备份后重试', 409, 'ai_reply_limits_unreadable');
    data.accountReplyRoundLimits[account] = limits(value);
  }
  // Keep the legacy field untouched for recovery; only the account map is active.
}

export function replyLimitsForAccount(data) {
  return validAccount(data.account) ? limits(data.accountReplyRoundLimits?.[data.account]) : empty();
}

export function migrateReplyLimitIdentity(data, account, equivalentIdentity) {
  const stored = data.accountReplyRoundLimits, previous = data.account;
  // This flag comes only from an exact authenticated native-to-data identity
  // mapping. A normal account switch, shared contact ID or nickname is insufficient.
  if (equivalentIdentity !== true || !validAccount(previous) || !validAccount(account)
    || !Object.hasOwn(stored, previous) || Object.hasOwn(stored, account)) return null;
  const next = structuredClone(stored[previous]);
  stored[account] = next;
  return { account, next };
}
