import { AsyncLocalStorage } from 'node:async_hooks';
import { accountRequestScope, verifyAccountScope } from './ai-account-scope.mjs';

// Internal snapshot projection used by staged object configuration commits.
export const configurationSnapshotPatch = Symbol('configurationSnapshotPatch');
const pending = new WeakSet();
const owner = new AsyncLocalStorage();
export const configurationCommitPending = assistant => pending.has(assistant);

// Call inside the existing actions queue. Only the transaction callback may use
// persist; ordinary saves wait until commit/rollback and then take a fresh clone.
export async function withConfigurationCommit(assistant, action, { drain = true, urgentStop = false, verify } = {}) {
  // A master close may overtake an action still verifying identity. That older
  // action must then join the close's completion, not enter its transaction.
  // Actual nested transactions still fail below.
  const inherited = owner.getStore();
  if (inherited?.assistant === assistant && inherited.active) throw new Error('Configuration commits cannot be nested');
  const requestedAccount = accountRequestScope(assistant);
  if (!verify && requestedAccount) verify = () => verifyAccountScope(assistant, requestedAccount);
  if (verify) {
    // Identity reads must remain outside the transaction barrier so a parent
    // close can still overtake them. Recheck after any intervening close/write.
    for (;;) {
      while (!urgentStop && assistant.urgentSettingsStop) await assistant.urgentSettingsStop.promise;
      const writes = assistant.writes;
      if (drain) await writes;
      await verify();
      if ((urgentStop || !assistant.urgentSettingsStop) && (!drain || assistant.writes === writes)) break;
    }
  }
  while (!urgentStop && assistant.urgentSettingsStop) await assistant.urgentSettingsStop.promise;
  if (pending.has(assistant)) throw new Error('Configuration commits cannot be nested');
  pending.add(assistant);
  const ownership = { assistant, active: true };
  const originalSave = assistant.save, settled = Promise.withResolvers();
  const deferredSave = (...args) => settled.promise.then(() => assistant.save(...args));
  assistant.save = deferredSave;
  try {
    // Master-switch cancellation must invalidate its epoch synchronously, even
    // when an older write is pending. Its persist still uses the normal queue.
    return await owner.run(ownership, async () => {
      if (drain && !verify) await assistant.writes;
      return action((...args) => originalSave.apply(assistant, args));
    });
  } finally {
    ownership.active = false;
    assistant.save = originalSave;
    pending.delete(assistant);
    settled.resolve();
  }
}
