import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './files.mjs';

export async function pasteManualText(runtime, text, { spawnProcess = spawn } = {}) {
  const process = runtime.processes.find(item => item.name === 'wechat')?.process;
  if (!process?.pid || runtime.status !== 'running') throw new AppError('请先点击微信输入框，再输入文字', 409);
  const child = spawnProcess(path.join(runtime.runtimeRoot, 'usr/bin/python3.11'), [path.join(runtime.appRoot, 'server/manual-text.py'), String(process.pid)], {
    env: { ...runtime.desktopEnv, PYTHONHOME: path.join(runtime.runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const fail = () => reject(new AppError('文字输入尚未确认，请核对微信草稿后继续', 409));
      timer = setTimeout(() => { child.kill(); fail(); }, 8000);
      child.once('error', fail); child.stdin.once('error', fail);
      child.stdout.on('data', bytes => { output += bytes; if (output.length > 1024) { child.kill(); fail(); } });
      child.once('close', code => {
        let result; try { result = JSON.parse(output); } catch {}
        code === 0 && result?.ready === true ? resolve() : fail();
      });
      child.stdin.end(text);
    });
    if (runtime.status !== 'running' || runtime.processes.find(item => item.name === 'wechat')?.process !== process) throw new AppError('微信连接已断开，请核对草稿', 409);
  } finally { clearTimeout(timer); child.kill(); }
  return { ready: true, pasteRequired: false };
}
