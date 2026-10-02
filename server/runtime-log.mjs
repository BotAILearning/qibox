// A full or unavailable log volume must not bring down every WeChat instance.
// Keep draining both child pipes after a write failure so the child can finish
// its own work even when there is nowhere to save diagnostic output.
export function attachRuntimeLog(child, stream, failed) {
  let unavailable = false;
  stream.on('error', error => {
    unavailable = true;
    for (const source of [child.stdout, child.stderr]) { source.unpipe(stream); source.resume(); }
    failed(error);
  });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  child.on('error', error => { if (!unavailable && !stream.destroyed) stream.write(String(error)); });
  child.on('close', () => { if (!stream.destroyed) stream.end(); });
}
