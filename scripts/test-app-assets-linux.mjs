#!/usr/bin/env node
/**
 * Isolated Linux fault matrix for install-time application assets.
 * Usage: node scripts/test-app-assets-linux.mjs --root /tmp/qibox-app-fixture
 * The fixture must contain config/app-assets.json and assets/<sha>-assets.tar.xz.
 * It is copied to a private temporary directory for every case.
 */
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const rootArg = option('--root');
const outputArg = option('--output');
const callbackArg = option('--callback');
const slowMs = Number(option('--slow-ms') || 2000);
if (!rootArg) throw new Error('Usage: node scripts/test-app-assets-linux.mjs --root <fixture-root>');
if (!Number.isSafeInteger(slowMs) || slowMs < 0) throw new Error('--slow-ms must be a non-negative integer');
if (process.platform !== 'linux') throw new Error('This matrix must run on Linux; no device or NAS state is modified.');
const source = path.resolve(rootArg);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(path.join(repository, 'server/app-assets.mjs')).href;
const work = await mkdtemp(path.join(os.tmpdir(), 'qibox-assets-matrix-'));
const output = outputArg ? path.resolve(outputArg) : path.join(work, 'results');
await (await import('node:fs/promises')).mkdir(output, { recursive: true });
const results = [];
let failures = 0;

async function copyCase(name) {
  const root = path.join(work, name);
  await cp(source, root, { recursive: true, dereference: false });
  return root;
}
function prepare(root, env = {}, signal, memoryKb = 0) {
  const code = `import { prepareAppAssets } from ${JSON.stringify(moduleUrl)}; await prepareAppAssets(process.argv[1]);`;
  const command = memoryKb ? '/bin/bash' : process.execPath;
  const args = memoryKb ? ['-c', 'ulimit -v "$1"; shift; exec "$@"', 'qibox-assets-memory', String(memoryKb), process.execPath, '--input-type=module', '-e', code, root] : ['--input-type=module', '-e', code, root];
  return new Promise(resolve => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    if (signal) signal(child);
    child.on('close', (code, signalName) => resolve({ code, signal: signalName, stdout, stderr }));
  });
}
async function wrapper(root, name, body) {
  const file = path.join(root, `.matrix-${name}.sh`);
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`); await chmod(file, 0o755); return file;
}
async function caseRun(name, fn) {
  let status = 'PASS', details = {}, errorText = '';
  try { details = await fn() || {}; status = details.resultStatus || 'PASS'; }
  catch (error) { status = error.message.startsWith('SKIP ') ? 'SKIP' : (error.message.startsWith('INJECTED ') ? 'INJECTED_FAILURE_EXPECTED' : (error.message.startsWith('REAL_EXPECTED ') ? 'REAL_FAILURE_EXPECTED' : 'FAIL')); if (status === 'FAIL') failures++; errorText = error.stack || String(error); details = error.details || {}; }
  const record = { name, status, error: errorText, ...details };
  await writeFile(path.join(output, `${name}.json`), JSON.stringify(record, null, 2) + '\n');
  await writeFile(path.join(output, `${name}.stdout`), details.stdout || '');
  await writeFile(path.join(output, `${name}.stderr`), details.stderr || errorText);
  results.push(`${name}: ${status}`);
  return record;
}
async function expectFailure(root, env, label, classification = 'INJECTED') {
  const result = await prepare(root, env);
  const details = { code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
  if (result.code === 0) { const error = new Error(`${label} unexpectedly succeeded`); error.details = details; throw error; }
  const log = `${result.stdout}${result.stderr}`;
  if (!log.trim()) { const error = new Error(`${label} returned failure without diagnostics`); error.details = details; throw error; }
  const error = new Error(`${classification} ${label} failed as expected`); error.details = details; throw error;
}

try {
  await caseRun('normal-repeat', async () => {
    const root = await copyCase('normal-repeat');
    const one = await prepare(root), two = await prepare(root);
    if (one.code !== 0 || two.code !== 0) { const error = new Error('repeat preparation failed'); error.details = { one, two }; throw error; }
    return { stdout: one.stdout + two.stdout, stderr: one.stderr + two.stderr };
  });
  await caseRun('concurrent-repeat', async () => {
    const root = await copyCase('concurrent-repeat');
    const [one, two] = await Promise.all([prepare(root), prepare(root)]);
    if (one.code !== 0 || two.code !== 0) { const error = new Error('concurrent preparation failed'); error.details = { one, two }; throw error; }
    return { stdout: one.stdout + two.stdout, stderr: one.stderr + two.stderr };
  });
  await caseRun('missing-tar', async () => expectFailure(await copyCase('missing-tar'), { QIBOX_ASSET_TAR: '/matrix/missing/tar' }, 'missing tar'));
  await caseRun('missing-xz', async () => {
    const root = await copyCase('missing-xz');
    const tar = await wrapper(root, 'missing-xz', 'PATH=/nonexistent exec /bin/tar "$@"');
    await expectFailure(root, { QIBOX_ASSET_TAR: tar }, 'missing xz');
  });
  await caseRun('slow-extraction', async () => {
    const root = await copyCase('slow-extraction');
    const tar = await wrapper(root, 'slow', `sleep ${Math.ceil(slowMs / 1000)}; exec /bin/tar "$@"`);
    const result = await prepare(root, { QIBOX_ASSET_TAR: tar });
    if (result.code !== 0) { const error = new Error('slow extraction failed'); error.details = result; throw error; }
    return { stdout: result.stdout, stderr: result.stderr, delayMs: slowMs };
  });
  await caseRun('interruption-recovery', async () => {
    const root = await copyCase('interruption-recovery');
    const tar = await wrapper(root, 'interrupt', 'sleep 2; exec /bin/tar "$@"');
    const killed = await prepare(root, { QIBOX_ASSET_TAR: tar }, child => setTimeout(() => child.kill('SIGKILL'), 250));
    if (!killed.signal) { const error = new Error('child was not interrupted'); error.details = killed; throw error; }
    await new Promise(resolve => setTimeout(resolve, 2200));
    const recovered = await prepare(root);
    if (recovered.code !== 0) { const error = new Error('recovery preparation failed'); error.details = recovered; throw error; }
    return { stdout: killed.stdout + recovered.stdout, stderr: killed.stderr + recovered.stderr, interrupted: killed.signal };
  });
  await caseRun('enospc-probe', async () => {
    const root = await copyCase('enospc-probe');
    const tar = await wrapper(root, 'enospc', 'echo "tar: No space left on device" >&2; exit 28');
    await expectFailure(root, { QIBOX_ASSET_TAR: tar }, 'ENOSPC probe');
  });
  await caseRun('low-memory-probe', async () => {
    const root = await copyCase('low-memory-probe');
    const result = await prepare(root, { QIBOX_ASSET_COMMAND_TIMEOUT_MS: '0' }, undefined, 256 * 1024);
    return { ...result, resultStatus: result.code === 0 ? 'REAL_LOW_MEMORY_PASS' : 'REAL_LOW_MEMORY_FAILURE' };
  });
  await caseRun('permission-probe', async () => {
    if (process.getuid?.() === 0) throw new Error('SKIP root cannot exercise permission denial safely');
    const root = await copyCase('permission-probe');
    const manifest = path.join(root, 'config/app-assets.json'); await chmod(manifest, 0o000);
    await expectFailure(root, {}, 'permission probe', 'REAL_EXPECTED');
  });
  await caseRun('missing-node-callback', async () => {
    if (!callbackArg) throw new Error('SKIP pass --callback <install_callback> under a chroot with nodejs_v22 removed');
    const root = await copyCase('missing-node-callback');
    const result = await new Promise(resolve => {
      const child = spawn('/bin/bash', [path.resolve(callbackArg)], { env: { ...process.env, TRIM_APPDEST: root, PATH: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    if (result.code === 0) { const error = new Error('callback unexpectedly found a node runtime'); error.details = result; throw error; }
    return { ...result, resultStatus: 'REAL_EXPECTED_FAILURE' };
  });
} finally {
  console.log(results.join('\n'));
  await rm(work, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
