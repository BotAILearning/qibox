import path from 'node:path';
import net from 'node:net';
import { mkdir, writeFile, chmod, readdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './files.mjs';

export async function startAudio(runtime, env) {
  runtime.audioEnv = { ...env };
  const directory = path.join(env.XDG_RUNTIME_DIR, 'audio');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cookie = path.join(directory, 'cookie'), socket = path.join(directory, 'native'), pcm = path.join(directory, 'pcm');
  try { await writeFile(cookie, randomBytes(256), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (const file of [socket, pcm]) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const config = path.join(directory, 'default.pa');
  await writeFile(config, [
    'load-module module-null-sink sink_name=qibox rate=48000 channels=2 format=s16le',
    `load-module module-native-protocol-unix socket=${quote(socket)} auth-cookie=${quote(cookie)}`,
    `load-module module-simple-protocol-unix socket=${quote(pcm)} source=qibox.monitor record=true playback=false rate=48000 channels=2 format=s16le`,
    'set-default-sink qibox', 'set-default-source qibox.monitor',
  ].join('\n') + '\n', { mode: 0o600 });
  Object.assign(env, { PULSE_SERVER: `unix:${socket}`, PULSE_SINK: 'qibox', PULSE_COOKIE: cookie,
    PULSE_RUNTIME_PATH: directory, PULSE_STATE_PATH: path.join(directory, 'state') });
  const triple = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
  const pulse = (await readdir(path.join(runtime.runtimeRoot, 'usr/lib'))).filter(name => /^pulse-\d/.test(name));
  if (pulse.length !== 1) throw new AppError('声音组件不完整，请重新安装栖盒');
  const modules = path.join(runtime.runtimeRoot, 'usr/lib', pulse[0], 'modules');
  const child = runtime.child(path.join(runtime.runtimeRoot, 'usr/bin/pulseaudio'), ['-n', '--daemonize=no', '--use-pid-file=no', '--exit-idle-time=-1', '--disable-shm=yes', '--log-target=stderr', `--dl-search-path=${modules}`, `--file=${config}`],
    { ...env, LD_LIBRARY_PATH: `${modules}:${path.join(runtime.runtimeRoot, 'usr/lib', triple, 'pulseaudio')}:${env.LD_LIBRARY_PATH}` }, 'audio');
  runtime.audioProcess = child;
  child.once('exit', () => { if (runtime.audioProcess === child) { runtime.audioSocket = null; runtime.audioProcess = null; } });
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new AppError('声音服务未启动，请重新打开应用');
    try { await chmod(pcm, 0o600); await chmod(socket, 0o600); runtime.audioSocket = pcm; return; } catch {}
    await delay(100);
  }
  child.kill(); throw new AppError('声音服务未启动，请重新打开应用');
}

export async function ensureAudio(runtime, start = startAudio) {
  if (runtime.status !== 'running' || !runtime.audioEnv) throw new AppError('声音暂不可用', 409);
  if (runtime.audioSocket && runtime.audioProcess?.exitCode === null && runtime.audioProcess?.signalCode === null) return;
  if (!runtime.audioStarting) runtime.audioStarting = start(runtime, { ...runtime.audioEnv }).then(() => { runtime.audioError = null; }).finally(() => { runtime.audioStarting = null; });
  await runtime.audioStarting;
  if (runtime.status !== 'running') throw new AppError('应用已关闭', 409);
}

export async function streamAudio(runtime, req, res) {
  await ensureAudio(runtime);
  runtime.audioListeners ??= new Set();
  if (runtime.audioListeners.size >= 4) throw new AppError('声音连接过多，请关闭其他播放页面', 429);
  const socket = net.connect(runtime.audioSocket); runtime.audioListeners.add(socket);
  let connected = false;
  const close = () => { runtime.audioListeners.delete(socket); socket.destroy(); if (connected && !res.writableEnded) res.end(); };
  res.on('close', close);
  socket.on('error', close); socket.on('close', close);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { close(); finish(new AppError('声音连接超时，请重试', 504)); }, 5000);
    const finish = error => { clearTimeout(timer); socket.off('connect', ready); socket.off('error', failed); socket.off('close', ended); error ? reject(error) : resolve(); };
    const ready = () => finish(), failed = error => finish(error), ended = () => finish(new AppError('声音连接已关闭', 409));
    socket.once('connect', ready); socket.once('error', failed); socket.once('close', ended);
  });
  connected = true;
  if (res.destroyed) return close();
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Audio-Format': 's16le;rate=48000;channels=2' });
  socket.pipe(res);
}
