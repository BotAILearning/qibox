// Poll read-only state only while it can be seen. Mutations stay with their
// callers and are never retried by this scheduler.
export function stateRefreshDelay({ ready, busy, job, instances = [] }) {
  const activeJob = job && !['complete', 'done', 'error', 'cancelled'].includes(job.status);
  return !ready || busy || activeJob || instances.some(item => ['starting', 'preparing', 'stopping'].includes(item.runtime?.status)) ? 1000 : 5000;
}

export function visibleRefresh({ refresh, interval = () => 5000, document, window,
  schedule = setTimeout, cancel = clearTimeout, maxDelay = 30000 }) {
  let timer, running = false, pending = false, stopped = true, failures = 0;
  const available = () => !document.hidden && window.navigator?.onLine !== false;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const later = () => {
    clear();
    if (!stopped && available()) timer = schedule(run, Math.min(maxDelay, Math.max(1000, interval()) * 2 ** failures));
  };
  async function run() {
    clear();
    if (stopped || !available()) return;
    if (running) { pending = true; return; }
    running = true;
    try { failures = await refresh() === false ? Math.min(5, failures + 1) : 0; }
    catch { failures = Math.min(5, failures + 1); }
    finally {
      running = false;
      if (pending && !stopped && available()) { pending = false; timer = schedule(run, 0); }
      else { pending = false; later(); }
    }
  }
  const wake = () => { failures = 0; if (!available()) { pending = false; clear(); } else void run(); };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      document.addEventListener('visibilitychange', wake);
      for (const event of ['online', 'offline', 'pageshow']) window.addEventListener(event, wake);
      void run();
    },
    stop() {
      stopped = true; pending = false; clear();
      document.removeEventListener('visibilitychange', wake);
      for (const event of ['online', 'offline', 'pageshow']) window.removeEventListener(event, wake);
    },
    wake,
  };
}
