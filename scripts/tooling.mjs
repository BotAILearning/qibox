import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
export const root = path.resolve(import.meta.dirname, '..');
const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
export const python = process.env.QIBOX_BUILD_PYTHON || (process.platform === 'win32' && existsSync(path.join(bundled, 'python/python.exe')) ? path.join(bundled, 'python/python.exe') : 'python3');
export const playwrightPath = process.env.QIBOX_PLAYWRIGHT || (existsSync(path.join(bundled, 'node/node_modules/playwright')) ? path.join(bundled, 'node/node_modules/playwright') : 'playwright');
export function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => { const child = spawn(bin, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}`))); });
}
