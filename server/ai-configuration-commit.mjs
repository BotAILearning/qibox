// Internal snapshot projection used by staged object configuration commits.
export const configurationSnapshotPatch = Symbol('configurationSnapshotPatch');
const pending = new WeakSet();

// Call inside the existing actions queue. Only the transaction callback may use
// persist; ordinary saves wait until commit/rollback and then take a fresh clone.
export async function withConfigurationCommit(assistant, action, { drain = true } = {}) {
  if (pending.has(assistant)) throw new Error('Configuration commits cannot be nested');
  pending.add(assistant);
  const originalSave = assistant.save, settled = Promise.withResolvers();
  const deferredSave = (...args) => settled.promise.then(() => assistant.save(...args));
  assistant.save = deferredSave;
  try {
    // Master-switch cancellation must invalidate its epoch synchronously, even
    // when an older write is pending. Its persist still uses the normal queue.
    if (drain) await assistant.writes;
    return await action((...args) => originalSave.apply(assistant, args));
  } finally {
    assistant.save = originalSave;
    pending.delete(assistant);
    settled.resolve();
  }
}
