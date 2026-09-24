import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'qibox-shadow-'));
const child = spawn(process.execPath, [path.join(root, 'server/index.mjs'), '--dev'], {
  cwd: root,
  env: { ...process.env, QIBOX_PORT: process.env.QIBOX_PORT || '0', QIBOX_DEV_DATA_DIR: dataRoot },
  stdio: 'inherit',
  windowsHide: true,
});

let stopping = false;
const stop = signal => {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', async (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  await rm(dataRoot, { recursive: true, force: true });
});
