import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, chmod, rename, rm } from 'node:fs/promises';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Relocate only the pinned Debian Xvfb's xkbcomp and keyboard-output paths.
// Both complete input and output hashes are checked, including the older build
// whose xkbcomp path was already relocated. The official WeChat stays untouched.
export function relocateXvfb(input, recipe) {
  const digest = hash(input);
  if (digest === recipe.sha256) return input;
  if (![recipe.sourceSha256, recipe.legacySha256].includes(digest)) throw new Error('Unrecognized Xvfb build');
  const output = Buffer.from(input);
  for (const patch of recipe.patches) {
    const before = Buffer.from(patch.before, 'hex'), after = Buffer.from(patch.after, 'hex');
    const current = output.subarray(patch.offset, patch.offset + before.length);
    if (before.length !== after.length || !current.equals(before) && !current.equals(after)) throw new Error('Xvfb relocation mismatch');
    after.copy(output, patch.offset);
  }
  if (hash(output) !== recipe.sha256) throw new Error('Xvfb relocation verification failed');
  return output;
}

export async function prepareXvfb(appRoot, runtimeRoot) {
  const recipes = JSON.parse(await readFile(path.join(appRoot, 'config/xvfb-relocations.json'), 'utf8'));
  const recipe = recipes[process.arch];
  if (!recipe) throw new Error('Unsupported desktop architecture');
  const destination = path.join(runtimeRoot, 'usr/bin/Xvfb-qibox');
  try { if (hash(await readFile(destination)) === recipe.sha256) return destination; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = relocateXvfb(await readFile(path.join(runtimeRoot, 'usr/bin/Xvfb')), recipe);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o755, flag: 'wx' });
    await chmod(temporary, 0o755);
    try { await rename(temporary, destination); }
    catch (error) {
      // Windows can reject replacement while a concurrent preparer reads it.
      // Accept only another writer's fully verified output, never a partial file.
      if (!['EPERM', 'EEXIST'].includes(error.code) || hash(await readFile(destination)) !== recipe.sha256) throw error;
    }
  } finally { await rm(temporary, { force: true }); }
  return destination;
}

// Xvfb chooses a free abstract Unix socket and signals readiness on this pipe.
// UGOS has no /tmp; filesystem socket/lock polling cannot detect this listener.
export function displayReady(child, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const pipe = child.stdio[3]; let output = '';
    const finish = (error, display) => {
      clearTimeout(timer); pipe.off('data', data); pipe.off('end', ended); pipe.off('error', failed);
      child.off('error', failed); child.off('exit', exited);
      error ? reject(error) : resolve(display);
    };
    const failed = error => finish(error);
    const exited = (code, signal) => finish(new Error(`Xvfb exited (${signal || code})`));
    const ended = () => finish(new Error('Xvfb closed its readiness pipe'));
    const data = chunk => {
      output += chunk.toString('ascii');
      if (output.length > 16 || /[^0-9\n]/.test(output)) return finish(new Error('Invalid Xvfb display number'));
      if (!output.includes('\n')) return;
      if (!/^\d{1,5}\n$/.test(output) || Number(output) > 65535) return finish(new Error('Invalid Xvfb display number'));
      finish(null, `:${Number(output)}`);
    };
    const timer = setTimeout(() => finish(new Error('Xvfb readiness timed out')), timeout);
    pipe.on('data', data); pipe.once('end', ended); pipe.once('error', failed);
    child.once('error', failed); child.once('exit', exited);
    if (child.exitCode !== null || child.signalCode != null) exited(child.exitCode, child.signalCode);
  });
}
