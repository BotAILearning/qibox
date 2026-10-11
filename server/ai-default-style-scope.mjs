import { AppError } from './files.mjs';
import { styleValue } from './ai-schema.mjs';

const validAccount = account => typeof account === 'string' && /^[a-f0-9]{64}$/.test(account);
const snapshot = a => ({ learnedDefaultStyle: a.data.learnedDefaultStyle || null, defaultStyleSnapshot: a.data.defaultStyleSnapshot || null });

// The legacy active fields stay compatible; inactive account defaults are
// encrypted with the instance's existing key and never enter public state.
export function rememberDefaultStyle(a) {
  const account = a.data.defaultStyleAccount;
  if (!validAccount(account) || account !== a.data.account) return;
  const current = snapshot(a), serialized = JSON.stringify(current);
  if (a.defaultStyleSavedAccount === account && a.defaultStyleSavedValue === serialized) return;
  a.data.accountDefaultStyles ||= {};
  a.data.accountDefaultStyles[account] = a.vault.seal(current);
  a.defaultStyleSavedAccount = account; a.defaultStyleSavedValue = serialized;
}

export function switchDefaultStyleAccount(a, account, { equivalentIdentity = false } = {}) {
  rememberDefaultStyle(a);
  const previous = snapshot(a), stored = a.data.accountDefaultStyles?.[account];
  let next = { learnedDefaultStyle: null, defaultStyleSnapshot: null };
  if (stored) {
    try {
      next = a.vault.open(stored);
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw Error('invalid default style');
      if (next.learnedDefaultStyle) styleValue(next.learnedDefaultStyle.style);
      if (next.defaultStyleSnapshot?.previous) styleValue(next.defaultStyleSnapshot.previous.style);
    } catch { throw new AppError('此账号的默认风格暂时无法读取，请恢复备份后重试', 409, 'ai_default_style_unreadable'); }
  } else if (!a.data.defaultStyleAccount || equivalentIdentity) next = structuredClone(previous);
  a.data.learnedDefaultStyle = next.learnedDefaultStyle || null;
  a.data.defaultStyleSnapshot = next.defaultStyleSnapshot || null;
  a.data.defaultStyleAccount = account;
  a.defaultStyleSavedAccount = null; a.defaultStyleSavedValue = null;
}

export function initDefaultStyleAccounts(a) {
  if (!a.data.accountDefaultStyles || typeof a.data.accountDefaultStyles !== 'object' || Array.isArray(a.data.accountDefaultStyles)) a.data.accountDefaultStyles = {};
  // Bind old, unscoped defaults only to the account recorded in that same file.
  if (!a.data.defaultStyleAccount) a.data.defaultStyleAccount = a.data.account || null;
  else if (a.data.defaultStyleAccount !== a.data.account) switchDefaultStyleAccount(a, a.data.account);
}

export async function verifyDefaultStyleAccount(a, account) {
  if (typeof a.bridge.currentAccount === 'function' && account) {
    const identity = await a.bridge.currentAccount();
    if (identity?.account !== account) throw new AppError('微信账号已变化，请重新打开默认风格', 409, 'ai_account_changed');
  }
  if (a.data.account !== account || a.data.defaultStyleAccount !== account) throw new AppError('微信账号已变化，请重新打开默认风格', 409, 'ai_account_changed');
}

export async function saveDefaultStyleChange(a, account, change) {
  await verifyDefaultStyleAccount(a, account);
  rememberDefaultStyle(a);
  const before = structuredClone(snapshot(a)), encryptedBefore = a.data.accountDefaultStyles?.[account];
  const fields = ['style', 'defaultStyle', 'pendingStyle'];
  const values = profile => Object.fromEntries(fields.map(field => [field, { present: Object.hasOwn(profile, field), value: structuredClone(profile[field]) }]));
  const profiles = a.profiles().map(profile => ({ profile, before: values(profile) }));
  const result = change(), candidate = JSON.stringify(snapshot(a));
  for (const entry of profiles) entry.after = values(entry.profile);
  try { await a.save(); }
  catch (error) {
    // Do not roll an old account's failure over a newly connected account,
    // or restore fields that another operation has since changed.
    if (a.data.defaultStyleAccount === account && a.data.account === account && JSON.stringify(snapshot(a)) === candidate) Object.assign(a.data, before);
    for (const { profile, before: old, after } of profiles) if (a.data.profiles[profile.id] === profile) for (const field of fields) {
      if (JSON.stringify({ present: Object.hasOwn(profile, field), value: profile[field] }) !== JSON.stringify(after[field])) continue;
      if (old[field].present) profile[field] = old[field].value;
      else delete profile[field];
    }
    if (encryptedBefore) a.data.accountDefaultStyles[account] = encryptedBefore;
    else if (a.data.accountDefaultStyles) delete a.data.accountDefaultStyles[account];
    if (a.defaultStyleSavedAccount === account) { a.defaultStyleSavedAccount = null; a.defaultStyleSavedValue = null; }
    throw error;
  }
  return { ...a.publicState(), ...result };
}
