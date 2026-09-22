import path from 'node:path';
const safeDiagnostic = value => ({
  phase: ['native-start','native-session','native-navigation','native-prepare'].includes(value?.phase) ? value.phase : 'native-prepare',
  code: ['timeout','cancelled','controls-unavailable'].includes(value?.code) ? value.code : 'unavailable'
});

// Hold one validated native chat session across the final DB revision check.
// Only the explicit commit contains text. No dispatch occurs during preparation.
export async function preparedSend(bridge, route, text, context, verify) {
  context.draft = { text, label: route.label };
  await bridge.handover(context);
  let memory;
  try {
    memory = await bridge.openMemory(`/proc/${context.pid}/mem`, 'r');
    bridge.check(context);
    return await new Promise((resolve, reject) => {
    const runtime = bridge.runtime;
    const child = bridge.spawnProcess(path.join(runtime.runtimeRoot, 'usr/bin/python3.11'),
      [path.join(runtime.appRoot, 'server/ai-native.py'), String(context.pid), '--prepare'], {
        env: { ...runtime.desktopEnv, PYTHONHOME: path.join(runtime.runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', memory.fd],
      });
    let output = '', size = 0, prepared = false, result, failure, killed = false, exited = false, forced = false, invalidOutput = false, killTimer, verifying = Promise.resolve();
    const abort = () => {
      if (killed || exited) return;
      killed = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!exited) { forced = true; result = undefined; child.kill('SIGKILL'); } }, 2500);
    };
    const invalidateOutput = () => { invalidOutput = true; result = undefined; output = ''; abort(); };
    let timer = setTimeout(abort, 95000);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); context.signal?.removeEventListener('abort', abort); };
    context.signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', abort); child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      // SIGTERM asks the helper to finish its owned-draft checks. Continue
      // accepting one bounded final report, but never authorize new work.
      if (exited || invalidOutput) return;
      size += Buffer.byteLength(chunk); if (size > 400000) { invalidateOutput(); return; }
      output += chunk;
      while (output.includes('\n')) {
        const at = output.indexOf('\n'), line = output.slice(0, at); output = output.slice(at + 1);
        let value; try { value = JSON.parse(line); } catch { invalidateOutput(); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { invalidateOutput(); return; }
        if (value.stage === 'prepared') {
          if (prepared || result) { invalidateOutput(); return; } prepared = true;
          if (killed) continue;
          clearTimeout(timer); timer = setTimeout(abort, 48000);
          verifying = (async () => {
            try {
              const authorized = await verify(value); bridge.check(context);
              if (killed || exited) return;
              clearTimeout(timer); timer = setTimeout(abort, 32000);
              if (authorized) {
                context.delivery.started = true;
                child.stdin.end(JSON.stringify({ action: 'commit', revision: value.revision, text }) + '\n');
              } else child.stdin.end(JSON.stringify({ action: 'cancel' }) + '\n');
            } catch (error) { failure = error; abort(); }
          })();
        } else {
          const final = value.stage === undefined && (['submitted', 'uncertain', 'stale', 'not-sent'].includes(value.status)
            || value.available === false && typeof value.error === 'string' && value.error.length > 0 && value.error.length <= 128);
          if (result || !final) { invalidateOutput(); return; }
          result = value;
        }
      }
    });
    child.once('error', error => { failure = error; abort(); });
    child.once('close', async (code, signal) => {
      exited = true; cleanup(); await verifying;
      // Cancellation never returns control until owned-draft cleanup completed.
      // A truncated, repeated, malformed or forcibly terminated report cannot
      // retain an earlier claim that the input box was safe.
      const complete = !!result && !invalidOutput && !forced && code === 0 && !signal && !output.trim();
      if (context.delivery.started) bridge.noteDraftResult(complete ? result : undefined, context);
      if (failure?.code === 'ai_account_changed') return reject(failure);
      if (context.signal?.aborted && !context.delivery.started) return resolve({ status: 'stale' });
      if (!complete || killed) return resolve({ status: context.delivery.started ? 'uncertain' : 'not-sent' });
      if (result.error === 'account-changed') return reject(Object.assign(new Error('微信账号已变化'), { code: 'ai_account_changed' }));
      if (result.error) return resolve({ status: context.delivery.started ? 'uncertain' : 'not-sent', diagnostic: safeDiagnostic(result.diagnostic) });
      resolve(result);
    });
    if (context.signal?.aborted) abort();
    else child.stdin.write(JSON.stringify({ action: 'prepare-send', ...route }) + '\n');
    });
  } finally {
    // Keep the descriptor until helper exit/owned-draft cleanup. Startup errors,
    // process changes and cancellation must release the parent copy as well.
    try { await memory?.close(); } catch {}
  }
}
