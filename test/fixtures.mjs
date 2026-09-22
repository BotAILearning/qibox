import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
export const packageBytes = Buffer.from('!<arch>\nqibox-test-package');
export const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
export const delay = ms => new Promise(r => setTimeout(r, ms));
export async function temp() { return mkdtemp(path.join(os.tmpdir(), 'qibox-test-')); }
export async function cleanup(root) { if (!path.basename(root).startsWith('qibox-test-')) throw new Error('Unexpected test root'); await rm(root, { recursive: true, force: true }); }
export async function extractor(file, destination) { await mkdir(path.join(destination, 'opt/wechat'), { recursive: true }); await writeFile(path.join(destination, 'opt/wechat/wechat'), 'test fixture, not an application'); return { version: '4.1.13.9' }; }
export const fetcher = async () => new Response(packageBytes, { headers: { 'content-length': String(packageBytes.length) } });
export function runtimeFactory(id, options, uid) {
  return { status: 'preparing', port: null, password: 'test1234', options, id, uid, starts: 0,
    autoLoginStatus: 'unknown', loginStatus: 'logged-out', windowVisible: true, shows: 0, logins: 0,
    async showWindow() { this.shows++; this.windowVisible = true; return true; },
    async showLogin() { this.logins++; this.loginStatus = 'logged-out'; return this.publicState(); },
    async inspectAutoLogin() { return { status: this.autoLoginStatus }; },
    async prepare() { this.status = 'stopped'; },
    async start() { if (this.status === 'running') return; this.starts++; this.status = 'starting'; await delay(5); this.status = 'running'; },
    async stop() { this.status = 'stopped'; },
    publicState() { return { status: this.status, loginStatus: this.loginStatus, aiEntryAvailable: this.aiEntryAvailable, windowVisible: this.windowVisible, canConnect: false }; },
    async setClipboard(text) { this.lastClipboard = text; return { ready: true }; }
  };
}
