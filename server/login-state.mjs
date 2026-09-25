// Current authentication is deliberately separate from automatic-login eligibility.
export class LoginState {
  constructor({ probe, now = Date.now, timeoutMs = 8000, pollIntervalMs = 1000 }) { this.probe = probe; this.now = now; this.timeoutMs = timeoutMs; this.pollIntervalMs = pollIntervalMs; this.reset(); }
  reset() { this.generation = (this.generation || 0) + 1; this.value = 'unknown'; this.observedAt = 0; this.startedAt = this.now(); this.attemptedAt = -Infinity; this.hadLogin = false; this.pending = null; }
  details(running) {
    const unknown = running && this.state(true) === 'unknown';
    const since = this.value === 'unknown' ? this.startedAt : this.observedAt + 15000;
    return { loginCheckTimedOut: unknown && this.now() - since >= 10000,
      loginObservedAt: this.observedAt || null, lastLoginStatus: this.value === 'unknown' ? null : this.value };
  }
  state(running) {
    if (!running) return 'logged-out';
    if (this.now() - this.observedAt > 15000) return 'unknown';
    return this.value;
  }
  entryAvailable(running) {
    // An inconclusive observation is not a logout. Background data operations
    // still validate the current account and process independently.
    return running && this.value === 'logged-in';
  }
  loggedOut(running) {
    // Only an explicit logout observation, never an inconclusive one. The native
    // inspection reads a UI that may be hidden, still rendering or unavailable
    // for seconds to minutes after a restart; treating that as "logged out" used
    // to fail every chat read for the whole window even though the databases
    // were readable and the account was signed in.
    return running && (this.value === 'logged-out' || this.value === 'relogin-required');
  }
  refresh(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.now() - this.attemptedAt < this.pollIntervalMs) return Promise.resolve(this.value);
    const generation = this.generation;
    this.attemptedAt = this.now();
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unknown' }), this.timeoutMs); timer.unref?.(); });
    const task = Promise.race([Promise.resolve().then(this.probe), timeout]).catch(() => ({ status: 'unknown' })).then(result => {
      if (generation !== this.generation) return this.value;
      if (['logged-in', 'logged-out', 'relogin-required'].includes(result?.status)) {
        this.value = result.status === 'logged-out' && this.hadLogin ? 'relogin-required' : result.status;
        this.observedAt = this.now();
        if (result.status === 'logged-in') this.hadLogin = true;
      }
      return this.state(true);
    }).finally(() => { clearTimeout(timer); if (this.pending === task) this.pending = null; });
    this.pending = task; return task;
  }
}
