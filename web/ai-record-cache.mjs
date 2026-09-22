// Short-lived memory only; never persist conversation text in browser storage.
export class RecordCache {
  constructor({ now = Date.now, ttl = 5 * 60000, limit = 4 } = {}) { Object.assign(this, { now, ttl, limit }); this.entries = new Map(); }
  save(instance, account, value) {
    if (!instance || !account) return;
    this.entries.delete(instance);
    this.entries.set(instance, { account, at: this.now(), value: structuredClone(value) });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
  take(instance, account) {
    const entry = this.entries.get(instance);
    if (!entry || !account || entry.account !== account || this.now() - entry.at >= this.ttl) { this.entries.delete(instance); return null; }
    return structuredClone(entry.value);
  }
  delete(instance) { this.entries.delete(instance); }
}

export function mergeRecordResults(previous, incoming) {
  return incoming.map(row => {
    const old = previous.find(p => p.id === row.id);
    if (!old || (!row.pending && !row.unavailable)) return row;
    const messages = new Map((old.messages || []).map(m => [m.id, m]));
    for (const m of row.messages || []) messages.set(m.id, m);
    return { ...row, messages: [...messages.values()] };
  });
}
