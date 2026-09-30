import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './files.mjs';
import { validateClipboardFiles } from './clipboard.mjs';

export async function prepareManualFiles(runtime, files, { spawnProcess = spawn } = {}) {
  validateClipboardFiles(files);
  const process = runtime.processes.find(item => item.name === 'wechat')?.process;
  if (!process?.pid || !runtime.fileChooser) throw new AppError('请先打开微信聊天，再粘贴文件', 409);
  const controller = new AbortController();
  const lease = runtime.fileChooser.armLocalFiles(files, { signal: controller.signal });
  let child, timer;
  try {
    const opened = new Promise((resolve, reject) => {
      child = spawnProcess(path.join(runtime.runtimeRoot, 'usr/bin/python3.11'), [path.join(runtime.appRoot, 'server/manual-files.py'), JSON.stringify(files.map(file => file.name)), String(process.pid)], {
        env: { ...runtime.desktopEnv, PYTHONHOME: path.join(runtime.runtimeRoot, 'usr'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      child.stdout.on('data', data => { output += data; if (output.length > 1024) child.kill(); });
      child.once('error', reject);
      child.once('close', code => {
        let value; try { value = JSON.parse(output); } catch {}
        code === 0 && value?.ready === true ? resolve() : reject(new AppError(value?.reason === 'preview'
          ? '文件没有全部进入微信，请核对草稿，或从微信“发送文件”重新选择'
          : '请先点击微信聊天输入框，再粘贴或拖入文件', 409));
      });
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { child?.kill(); controller.abort(); reject(new AppError('文件准备超时，请从微信的发送文件按钮重新选择', 504)); }, 15000);
    });
    await Promise.race([Promise.all([opened, lease.done]), timeout]);
    if (runtime.status !== 'running' || runtime.processes.find(item => item.name === 'wechat')?.process !== process) throw new AppError('微信连接已断开，请重新选择文件', 409);
    return { ready: true, pasteRequired: false };
  } finally {
    clearTimeout(timer); controller.abort(); child?.kill();
    await lease.close();
  }
}
