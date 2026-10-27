import { AppError } from './files.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const validAccount = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unverified = () => new AppError('暂时无法确认当前微信账号，请稍后重试', 409, 'AI_ACCOUNT_UNVERIFIED');
const changed = () => new AppError('微信账号已变化，请重新打开 AI 辅助', 409, 'AI_SCOPE_CHANGED');
const requestScope = new AsyncLocalStorage();

export function accountRequestScope(a) {
  const scope = requestScope.getStore();
  return scope?.assistant === a && scope.active ? scope.account : null;
}
export async function withAccountRequestScope(a, account, action) {
  const scope = { assistant: a, account, active: true };
  try { return await requestScope.run(scope, action); }
  finally { scope.active = false; }
}

// This is the private worker's current-process/contact.db identity read. It
// neither navigates WeChat nor scans its address book. Share concurrent reads,
// but do not retain an identity result across subsequent polling rounds.
export async function currentAccountIdentity(a) {
  if (a.storageError) throw a.storageError;
  if (!a.ready() || typeof a.bridge.currentAccount !== 'function') throw unverified();
  if (a.accountIdentityRead) return a.accountIdentityRead;
  const pending = Promise.resolve().then(() => a.bridge.currentAccount()).then(identity => {
    if (!validAccount(identity?.account)) throw unverified();
    return identity.account;
  }).catch(error => {
    if (['ai_account_changed', 'AI_SCOPE_CHANGED'].includes(error?.code)) throw changed();
    throw unverified();
  });
  a.accountIdentityRead = pending;
  try { return await pending; }
  finally { if (a.accountIdentityRead === pending) a.accountIdentityRead = null; }
}

export async function verifyAccountScope(a, account = a.data.account) {
  const requestedAccount = accountRequestScope(a);
  if (requestedAccount && requestedAccount !== account) throw changed();
  const current = await currentAccountIdentity(a);
  if (!account || account !== a.data.account || current !== account) throw changed();
  return account;
}

// A fresh native read proves which account is active now, not which account
// the submitting page was editing. Bind the caller before entering the write
// queue; the existing request scope rechecks that identity when queued work runs.
export async function verifyCallerAccountScope(a, expectedAccount) {
  const account = await verifyAccountScope(a);
  if (!validAccount(expectedAccount)) throw new AppError('页面已过期，请刷新栖盒页面后重试', 409, 'AI_SCOPE_CHANGED');
  if (expectedAccount !== account) throw changed();
  return account;
}

// Model settings are instance-owned and remain manageable while WeChat is
// stopped. No old account's contacts, facts, styles, reports or records enter
// this response. scopeUnknown tells the UI to conceal without losing drafts.
export function unverifiedAccountState(a) {
  if (a.storageError) throw a.storageError;
  const { capabilities, provider, models, assignments, schema } = a.publicState();
  const page = { total: 0, hasMore: false, nextBefore: null, limit: 50 };
  return { capabilities, provider, models, assignments, schema, scopeUnknown: true,
    account: null, configurationRevision: `unverified:${a.revision}`, settings: { ...a.data.settings, enabled: false, autoLearning: false, updateStyle: false },
    strategy: {}, replyStrategy: {}, personalInformation: { entries: [], suggestions: [], history: [] }, personalFields: [], replyRoundLimits: { person: null, group: null },
    profiles: [], contacts: [], targets: [], replyTargets: [], proactiveTargets: [], proactiveTasks: [], proactiveRecords: [], proactiveRecordsPage: page, proactiveRequirements: [],
    activity: [], activityHistory: [], analysis: { mode: a.data.analysisMode, provider: a.publicProvider('analysis'), effectiveProvider: a.publicProvider('analysis'), history: [] },
    queue: { status: 'idle', items: [], nextAt: null }, schedules: [], events: [], skipRecords: [], skipRecordsPage: page, recentErrors: [], errorsPage: page,
    available: false, avatarReady: false, notice: '请打开微信并确认当前账号后重试', waiting: false, operation: null, manualRecovery: false, labels: { available: false, groups: [] }, live: [],
    learnedDefaultStyle: null, effectiveDefaultStyle: null, defaultStyleUndoable: false, requirements: { proactive: '', reply: '' } };
}

export async function currentAccountState(a, { live = false, contact } = {}) {
  if (a.storageError) throw a.storageError;
  if (!a.ready()) return unverifiedAccountState(a);
  const account = await currentAccountIdentity(a);
  if (account !== a.data.account) {
    // Detection must stop the old account before a potentially slow new scan.
    if (!a.accountStateRefresh) {
      const pending = (async () => {
        const existingScan = a.scanPromise;
        if (!existingScan) a.invalidate();
        a.data.settings.enabled = false; a.available = false;
        a.pauseQueue(); if (!existingScan) a.forgetContext();
        a.contacts.clear(); a.avatarUrls.clear(); a.avatarReady = false;
        a.data.contacts = []; a.data.lastScanAt = null;
        await a.save();
        await (existingScan || a.scan());
      })();
      a.accountStateRefresh = pending;
      pending.finally(() => { if (a.accountStateRefresh === pending) a.accountStateRefresh = null; }).catch(() => {});
    }
    await a.accountStateRefresh;
    if (a.data.account !== account) throw changed();
    // Full state is needed so the caller discards every old account draft.
    return a.publicState();
  }
  return live ? a.publicLiveState(contact) : a.publicState();
}

export function accountIndependentAction(action) {
  return ['configure', 'test', 'models', 'model-test', 'models-save', 'verify-provider', 'analysis-use-chat', 'reveal-key'].includes(action);
}
export function accountStopAction({ action, value, command } = {}) {
  if (['cancel', 'activity', 'style-trial-cancel'].includes(action)) return true;
  if (action === 'settings') {
    const entries = Object.entries(value || {});
    return entries.length > 0 && entries.every(([key, val]) => ['enabled', 'reply', 'proactive', 'autoLearning'].includes(key) && val === false);
  }
  return action === 'queue' && ['pause', 'cancel'].includes(command)
    || action === 'proactive-task' && value?.command === 'pause';
}
