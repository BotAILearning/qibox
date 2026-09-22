import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppError } from './files.mjs';

export function docker(args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', errors = ''; const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', data => { out += data; if (out.length > 1024 * 1024) child.kill(); });
    child.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
    child.on('error', () => { clearTimeout(timer); reject(new AppError('Docker 不可用，请先在 NAS 启用容器服务', 503, 'docker-unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const unavailable = /cannot connect to the docker daemon|permission denied.*docker\.sock|is the docker daemon running/i.test(errors);
      reject(new AppError(unavailable ? 'Docker 不可用，请检查 NAS 容器服务与访问权限' : '容器操作未完成，请检查容器服务和镜像网络', unavailable ? 503 : 400, unavailable ? 'docker-unavailable' : undefined));
    });
  });
}
export class DockerRuntime {
  constructor({ dataRoot, definition, dev = false, command = docker }) {
    this.dataRoot = dataRoot; this.definition = definition; this.dev = dev; this.command = command;
    this.tag = createHash('sha256').update(path.resolve(dataRoot)).digest('hex'); this.name = 'qibox-' + this.tag.slice(0, 24);
    this.status = 'preparing'; this.webPort = null; this.message = ''; this.processes = [];
  }
  publicState() { return { status: this.status, message: this.message, canConnect: this.status === 'running', transport: 'web' }; }
  async inspect() {
    const values = JSON.parse(await this.command(['inspect', this.name])); const value = values[0];
    if (values.length !== 1 || value?.Config?.Labels?.['com.qibox.instance'] !== this.tag || value?.Config?.Labels?.['com.qibox.app'] !== this.definition.id) throw new AppError('容器归属不符，已停止操作');
    return value;
  }
  async exists() { return !!(await this.command(['ps', '-a', '--filter', `name=^/${this.name}$`, '--format', '{{.Names}}'])); }
  async prepare() {
    this.status = 'stopped';
    if (this.dev) return;
    try { if (await this.exists()) { const value = await this.inspect(); if (value.State?.Running) this.adopt(value); } }
    catch (error) { this.status = 'unavailable'; this.message = error.message; }
  }
  adopt(value) {
    const bindings = value.NetworkSettings?.Ports?.['8080/tcp'];
    if (!value.State?.Running || bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || !/^\d+$/.test(bindings[0].HostPort)) throw new AppError('容器尚未就绪');
    const port = Number(bindings[0].HostPort); if (port < 1 || port > 65535) throw new AppError('容器端口无效');
    this.webPort = port; this.status = 'running'; this.message = '';
  }
  async start() {
    if (this.status === 'running') { const value = await this.inspect(); if (value.State?.Running) { this.adopt(value); return; } this.webPort = null; }
    if (this.dev) throw new AppError('请在 NAS 中启动容器应用');
    this.status = 'starting'; this.message = '正在准备容器…';
    try {
      if (await this.exists()) { await this.inspect(); await this.command(['start', this.name]); }
      else {
        const directory = path.join(this.dataRoot, 'site'); await mkdir(directory, { recursive: true, mode: 0o755 });
        if (typeof this.definition.initialContent === 'string') await writeFile(path.join(directory, 'index.html'), this.definition.initialContent, { flag: 'wx', mode: 0o644 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        await this.command(['run', '-d', '--name', this.name, '--label', `com.qibox.instance=${this.tag}`, '--label', `com.qibox.app=${this.definition.id}`,
          '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m', '--cpus=0.5',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--publish', '127.0.0.1::8080', '--mount', `type=bind,src=${directory},dst=/usr/share/nginx/html,readonly`, this.definition.image]);
      }
      this.adopt(await this.inspect());
    } catch (error) { this.status = 'error'; this.webPort = null; this.message = error.message; throw error; }
  }
  async stop({ shutdown = false } = {}) {
    try { if (!this.dev && await this.exists()) { await this.inspect(); await this.command(['stop', '-t', '10', this.name]); } }
    catch (error) {
      this.webPort = null;
      if (!shutdown || error.code !== 'docker-unavailable') throw error;
      this.status = 'unavailable'; this.message = error.message; return;
    }
    this.status = 'stopped'; this.webPort = null;
  }
  async remove() { if (!this.dev && await this.exists()) { await this.inspect(); await this.command(['rm', '-f', this.name]); } this.status = 'stopped'; this.webPort = null; }
}
